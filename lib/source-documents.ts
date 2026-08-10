import type { SupabaseClient } from "@supabase/supabase-js";
import type { PodcastSourceCorpus } from "./ollama-semantic";
import {
  hydrateSourceDocuments,
  SOURCE_EXTRACTOR_VERSION,
} from "./source-extraction";
import type {
  SourceDescriptor,
  SourceHydrationOptions,
} from "./source-extraction";
import {
  createPipelineTraceId,
  logPipelineEvent,
} from "./pipeline-log";
import { MAX_OLLAMA_PODCAST_SOURCES } from "./podcast-source-selection";
import { getSupabase } from "./supabase";
import type { ContentItem, SourceBlock, SourceDocument } from "./types";

type SourceDocumentRow = Record<string, unknown>;

export type SourceDocumentRepository = {
  load(
    ownerId: string,
    contentItemIds: readonly string[],
  ): Promise<readonly SourceDocument[]>;
  save(ownerId: string, documents: readonly SourceDocument[]): Promise<void>;
};

export type PodcastSourceHydrator = (
  descriptors: readonly SourceDescriptor[],
  options?: SourceHydrationOptions,
) => Promise<SourceDocument[]>;

export type HydratePodcastSourcesOptions = {
  traceId?: string;
  signal?: AbortSignal;
  repository?: SourceDocumentRepository | null;
  hydrateDocuments?: PodcastSourceHydrator;
  extractorVersion?: string;
  hydration?: Omit<
    SourceHydrationOptions,
    "cachedDocuments" | "signal"
  >;
};

function finiteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function sourceBlockArray(value: unknown): SourceBlock[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set<SourceBlock["kind"]>([
    "heading",
    "paragraph",
    "list_item",
    "quote",
    "code",
    "table_row",
    "caption",
  ]);
  return value.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as SourceDocumentRow;
    const id = optionalString(row.id);
    const text = optionalString(row.text);
    const kind = optionalString(row.kind);
    if (!id || !text || !kind || !kinds.has(kind as SourceBlock["kind"])) return [];
    const level = optionalFiniteNumber(row.level);
    const page = optionalFiniteNumber(row.page);
    return [{
      id,
      order: finiteNumber(row.order, index),
      kind: kind as SourceBlock["kind"],
      text,
      sectionPath: stringArray(row.sectionPath),
      ...(level && level >= 1 && level <= 6
        ? { level: level as SourceBlock["level"] }
        : {}),
      ...(page && page > 0 ? { page } : {}),
    }];
  }).sort((left, right) => left.order - right.order);
}

/** Maps the plain-text-only cache row back to the canonical document shape. */
export function sourceDocumentFromRow(
  value: unknown,
): SourceDocument | null {
  if (!value || typeof value !== "object") return null;
  const row = value as SourceDocumentRow;
  const contentItemId = optionalString(row.content_item_id);
  const canonicalUrl = optionalString(row.canonical_url);
  const retrievalUrl = optionalString(row.retrieval_url);
  const resolvedUrl = optionalString(row.resolved_url);
  const extractor = optionalString(row.extractor);
  const extractorVersion = optionalString(row.extractor_version);
  const fetchedAt = optionalString(row.fetched_at);
  const format = optionalString(row.format);
  const status = optionalString(row.status);
  if (finiteNumber(row.schema_version, 1) !== 1) return null;
  if (
    !contentItemId ||
    !canonicalUrl ||
    !retrievalUrl ||
    !resolvedUrl ||
    !extractor ||
    !extractorVersion ||
    !fetchedAt ||
    !format ||
    !status
  ) return null;
  if (!["html", "pdf", "feed", "abstract"].includes(format)) return null;
  if (!["ready", "fallback", "failed"].includes(status)) return null;

  const title = optionalString(row.title);
  const byline = optionalString(row.byline);
  const language = optionalString(row.language);
  const pages = optionalFiniteNumber(row.page_count);
  const contentHash = optionalString(row.content_hash);
  const errorCode = optionalString(row.error_code);
  const retryAfter = optionalString(row.retry_after);

  return {
    schemaVersion: 1,
    contentItemId,
    canonicalUrl,
    retrievalUrl,
    resolvedUrl,
    format: format as SourceDocument["format"],
    ...(title ? { title } : {}),
    ...(byline ? { byline } : {}),
    ...(language ? { language } : {}),
    blocks: sourceBlockArray(row.blocks_json),
    status: status as SourceDocument["status"],
    stats: {
      rawBytes: Math.max(0, finiteNumber(row.raw_bytes)),
      characters: Math.max(0, finiteNumber(row.character_count)),
      ...(pages !== undefined ? { pages } : {}),
      truncated: Boolean(row.truncated),
    },
    extraction: {
      extractor,
      version: extractorVersion,
      fetchedAt,
      ...(contentHash ? { contentHash } : {}),
      warnings: stringArray(row.warnings_json),
      ...(errorCode ? { errorCode } : {}),
      ...(retryAfter ? { retryAfter } : {}),
    },
  };
}

