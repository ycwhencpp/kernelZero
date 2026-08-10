import { getDocumentProxy } from "unpdf";
import { SourceBlockCollector, normalizeSourceText } from "./normalize";
import {
  SourceExtractionError,
  type ExtractedBlockContent,
  type SourceExtractionLimits,
} from "./types";

export type PdfExtractionInput = {
  bytes: Uint8Array;
  limits: SourceExtractionLimits;
  signal?: AbortSignal;
};

let pdfParseQueue: Promise<void> = Promise.resolve();

type PositionedItem = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
};

type PdfLine = {
  page: number;
  pageWidth: number;
  pageHeight: number;
  text: string;
  x: number;
  maxX: number;
  y: number;
  height: number;
  fontSize: number;
  column: "left" | "right" | "full";
};

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function joinItems(items: readonly PositionedItem[]): string {
  let result = "";
  let rightEdge = 0;
  for (const item of items) {
    if (result && item.x - rightEdge > Math.max(1.5, item.fontSize * 0.18)) result += " ";
    result += item.text;
    rightEdge = Math.max(rightEdge, item.x + item.width);
  }
  return normalizeSourceText(result);
}

function linesFromItems(
  items: readonly PositionedItem[],
  page: number,
  pageWidth: number,
  pageHeight: number,
): PdfLine[] {
  const rows: PositionedItem[][] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const tolerance = Math.max(1.5, item.fontSize * 0.35);
    const row = rows.find((candidate) => Math.abs(candidate[0].y - item.y) <= tolerance);
    if (row) row.push(item);
    else rows.push([item]);
  }

  const lines: PdfLine[] = [];
  for (const row of rows) {
    const sorted = row.sort((a, b) => a.x - b.x);
    const segments: PositionedItem[][] = [];
    for (const item of sorted) {
      const segment = segments.at(-1);
      const previous = segment?.at(-1);
      const gap = previous ? item.x - (previous.x + previous.width) : 0;
      if (previous && gap > Math.max(42, item.fontSize * 4.5)) segments.push([item]);
      else if (segment) segment.push(item);
      else segments.push([item]);
    }
    for (const segment of segments) {
      const text = joinItems(segment);
      if (!text) continue;
      const x = Math.min(...segment.map((item) => item.x));
      const maxX = Math.max(...segment.map((item) => item.x + item.width));
      const fontSize = median(segment.map((item) => item.fontSize).filter((value) => value > 0));
      lines.push({
        page,
        pageWidth,
        pageHeight,
        text,
        x,
        maxX,
        y: median(segment.map((item) => item.y)),
        height: Math.max(...segment.map((item) => item.height || item.fontSize)),
        fontSize,
        column: "full",
      });
    }
  }
  return orderPageLines(lines, pageWidth);
}

function orderPageLines(lines: PdfLine[], pageWidth: number): PdfLine[] {
  const center = pageWidth / 2;
  const left = lines.filter((line) => line.maxX <= center + pageWidth * 0.08);
  const right = lines.filter((line) => line.x >= center - pageWidth * 0.08);
  const hasColumns = left.length >= 4 && right.length >= 4;
  if (!hasColumns) return lines.sort((a, b) => b.y - a.y || a.x - b.x);

  for (const line of lines) {
    if (line.maxX <= center + pageWidth * 0.08) line.column = "left";
    else if (line.x >= center - pageWidth * 0.08) line.column = "right";
    else line.column = "full";
  }

  const spanning = lines
    .filter((line) => line.column === "full")
    .sort((a, b) => b.y - a.y);
  const columns = lines.filter((line) => line.column !== "full");
  const ordered: PdfLine[] = [];
  let upperBound = Number.POSITIVE_INFINITY;
  for (const separator of [...spanning, { y: Number.NEGATIVE_INFINITY } as PdfLine]) {
    const band = columns.filter((line) => line.y < upperBound && line.y > separator.y);
    ordered.push(
      ...band.filter((line) => line.column === "left").sort((a, b) => b.y - a.y || a.x - b.x),
      ...band.filter((line) => line.column === "right").sort((a, b) => b.y - a.y || a.x - b.x),
    );
    if (Number.isFinite(separator.y)) ordered.push(separator);
    upperBound = separator.y;
  }
  return ordered;
}

