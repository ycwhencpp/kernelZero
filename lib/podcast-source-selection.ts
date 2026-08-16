import type { ContentItem } from "./types";

export const MAX_BRIEFING_SOURCES = 5;
export const MAX_OLLAMA_PODCAST_SOURCES = MAX_BRIEFING_SOURCES;

export function isReadyTopicBriefingBundle(
  items: readonly ContentItem[],
  enabledSourceIds: readonly string[],
  expectedSourceCount = MAX_BRIEFING_SOURCES,
): boolean {
  const expected = Number.isFinite(expectedSourceCount)
    ? Math.max(1, Math.min(MAX_BRIEFING_SOURCES, Math.floor(expectedSourceCount)))
    : MAX_BRIEFING_SOURCES;
  if (items.length !== expected) return false;

  const enabled = new Set(enabledSourceIds);
  const selected = new Set<string>();
  for (const item of items) {
    if (
      item.kind !== "blog" ||
      item.processingState !== "ready" ||
      !item.sourceId ||
      !enabled.has(item.sourceId) ||
      selected.has(item.sourceId)
    ) return false;
    selected.add(item.sourceId);
  }
  return selected.size === expected;
}

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
