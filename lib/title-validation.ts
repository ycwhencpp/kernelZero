import type { EpisodeGenerationWarning } from "./types";

export const TITLE_VALIDATION_FAILED_WARNING: EpisodeGenerationWarning =
  "title_validation_failed";

const GENERIC_TITLE_WORDS = new Set([
  "about",
  "after",
  "against",
  "agent",
  "agents",
  "artificial",
  "before",
  "briefing",
  "build",
  "building",
  "deep",
  "dive",
  "episode",
  "explained",
  "future",
  "guide",
  "inside",
  "intelligence",
  "latest",
  "local",
  "model",
  "models",
  "new",
  "podcast",
  "research",
  "system",
  "systems",
  "technology",
  "using",
]);

const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "their",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "why",
  "with",
  "your",
]);

function normalizedTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Returns the distinctive title terms used by the deterministic alignment
 * check. Generic podcast framing cannot make an otherwise unrelated title
 * appear valid merely because words such as "episode" or "research" recur.
 */
export function titleValidationTerms(title: string): string[] {
  return [
    ...new Set(
      normalizedTokens(title).filter(
        (token) =>
          token.length >= 3 &&
          !TITLE_STOP_WORDS.has(token) &&
          !GENERIC_TITLE_WORDS.has(token),
      ),
    ),
  ];
}

export type TitleValidationResult = {
  valid: boolean;
  terms: string[];
  recurringTerms: string[];
};

/**
 * A title is aligned when enough of its distinctive terms recur in the final
 * script. Requiring recurrence prevents a detail mentioned once in passing
 * from validating a narrowly framed title.
 */
export function validateEpisodeTitle(
  title: string,
  script: string | readonly string[],
): TitleValidationResult {
  const terms = titleValidationTerms(title);
  const segments = (typeof script === "string"
    ? script.split(/\n{2,}/)
    : script)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const segmentCounts = segments.map((segment) => {
    const counts = new Map<string, number>();
    for (const token of normalizedTokens(segment)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
  });
  const recurringTerms = terms.filter((term) => {
    const totalMentions = segmentCounts.reduce(
      (total, counts) => total + (counts.get(term) ?? 0),
      0,
    );
    const coveredSegments = segmentCounts.filter(
      (counts) => (counts.get(term) ?? 0) > 0,
    ).length;
    return (
      totalMentions >= 2 &&
      (segmentCounts.length < 2 || coveredSegments >= 2)
    );
  });
  const requiredRecurringTerms =
    terms.length <= 1
      ? terms.length
      : Math.min(
          terms.length,
          Math.max(2, Math.ceil(terms.length * 0.4)),
        );

  return {
    valid:
      Boolean(title.trim()) &&
      segments.length > 0 &&
      terms.length > 0 &&
      recurringTerms.length >= requiredRecurringTerms,
    terms,
    recurringTerms,
  };
}

export function episodeTitleGenerationWarning(
  title: string,
  script: string | readonly string[],
): EpisodeGenerationWarning | null {
  return validateEpisodeTitle(title, script).valid
    ? null
    : TITLE_VALIDATION_FAILED_WARNING;
}
