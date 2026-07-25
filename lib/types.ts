export type ContentKind = "paper" | "blog";
export type TrendBucket = "latest" | "foundational" | "rising";
export type EpisodeStatus =
  | "draft"
  | "generating"
  | "needs_approval"
  | "approved"
  | "published"
  | "failed";

export type InterestProfile = {
  id: string;
  name: string;
  query: string;
  keywords: string[];
  exclusions: string[];
  preferredSources: string[];
  freshnessDays: number;
  weight: number;
  enabled: boolean;
};

export type Source = {
  id: string;
  name: string;
  type: "openalex" | "semantic_scholar" | "arxiv" | "rss" | "atom";
  url: string;
  trustLevel: "primary" | "trusted" | "standard";
  rightsMode: "open_access" | "feed_only" | "metadata_only";
  enabled: boolean;
  lastSuccessfulFetch: string | null;
};

export type ContentItem = {
  id: string;
  kind: ContentKind;
  title: string;
  summary: string;
  authors: string[];
  sourceName: string;
  sourceId?: string;
  canonicalUrl: string;
  doi?: string;
  arxivId?: string;
  publishedAt: string;
  accessLevel: "open_access" | "abstract_only" | "feed_content";
  peerReviewState: "peer_reviewed" | "preprint" | "unknown";
  topics: string[];
  score: number;
  trend: TrendBucket;
  citationCount: number;
  readingMinutes: number;
  saved: boolean;
  listened: boolean;
  processingState: "ready" | "queued" | "processing" | "failed";
};

export type Collection = {
  id: string;
  name: string;
  color: string;
  description: string;
  itemIds: string[];
};

export type Citation = {
  label: string;
  title: string;
  url: string;
};

export type Chapter = {
  title: string;
  startSeconds: number;
};

export type EvidenceClaim = {
  id: string;
  episodeId: string;
  contentItemId: string;
  claim: string;
  support: string;
  sourceUrl: string;
  confidence: number;
  location: string;
};

export type Episode = {
  id: string;
  contentItemId?: string;
  type: "daily_digest" | "paper_deep_dive" | "blog_deep_dive";
  title: string;
  dek: string;
  script: string;
  showNotes: string;
  transcript: string;
  citations: Citation[];
  chapters: Chapter[];
  audioUrl: string | null;
  audioKey?: string | null;
  audioBytes?: number | null;
  durationSeconds: number;
  status: EpisodeStatus;
  publishedAt: string | null;
  immutableGuid: string;
  generation: number;
  createdAt: string;
};

export type RadarTopic = {
  id: string;
  name: string;
  category: string;
  velocity: number;
  volume: number;
  confidence: number;
  changeLabel: string;
  itemCount: number;
  x: number;
  y: number;
};

export type JobRun = {
  id: string;
  stage: string;
  status: "queued" | "running" | "completed" | "failed";
  provider: string | null;
  costUsd: number;
  startedAt: string;
  completedAt: string | null;
};

export type DashboardState = {
  interests: InterestProfile[];
  sources: Source[];
  items: ContentItem[];
  collections: Collection[];
  episodes: Episode[];
  evidence: EvidenceClaim[];
  radar: RadarTopic[];
  jobs: JobRun[];
  stats: {
    newToday: number;
    savedItems: number;
    listeningMinutes: number;
    dailySpendUsd: number;
    dailyBudgetUsd: number;
    lastSync: string;
  };
};

export type NormalizedCandidate = Omit<
  ContentItem,
  "score" | "trend" | "saved" | "listened" | "processingState"
> & {
  sourceAuthority: number;
};
