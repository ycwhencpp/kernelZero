import type { SourceBlock, SourceDocument } from "../types";

export type { SourceBlock, SourceDocument } from "../types";

export const SOURCE_EXTRACTOR_VERSION = "source-extraction-v1";

export type SourceRetrievalPolicy =
  | "full_text"
  | "feed_only"
  | "metadata_only";

/** Minimal metadata needed to retrieve a source without coupling extraction to storage. */
export type SourceDescriptor = {
  contentItemId: string;
  title: string;
  canonicalUrl: string;
  retrievalUrl?: string;
  authors?: string[];
  sourceName?: string;
  publishedAt?: string;
  accessLevel?: "open_access" | "abstract_only" | "feed_content";
  peerReviewState?: "peer_reviewed" | "preprint" | "unknown";
  fallbackText?: string;
  /** Raw content:encoded/Atom HTML captured during feed parsing. */
  feedContentHtml?: string;
  retrievalPolicy?: SourceRetrievalPolicy;
};

export type SourceExtractionLimits = {
  maxHtmlBytes: number;
  maxPdfBytes: number;
  maxRedirects: number;
  dnsTimeoutMs: number;
  headersTimeoutMs: number;
  bodyIdleTimeoutMs: number;
  totalTimeoutMs: number;
  maxHtmlElements: number;
  maxPdfPages: number;
  maxCharacters: number;
  maxBlocks: number;
  minUsefulCharacters: number;
};

export const DEFAULT_SOURCE_EXTRACTION_LIMITS: Readonly<SourceExtractionLimits> =
  Object.freeze({
    maxHtmlBytes: 5 * 1024 * 1024,
    maxPdfBytes: 20 * 1024 * 1024,
    maxRedirects: 3,
    dnsTimeoutMs: 2_000,
    headersTimeoutMs: 8_000,
    bodyIdleTimeoutMs: 5_000,
    totalTimeoutMs: 20_000,
    maxHtmlElements: 50_000,
    maxPdfPages: 100,
    maxCharacters: 300_000,
    maxBlocks: 2_000,
    minUsefulCharacters: 300,
  });

export type SourceExtractionErrorCode =
  | "invalid_url"
  | "unsafe_url"
  | "dns_failed"
  | "timeout"
  | "redirect_limit"
  | "redirect_downgrade"
  | "http_status"
  | "response_too_large"
  | "unsupported_media_type"
  | "html_not_readable"
  | "pdf_encrypted"
  | "pdf_image_only"
  | "parse_failed"
  | "retrieval_disallowed"
  | "batch_timeout";

export class SourceExtractionError extends Error {
  readonly code: SourceExtractionErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: SourceExtractionErrorCode,
    message: string,
    options: { cause?: unknown; retryable?: boolean; status?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SourceExtractionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}

export type SourceExtractionOptions = {
  limits?: Partial<SourceExtractionLimits>;
  signal?: AbortSignal;
};

export type SourceHydrationOptions = SourceExtractionOptions & {
  cachedDocuments?: ReadonlyMap<string, SourceDocument>;
  concurrency?: number;
  batchTimeoutMs?: number;
};

export type PodcastSourceCorpus = {
  schemaVersion: 1;
  sources: SourceDocument[];
  totalCharacters: number;
  truncated: boolean;
};

export type ExtractedBlockContent = {
  blocks: SourceBlock[];
  title?: string;
  byline?: string;
  language?: string;
  pages?: number;
  characters: number;
  truncated: boolean;
  warnings: string[];
};

function boundedEnvironmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

export function resolveSourceDocumentBatchTimeoutMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.round(override);
  }
  return boundedEnvironmentInteger(
    "SOURCE_DOCUMENT_BATCH_TIMEOUT_MS",
    45_000,
    1_000,
    300_000,
  );
}

export function resolveExtractionLimits(
  overrides?: Partial<SourceExtractionLimits>,
): SourceExtractionLimits {
  const environment: Partial<SourceExtractionLimits> = {
    totalTimeoutMs: boundedEnvironmentInteger(
      "SOURCE_DOCUMENT_FETCH_TIMEOUT_MS",
      DEFAULT_SOURCE_EXTRACTION_LIMITS.totalTimeoutMs,
      1_000,
      120_000,
    ),
    maxHtmlBytes: boundedEnvironmentInteger(
      "SOURCE_DOCUMENT_HTML_MAX_BYTES",
      DEFAULT_SOURCE_EXTRACTION_LIMITS.maxHtmlBytes,
      64_000,
      20_000_000,
    ),
    maxPdfBytes: boundedEnvironmentInteger(
      "SOURCE_DOCUMENT_PDF_MAX_BYTES",
      DEFAULT_SOURCE_EXTRACTION_LIMITS.maxPdfBytes,
      256_000,
      100_000_000,
    ),
    maxCharacters: boundedEnvironmentInteger(
      "SOURCE_DOCUMENT_MAX_CHARACTERS",
      DEFAULT_SOURCE_EXTRACTION_LIMITS.maxCharacters,
      1_000,
      2_000_000,
    ),
    maxBlocks: boundedEnvironmentInteger(
      "SOURCE_DOCUMENT_MAX_BLOCKS",
      DEFAULT_SOURCE_EXTRACTION_LIMITS.maxBlocks,
      10,
      10_000,
    ),
    maxPdfPages: boundedEnvironmentInteger(
      "SOURCE_DOCUMENT_MAX_PDF_PAGES",
      DEFAULT_SOURCE_EXTRACTION_LIMITS.maxPdfPages,
      1,
      500,
    ),
  };
  return { ...DEFAULT_SOURCE_EXTRACTION_LIMITS, ...environment, ...overrides };
}