function marginKey(line: PdfLine): string {
  return line.text
    .toLocaleLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function removeRepeatedMargins(pages: PdfLine[][]): PdfLine[][] {
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const keys = new Set(
      lines
        .filter(
          (line) => line.y >= line.pageHeight * 0.92 || line.y <= line.pageHeight * 0.08,
        )
        .map(marginKey)
        .filter((key) => key.length >= 3),
    );
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.45));
  return pages.map((lines) =>
    lines.filter((line) => {
      const inMargin = line.y >= line.pageHeight * 0.92 || line.y <= line.pageHeight * 0.08;
      if (!inMargin) return true;
      if (/^(?:page\s+)?\d+(?:\s+of\s+\d+)?$/i.test(line.text)) return false;
      return (counts.get(marginKey(line)) ?? 0) < threshold;
    }),
  );
}

function looksLikeHeading(line: PdfLine, bodyFontSize: number): boolean {
  if (line.text.length > 180 || /[.!?;:]$/.test(line.text)) return false;
  if (/^(?:references|bibliography|abstract|introduction|conclusion|appendix)$/i.test(line.text)) {
    return true;
  }
  if (/^\d+(?:\.\d+)*\.?\s+[A-Z]/.test(line.text)) return true;
  return bodyFontSize > 0 && line.fontSize >= bodyFontSize * 1.18;
}

function headingLevel(text: string, fontSize: number, bodyFontSize: number): 1 | 2 | 3 {
  const numbered = text.match(/^(\d+(?:\.\d+)*)/);
  if (numbered) return Math.min(3, numbered[1].split(".").length) as 1 | 2 | 3;
  if (fontSize >= bodyFontSize * 1.55) return 1;
  if (fontSize >= bodyFontSize * 1.3) return 2;
  return 3;
}

function joinWrappedLine(previous: string, current: string): string {
  if (/\p{L}-$/u.test(previous) && /^\p{Ll}/u.test(current)) {
    return `${previous.slice(0, -1)}${current}`;
  }
  return `${previous} ${current}`;
}

function collectPdfBlocks(lines: PdfLine[], limits: SourceExtractionLimits) {
  const collector = new SourceBlockCollector(limits.maxBlocks, limits.maxCharacters);
  const bodyFontSize = median(
    lines
      .filter((line) => line.text.length >= 40)
      .map((line) => line.fontSize)
      .filter((value) => value > 0),
  );
  const sectionPath: string[] = [];
  let paragraph = "";
  let paragraphStart: PdfLine | null = null;
  let previous: PdfLine | null = null;

  const flush = () => {
    if (paragraph && paragraphStart) {
      collector.add("paragraph", paragraph, sectionPath, { page: paragraphStart.page });
    }
    paragraph = "";
    paragraphStart = null;
  };

  for (const line of lines) {
    if (looksLikeHeading(line, bodyFontSize)) {
      flush();
      const level = headingLevel(line.text, line.fontSize, bodyFontSize);
      sectionPath[level - 1] = line.text;
      sectionPath.length = level;
      if (!collector.add("heading", line.text, sectionPath, { level, page: line.page })) break;
      previous = line;
      continue;
    }
    if (/^[•▪◦*]\s*|^[-–]\s+/.test(line.text)) {
      flush();
      if (!collector.add("list_item", line.text.replace(/^[•▪◦*]\s*|^[-–]\s+/, ""), sectionPath, { page: line.page })) break;
      previous = line;
      continue;
    }
    if (/^(?:fig(?:ure)?|table)\s+[A-Z]?\d+[.:]?\s/i.test(line.text)) {
      flush();
      if (!collector.add("caption", line.text, sectionPath, { page: line.page })) break;
      previous = line;
      continue;
    }

    const verticalGap = previous && previous.page === line.page
      ? Math.abs(previous.y - line.y)
      : Number.POSITIVE_INFINITY;
    const startsNewParagraph =
      !previous ||
      previous.page !== line.page ||
      previous.column !== line.column ||
      verticalGap > Math.max(previous.height, line.height, bodyFontSize) * 1.75 ||
      (Math.abs(previous.x - line.x) > Math.max(bodyFontSize * 1.8, 18) && /[.!?]$/.test(previous.text)) ||
      paragraph.length >= 1_200;
    if (startsNewParagraph) flush();
    if (!paragraphStart) paragraphStart = line;
    paragraph = paragraph ? joinWrappedLine(paragraph, line.text) : line.text;
    previous = line;
  }
  flush();
  return collector;
}

