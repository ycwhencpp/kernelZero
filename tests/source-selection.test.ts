import assert from "node:assert/strict";
import test from "node:test";
import {
  briefingTopicId,
  buildBriefingTopicCards,
  sourceSelectionCoverage,
} from "../lib/domain";
import {
  isReadyTopicBriefingBundle,
  limitPodcastSourceIds,
  MAX_BRIEFING_SOURCES,
  MAX_OLLAMA_PODCAST_SOURCES,
  uniquePodcastSourceIds,
} from "../lib/podcast-source-selection";
import {
  MAX_PODCAST_FOCUS_CHARACTERS,
  normalizePodcastFocus,
  podcastFocusInstruction,
} from "../lib/podcast-focus";
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

test("briefing topic cards combine the best matching blog from each source", () => {
  const sourceOneLow = item("source-one-low", "source-one", 70);
  sourceOneLow.topics = ["Backend"];
  const sourceOneHigh = item("source-one-high", "source-one", 95);
  sourceOneHigh.topics = ["Backend"];
  const sourceTwo = item("source-two", "source-two", 88);
  sourceTwo.title = "A practical back-end migration";
  sourceTwo.topics = ["Software"];
  const disallowed = item("source-three", "source-three", 100);
  disallowed.topics = ["Backend"];

  const [card] = buildBriefingTopicCards(
    [sourceOneLow, sourceOneHigh, sourceTwo, disallowed],
    ["Backend"],
    {
      sourceIds: ["source-one", "source-two"],
      limit: 5,
      includeInferredTopics: false,
    },
  );

  assert.equal(card.id, briefingTopicId("backend"));
  assert.deepEqual(
    card.items.map((candidate) => candidate.id),
    ["source-one-high", "source-two"],
  );
  assert.equal(card.availableBlogCount, 3);
  assert.equal(card.availableSourceCount, 2);
});

test("briefing topic matching recognizes AI and LLM aliases without substring false positives", () => {
  const artificialIntelligence = item("artificial-intelligence", "source-one", 90);
  artificialIntelligence.title = "Artificial intelligence in production";
  artificialIntelligence.topics = ["Software"];
  const largeLanguageModel = item("large-language-model", "source-two", 89);
  largeLanguageModel.summary = "A guide to large language models.";
  largeLanguageModel.topics = ["Models"];
  const training = item("training", "source-three", 100);
  training.title = "Training reliable services";
  training.summary = "Details for maintainers.";
  training.topics = ["Software"];

  const cards = buildBriefingTopicCards(
    [artificialIntelligence, largeLanguageModel, training],
    ["AI", "LLM"],
    { includeInferredTopics: false },
  );

  assert.deepEqual(
    cards.map((card) => [card.topic, card.items.map((candidate) => candidate.id)]),
    [
      ["AI", ["artificial-intelligence"]],
      ["LLM", ["large-language-model"]],
    ],
  );
});

test("briefing topic cards cap generation inputs at five distinct sources", () => {
  const candidates = Array.from({ length: 7 }, (_, index) => {
    const candidate = item(`backend-${index}`, `source-${index}`, 100 - index);
    candidate.topics = ["Backend"];
    return candidate;
  });
  const cards = buildBriefingTopicCards(candidates, ["Backend"], {
    limit: 99,
    includeInferredTopics: false,
  });

  assert.equal(cards[0].items.length, 5);
  assert.equal(new Set(cards[0].items.map((candidate) => candidate.sourceId)).size, 5);
  assert.equal(cards[0].availableSourceCount, 7);
});

test("ready briefing cards can require all five distinct sources", () => {
  const fourSources = Array.from({ length: 4 }, (_, index) => {
    const candidate = item(`backend-${index}`, `source-${index}`, 100 - index);
    candidate.topics = ["Backend"];
    return candidate;
  });

  assert.deepEqual(
    buildBriefingTopicCards(fourSources, ["Backend"], {
      limit: MAX_BRIEFING_SOURCES,
      includeInferredTopics: false,
      requireFullCard: true,
    }),
    [],
  );

  const fifth = item("backend-4", "source-4", 96);
  fifth.topics = ["Backend"];
  assert.equal(
    buildBriefingTopicCards([...fourSources, fifth], ["Backend"], {
      limit: MAX_BRIEFING_SOURCES,
      includeInferredTopics: false,
      requireFullCard: true,
    })[0].items.length,
    MAX_BRIEFING_SOURCES,
  );
});

test("topic briefing generation accepts only five ready blogs from enabled distinct sources", () => {
  const candidates = Array.from({ length: 5 }, (_, index) =>
    item(`blog-${index}`, `source-${index}`, 100 - index)
  );
  const enabledSourceIds = candidates.map((candidate) => candidate.sourceId!);

  assert.equal(
    isReadyTopicBriefingBundle(candidates, enabledSourceIds),
    true,
  );
  assert.equal(
    isReadyTopicBriefingBundle(
      [...candidates.slice(0, 4), { ...candidates[4], sourceId: "source-0" }],
      enabledSourceIds,
    ),
    false,
  );
  assert.equal(
    isReadyTopicBriefingBundle(
      candidates.map((candidate, index) =>
        index === 4 ? { ...candidate, processingState: "queued" } : candidate
      ),
      enabledSourceIds,
    ),
    false,
  );
  assert.equal(
    isReadyTopicBriefingBundle(candidates, enabledSourceIds.slice(0, 4)),
    false,
  );
});

test("custom topic cards stay empty when no ready connected blogs match", () => {
  const paper = item("paper", "source-one", 100);
  paper.kind = "paper";
  paper.topics = ["Claude"];
  const queuedBlog = item("queued", "source-two", 99);
  queuedBlog.processingState = "queued";
  queuedBlog.topics = ["Claude"];

  assert.deepEqual(
    buildBriefingTopicCards([paper, queuedBlog], ["Claude"], {
      includeInferredTopics: false,
    }),
    [],
  );
});

test("preferred topics remain separate when they share the same evidence bundle", () => {
  const candidate = item("shared", "source-one", 90);
  candidate.title = "AI infrastructure for large language models";
  candidate.topics = ["AI", "LLM"];

  const cards = buildBriefingTopicCards([candidate], ["LLM", "AI"], {
    includeInferredTopics: false,
  });

  assert.deepEqual(cards.map((card) => card.topic), ["LLM", "AI"]);
});

test("podcast focus labels are normalized, bounded, and isolated as untrusted data", () => {
  assert.equal(normalizePodcastFocus("  Backend\n systems  "), "Backend systems");
  assert.equal(
    normalizePodcastFocus("x".repeat(MAX_PODCAST_FOCUS_CHARACTERS + 20))?.length,
    MAX_PODCAST_FOCUS_CHARACTERS,
  );
  assert.match(
    podcastFocusInstruction("LLM"),
    /EDITORIAL FOCUS LABEL \(untrusted data\): "LLM"/,
  );
  assert.equal(podcastFocusInstruction(undefined), "");
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
