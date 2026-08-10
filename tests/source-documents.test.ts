import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createSupabaseSourceDocumentRepository,
  fallbackSourceDocument,
  hydratePodcastSources,
  isReusableSourceDocument,
  sourceDescriptor,
  sourceDocumentsToPodcastCorpus,
  sourceDocumentFromRow,
  sourceDocumentRow,
  storeSourceDocuments,
  type SourceDocumentRepository,
} from "../lib/source-documents";
import type { ContentItem, SourceDocument } from "../lib/types";

function contentItem(
  id: string,
  overrides: Partial<ContentItem> = {},
): ContentItem {
  return {
    id,
    kind: "paper",
    title: `Title ${id}`,
    summary: `Summary for ${id}. It contains source-backed detail.`,
    authors: ["Ada Lovelace"],
    sourceName: "Test source",
    canonicalUrl: `https://example.com/citation/${id}`,
    documentUrl: `https://example.com/document/${id}.pdf`,
    publishedAt: "2026-08-01T00:00:00.000Z",
    accessLevel: "open_access",
    peerReviewState: "peer_reviewed",
    topics: ["systems"],
    score: 90,
    trend: "latest",
    citationCount: 10,
    readingMinutes: 5,
    saved: false,
    listened: false,
    processingState: "ready",
    ...overrides,
  };
}

function sourceDocument(
  item: ContentItem,
  overrides: Partial<SourceDocument> = {},
): SourceDocument {
  return {
    schemaVersion: 1,
    contentItemId: item.id,
    canonicalUrl: item.canonicalUrl,
    retrievalUrl: item.documentUrl ?? item.canonicalUrl,
    resolvedUrl: item.documentUrl ?? item.canonicalUrl,
    format: "pdf",
    title: item.title,
    blocks: [{
      id: "b0001",
      order: 0,
      kind: "paragraph",
      text: `Extracted detail for ${item.id}.`,
      sectionPath: ["Results"],
      page: 2,
    }],
    status: "ready",
    stats: {
      rawBytes: 123,
      characters: 25,
      pages: 3,
      truncated: false,
    },
    extraction: {
      extractor: "unpdf",
      version: "source-extraction-v1",
      fetchedAt: "2026-08-08T00:00:00.000Z",
      contentHash: "abc",
      warnings: [],
    },
    ...overrides,
  };
}

test("cache rows preserve canonical plain-text document fields", () => {
  const item = contentItem("paper-a");
  const document = sourceDocument(item);
  const row = sourceDocumentRow("owner-a", document);
  assert.equal(row.owner_id, "owner-a");
  assert.deepEqual(row.blocks_json, document.blocks);
  assert.equal(row.character_count, 25);

  const mapped = sourceDocumentFromRow(row);
  assert.deepEqual(mapped, document);
});

test("cache reuse requires the current retrieval URL and extractor version", () => {
  const item = contentItem("paper-a");
  assert.equal(isReusableSourceDocument(sourceDocument(item), item), true);
  assert.equal(isReusableSourceDocument(sourceDocument(item, {
    retrievalUrl: "https://example.com/old.pdf",
  }), item), false);
  assert.equal(isReusableSourceDocument(sourceDocument(item, {
    extraction: {
      extractor: "unpdf",
      version: "source-extraction-v0",
      fetchedAt: "2026-08-08T00:00:00.000Z",
      warnings: [],
    },
  }), item), false);
  assert.equal(isReusableSourceDocument(sourceDocument(item, {
    extraction: {
      extractor: "unpdf",
      version: "source-extraction-v1",
      fetchedAt: "2026-08-08T00:00:00.000Z",
      warnings: [],
      errorCode: "timeout",
      retryAfter: new Date(Date.now() - 1_000).toISOString(),
    },
  }), item), false);
});

test("selected hydration reuses valid cache and preserves item order", async () => {
  const first = contentItem("paper-a");
  const second = contentItem("paper-b");
  const cachedFirst = sourceDocument(first);
  const staleSecond = sourceDocument(second, {
    retrievalUrl: "https://example.com/retired.pdf",
  });
  const saved: SourceDocument[][] = [];
  const repository: SourceDocumentRepository = {
    async load(ownerId, ids) {
      assert.equal(ownerId, "owner-a");
      assert.deepEqual(ids, ["paper-a", "paper-b"]);
      return [cachedFirst, staleSecond];
    },
    async save(ownerId, documents) {
      assert.equal(ownerId, "owner-a");
      saved.push([...documents]);
    },
  };

  const corpus = await hydratePodcastSources("owner-a", [first, second], {
    traceId: "test-cache-order",
    repository,
    async hydrateDocuments(descriptors, options) {
      assert.deepEqual(descriptors.map((descriptor) => descriptor.contentItemId), [
        "paper-a",
        "paper-b",
      ]);
      assert.deepEqual([...options!.cachedDocuments!.keys()], ["paper-a"]);
      // Deliberately return out of order; the adapter restores selected order.
      return [sourceDocument(second), cachedFirst];
    },
  });

  assert.deepEqual(corpus.sources.map((source) => source.contentItemId), [
    "paper-a",
    "paper-b",
  ]);
  assert.deepEqual(corpus.sources.map((source) => source.sourceNumber), [1, 2]);
  assert.deepEqual(corpus.sources.map((source) => source.blocks[0].id), [
    "paper-a:b0001",
    "paper-b:b0001",
  ]);
  assert.deepEqual(saved[0].map((document) => document.contentItemId), [
    "paper-a",
    "paper-b",
  ]);
});

