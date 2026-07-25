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
