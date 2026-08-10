import assert from "node:assert/strict";
import test from "node:test";
import { sourceSelectionCoverage } from "../lib/domain";
import {
  limitPodcastSourceIds,
  MAX_OLLAMA_PODCAST_SOURCES,
  uniquePodcastSourceIds,
} from "../lib/podcast-source-selection";
import { loadAllPaginatedRows } from "../lib/supabase-pagination";
import type { ContentItem } from "../lib/types";

function item(
  id: string,
  sourceId: string | undefined,
  score: number,
): ContentItem {
  return {
    id,
    kind: "blog",
    title: id,
    summary: `${id} summary`,
    authors: ["KernelZero"],
    sourceName: sourceId ?? "Discovery",
    sourceId,
    canonicalUrl: `https://example.com/${id}`,
    publishedAt: "2026-08-06T00:00:00.000Z",
    accessLevel: "feed_content",
    peerReviewState: "unknown",
    topics: ["AI"],
    score,
    trend: "latest",
    citationCount: 0,
    readingMinutes: 2,
    saved: false,
    listened: false,
    processingState: "ready",
  };
}

test("paginated workspace loading includes rows beyond Supabase's first page", async () => {
  const rows = Array.from({ length: 1_236 }, (_, index) => ({
    id: `item-${index}`,
    sourceId: index === 1_200 ? "late-source" : "early-source",
  }));
  const requestedRanges: Array<[number, number]> = [];

  const result = await loadAllPaginatedRows((from, to) => {
    requestedRanges.push([from, to]);
    return Promise.resolve({
      data: rows.slice(from, to + 1),
      error: null,
    });
  });

  assert.equal(result.error, null);
  assert.equal(result.data.length, 1_236);
  assert.equal(result.data.some((row) => row.sourceId === "late-source"), true);
  assert.deepEqual(requestedRanges, [
    [0, 999],
    [1_000, 1_999],
  ]);
});

test("source coverage separates selected, ready, and unavailable sources", () => {
  const selection = sourceSelectionCoverage(
    [
      item("source-one-low", "source-one", 70),
      item("source-one-high", "source-one", 95),
      item("source-two", "source-two", 80),
      item("unlinked-discovery", undefined, 100),
    ],
    ["source-one", "source-two", "source-three"],
  );

  assert.equal(selection.selectedSourceCount, 3);
  assert.equal(selection.readySourceCount, 2);
  assert.equal(selection.unavailableSourceCount, 1);
  assert.deepEqual(
    selection.selectedItems.map((candidate) => candidate.id),
    ["source-one-high", "source-two"],
  );
});

test("source coverage has no hidden cap when every selected source is ready", () => {
  const sourceIds = Array.from(
    { length: 134 },
    (_, index) => `source-${index}`,
  );
  const selection = sourceSelectionCoverage(
    sourceIds.map((sourceId, index) => item(`item-${index}`, sourceId, 80)),
    sourceIds,
  );

  assert.equal(selection.selectedSourceCount, 134);
  assert.equal(selection.readySourceCount, 134);
  assert.equal(selection.unavailableSourceCount, 0);
  assert.equal(selection.selectedItems.length, 134);
});

test("Ollama source request normalization deduplicates IDs without reordering them", () => {
  assert.deepEqual(
    uniquePodcastSourceIds([
      "source-three",
      "source-one",
      "source-three",
      " ",
      null,
      "source-two",
    ]),
    ["source-three", "source-one", "source-two"],
  );
});

test("legacy Ollama regeneration retains the first five unique source IDs", () => {
  const sourceIds = Array.from({ length: 7 }, (_, index) => `source-${index + 1}`);
  const limited = limitPodcastSourceIds(sourceIds);

  assert.equal(MAX_OLLAMA_PODCAST_SOURCES, 5);
  assert.deepEqual(limited.itemIds, sourceIds.slice(0, 5));
  assert.equal(limited.omittedCount, 2);
  assert.deepEqual(
    limitPodcastSourceIds(sourceIds.slice(0, 5)),
    { itemIds: sourceIds.slice(0, 5), omittedCount: 0 },
  );
});
