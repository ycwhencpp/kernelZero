import { createHash } from "node:crypto";
import { extractHtmlBlocks } from "./source-extraction/html";
import { SourceBlockCollector, normalizeSourceText } from "./source-extraction/normalize";
import { safeFetchBytes, type BoundedHttpResponse } from "./source-extraction/safe-http";
import {
  SOURCE_EXTRACTOR_VERSION,
  SourceExtractionError,
  resolveExtractionLimits,
} from "./source-extraction/types";
import type { NormalizedCandidate, SourceBlock, SourceDocument } from "./types";

export type ParsedFeed = {
  title: string;
  items: NormalizedCandidate[];
  /** Plain-text-only feed bodies, keyed by each generated content item ID. */
  documents: SourceDocument[];
};

const MAX_FEED_BYTES = 5 * 1024 * 1024;

function stripCdata(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
  return (match?.[1] ?? value).trim();
}

function decodeXmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.toLowerCase().startsWith("#x")) {
      const point = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function plainText(value: string): string {
  return normalizeSourceText(
    decodeXmlEntities(stripCdata(value))
      .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<\s*br\s*\/?>|<\/(?:p|div|li|h[1-6]|blockquote|tr)\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rawTag(block: string, names: readonly string[]): string {
  for (const name of names) {
    const escaped = escapeRegExp(name);
    const expression = new RegExp(
      `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}\\s*>`,
      "i",
    );
    const match = block.match(expression);
    if (match?.[1] !== undefined) return stripCdata(match[1]);
  }
  return "";
}

function tag(block: string, names: readonly string[]): string {
  return plainText(rawTag(block, names));
}

function attribute(block: string, tagName: string, attributeName: string): string {
  const expression = new RegExp(
    `<${escapeRegExp(tagName)}\\s[^>]*${escapeRegExp(attributeName)}=["']([^"']+)["'][^>]*\\/?>`,
    "i",
  );
  return plainText(block.match(expression)?.[1] ?? "");
}

function canonicalItemUrl(block: string, feedUrl: string, index: number): string {
  const candidate =
    tag(block, ["link", "guid"]) || attribute(block, "link", "href");
  if (candidate) {
    try {
      const parsed = new URL(candidate, feedUrl);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        parsed.hash = "";
        return parsed.toString();
      }
    } catch {
      // A non-URL GUID is not suitable as the canonical/retrieval URL.
    }
  }
  const fallback = new URL(feedUrl);
  fallback.hash = `item-${index}`;
  return fallback.toString();
}

function markupForExtraction(value: string): string {
  const stripped = stripCdata(value);
  if (!stripped) return "";
  const decoded = /&lt;\/?[a-z][\s\S]*?&gt;/i.test(stripped)
    ? decodeXmlEntities(stripped)
    : stripped;
  if (/<[a-z][^>]*>/i.test(decoded)) return decoded;
  const safeText = decodeXmlEntities(decoded)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<article><p>${safeText}</p></article>`;
}

function fallbackFeedBlocks(text: string): SourceBlock[] {
  const collector = new SourceBlockCollector(2_000, 300_000);
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => normalizeSourceText(paragraph))
    .filter(Boolean);
  for (const paragraph of paragraphs) {
    if (!collector.add("paragraph", paragraph, [])) break;
  }
  return collector.blocks;
}

function createFeedDocument(input: {
  contentItemId: string;
  canonicalUrl: string;
  title: string;
  author: string;
  bodyMarkup: string;
  summary: string;
}): SourceDocument {
  const limits = resolveExtractionLimits({ maxHtmlBytes: MAX_FEED_BYTES });
  const markup = markupForExtraction(input.bodyMarkup);
  const rawBytes = Buffer.byteLength(markup, "utf8");
  let blocks: SourceBlock[] = [];
  let characters = 0;
  let truncated = false;
  let status: SourceDocument["status"] = "ready";
  let extractor = "readability-feed";
  const warnings: string[] = [];

  if (markup) {
    try {
      const extracted = extractHtmlBlocks({
        html: markup,
        url: input.canonicalUrl,
        limits,
      });
      blocks = extracted.blocks;
      characters = extracted.characters;
      truncated = extracted.truncated;
      warnings.push(...extracted.warnings);
    } catch (error) {
      warnings.push(
        error instanceof Error ? error.message : "Feed body extraction failed.",
      );
    }
  }

  if (!blocks.length) {
    blocks = fallbackFeedBlocks(input.summary || input.title);
    characters = blocks.reduce((sum, block) => sum + block.text.length, 0);
    status = blocks.length ? "fallback" : "failed";
    extractor = "feed-text-fallback";
  }

  return {
    schemaVersion: 1,
    contentItemId: input.contentItemId,
    canonicalUrl: input.canonicalUrl,
    retrievalUrl: input.canonicalUrl,
    resolvedUrl: input.canonicalUrl,
    format: "feed",
    title: input.title,
    ...(input.author ? { byline: input.author } : {}),
    blocks,
    status,
    stats: {
      rawBytes,
      characters,
      truncated,
    },
    extraction: {
      extractor,
      version: SOURCE_EXTRACTOR_VERSION,
      fetchedAt: new Date().toISOString(),
      ...(markup
        ? { contentHash: createHash("sha256").update(markup).digest("hex") }
        : {}),
      warnings,
      ...(status === "failed" ? { errorCode: "feed_body_empty" } : {}),
    },
  };
}

export function parseFeed(xml: string, feedUrl: string): ParsedFeed {
  if (!/<(?:rss|feed|rdf:RDF)\b/i.test(xml)) {
    throw new Error("The source is not a recognizable RSS or Atom feed.");
  }

  const feedTitle = tag(xml, ["title"]) || new URL(feedUrl).hostname;
  const blocks =
    xml.match(/<item\b[\s\S]*?<\/item>/gi) ??
    xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ??
    [];

  const documents: SourceDocument[] = [];
  const items = blocks.slice(0, 30).map((block, index) => {
    const title = tag(block, ["title"]) || "Untitled feed item";
    const canonicalUrl = canonicalItemUrl(block, feedUrl, index);
    const descriptionMarkup = rawTag(block, ["description", "summary"]);
    // Full feed bodies prefer content:encoded/Atom content. Linked pages are
    // never fetched for feed_only sources.
    const bodyMarkup =
      rawTag(block, ["content:encoded", "content"]) || descriptionMarkup;
    const summary = plainText(descriptionMarkup || bodyMarkup);
    const author = tag(block, ["author", "dc:creator", "name"]);
    const publishedAt =
      tag(block, ["pubDate", "published", "updated", "dc:date"]) ||
      new Date().toISOString();
    const idSource = `${canonicalUrl}|${title}`;
    const id = `feed-${simpleHash(idSource)}`;

    documents.push(createFeedDocument({
      contentItemId: id,
      canonicalUrl,
      title,
      author,
      bodyMarkup,
      summary,
    }));

    return {
      id,
      kind: "blog" as const,
      title,
      summary,
      authors: author ? [author] : [feedTitle],
      sourceName: feedTitle,
      canonicalUrl,
      publishedAt: safeIsoDate(publishedAt),
      accessLevel: "feed_content" as const,
      peerReviewState: "unknown" as const,
      topics: inferTopics(`${title} ${summary}`),
      citationCount: 0,
      readingMinutes: Math.max(2, Math.ceil(summary.split(/\s+/).length / 220)),
      sourceAuthority: 0.78,
    };
  });

  return { title: feedTitle, items, documents };
}

export type FetchFeedOptions = {
  signal?: AbortSignal;
  /** Test seam; production always defaults to the SSRF-safe pinned downloader. */
  fetchBytes?: typeof safeFetchBytes;
};

export async function fetchFeed(
  feedUrl: string,
  options: FetchFeedOptions = {},
): Promise<ParsedFeed> {
  try {
    const response: BoundedHttpResponse = await (options.fetchBytes ?? safeFetchBytes)(
      feedUrl,
      {
        allowedMediaTypes: ["feed"],
        limits: { maxHtmlBytes: MAX_FEED_BYTES },
        signal: options.signal,
        userAgent: "KernelZero/1.0 feed reader",
      },
    );
    return parseFeed(new TextDecoder().decode(response.body), response.resolvedUrl);
  } catch (error) {
    if (
      error instanceof SourceExtractionError &&
      error.code === "response_too_large"
    ) {
      throw new Error("Feed is larger than the 5 MB ingestion limit.", {
        cause: error,
      });
    }
    throw error;
  }
}

function safeIsoDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString()
    : parsed.toISOString();
}

function inferTopics(text: string): string[] {
  const value = text.toLowerCase();
  const dictionary: Array<[string, string[]]> = [
    ["AI agents", ["agent", "tool use", "planning"]],
    ["Efficient models", ["quantization", "inference", "efficient model"]],
    ["Robotics", ["robot", "embodied", "vision-language-action"]],
    ["Infrastructure", ["cloud", "database", "infrastructure", "observability"]],
    ["Security", ["security", "vulnerability", "attack"]],
  ];
  const matches = dictionary
    .filter(([, terms]) => terms.some((term) => value.includes(term)))
    .map(([topic]) => topic);
  return matches.length ? matches.slice(0, 3) : ["Technology"];
}

export function simpleHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
