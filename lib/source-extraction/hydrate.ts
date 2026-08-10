import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import type { SourceDocument } from "../types";
import { extractHtmlBlocks } from "./html";
import { blocksToText, SourceBlockCollector, normalizeSourceText } from "./normalize";
import { extractPdfBlocks } from "./pdf";
import { safeFetchSource } from "./safe-http";
import {
  SOURCE_EXTRACTOR_VERSION,
  SourceExtractionError,
  type PodcastSourceCorpus,
  type SourceDescriptor,
  type SourceExtractionOptions,
  type SourceHydrationOptions,
  resolveExtractionLimits,
  resolveSourceDocumentBatchTimeoutMs,
} from "./types";

function defaultRetrievalPolicy(source: SourceDescriptor) {
  if (source.accessLevel === "open_access") return "full_text" as const;
  if (source.accessLevel === "feed_content") return "feed_only" as const;
  return "metadata_only" as const;
}

function fallbackParagraphs(value: string): string[] {
  let plainValue = value;
  const containedMarkup = /<(?:!doctype|\/?[a-z][^>]*)>/i.test(value);
  if (containedMarkup) {
    const dom = new JSDOM(value, { contentType: "text/html" });
    const document = dom.window.document;
    document
      .querySelectorAll("script, style, noscript, template, iframe, svg, canvas")
      .forEach((element) => element.remove());
    document.querySelectorAll("br").forEach((element) => element.replaceWith("\n"));
    document
      .querySelectorAll(
        "address, article, aside, blockquote, dd, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, li, main, nav, ol, p, pre, section, table, tr, ul",
      )
      .forEach((element) => element.append("\n\n"));
    plainValue = document.body?.textContent ?? "";
    dom.window.close();
  }
  const normalized = plainValue
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => normalizeSourceText(paragraph))
    .filter(Boolean);
  if (normalized.length) return normalized;
  return containedMarkup ? [] : [normalizeSourceText(value)].filter(Boolean);
}

export function sourceDocumentText(document: SourceDocument): string {
  return blocksToText(document.blocks);
}

export function createFallbackSourceDocument(
  source: SourceDescriptor,
  reason: { code?: string; warning?: string; retryable?: boolean } = {},
): SourceDocument {
  const limits = resolveExtractionLimits();
  const collector = new SourceBlockCollector(limits.maxBlocks, limits.maxCharacters);
  for (const paragraph of fallbackParagraphs(source.fallbackText ?? "")) {
    if (!collector.add("paragraph", paragraph, [])) break;
  }
  const hasContent = collector.blocks.length > 0;
  const policy = source.retrievalPolicy ?? defaultRetrievalPolicy(source);
  const format = policy === "feed_only" ? "feed" : "abstract";
  return {
    schemaVersion: 1,
    contentItemId: source.contentItemId,
    canonicalUrl: source.canonicalUrl,
    retrievalUrl: source.retrievalUrl ?? source.canonicalUrl,
    resolvedUrl: source.retrievalUrl ?? source.canonicalUrl,
    format,
    title: source.title || undefined,
    blocks: collector.blocks,
    status: hasContent ? "fallback" : "failed",
    stats: {
      rawBytes: 0,
      characters: collector.characters,
      truncated: collector.truncated,
    },
    extraction: {
      extractor: format === "feed" ? "feed-fallback" : "metadata-fallback",
      version: SOURCE_EXTRACTOR_VERSION,
      fetchedAt: new Date().toISOString(),
      warnings: reason.warning ? [reason.warning] : [],
      ...(reason.code ? { errorCode: reason.code } : {}),
      ...(reason.retryable
        ? { retryAfter: new Date(Date.now() + 15 * 60_000).toISOString() }
        : {}),
    },
  };
}

