export {
  createFallbackSourceDocument,
  createPodcastSourceCorpus,
  extractSourceDocument,
  hydrateSourceDocument,
  hydrateSourceDocuments,
  sourceDocumentText,
} from "./hydrate";
export { extractHtmlBlocks, type HtmlExtractionInput } from "./html";
export { extractPdfBlocks, type PdfExtractionInput } from "./pdf";
export {
  detectSourceMediaType,
  isPublicIpAddress,
  normalizePublicHttpUrl,
  safeFetchBytes,
  safeFetchSource,
  type BoundedHttpResponse,
  type SafeFetchOptions,
  type SourceMediaType,
} from "./safe-http";
export {
  DEFAULT_SOURCE_EXTRACTION_LIMITS,
  SOURCE_EXTRACTOR_VERSION,
  SourceExtractionError,
  resolveExtractionLimits,
  resolveSourceDocumentBatchTimeoutMs,
  type PodcastSourceCorpus,
  type SourceDescriptor,
  type SourceExtractionErrorCode,
  type SourceExtractionLimits,
  type SourceExtractionOptions,
  type SourceHydrationOptions,
  type SourceRetrievalPolicy,
} from "./types";
export type { SourceBlock, SourceDocument } from "../types";
