import type { NormalizedCandidate } from "./types";

type ParsedFeed = {
  title: string;
  items: NormalizedCandidate[];
};

const MAX_FEED_BYTES = 2_000_000;

function decodeEntities(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, names: string[]): string {
  for (const name of names) {
    const expression = new RegExp(
      `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,
      "i",
    );
    const match = block.match(expression);
    if (match?.[1]) return decodeEntities(match[1]);
  }
  return "";
}

function attribute(block: string, tagName: string, attributeName: string): string {
  const expression = new RegExp(
    `<${tagName}\\s[^>]*${attributeName}=["']([^"']+)["'][^>]*\\/?>`,
    "i",
  );
  return decodeEntities(block.match(expression)?.[1] ?? "");
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

  const items = blocks.slice(0, 30).map((block, index) => {
    const title = tag(block, ["title"]) || "Untitled feed item";
    const canonicalUrl =
      tag(block, ["link", "guid"]) ||
      attribute(block, "link", "href") ||
      `${feedUrl}#item-${index}`;
    const summary = tag(block, [
      "description",
      "summary",
      "content",
      "content:encoded",
    ]);
    const author = tag(block, ["author", "dc:creator", "name"]);
    const publishedAt =
      tag(block, ["pubDate", "published", "updated", "dc:date"]) ||
      new Date().toISOString();
    const idSource = `${canonicalUrl}|${title}`;
    const id = `feed-${simpleHash(idSource)}`;

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

  return { title: feedTitle, items };
}

export async function fetchFeed(feedUrl: string): Promise<ParsedFeed> {
  const response = await fetch(feedUrl, {
    headers: {
      Accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml",
      "User-Agent": "SignalCast/1.0 feed reader",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Feed returned ${response.status}`);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_FEED_BYTES) {
    throw new Error("Feed is larger than the 2 MB ingestion limit.");
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_FEED_BYTES) {
    throw new Error("Feed is larger than the 2 MB ingestion limit.");
  }

  return parseFeed(new TextDecoder().decode(bytes), feedUrl);
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