function cachedDocumentIsUsable(
  cached: SourceDocument | undefined,
  source: SourceDescriptor,
): cached is SourceDocument {
  if (!cached || cached.status === "failed") return false;
  if (cached.extraction.retryAfter) {
    const retryAt = new Date(cached.extraction.retryAfter).getTime();
    if (!Number.isFinite(retryAt) || retryAt <= Date.now()) return false;
  }
  const retrievalUrl = source.retrievalUrl ?? source.canonicalUrl;
  return (
    cached.schemaVersion === 1 &&
    cached.extraction.version === SOURCE_EXTRACTOR_VERSION &&
    cached.canonicalUrl === source.canonicalUrl &&
    cached.retrievalUrl === retrievalUrl &&
    cached.blocks.length > 0
  );
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function extractSourceDocument(
  source: SourceDescriptor,
  options: SourceExtractionOptions = {},
): Promise<SourceDocument> {
  const limits = resolveExtractionLimits(options.limits);
  const policy = source.retrievalPolicy ?? defaultRetrievalPolicy(source);
  const retrievalUrl = source.retrievalUrl ?? source.canonicalUrl;

  if (policy === "metadata_only") {
    throw new SourceExtractionError(
      "retrieval_disallowed",
      "Source rights allow metadata only.",
    );
  }

  if (policy === "feed_only") {
    if (!source.feedContentHtml) {
      throw new SourceExtractionError(
        "retrieval_disallowed",
        "Feed-only source has no captured feed body.",
      );
    }
    const bytes = Buffer.from(source.feedContentHtml, "utf8");
    if (bytes.byteLength > limits.maxHtmlBytes) {
      throw new SourceExtractionError(
        "response_too_large",
        "Feed content exceeds the HTML byte limit.",
      );
    }
    const extracted = extractHtmlBlocks({ html: bytes, url: source.canonicalUrl, limits });
    return {
      schemaVersion: 1,
      contentItemId: source.contentItemId,
      canonicalUrl: source.canonicalUrl,
      retrievalUrl,
      resolvedUrl: source.canonicalUrl,
      format: "feed",
      title: extracted.title || source.title || undefined,
      byline: extracted.byline,
      language: extracted.language,
      blocks: extracted.blocks,
      status: "ready",
      stats: {
        rawBytes: bytes.byteLength,
        characters: extracted.characters,
        truncated: extracted.truncated,
      },
      extraction: {
        extractor: "readability-feed",
        version: SOURCE_EXTRACTOR_VERSION,
        fetchedAt: new Date().toISOString(),
        contentHash: hashBytes(bytes),
        warnings: extracted.warnings,
      },
    };
  }

  const downloaded = await safeFetchSource(retrievalUrl, {
    limits,
    signal: options.signal,
  });
  const extracted = downloaded.mediaType === "pdf"
    ? await extractPdfBlocks({ bytes: downloaded.body, limits, signal: options.signal })
    : extractHtmlBlocks({ html: downloaded.body, url: downloaded.resolvedUrl, limits });
  return {
    schemaVersion: 1,
    contentItemId: source.contentItemId,
    canonicalUrl: source.canonicalUrl,
    retrievalUrl,
    resolvedUrl: downloaded.resolvedUrl,
    format: downloaded.mediaType,
    title: extracted.title || source.title || undefined,
    byline: extracted.byline,
    language: extracted.language,
    blocks: extracted.blocks,
    status: "ready",
    stats: {
      rawBytes: downloaded.rawBytes,
      characters: extracted.characters,
      ...(extracted.pages ? { pages: extracted.pages } : {}),
      truncated: extracted.truncated,
    },
    extraction: {
      extractor: downloaded.mediaType === "pdf" ? "unpdf-layout" : "readability-html",
      version: SOURCE_EXTRACTOR_VERSION,
      fetchedAt: new Date().toISOString(),
      contentHash: hashBytes(downloaded.body),
      warnings: extracted.warnings,
    },
  };
}

export async function hydrateSourceDocument(
  source: SourceDescriptor,
  options: SourceHydrationOptions = {},
): Promise<SourceDocument> {
  const cached = options.cachedDocuments?.get(source.contentItemId);
  if (cachedDocumentIsUsable(cached, source)) return cached;
  try {
    const document = await extractSourceDocument(source, options);
    if (document.stats.characters >= resolveExtractionLimits(options.limits).minUsefulCharacters) {
      return document;
    }
    return createFallbackSourceDocument(source, {
      code: "html_not_readable",
      warning: "Extracted source was too short; used the stored abstract or feed text.",
    });
  } catch (error) {
    const normalized = error instanceof SourceExtractionError
      ? error
      : new SourceExtractionError("parse_failed", "Source extraction failed.", { cause: error });
    return createFallbackSourceDocument(source, {
      code: normalized.code,
      warning: normalized.message,
      retryable:
        normalized.retryable ||
        ["dns_failed", "timeout", "http_status", "batch_timeout"].includes(
          normalized.code,
        ),
    });
  }
}

function combinedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!present.length) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

export async function hydrateSourceDocuments(
  sources: readonly SourceDescriptor[],
  options: SourceHydrationOptions = {},
): Promise<SourceDocument[]> {
  if (!sources.length) return [];
  const requestedConcurrency = options.concurrency ?? 2;
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.max(1, Math.min(2, Math.floor(requestedConcurrency)))
    : 2;
  const timeoutSignal = AbortSignal.timeout(
    resolveSourceDocumentBatchTimeoutMs(options.batchTimeoutMs),
  );
  const signal = combinedSignal(options.signal, timeoutSignal);
  const results = new Array<SourceDocument>(sources.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < sources.length) {
      const index = cursor;
      cursor += 1;
      const source = sources[index];
      if (signal?.aborted) {
        results[index] = createFallbackSourceDocument(source, {
          code: "batch_timeout",
          warning: "Source hydration batch exceeded its time budget.",
          retryable: true,
        });
        continue;
      }
      results[index] = await hydrateSourceDocument(source, { ...options, signal });
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  return results;
}

export function createPodcastSourceCorpus(
  documents: readonly SourceDocument[],
): PodcastSourceCorpus {
  const sources = documents.map((document) => ({
    ...document,
    blocks: document.blocks.map((block) => ({ ...block, sectionPath: [...block.sectionPath] })),
  }));
  return {
    schemaVersion: 1,
    sources,
    totalCharacters: sources.reduce((sum, document) => sum + document.stats.characters, 0),
    truncated: sources.some((document) => document.stats.truncated),
  };
}
