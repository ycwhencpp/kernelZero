/**
 * Retired: generation now hydrates only the selected sources through the
 * owner-scoped content_documents cache. Keeping the old eager crawler would
 * bypass rights checks, SSRF protection, byte limits, and structured blocks.
 */
throw new Error(
  "fetch_empty.ts is retired. Generate an episode to hydrate its selected sources lazily.",
);
