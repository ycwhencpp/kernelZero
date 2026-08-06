import type { ContentItem, Episode } from "./types";

export const LINKEDIN_POST_MAX_CHARACTERS = 3_000;
export const LINKEDIN_SOURCE_CTA_MAX_CHARACTERS = 180;

export type LinkedInPostSource = {
  name: string;
  url: string;
};

export type LinkedInPostParts = {
  content: string;
  sourceCta: string | null;
  sourceFooter: string | null;
};

const LINKEDIN_POST_SOURCE_PATTERN =
  /(?:^|\n\n)(Want to [^\n]{1,500}\?)\n\nSource: ([^\n]+)\n(https?:\/\/[^\s\n]+)(?=\n\n|$)/u;
const LINKEDIN_POST_UNTRUSTED_SOURCE_PATTERN =
  /https?:\/\/|(?:^|\n)\s*Source\s*:/iu;
const LINKEDIN_SOURCE_CTA_LINK_PATTERN =
  /\b(?:[a-z][a-z0-9+.-]*:\/\/|(?:mailto|tel|data|javascript):|www\.)/iu;
const LINKEDIN_SOURCE_CTA_BARE_DOMAIN_PATTERN =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:(?:[a-z]{2,63})(?=\/)|(?:com|org|net|edu|gov|io|ai|co|dev|app|tech|info|biz|xyz|me|in|uk|us|ca|au|de|fr|jp|cn)(?=\/|[?#\s),.!;:]|$))(?:\/[^\s]*)?/iu;
const GENERIC_SOURCE_CTA_PATTERN =
  /^want to (?:know|learn|read|find out|discover|explore) more(?: about (?:it|this|this topic))?\?$/iu;

function webUrl(value: string): string | null {
  const candidate = value.trim();
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function comparableWebUrl(value: string): string | null {
  const normalized = webUrl(value);
  if (!normalized) return null;

  const url = new URL(normalized);
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString().replace(/%[\dA-F]{2}/gi, (encoded) => {
    const character = String.fromCharCode(Number.parseInt(encoded.slice(1), 16));
    return /^[A-Za-z0-9._~-]$/u.test(character)
      ? character
      : encoded.toUpperCase();
  });
}

/** Resolve one stable, trusted source for a generated post. */
export function primaryLinkedInPostSource(
  episode: Pick<Episode, "citations" | "contentItemId">,
  items: readonly ContentItem[],
): LinkedInPostSource | null {
  let citation: Episode["citations"][number] | undefined;
  let citationUrl: string | null = null;
  for (const candidate of episode.citations) {
    const url = webUrl(candidate.url);
    if (!url) continue;
    citation = candidate;
    citationUrl = url;
    break;
  }

  const citationIdentity = citationUrl
    ? comparableWebUrl(citationUrl)
    : null;
  const citedItem = citationIdentity
    ? items.find(
        (item) =>
          comparableWebUrl(item.canonicalUrl) === citationIdentity,
      )
    : undefined;
  const contentItem = episode.contentItemId
    ? items.find((item) => item.id === episode.contentItemId)
    : undefined;
  const item = citedItem ?? (citation ? undefined : contentItem);
  const url = citationUrl ?? webUrl(item?.canonicalUrl ?? "");
  if (!url) return null;

  const name = [item?.sourceName, citation?.title, item?.title]
    .map((candidate) => candidate?.replace(/\s+/g, " ").trim())
    .find(Boolean);
  return name ? { name, url } : null;
}

export function splitLinkedInPostSource(post: string): LinkedInPostParts {
  let content = post.replace(/\r\n?/g, "\n");
  let sourceCta: string | null = null;
  let sourceFooter: string | null = null;
  let match = LINKEDIN_POST_SOURCE_PATTERN.exec(content);

  // Strip every canonical footer so generated or submitted text can never
  // accumulate more than the one trusted footer appended by the application.
  while (match && match.index !== undefined) {
    const matchedBlock = match[0].startsWith("\n\n")
      ? match[0].slice(2)
      : match[0];
    const candidateCta = match[1].trim();
    if (normalizeLinkedInSourceCta(candidateCta)) {
      // Prefer the last valid contextual CTA. Canonical composition always puts
      // the application-owned footer last, while legacy generic CTAs stay ignored.
      sourceCta = candidateCta;
      sourceFooter = matchedBlock;
    } else {
      sourceCta ??= candidateCta;
      sourceFooter ??= matchedBlock;
    }

    const before = content.slice(0, match.index);
    let after = content.slice(match.index + match[0].length);
    if (!before && after.startsWith("\n\n")) after = after.slice(2);
    content = `${before}${after}`;
    match = LINKEDIN_POST_SOURCE_PATTERN.exec(content);
  }

  return { content, sourceCta, sourceFooter };
}

export function normalizeLinkedInSourceCta(value: unknown): string | null {
  if (typeof value !== "string" || /[\r\n]|\\[rn]/u.test(value)) return null;
  const cta = value.replace(/\s+/g, " ").trim();
  if (
    cta.length < 20 ||
    cta.length > LINKEDIN_SOURCE_CTA_MAX_CHARACTERS ||
    !/^Want to .+\?$/u.test(cta) ||
    GENERIC_SOURCE_CTA_PATTERN.test(cta) ||
    /\bSource\s*:/iu.test(cta) ||
    /#[\p{L}\p{N}_]+/u.test(cta) ||
    LINKEDIN_SOURCE_CTA_LINK_PATTERN.test(cta) ||
    LINKEDIN_SOURCE_CTA_BARE_DOMAIN_PATTERN.test(cta) ||
    containsLinkedInPostSourceReference(cta)
  ) {
    return null;
  }
  return cta;
}

export function fallbackLinkedInSourceCta(title: string): string {
  const safeFallback =
    "Want to explore the topic covered in this episode in more detail?";
  const subject = title
    .replace(/[\r\n]+/g, " ")
    .replace(/https?:\/\/\S+/giu, "")
    .replace(/\bSource\s*:/giu, "Source")
    .replace(/#[\p{L}\p{N}_]+/gu, "")
    .replace(/\s+/g, " ")
    .replace(/[?!.]+$/u, "")
    .replaceAll('"', "'")
    .trim()
    .slice(0, 110);
  const contextualSubject = subject || "the topic covered in this episode";
  const cta = `Want to explore ${contextualSubject} in more detail?`;
  return normalizeLinkedInSourceCta(cta) ?? safeFallback;
}

/** Preserve a generated CTA, upgrading legacy generic footers from the episode title. */
export function resolveLinkedInSourceCta(
  persistedPost: string | null | undefined,
  title: string,
): string {
  const persistedCta = persistedPost
    ? splitLinkedInPostSource(persistedPost).sourceCta
    : null;
  return (
    normalizeLinkedInSourceCta(persistedCta) ??
    fallbackLinkedInSourceCta(title)
  );
}

export function appendLinkedInPostSource(
  post: string,
  source: LinkedInPostSource,
  sourceCta: string,
): string {
  const content = splitLinkedInPostSource(post).content.trim();
  const name = source.name.replace(/\s+/g, " ").trim();
  const url = webUrl(source.url);
  const cta = normalizeLinkedInSourceCta(sourceCta);
  if (!content || !name || !url || !cta) {
    throw new Error("A valid LinkedIn post source footer is required.");
  }

  return [
    content,
    cta,
    `Source: ${name}\n${url}`,
  ].join("\n\n");
}

export function containsLinkedInPostSourceReference(content: string): boolean {
  return LINKEDIN_POST_UNTRUSTED_SOURCE_PATTERN.test(content);
}

/** Replace only editable copy while preserving the trusted, read-only footer. */
export function replaceLinkedInPostContent(
  post: string,
  content: string,
): string {
  const sourceFooter = splitLinkedInPostSource(post).sourceFooter;
  const safeContent = splitLinkedInPostSource(content).content;
  if (!sourceFooter) return safeContent;
  return safeContent ? `${safeContent}\n\n${sourceFooter}` : sourceFooter;
}

/** Count only authored post copy; the canonical source footer is metadata. */
export function linkedInPostCharacterCount(post: string): number {
  return splitLinkedInPostSource(post).content.trim().length;
}