/** Extracts text blocks only; it never renders or executes PDF content. */
async function extractPdfBlocksUnlocked(input: PdfExtractionInput): Promise<ExtractedBlockContent> {
  if (input.signal?.aborted) {
    throw new SourceExtractionError("timeout", "PDF extraction was aborted.", {
      cause: input.signal.reason,
      retryable: true,
    });
  }
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  try {
    pdf = await getDocumentProxy(new Uint8Array(input.bytes), {
      stopAtErrors: false,
      useSystemFonts: true,
      disableFontFace: true,
    });
    const pageLimit = Math.min(pdf.numPages, input.limits.maxPdfPages);
    const pages: PdfLine[][] = [];
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      if (input.signal?.aborted) {
        throw new SourceExtractionError("timeout", "PDF extraction was aborted.", {
          cause: input.signal.reason,
          retryable: true,
        });
      }
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent({ disableNormalization: false });
      const items: PositionedItem[] = content.items.flatMap((item) => {
        if (!("str" in item) || !normalizeSourceText(item.str)) return [];
        const transform = item.transform;
        const fontSize = Math.max(
          Math.hypot(transform[0] ?? 0, transform[1] ?? 0),
          Math.hypot(transform[2] ?? 0, transform[3] ?? 0),
          item.height || 0,
        );
        return [{
          text: item.str,
          x: transform[4] ?? 0,
          y: transform[5] ?? 0,
          width: item.width ?? 0,
          height: item.height ?? fontSize,
          fontSize,
        }];
      });
      pages.push(linesFromItems(items, pageNumber, viewport.width, viewport.height));
      page.cleanup();
    }

    const orderedLines = removeRepeatedMargins(pages).flat();
    const usefulCharacters = orderedLines.reduce((sum, line) => sum + line.text.length, 0);
    if (usefulCharacters < input.limits.minUsefulCharacters) {
      throw new SourceExtractionError(
        "pdf_image_only",
        "PDF contains too little extractable text and may be image-only.",
      );
    }
    const collector = collectPdfBlocks(orderedLines, input.limits);
    if (!collector.blocks.length) {
      throw new SourceExtractionError("pdf_image_only", "PDF contains no usable text blocks.");
    }

    let title: string | undefined;
    try {
      const metadata = await pdf.getMetadata();
      const info = metadata.info as { Title?: unknown };
      title = typeof info.Title === "string" ? normalizeSourceText(info.Title) : undefined;
    } catch {
      // Metadata is optional and must not invalidate otherwise usable text.
    }
    return {
      blocks: collector.blocks,
      title,
      pages: pdf.numPages,
      characters: collector.characters,
      truncated: collector.truncated || pdf.numPages > input.limits.maxPdfPages,
      warnings:
        pdf.numPages > input.limits.maxPdfPages
          ? [`PDF was limited to its first ${input.limits.maxPdfPages} pages.`]
          : [],
    };
  } catch (error) {
    if (error instanceof SourceExtractionError) throw error;
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypted/i.test(`${name} ${message}`)) {
      throw new SourceExtractionError("pdf_encrypted", "Encrypted PDF cannot be extracted.", {
        cause: error,
      });
    }
    throw new SourceExtractionError("parse_failed", "PDF source could not be parsed.", {
      cause: error,
    });
  } finally {
    if (pdf) {
      const destroy = (pdf as unknown as { destroy?: () => Promise<void> }).destroy;
      if (destroy) await destroy.call(pdf).catch(() => undefined);
      else await pdf.cleanup().catch(() => undefined);
    }
  }
}

/**
 * PDF.js can use substantially more memory than the downloaded bytes. Keep one
 * parser active per process while still allowing HTML/download work in parallel.
 */
export function extractPdfBlocks(input: PdfExtractionInput): Promise<ExtractedBlockContent> {
  const run = pdfParseQueue.then(() => extractPdfBlocksUnlocked(input));
  pdfParseQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
