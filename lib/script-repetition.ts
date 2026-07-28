import { splitNarrationSentences } from "./sentence-segmentation";

export type RepeatedParagraph = {
  earlierParagraph: number;
  laterParagraph: number;
  similarity: number;
  containment: number;
};

function paragraphTokens(paragraph: string): Set<string> {
  return new Set(
    paragraph
      .toLocaleLowerCase("en-US")
      .replace(/[^\p{L}\p{N}'’-]+/gu, " ")
      .split(/\s+/)
      .map((token) => token.replace(/[’']/g, "'").trim())
      .filter((token) => token.length > 2),
  );
}

const SEMANTIC_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "because",
  "before",
  "being",
  "both",
  "could",
  "from",
  "have",
  "into",
  "more",
  "only",
  "other",
  "same",
  "sections",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "those",
  "through",
  "using",
  "with",
  "would",
]);

function semanticTokens(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase("en-US")
      .replace(/[^\p{L}\p{N}'’-]+/gu, " ")
      .split(/\s+/)
      .map((token) => token.replace(/[’']/g, "'").trim())
      .filter((token) => token.length > 3 && !SEMANTIC_STOP_WORDS.has(token))
      .map((token) => (token.length > 7 ? token.slice(0, 7) : token)),
  );
}

function semanticContainment(left: string, right: string): {
  score: number;
  shared: number;
} {
  const leftTokens = semanticTokens(left);
  const rightTokens = semanticTokens(right);
  if (!leftTokens.size || !rightTokens.size) return { score: 0, shared: 0 };

  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return {
    score: shared / Math.min(leftTokens.size, rightTokens.size),
    shared,
  };
}

/**
 * Removes one sentence only when it has a clear lexical match to a supplied
 * semantic repetition description.
 */
export function removeClosestRepeatedSentence(
  script: string,
  repeatedIdea: string,
): string | null {
  const sentences = splitNarrationSentences(script);
  if (sentences.length < 2) return null;

  let bestIndex = -1;
  let bestScore = 0;
  let bestShared = 0;
  for (const [index, sentence] of sentences.entries()) {
    const { score, shared } = semanticContainment(sentence, repeatedIdea);
    if (score > bestScore || (score === bestScore && shared > bestShared)) {
      bestIndex = index;
      bestScore = score;
      bestShared = shared;
    }
  }
  if (bestIndex < 0 || bestShared < 2 || bestScore < 0.35) return null;

  sentences.splice(bestIndex, 1);
  return sentences.join(" ").trim();
}

function normalizedSentence(sentence: string): string {
  return sentence
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Removes exact or high-confidence near-verbatim sentences already present in
 * another section. Returns null when no safe deterministic match exists.
 */
export function removeRepeatedSentencesAgainstReference(
  targetScript: string,
  referenceScript: string,
): string | null {
  const targetSentences = splitNarrationSentences(targetScript);
  const referenceSentences = splitNarrationSentences(referenceScript);
  if (!targetSentences.length || !referenceSentences.length) return null;

  const referenceNormalized = new Set(
    referenceSentences.map(normalizedSentence),
  );
  const kept = targetSentences.filter((sentence) => {
    if (referenceNormalized.has(normalizedSentence(sentence))) return false;
    return !referenceSentences.some((reference) => {
      const { score, shared } = semanticContainment(sentence, reference);
      return shared >= 4 && score >= 0.78;
    });
  });
  if (kept.length === targetSentences.length) return null;
  return kept.join(" ").trim();
}

/**
 * A deterministic last line of defense for blatant paragraph duplication.
 * This check is deliberately high-confidence so normal callbacks and topic
 * continuity do not block an episode.
 */
export function findRepeatedParagraphs(script: string): RepeatedParagraph[] {
  const paragraphs = script
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const tokenSets = paragraphs.map(paragraphTokens);
  const issues: RepeatedParagraph[] = [];

  for (let earlier = 0; earlier < tokenSets.length; earlier += 1) {
    for (let later = earlier + 1; later < tokenSets.length; later += 1) {
      const left = tokenSets[earlier];
      const right = tokenSets[later];
      if (Math.min(left.size, right.size) < 25) continue;

      let shared = 0;
      for (const token of left) {
        if (right.has(token)) shared += 1;
      }
      const similarity = shared / (left.size + right.size - shared);
      const containment = shared / Math.min(left.size, right.size);
      const broadNearCopy =
        shared >= 45 && similarity >= 0.55 && containment >= 0.72;
      if (similarity >= 0.62 || containment >= 0.82 || broadNearCopy) {
        issues.push({
          earlierParagraph: earlier + 1,
          laterParagraph: later + 1,
          similarity,
          containment,
        });
      }
    }
  }
  return issues;
}

export function repetitionFailureMessage(
  issues: RepeatedParagraph[],
): string {
  const details = issues
    .slice(0, 4)
    .map(
      (issue) =>
        `paragraph ${issue.laterParagraph} repeats paragraph ${issue.earlierParagraph} (${Math.round(Math.max(issue.similarity, issue.containment) * 100)}% overlap)`,
    )
    .join("; ");
  return `Repetition verification failed: ${details}. Rewrite repeated paragraphs with new, section-specific material.`;
}
