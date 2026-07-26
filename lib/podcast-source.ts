import type { ContentItem } from "./types";

const TOTAL_SOURCE_CHARACTER_BUDGET = 18_000;
const MIN_SOURCE_CHARACTER_BUDGET = 3_000;

function sourceExcerpt(summary: string, itemCount: number): {
  text: string;
  truncated: boolean;
} {
  const limit = Math.max(
    MIN_SOURCE_CHARACTER_BUDGET,
    Math.floor(TOTAL_SOURCE_CHARACTER_BUDGET / Math.max(1, itemCount)),
  );
  if (summary.length <= limit) return { text: summary, truncated: false };

  const candidate = summary.slice(0, limit);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("? "),
    candidate.lastIndexOf("! "),
  );
  const text = sentenceEnd >= limit * 0.7
    ? candidate.slice(0, sentenceEnd + 1)
    : candidate;
  return {
    text: `${text.trim()} [Source excerpt ends here.]`,
    truncated: true,
  };
}

/**
 * Keeps local-model prompts inside their configured context window. Feed items
 * can contain entire articles (tens of thousands of characters), which used to
 * crowd out the requested script and produce a one-paragraph response.
 */
export function podcastSourcePacket(items: ContentItem[]) {
  return items.map((item, index) => {
    const excerpt = sourceExcerpt(item.summary, items.length);
    return {
      source: index + 1,
      title: item.title,
      authors: item.authors,
      sourceName: item.sourceName,
      url: item.canonicalUrl,
      publicationDate: item.publishedAt,
      accessLevel: item.accessLevel,
      peerReviewState: item.peerReviewState,
      abstractOrFeedText: excerpt.text,
      sourceTextTruncated: excerpt.truncated,
    };
  });
}

export function podcastVerificationSources(items: ContentItem[]) {
  return podcastSourcePacket(items).map((item) => ({
    title: item.title,
    summary: item.abstractOrFeedText,
    peerReviewState: item.peerReviewState,
  }));
}
