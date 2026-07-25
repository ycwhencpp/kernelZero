import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const profiles = sqliteTable("profiles", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  dailyBudgetUsd: real("daily_budget_usd").notNull().default(2),
  ...timestamps,
});

export const interestProfiles = sqliteTable(
  "interest_profiles",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    query: text("query").notNull(),
    keywordsJson: text("keywords_json").notNull().default("[]"),
    exclusionsJson: text("exclusions_json").notNull().default("[]"),
    preferredSourcesJson: text("preferred_sources_json").notNull().default("[]"),
    freshnessDays: integer("freshness_days").notNull().default(30),
    weight: real("weight").notNull().default(1),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    ...timestamps,
  },
  (table) => [index("interests_owner_idx").on(table.ownerId)],
);

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    type: text("type").notNull(),
    url: text("url").notNull(),
    trustLevel: text("trust_level").notNull().default("trusted"),
    rightsMode: text("rights_mode").notNull().default("feed_only"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastSuccessfulFetch: text("last_successful_fetch"),
    ...timestamps,
  },
  (table) => [index("sources_owner_idx").on(table.ownerId)],
);

export const contentItems = sqliteTable(
  "content_items",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    authorsJson: text("authors_json").notNull().default("[]"),
    sourceName: text("source_name").notNull(),
    sourceId: text("source_id"),
    canonicalUrl: text("canonical_url").notNull(),
    doi: text("doi"),
    arxivId: text("arxiv_id"),
    publishedAt: text("published_at").notNull(),
    accessLevel: text("access_level").notNull().default("abstract_only"),
    peerReviewState: text("peer_review_state").notNull().default("unknown"),
    topicsJson: text("topics_json").notNull().default("[]"),
    score: real("score").notNull().default(0),
    trend: text("trend").notNull().default("latest"),
    citationCount: integer("citation_count").notNull().default(0),
    readingMinutes: integer("reading_minutes").notNull().default(8),
    saved: integer("saved", { mode: "boolean" }).notNull().default(false),
    listened: integer("listened", { mode: "boolean" }).notNull().default(false),
    processingState: text("processing_state").notNull().default("ready"),
    ...timestamps,
  },
  (table) => [
    index("content_owner_score_idx").on(table.ownerId, table.score),
    index("content_owner_published_idx").on(table.ownerId, table.publishedAt),
  ],
);

export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  name: text("name").notNull(),
  color: text("color").notNull().default("#b9ef65"),
  description: text("description").notNull().default(""),
  ...timestamps,
});

export const collectionItems = sqliteTable(
  "collection_items",
  {
    collectionId: text("collection_id").notNull(),
    contentItemId: text("content_item_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.contentItemId] }),
  ],
);

export const episodes = sqliteTable(
  "episodes",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    contentItemId: text("content_item_id"),
    type: text("type").notNull(),
    title: text("title").notNull(),
    dek: text("dek").notNull().default(""),
    script: text("script").notNull(),
    showNotes: text("show_notes").notNull().default(""),
    transcript: text("transcript").notNull().default(""),
    citationsJson: text("citations_json").notNull().default("[]"),
    chaptersJson: text("chapters_json").notNull().default("[]"),
    audioUrl: text("audio_url"),
    audioKey: text("audio_key"),
    audioBytes: integer("audio_bytes"),
    durationSeconds: integer("duration_seconds").notNull().default(0),
    status: text("status").notNull().default("needs_approval"),
    publishedAt: text("published_at"),
    immutableGuid: text("immutable_guid").notNull(),
    generation: integer("generation").notNull().default(1),
    ...timestamps,
  },
  (table) => [index("episodes_owner_status_idx").on(table.ownerId, table.status)],
);

export const evidence = sqliteTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    episodeId: text("episode_id").notNull(),
    contentItemId: text("content_item_id").notNull(),
    claim: text("claim").notNull(),
    support: text("support").notNull(),
    sourceUrl: text("source_url").notNull(),
    confidence: real("confidence").notNull().default(0.8),
    location: text("location").notNull().default("abstract"),
    ...timestamps,
  },
  (table) => [index("evidence_episode_idx").on(table.episodeId)],
);

export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    contentItemId: text("content_item_id").notNull(),
    action: text("action").notNull(),
    value: integer("value"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("feedback_owner_item_idx").on(table.ownerId, table.contentItemId),
  ],
);

export const jobRuns = sqliteTable("job_runs", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  stage: text("stage").notNull(),
  status: text("status").notNull(),
  attempts: integer("attempts").notNull().default(1),
  provider: text("provider"),
  costUsd: real("cost_usd").notNull().default(0),
  error: text("error"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
});