/** Maps a canonical document to the migration's normalized storage columns. */
export function sourceDocumentRow(
  ownerId: string,
  document: SourceDocument,
): SourceDocumentRow {
  return {
    owner_id: ownerId,
    content_item_id: document.contentItemId,
    schema_version: document.schemaVersion,
    canonical_url: document.canonicalUrl,
    retrieval_url: document.retrievalUrl,
    resolved_url: document.resolvedUrl,
    format: document.format,
    status: document.status,
    title: document.title ?? null,
    byline: document.byline ?? null,
    language: document.language ?? null,
    blocks_json: document.blocks,
    raw_bytes: document.stats.rawBytes,
    character_count: document.stats.characters,
    page_count: document.stats.pages ?? null,
    truncated: document.stats.truncated,
    extractor: document.extraction.extractor,
    extractor_version: document.extraction.version,
    content_hash: document.extraction.contentHash ?? null,
    warnings_json: document.extraction.warnings,
    error_code: document.extraction.errorCode ?? null,
    fetched_at: document.extraction.fetchedAt,
    retry_after: document.extraction.retryAfter ?? null,
    updated_at: new Date().toISOString(),
  };
}

export function createSupabaseSourceDocumentRepository(
  database: SupabaseClient,
): SourceDocumentRepository {
  return {
    async load(ownerId, contentItemIds) {
      if (!contentItemIds.length) return [];
      const { data, error } = await database
        .from("content_documents")
        .select()
        .eq("owner_id", ownerId)
        .in("content_item_id", [...contentItemIds]);
      if (error) throw new Error(`Unable to load source document cache: ${error.message}`);
      return (data ?? []).flatMap((row) => {
        const document = sourceDocumentFromRow(row);
        return document ? [document] : [];
      });
    },
    async save(ownerId, documents) {
      if (!documents.length) return;
      const { error } = await database
        .from("content_documents")
        .upsert(
          documents.map((document) => sourceDocumentRow(ownerId, document)),
          { onConflict: "owner_id,content_item_id" },
        );
      if (error) throw new Error(`Unable to save source document cache: ${error.message}`);
    },
  };
}

function defaultRepository(): SourceDocumentRepository | null {
  const database = getSupabase();
  return database ? createSupabaseSourceDocumentRepository(database) : null;
}

export type StoreSourceDocumentsOptions = {
  traceId?: string;
  repository?: SourceDocumentRepository | null;
};

/** Persists already-extracted feed documents without triggering retrieval. */
export async function storeSourceDocuments(
  ownerId: string,
  documents: readonly SourceDocument[],
  options: StoreSourceDocumentsOptions = {},
): Promise<void> {
  if (!documents.length) return;
  const repository = Object.prototype.hasOwnProperty.call(options, "repository")
    ? options.repository ?? null
    : defaultRepository();
  if (!repository) return;
  const traceId = options.traceId ?? createPipelineTraceId("source-store");
  try {
    await repository.save(ownerId, documents);
    logPipelineEvent(traceId, "source_documents_stored", {
      documentCount: documents.length,
    }, "debug");
  } catch (error) {
    logPipelineEvent(traceId, "source_documents_store_failed", {
      documentCount: documents.length,
      errorType: error instanceof Error ? error.name : "unknown",
    });
  }
}

export function sourceRetrievalUrl(item: ContentItem): string {
  return item.accessLevel === "open_access" && item.documentUrl?.trim()
    ? item.documentUrl.trim()
    : item.canonicalUrl;
}

export function sourceDescriptor(item: ContentItem): SourceDescriptor {
  const canRetrieveFullText = item.accessLevel === "open_access" &&
    Boolean(item.documentUrl?.trim());
  const isFeedContent = item.accessLevel === "feed_content";
  return {
    contentItemId: item.id,
    title: item.title,
    canonicalUrl: item.canonicalUrl,
    ...(canRetrieveFullText ? { retrievalUrl: item.documentUrl!.trim() } : {}),
    authors: item.authors,
    sourceName: item.sourceName,
    publishedAt: item.publishedAt,
    accessLevel: item.accessLevel,
    peerReviewState: item.peerReviewState,
    fallbackText: item.summary,
    ...(isFeedContent ? { feedContentHtml: item.summary } : {}),
    retrievalPolicy: canRetrieveFullText
      ? "full_text"
      : isFeedContent
        ? "feed_only"
        : "metadata_only",
  };
}

