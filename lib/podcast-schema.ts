export type PodcastDraft = {
  title: string;
  dek: string;
  script: string;
  showNotes: string;
  chapters: Array<{ title: string; startSeconds: number; scriptStart?: number }>;
  claims: Array<{
    claim: string;
    support: string;
    confidence: number;
    location: string;
    /** One-based index into the ordered source list. */
    sourceNumber?: number;
  }>;
};

export type PodcastSection = {
  script: string;
  claims: PodcastDraft["claims"];
};

/** Resolves new explicit source ownership while preserving legacy claim order. */
export function podcastClaimSourceIndex(
  claim: Pick<PodcastDraft["claims"][number], "sourceNumber">,
  legacyClaimIndex: number,
  sourceCount: number,
): number {
  if (!Number.isInteger(sourceCount) || sourceCount < 1) {
    throw new Error("Podcast claims require at least one source.");
  }
  const sourceNumber = Number(claim.sourceNumber);
  return Number.isInteger(sourceNumber) &&
      sourceNumber >= 1 &&
      sourceNumber <= sourceCount
    ? sourceNumber - 1
    : Math.min(Math.max(0, legacyClaimIndex), sourceCount - 1);
}

export function normalizeEvidenceConfidence(value: unknown): number {
  const confidence = Number(value);
  if (!Number.isFinite(confidence) || confidence < 0) return 0;
  if (confidence <= 1) return confidence;
  if (confidence <= 100) return confidence / 100;
  return 0;
}

export function podcastSchema() {
  return {
    type: "object",
    properties: {
      title: { type: "string" },
      dek: { type: "string" },
      script: { type: "string" },
      showNotes: { type: "string" },
      chapters: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            startSeconds: { type: "integer" },
          },
          required: ["title", "startSeconds"],
        },
      },
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            support: { type: "string" },
            confidence: { type: "number" },
            location: { type: "string" },
          },
          required: ["claim", "support", "confidence", "location"],
        },
      },
    },
    required: ["title", "dek", "script", "showNotes", "chapters", "claims"],
  };
}

export function podcastSectionSchema() {
  return {
    type: "object",
    properties: {
      script: { type: "string" },
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string" },
            support: { type: "string" },
            confidence: { type: "number" },
            location: { type: "string" },
          },
          required: ["claim", "support", "confidence", "location"],
        },
      },
    },
    required: ["script", "claims"],
  };
}
