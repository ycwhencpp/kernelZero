import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { SourceBlockCollector, normalizeSourceText } from "./normalize";
import {
  SourceExtractionError,
  type ExtractedBlockContent,
  type SourceExtractionLimits,
} from "./types";

export type HtmlExtractionInput = {
  html: string | Uint8Array;
  url: string;
  limits: SourceExtractionLimits;
};

const CONTENT_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "li",
  "blockquote",
  "pre",
  "figcaption",
  "tr",
].join(",");

const PRUNE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "nav",
  "aside",
  "footer",
  "form",
  "iframe",
  "svg",
  "canvas",
  "dialog",
  "[hidden]",
  "[aria-hidden='true']",
].join(",");

function asDomInput(value: string | Uint8Array): string | Buffer {
  return typeof value === "string" ? value : Buffer.from(value);
}

function largestFallbackRoot(document: Document): Element {
  const candidates = [
    ...document.querySelectorAll("article, main, [role='main']"),
  ];
  if (!candidates.length && document.body) candidates.push(document.body);
  const root = candidates.reduce<Element | null>((largest, candidate) => {
    if (!largest) return candidate;
    return (candidate.textContent?.length ?? 0) > (largest.textContent?.length ?? 0)
      ? candidate
      : largest;
  }, null);
  if (!root) {
    throw new SourceExtractionError("html_not_readable", "HTML source has no document body.");
  }
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll(PRUNE_SELECTOR).forEach((element) => element.remove());
  return clone;
}

function elementText(element: Element): string {
  if (element.tagName.toLocaleLowerCase() === "li") {
    const clone = element.cloneNode(true) as Element;
    clone.querySelectorAll("ol, ul").forEach((nested) => nested.remove());
    return clone.textContent ?? "";
  }
  if (element.tagName.toLocaleLowerCase() === "tr") {
    return [...element.querySelectorAll(":scope > th, :scope > td")]
      .map((cell) => normalizeSourceText(cell.textContent ?? ""))
      .filter(Boolean)
      .join(" | ");
  }
  return element.textContent ?? "";
}

function isNestedDuplicate(element: Element): boolean {
  const tag = element.tagName.toLocaleLowerCase();
  if (tag === "p" && element.closest("li, blockquote, pre, td, th, figcaption")) return true;
  if (tag === "li" && element.parentElement?.closest("li")) return false;
  if (tag === "blockquote" && !normalizeSourceText(elementText(element))) return true;
  return false;
}

function collectBlocks(
  root: Element,
  limits: SourceExtractionLimits,
  rootHeading?: string,
) {
  const collector = new SourceBlockCollector(limits.maxBlocks, limits.maxCharacters);
  const sectionPath: string[] = rootHeading ? [normalizeSourceText(rootHeading)] : [];

  for (const element of root.querySelectorAll(CONTENT_SELECTOR)) {
    if (isNestedDuplicate(element)) continue;
    const tag = element.tagName.toLocaleLowerCase();
    const text = elementText(element);
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1)) as 1 | 2 | 3 | 4 | 5 | 6;
      const heading = normalizeSourceText(text);
      if (!heading) continue;
      sectionPath[level - 1] = heading;
      sectionPath.length = level;
      if (!collector.add("heading", heading, sectionPath, { level })) break;
      continue;
    }
    const kind =
      tag === "li"
        ? "list_item"
        : tag === "blockquote"
          ? "quote"
          : tag === "pre"
            ? "code"
            : tag === "tr"
              ? "table_row"
              : tag === "figcaption"
                ? "caption"
                : "paragraph";
    if (!collector.add(kind, text, sectionPath, { preserveLines: tag === "pre" })) break;
  }
  return collector;
}

/** Extracts ordered semantic blocks without retaining untrusted HTML. */
export function extractHtmlBlocks(input: HtmlExtractionInput): ExtractedBlockContent {
  let dom: JSDOM;
  try {
    dom = new JSDOM(asDomInput(input.html), {
      url: input.url,
      contentType: "text/html",
      includeNodeLocations: false,
    });
  } catch (error) {
    throw new SourceExtractionError("parse_failed", "HTML source could not be parsed.", {
      cause: error,
    });
  }

  const document = dom.window.document;
  const elementCount = document.querySelectorAll("*").length;
  if (elementCount > input.limits.maxHtmlElements) {
    dom.window.close();
    throw new SourceExtractionError(
      "response_too_large",
      `HTML source exceeds the ${input.limits.maxHtmlElements}-element limit.`,
    );
  }

  const originalTitle = normalizeSourceText(document.title);
  const originalLanguage = normalizeSourceText(document.documentElement.lang);
  const warnings: string[] = [];
  let articleDom: JSDOM | null = null;
  let article: ReturnType<Readability["parse"]> = null;
  try {
    article = new Readability(document.cloneNode(true) as Document, {
      maxElemsToParse: input.limits.maxHtmlElements,
      charThreshold: Math.min(input.limits.minUsefulCharacters, 500),
      keepClasses: false,
    }).parse();
  } catch (error) {
    warnings.push(
      `Readability failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let root: Element;
  if (article?.content && normalizeSourceText(article.textContent ?? "").length >= 120) {
    articleDom = new JSDOM(`<main>${article.content}</main>`, {
      url: input.url,
      contentType: "text/html",
    });
    root = articleDom.window.document.querySelector("main")!;
  } else {
    warnings.push("Readability returned no substantial article; used the largest content root.");
    root = largestFallbackRoot(document);
  }

  const collector = collectBlocks(root, input.limits, article?.title ?? undefined);
  if (!collector.blocks.length) {
    articleDom?.window.close();
    dom.window.close();
    throw new SourceExtractionError("html_not_readable", "HTML source contained no readable blocks.");
  }
  articleDom?.window.close();
  dom.window.close();

  return {
    blocks: collector.blocks,
    title: normalizeSourceText(article?.title ?? "") || originalTitle || undefined,
    byline: normalizeSourceText(article?.byline ?? "") || undefined,
    language: normalizeSourceText(article?.lang ?? "") || originalLanguage || undefined,
    characters: collector.characters,
    truncated: collector.truncated,
    warnings,
  };
}