export function isReusableSourceDocument(
  document: SourceDocument,
  item: ContentItem,
  extractorVersion = SOURCE_EXTRACTOR_VERSION,
): boolean {
  const retryAt = document.extraction.retryAfter
    ? new Date(document.extraction.retryAfter).getTime()
    : null;
  return document.schemaVersion === 1 &&
    document.contentItemId === item.id &&
    document.retrievalUrl === sourceRetrievalUrl(item) &&
    document.extraction.version === extractorVersion &&
    (retryAt === null || (Number.isFinite(retryAt) && retryAt > Date.now())) &&
    document.status !== "failed" &&
    document.blocks.some((block) => block.text.trim().length > 0);
}

function decodeFallbackEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code.startsWith("#x")) {
      const point = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
    }
    return entities[code.toLocaleLowerCase()] ?? entity;
  });
}

function plainFallbackText(value: string): string {
  return decodeFallbackEntities(value
    .replace(/<(script|style|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>|<\/(?:p|div|li|h[1-6]|blockquote|tr)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fallbackBlocks(item: ContentItem): SourceBlock[] {
  const text = plainFallbackText(item.summary) || plainFallbackText(item.title);
  const paragraphs = text.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
  return (paragraphs.length ? paragraphs : [text]).filter(Boolean).map((value, order) => ({
    id: `fallback-${String(order + 1).padStart(4, "0")}`,
    order,
    kind: "paragraph" as const,
    text: value,
    sectionPath: [],
  }));
}

export function fallbackSourceDocument(
  item: ContentItem,
  extractorVersion = SOURCE_EXTRACTOR_VERSION,
  errorCode = "hydration_failed",
  retryable = false,
): SourceDocument {
  const blocks = fallbackBlocks(item);
  return {
    schemaVersion: 1,
    contentItemId: item.id,
    canonicalUrl: item.canonicalUrl,
    retrievalUrl: sourceRetrievalUrl(item),
    resolvedUrl: sourceRetrievalUrl(item),
    format: item.accessLevel === "feed_content" ? "feed" : "abstract",
    title: item.title,
    byline: item.authors.join(", ") || undefined,
    blocks,
    status: "fallback",
    stats: {
      rawBytes: 0,
      characters: blocks.reduce((sum, block) => sum + block.text.length, 0),
      truncated: false,
    },
    extraction: {
      extractor: "source-document-fallback",
      version: extractorVersion,
      fetchedAt: new Date().toISOString(),
      warnings: ["Stored source summary used because full-text hydration was unavailable."],
      errorCode,
      ...(retryable
        ? { retryAfter: new Date(Date.now() + 15 * 60_000).toISOString() }
        : {}),
    },
  };
}

const NON_NARRATIVE_SECTION = /^(?:references|bibliography|works cited|literature cited)$/i;

/** Keep provenance in storage while excluding bibliography prose from model input. */
export function sourceBlockEligibleForNarration(block: SourceBlock): boolean {
  return !block.sectionPath.some((heading) =>
    NON_NARRATIVE_SECTION.test(heading.trim())
  ) && !(
    block.kind === "heading" && NON_NARRATIVE_SECTION.test(block.text.trim())
  );
}

function usableHydratedDocument(
  document: SourceDocument | undefined,
  item: ContentItem,
): SourceDocument | null {
  if (!document || document.contentItemId !== item.id) return null;
  if (document.status === "failed" || !document.blocks.some((block) => block.text.trim())) {
    return null;
  }
  return document;
}

/** Converts canonical documents into the source-numbered corpus used by Ollama. */
export function sourceDocumentsToPodcastCorpus(
  items: readonly ContentItem[],
  documents: readonly SourceDocument[],
  extractorVersion = SOURCE_EXTRACTOR_VERSION,
): PodcastSourceCorpus {
  const byItemId = new Map(documents.map((document) => [document.contentItemId, document]));
  return {
    extractorVersion,
    sources: items.map((item, index) => {
      const document = usableHydratedDocument(byItemId.get(item.id), item) ??
        fallbackSourceDocument(item, extractorVersion, "invalid_hydration_result");
      const eligibleBlocks = document.blocks.filter(sourceBlockEligibleForNarration);
      const narrationBlocks = eligibleBlocks.length
        ? eligibleBlocks
        : fallbackSourceDocument(
            item,
            extractorVersion,
            "no_narration_eligible_blocks",
          ).blocks;
      return {
        sourceNumber: index + 1,
        contentItemId: item.id,
        title: item.title,
        sourceName: item.sourceName,
        url: item.canonicalUrl,
        authors: item.authors,
        publicationDate: item.publishedAt,
        accessLevel: item.accessLevel,
        peerReviewState: item.peerReviewState,
        blocks: narrationBlocks.map((block) => ({
          id: `${item.id}:${block.id}`,
          kind: block.kind,
          text: block.text,
          headingPath: block.sectionPath,
          page: block.page,
        })),
      };
    }),
  };
}

/**
 * Hydrates only the selected 1-5 items, reusing owner-scoped cached documents.
 * Cache/database failures are deliberately non-fatal so generation can continue
 * from each item's stored feed body or abstract.
 */
export async function hydratePodcastSources(
  ownerId: string,
  items: readonly ContentItem[],
  options: HydratePodcastSourcesOptions = {},
): Promise<PodcastSourceCorpus> {
  if (
    items.length < 1 ||
    items.length > MAX_OLLAMA_PODCAST_SOURCES
  ) {
    throw new Error("Podcast source hydration requires between one and five selected items.");
  }
  const duplicateId = items.find((item, index) =>
    items.findIndex((candidate) => candidate.id === item.id) !== index
  );
  if (duplicateId) throw new Error("Podcast source hydration requires unique content items.");

  const traceId = options.traceId ?? createPipelineTraceId("sources");
  const extractorVersion = options.extractorVersion ?? SOURCE_EXTRACTOR_VERSION;
  const repository = Object.prototype.hasOwnProperty.call(options, "repository")
    ? options.repository ?? null
    : defaultRepository();
  const hydrateDocuments = options.hydrateDocuments ?? hydrateSourceDocuments;
  const descriptors = items.map(sourceDescriptor);
  const startedAt = performance.now();
  logPipelineEvent(traceId, "source_batch_started", { sourceCount: items.length });

  let loadedDocuments: readonly SourceDocument[] = [];
  if (repository) {
    try {
      loadedDocuments = await repository.load(ownerId, items.map((item) => item.id));
      logPipelineEvent(traceId, "source_cache_loaded", {
        requestedCount: items.length,
        loadedCount: loadedDocuments.length,
      }, "debug");
    } catch (error) {
      logPipelineEvent(traceId, "source_cache_load_failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  } else {
    logPipelineEvent(traceId, "source_cache_unavailable", { sourceCount: items.length }, "debug");
  }

  const loadedById = new Map(loadedDocuments.map((document) => [document.contentItemId, document]));
  const reusableCache = new Map<string, SourceDocument>();
  items.forEach((item, index) => {
    const cached = loadedById.get(item.id);
    const reusable = Boolean(cached && isReusableSourceDocument(cached, item, extractorVersion));
    if (reusable) reusableCache.set(item.id, cached!);
    logPipelineEvent(traceId, reusable ? "source_cache_hit" : "source_cache_miss", {
      sourceIndex: index + 1,
      contentItemId: item.id,
    }, "debug");
  });

  let hydrationFailed = false;
  let hydrated: SourceDocument[];
  try {
    hydrated = await hydrateDocuments(descriptors, {
      ...options.hydration,
      cachedDocuments: reusableCache,
      signal: options.signal,
    });
  } catch (error) {
    hydrationFailed = true;
    logPipelineEvent(traceId, "source_hydration_failed", {
      sourceCount: items.length,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    hydrated = items.map((item) =>
      reusableCache.get(item.id) ??
      fallbackSourceDocument(item, extractorVersion, "hydration_failed", true)
    );
  }

  const returnedById = new Map(hydrated.map((document) => [document.contentItemId, document]));
  const orderedDocuments = items.map((item, index) => {
    const document = usableHydratedDocument(returnedById.get(item.id), item) ??
      reusableCache.get(item.id) ??
      fallbackSourceDocument(item, extractorVersion, "invalid_hydration_result");
    logPipelineEvent(traceId, "source_hydration_completed", {
      sourceIndex: index + 1,
      contentItemId: item.id,
      status: document.status,
      format: document.format,
      blockCount: document.blocks.length,
      characterCount: document.stats.characters,
      cacheHit: reusableCache.get(item.id) === document,
    });
    return document;
  });

  if (repository) {
    try {
      await repository.save(ownerId, orderedDocuments);
      logPipelineEvent(traceId, "source_cache_saved", {
        documentCount: orderedDocuments.length,
      }, "debug");
    } catch (error) {
      logPipelineEvent(traceId, "source_cache_save_failed", {
        documentCount: orderedDocuments.length,
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const corpus = sourceDocumentsToPodcastCorpus(items, orderedDocuments, extractorVersion);
  logPipelineEvent(traceId, "source_batch_completed", {
    sourceCount: items.length,
    cacheHitCount: reusableCache.size,
    fallbackCount: orderedDocuments.filter((document) => document.status !== "ready").length,
    hydrationFailed,
    blockCount: corpus.sources.reduce((sum, source) => sum + source.blocks.length, 0),
    durationMs: Math.round(performance.now() - startedAt),
  });
  return corpus;
}