test("rights-aware descriptors never retrieve feed-only or abstract-only URLs", () => {
  const feed = sourceDescriptor(contentItem("feed-a", {
    accessLevel: "feed_content",
    summary: "<p>Embedded body</p>",
  }));
  assert.equal(feed.retrievalPolicy, "feed_only");
  assert.equal(feed.retrievalUrl, undefined);
  assert.equal(feed.feedContentHtml, "<p>Embedded body</p>");

  const abstract = sourceDescriptor(contentItem("abstract-a", {
    accessLevel: "abstract_only",
  }));
  assert.equal(abstract.retrievalPolicy, "metadata_only");
  assert.equal(abstract.retrievalUrl, undefined);
});

test("bibliography blocks stay cached but are excluded from narration", () => {
  const item = contentItem("paper-references");
  const document = sourceDocument(item, {
    blocks: [
      {
        id: "result",
        order: 0,
        kind: "paragraph",
        text: "The measured result belongs in narration.",
        sectionPath: ["Results"],
      },
      {
        id: "references",
        order: 1,
        kind: "heading",
        text: "References",
        sectionPath: ["References"],
      },
      {
        id: "citation",
        order: 2,
        kind: "paragraph",
        text: "Example et al. 2025.",
        sectionPath: ["References"],
      },
    ],
  });
  const corpus = sourceDocumentsToPodcastCorpus([item], [document]);
  assert.deepEqual(
    corpus.sources[0].blocks.map((block) => block.id),
    ["paper-references:result"],
  );
  assert.equal(document.blocks.length, 3);
});

test("database and batch failures fall back per source without raw markup", async () => {
  const item = contentItem("feed-a", {
    accessLevel: "feed_content",
    summary: "<script>secret()</script><p>A cached feed fact.</p>",
  });
  let saveCalled = false;
  const corpus = await hydratePodcastSources("owner-a", [item], {
    traceId: "test-source-fallback",
    repository: {
      async load() {
        throw new Error("migration unavailable");
      },
      async save() {
        saveCalled = true;
        throw new Error("database unavailable");
      },
    },
    async hydrateDocuments() {
      throw new Error("batch timed out");
    },
  });

  assert.equal(saveCalled, true);
  assert.equal(corpus.sources.length, 1);
  assert.equal(corpus.sources[0].blocks[0].text, "A cached feed fact.");
  assert.equal(corpus.sources[0].blocks[0].text.includes("<"), false);
  assert.equal(corpus.sources[0].blocks[0].text.includes("secret"), false);
});

test("storeSourceDocuments persists feed extraction without hydration", async () => {
  const document = fallbackSourceDocument(contentItem("feed-a", {
    accessLevel: "feed_content",
  }));
  let storedOwner = "";
  let stored: readonly SourceDocument[] = [];
  await storeSourceDocuments("owner-a", [document], {
    traceId: "test-feed-store",
    repository: {
      async load() {
        throw new Error("load must not be called");
      },
      async save(ownerId, documents) {
        storedOwner = ownerId;
        stored = documents;
      },
    },
  });
  assert.equal(storedOwner, "owner-a");
  assert.deepEqual(stored, [document]);
});

test("Supabase cache reads and writes are owner scoped", async () => {
  const item = contentItem("paper-a");
  const document = sourceDocument(item);
  const calls: Array<unknown[]> = [];
  const loadQuery = {
    eq(column: string, value: string) {
      calls.push(["eq", column, value]);
      return this;
    },
    async in(column: string, values: string[]) {
      calls.push(["in", column, values]);
      return { data: [sourceDocumentRow("owner-a", document)], error: null };
    },
  };
  const fakeDatabase = {
    from(table: string) {
      calls.push(["from", table]);
      return {
        select() {
          calls.push(["select"]);
          return loadQuery;
        },
        async upsert(rows: unknown[], options: unknown) {
          calls.push(["upsert", rows, options]);
          return { error: null };
        },
      };
    },
  } as unknown as SupabaseClient;
  const repository = createSupabaseSourceDocumentRepository(fakeDatabase);
  const loaded = await repository.load("owner-a", ["paper-a"]);
  await repository.save("owner-a", [document]);

  assert.equal(loaded[0].contentItemId, "paper-a");
  assert.deepEqual(calls[2], ["eq", "owner_id", "owner-a"]);
  const upsert = calls.find((call) => call[0] === "upsert")!;
  const rows = upsert[1] as Array<Record<string, unknown>>;
  assert.equal(rows[0].owner_id, "owner-a");
  assert.deepEqual(upsert[2], { onConflict: "owner_id,content_item_id" });
});
