export const MAX_OLLAMA_PODCAST_SOURCES = 5;

export function uniquePodcastSourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export function limitPodcastSourceIds(
  ids: readonly string[],
  limit = MAX_OLLAMA_PODCAST_SOURCES,
): { itemIds: string[]; omittedCount: number } {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : 0;
  return {
    itemIds: ids.slice(0, normalizedLimit),
    omittedCount: Math.max(0, ids.length - normalizedLimit),
  };
}
