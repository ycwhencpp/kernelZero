import { cloneDemoState, demoState } from "./demo-data";
import { buildTechRadar } from "./domain";
import type {
  Collection,
  ContentItem,
  DashboardState,
  Episode,
  EvidenceClaim,
  InterestProfile,
  JobRun,
  Source,
} from "./types";

type Bindings = {
  DB?: D1Database;
  MEDIA?: R2Bucket;
  PODCAST_BASE_URL?: string;
};

let initialization: Promise<void> | null = null;

function bindings(): Bindings {
  return (
    (globalThis as typeof globalThis & { __signalcastEnv?: Bindings })
      .__signalcastEnv ?? (process.env as unknown as Bindings)
  );
}

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS profiles (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata', daily_budget_usd REAL NOT NULL DEFAULT 2,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS interest_profiles (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, query TEXT NOT NULL,
    keywords_json TEXT NOT NULL DEFAULT '[]', exclusions_json TEXT NOT NULL DEFAULT '[]',
    preferred_sources_json TEXT NOT NULL DEFAULT '[]', freshness_days INTEGER NOT NULL DEFAULT 30,
    weight REAL NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    url TEXT NOT NULL, trust_level TEXT NOT NULL DEFAULT 'trusted',
    rights_mode TEXT NOT NULL DEFAULT 'feed_only', enabled INTEGER NOT NULL DEFAULT 1,
    last_successful_fetch TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS content_items (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '', authors_json TEXT NOT NULL DEFAULT '[]',
    source_name TEXT NOT NULL, source_id TEXT, canonical_url TEXT NOT NULL, doi TEXT, arxiv_id TEXT,
    published_at TEXT NOT NULL, access_level TEXT NOT NULL DEFAULT 'abstract_only',
    peer_review_state TEXT NOT NULL DEFAULT 'unknown', topics_json TEXT NOT NULL DEFAULT '[]',
    score REAL NOT NULL DEFAULT 0, trend TEXT NOT NULL DEFAULT 'latest',
    citation_count INTEGER NOT NULL DEFAULT 0, reading_minutes INTEGER NOT NULL DEFAULT 8,
    saved INTEGER NOT NULL DEFAULT 0, listened INTEGER NOT NULL DEFAULT 0,
    processing_state TEXT NOT NULL DEFAULT 'ready',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#b9ef65',
    description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS collection_items (
    collection_id TEXT NOT NULL, content_item_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (collection_id, content_item_id)
  )`,
  `CREATE TABLE IF NOT EXISTS episodes (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, content_item_id TEXT, type TEXT NOT NULL,
    title TEXT NOT NULL, dek TEXT NOT NULL DEFAULT '', script TEXT NOT NULL,
    show_notes TEXT NOT NULL DEFAULT '', transcript TEXT NOT NULL DEFAULT '',
    citations_json TEXT NOT NULL DEFAULT '[]', chapters_json TEXT NOT NULL DEFAULT '[]',
    audio_url TEXT, audio_key TEXT, audio_bytes INTEGER, duration_seconds INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'needs_approval', published_at TEXT,
    immutable_guid TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY, episode_id TEXT NOT NULL, content_item_id TEXT NOT NULL,
    claim TEXT NOT NULL, support TEXT NOT NULL, source_url TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.8, location TEXT NOT NULL DEFAULT 'abstract',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, content_item_id TEXT NOT NULL,
    action TEXT NOT NULL, value INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS job_runs (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 1, provider TEXT, cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT, idempotency_key TEXT NOT NULL UNIQUE,
    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS interests_owner_idx ON interest_profiles(owner_id)`,
  `CREATE INDEX IF NOT EXISTS sources_owner_idx ON sources(owner_id)`,
  `CREATE INDEX IF NOT EXISTS content_owner_score_idx ON content_items(owner_id, score DESC)`,
  `CREATE INDEX IF NOT EXISTS content_owner_published_idx ON content_items(owner_id, published_at DESC)`,
  `CREATE INDEX IF NOT EXISTS episodes_owner_status_idx ON episodes(owner_id, status)`,
  `CREATE INDEX IF NOT EXISTS evidence_episode_idx ON evidence(episode_id)`,
  `CREATE INDEX IF NOT EXISTS feedback_owner_item_idx ON feedback(owner_id, content_item_id)`,
];

async function ensureDatabase(): Promise<D1Database | null> {
  const db = bindings().DB;
  if (!db) return null;
  if (!initialization) {
    initialization = (async () => {
      for (let index = 0; index < schemaStatements.length; index += 20) {
        const chunk = schemaStatements.slice(index, index + 20);
        await db.batch(chunk.map((statement) => db.prepare(statement)));
      }
    })();
  }
  await initialization;
  return db;
}

function json<T>(value: unknown, fallback: T): T {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function mapInterest(row: Record<string, unknown>): InterestProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    query: String(row.query),
    keywords: json(row.keywords_json, []),
    exclusions: json(row.exclusions_json, []),
    preferredSources: json(row.preferred_sources_json, []),
    freshnessDays: Number(row.freshness_days),
    weight: Number(row.weight),
    enabled: Boolean(row.enabled),
  };
}

function mapSource(row: Record<string, unknown>): Source {
  return {
    id: String(row.id),
    name: String(row.name),
    type: String(row.type) as Source["type"],
    url: String(row.url),
    trustLevel: String(row.trust_level) as Source["trustLevel"],
    rightsMode: String(row.rights_mode) as Source["rightsMode"],
    enabled: Boolean(row.enabled),
    lastSuccessfulFetch: row.last_successful_fetch
      ? String(row.last_successful_fetch)
      : null,
  };
}

function mapItem(row: Record<string, unknown>): ContentItem {
  return {
    id: String(row.id),
    kind: String(row.kind) as ContentItem["kind"],
    title: String(row.title),
    summary: String(row.summary),
    authors: json(row.authors_json, []),
    sourceName: String(row.source_name),
    sourceId: row.source_id ? String(row.source_id) : undefined,
    canonicalUrl: String(row.canonical_url),
    doi: row.doi ? String(row.doi) : undefined,
    arxivId: row.arxiv_id ? String(row.arxiv_id) : undefined,
    publishedAt: String(row.published_at),
    accessLevel: String(row.access_level) as ContentItem["accessLevel"],
    peerReviewState: String(row.peer_review_state) as ContentItem["peerReviewState"],
    topics: json(row.topics_json, []),
    score: Number(row.score),
    trend: String(row.trend) as ContentItem["trend"],
    citationCount: Number(row.citation_count),
    readingMinutes: Number(row.reading_minutes),
    saved: Boolean(row.saved),
    listened: Boolean(row.listened),
    processingState: String(row.processing_state) as ContentItem["processingState"],
  };
}

function mapEpisode(row: Record<string, unknown>): Episode {
  return {
    id: String(row.id),
    contentItemId: row.content_item_id ? String(row.content_item_id) : undefined,
    type: String(row.type) as Episode["type"],
    title: String(row.title),
    dek: String(row.dek),
    script: String(row.script),
    showNotes: String(row.show_notes),
    transcript: String(row.transcript),
    citations: json(row.citations_json, []),
    chapters: json(row.chapters_json, []),
    audioUrl: row.audio_url ? String(row.audio_url) : null,
    audioKey: row.audio_key ? String(row.audio_key) : null,
    audioBytes: row.audio_bytes ? Number(row.audio_bytes) : null,
    durationSeconds: Number(row.duration_seconds),
    status: String(row.status) as Episode["status"],
    publishedAt: row.published_at ? String(row.published_at) : null,
    immutableGuid: String(row.immutable_guid),
    generation: Number(row.generation),
    createdAt: String(row.created_at),
  };
}

function mapEvidence(row: Record<string, unknown>): EvidenceClaim {
  return {
    id: String(row.id),
    episodeId: String(row.episode_id),
    contentItemId: String(row.content_item_id),
    claim: String(row.claim),
    support: String(row.support),
    sourceUrl: String(row.source_url),
    confidence: Number(row.confidence),
    location: String(row.location),
  };
}

async function seedOwner(db: D1Database, ownerId: string): Promise<void> {
  const countResult = await db
    .prepare("SELECT COUNT(*) AS count FROM profiles WHERE id = ?")
    .bind(ownerId)
    .first<{ count: number }>();
  if (Number(countResult?.count ?? 0) > 0) return;

  const profile = db
    .prepare(
      "INSERT OR IGNORE INTO profiles (id, email, display_name, timezone, daily_budget_usd) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(ownerId, ownerId, "SignalCast Listener", "Asia/Kolkata", 2);
  const interests = demoState.interests.map((interest) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO interest_profiles
         (id, owner_id, name, query, keywords_json, exclusions_json, preferred_sources_json, freshness_days, weight, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        interest.id,
        ownerId,
        interest.name,
        interest.query,
        JSON.stringify(interest.keywords),
        JSON.stringify(interest.exclusions),
        JSON.stringify(interest.preferredSources),
        interest.freshnessDays,
        interest.weight,
        interest.enabled ? 1 : 0,
      ),
  );
  const sourceStatements = demoState.sources.map((source) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO sources
         (id, owner_id, name, type, url, trust_level, rights_mode, enabled, last_successful_fetch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        source.id,
        ownerId,
        source.name,
        source.type,
        source.url,
        source.trustLevel,
        source.rightsMode,
        source.enabled ? 1 : 0,
        source.lastSuccessfulFetch,
      ),
  );
  const itemStatements = demoState.items.map((item) => itemInsert(db, ownerId, item));
  const collectionStatements = demoState.collections.map((collection) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO collections (id, owner_id, name, color, description) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        collection.id,
        ownerId,
        collection.name,
        collection.color,
        collection.description,
      ),
  );
  const collectionItemStatements = demoState.collections.flatMap((collection) =>
    collection.itemIds.map((itemId) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO collection_items (collection_id, content_item_id) VALUES (?, ?)",
        )
        .bind(collection.id, itemId),
    ),
  );
  const episodeStatements = demoState.episodes.map((episode) =>
    episodeInsert(db, ownerId, episode),
  );
  const evidenceStatements = demoState.evidence.map((claim) =>
    evidenceInsert(db, claim),
  );
  const jobStatements = demoState.jobs.map((job) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO job_runs
         (id, owner_id, stage, status, provider, cost_usd, idempotency_key, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        job.id,
        ownerId,
        job.stage,
        job.status,
        job.provider,
        job.costUsd,
        job.id,
        job.startedAt,
        job.completedAt,
      ),
  );

  const statements = [
    profile,
    ...interests,
    ...sourceStatements,
    ...itemStatements,
    ...collectionStatements,
    ...collectionItemStatements,
    ...episodeStatements,
    ...evidenceStatements,
    ...jobStatements,
  ];
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
}

function itemInsert(db: D1Database, ownerId: string, item: ContentItem) {
  return db
    .prepare(
      `INSERT OR REPLACE INTO content_items
       (id, owner_id, kind, title, summary, authors_json, source_name, source_id, canonical_url,
        doi, arxiv_id, published_at, access_level, peer_review_state, topics_json, score, trend,
        citation_count, reading_minutes, saved, listened, processing_state, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(
      item.id,
      ownerId,
      item.kind,
      item.title,
      item.summary,
      JSON.stringify(item.authors),
      item.sourceName,
      item.sourceId ?? null,
      item.canonicalUrl,
      item.doi ?? null,
      item.arxivId ?? null,
      item.publishedAt,
      item.accessLevel,
      item.peerReviewState,
      JSON.stringify(item.topics),
      item.score,
      item.trend,
      item.citationCount,
      item.readingMinutes,
      item.saved ? 1 : 0,
      item.listened ? 1 : 0,
      item.processingState,
    );
}

function episodeInsert(db: D1Database, ownerId: string, episode: Episode) {
  return db
    .prepare(
      `INSERT OR REPLACE INTO episodes
       (id, owner_id, content_item_id, type, title, dek, script, show_notes, transcript,
        citations_json, chapters_json, audio_url, audio_key, audio_bytes, duration_seconds, status, published_at,
        immutable_guid, generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(
      episode.id,
      ownerId,
      episode.contentItemId ?? null,
      episode.type,
      episode.title,
      episode.dek,
      episode.script,
      episode.showNotes,
      episode.transcript,
      JSON.stringify(episode.citations),
      JSON.stringify(episode.chapters),
      episode.audioUrl,
      episode.audioKey ?? null,
      episode.audioBytes ?? null,
      episode.durationSeconds,
      episode.status,
      episode.publishedAt,
      episode.immutableGuid,
      episode.generation,
      episode.createdAt,
    );
}

function evidenceInsert(db: D1Database, claim: EvidenceClaim) {
  return db
    .prepare(
      `INSERT OR REPLACE INTO evidence
       (id, episode_id, content_item_id, claim, support, source_url, confidence, location, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(
      claim.id,
      claim.episodeId,
      claim.contentItemId,
      claim.claim,
      claim.support,
      claim.sourceUrl,
      claim.confidence,
      claim.location,
    );
}

export async function getDashboardState(ownerId: string): Promise<DashboardState> {
  const db = await ensureDatabase();
  if (!db) return cloneDemoState();
  await seedOwner(db, ownerId);

  const [
    interestRows,
    sourceRows,
    itemRows,
    collectionRows,
    collectionItemRows,
    episodeRows,
    evidenceRows,
    jobRows,
    profile,
  ] = await Promise.all([
    db.prepare("SELECT * FROM interest_profiles WHERE owner_id = ? ORDER BY weight DESC").bind(ownerId).all(),
    db.prepare("SELECT * FROM sources WHERE owner_id = ? ORDER BY name").bind(ownerId).all(),
    db.prepare("SELECT * FROM content_items WHERE owner_id = ? ORDER BY score DESC, published_at DESC").bind(ownerId).all(),
    db.prepare("SELECT * FROM collections WHERE owner_id = ? ORDER BY created_at").bind(ownerId).all(),
    db.prepare("SELECT * FROM collection_items").all(),
    db.prepare("SELECT * FROM episodes WHERE owner_id = ? ORDER BY created_at DESC").bind(ownerId).all(),
    db.prepare("SELECT e.* FROM evidence e JOIN episodes ep ON ep.id = e.episode_id WHERE ep.owner_id = ?").bind(ownerId).all(),
    db.prepare("SELECT * FROM job_runs WHERE owner_id = ? ORDER BY started_at DESC LIMIT 20").bind(ownerId).all(),
    db.prepare("SELECT * FROM profiles WHERE id = ?").bind(ownerId).first<Record<string, unknown>>(),
  ]);

  const collectionMembership = new Map<string, string[]>();
  for (const row of collectionItemRows.results as Array<Record<string, unknown>>) {
    const collectionId = String(row.collection_id);
    collectionMembership.set(collectionId, [
      ...(collectionMembership.get(collectionId) ?? []),
      String(row.content_item_id),
    ]);
  }
  const items = (itemRows.results as Array<Record<string, unknown>>).map(mapItem);
  const episodes = (episodeRows.results as Array<Record<string, unknown>>).map(mapEpisode);
  const jobs: JobRun[] = (jobRows.results as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    stage: String(row.stage),
    status: String(row.status) as JobRun["status"],
    provider: row.provider ? String(row.provider) : null,
    costUsd: Number(row.cost_usd),
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  }));
  const today = new Date().toISOString().slice(0, 10);
  const radar = buildTechRadar(items);

  return {
    interests: (interestRows.results as Array<Record<string, unknown>>).map(mapInterest),
    sources: (sourceRows.results as Array<Record<string, unknown>>).map(mapSource),
    items,
    collections: (collectionRows.results as Array<Record<string, unknown>>).map(
      (row): Collection => ({
        id: String(row.id),
        name: String(row.name),
        color: String(row.color),
        description: String(row.description),
        itemIds: collectionMembership.get(String(row.id)) ?? [],
      }),
    ),
    episodes,
    evidence: (evidenceRows.results as Array<Record<string, unknown>>).map(mapEvidence),
    radar: radar.length ? radar : demoState.radar,
    jobs,
    stats: {
      newToday: items.filter((item) => item.publishedAt.startsWith(today)).length || demoState.stats.newToday,
      savedItems: items.filter((item) => item.saved).length,
      listeningMinutes: episodes
        .filter((episode) => episode.status === "approved" || episode.status === "published")
        .reduce((sum, episode) => sum + Math.round(episode.durationSeconds / 60), 0),
      dailySpendUsd: jobs
        .filter((job) => job.startedAt.startsWith(today))
        .reduce((sum, job) => sum + job.costUsd, 0),
      dailyBudgetUsd: Number(profile?.daily_budget_usd ?? 2),
      lastSync: demoState.stats.lastSync,
    },
  };
}

export async function saveItem(ownerId: string, itemId: string, saved: boolean) {
  const db = await ensureDatabase();
  if (!db) return;
  await seedOwner(db, ownerId);
  await db
    .prepare(
      "UPDATE content_items SET saved = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
    )
    .bind(saved ? 1 : 0, itemId, ownerId)
    .run();
}

export async function recordFeedback(
  ownerId: string,
  itemId: string,
  action: "saved" | "skipped" | "listened" | "rating",
  value?: number,
): Promise<void> {
  const db = await ensureDatabase();
  if (!db) return;
  await seedOwner(db, ownerId);
  const normalizedValue =
    action === "rating"
      ? Math.max(1, Math.min(5, Math.round(value ?? 3)))
      : value ?? 1;
  const scoreDelta =
    action === "saved"
      ? normalizedValue > 0
        ? 4
        : -4
      : action === "skipped"
        ? -14
        : action === "listened"
          ? 5
          : (normalizedValue - 3) * 4;

  await db.batch([
    db
      .prepare(
        `INSERT INTO feedback (id, owner_id, content_item_id, action, value)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        `feedback-${crypto.randomUUID()}`,
        ownerId,
        itemId,
        action,
        normalizedValue,
      ),
    db
      .prepare(
        `UPDATE content_items
         SET score = MAX(0, MIN(100, score + ?)),
             saved = CASE WHEN ? = 'saved' THEN ? ELSE saved END,
             listened = CASE WHEN ? = 'listened' THEN 1 ELSE listened END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND owner_id = ?`,
      )
      .bind(
        scoreDelta,
        action,
        normalizedValue > 0 ? 1 : 0,
        action,
        itemId,
        ownerId,
      ),
  ]);
}

export async function personalizeItems(
  ownerId: string,
  items: ContentItem[],
): Promise<ContentItem[]> {
  const db = await ensureDatabase();
  if (!db || !items.length) return items;
  await seedOwner(db, ownerId);
  const rows = await db
    .prepare(
      `SELECT f.action, f.value, c.source_name, c.topics_json
       FROM feedback f
       JOIN content_items c ON c.id = f.content_item_id
       WHERE f.owner_id = ?
       ORDER BY f.created_at DESC
       LIMIT 200`,
    )
    .bind(ownerId)
    .all();
  const sourceSignals = new Map<string, number>();
  const topicSignals = new Map<string, number>();

  for (const row of rows.results as Array<Record<string, unknown>>) {
    const action = String(row.action);
    const value = Number(row.value ?? 1);
    const signal =
      action === "saved"
        ? value > 0
          ? 2.5
          : -1
        : action === "skipped"
          ? -5
          : action === "listened"
            ? 3
            : (value - 3) * 2;
    const sourceName = String(row.source_name).toLowerCase();
    sourceSignals.set(
      sourceName,
      (sourceSignals.get(sourceName) ?? 0) + signal,
    );
    for (const topic of json<string[]>(row.topics_json, [])) {
      const key = topic.toLowerCase();
      topicSignals.set(key, (topicSignals.get(key) ?? 0) + signal);
    }
  }

  return items.map((item) => {
    const sourceBoost = sourceSignals.get(item.sourceName.toLowerCase()) ?? 0;
    const topicBoost = item.topics.reduce(
      (sum, topic) => sum + (topicSignals.get(topic.toLowerCase()) ?? 0),
      0,
    );
    return {
      ...item,
      score: Math.max(
        0,
        Math.min(100, Math.round(item.score + sourceBoost + topicBoost)),
      ),
    };
  });
}

export async function addInterest(
  ownerId: string,
  interest: InterestProfile,
): Promise<void> {
  const db = await ensureDatabase();
  if (!db) return;
  await seedOwner(db, ownerId);
  await db
    .prepare(
      `INSERT OR REPLACE INTO interest_profiles
       (id, owner_id, name, query, keywords_json, exclusions_json, preferred_sources_json,
        freshness_days, weight, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(
      interest.id,
      ownerId,
      interest.name,
      interest.query,
      JSON.stringify(interest.keywords),
      JSON.stringify(interest.exclusions),
      JSON.stringify(interest.preferredSources),
      interest.freshnessDays,
      interest.weight,
      interest.enabled ? 1 : 0,
    )
    .run();
}

export async function addSource(ownerId: string, source: Source): Promise<void> {
  const db = await ensureDatabase();
  if (!db) return;
  await seedOwner(db, ownerId);
  await db
    .prepare(
      `INSERT OR REPLACE INTO sources
       (id, owner_id, name, type, url, trust_level, rights_mode, enabled, last_successful_fetch, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    )
    .bind(
      source.id,
      ownerId,
      source.name,
      source.type,
      source.url,
      source.trustLevel,
      source.rightsMode,
      source.enabled ? 1 : 0,
      source.lastSuccessfulFetch,
    )
    .run();
}

export async function upsertItems(ownerId: string, items: ContentItem[]): Promise<void> {
  const db = await ensureDatabase();
  if (!db || !items.length) return;
  await seedOwner(db, ownerId);
  for (let index = 0; index < items.length; index += 50) {
    await db.batch(items.slice(index, index + 50).map((item) => itemInsert(db, ownerId, item)));
  }
}

export async function findItems(ownerId: string, itemIds: string[]): Promise<ContentItem[]> {
  const state = await getDashboardState(ownerId);
  const byId = new Map(state.items.map((item) => [item.id, item]));
  return itemIds.map((id) => byId.get(id)).filter((item): item is ContentItem => Boolean(item));
}

export async function createEpisode(
  ownerId: string,
  episode: Episode,
  claims: EvidenceClaim[],
  audio?: ArrayBuffer | null,
  requestBaseUrl?: string,
): Promise<Episode> {
  const db = await ensureDatabase();
  if (!db) return episode;
  await seedOwner(db, ownerId);

  if (audio && bindings().MEDIA) {
    const key = `audio/${ownerId.replace(/[^a-z0-9]/gi, "_")}/${episode.id}.mp3`;
    await bindings().MEDIA!.put(key, audio, {
      httpMetadata: {
        contentType: "audio/mpeg",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { episodeId: episode.id, ownerId },
    });
    const baseUrl =
      bindings().PODCAST_BASE_URL ||
      process.env.PODCAST_BASE_URL ||
      requestBaseUrl ||
      "";
    episode.audioKey = key;
    episode.audioBytes = audio.byteLength;
    episode.audioUrl = `${baseUrl}/api/media/${encodeURIComponent(key)}`;
  }

  await db.batch([
    episodeInsert(db, ownerId, episode),
    ...claims.map((claim) => evidenceInsert(db, claim)),
  ]);
  return episode;
}

export async function approveEpisode(ownerId: string, episodeId: string): Promise<void> {
  const db = await ensureDatabase();
  if (!db) return;
  await seedOwner(db, ownerId);
  await db
    .prepare(
      `UPDATE episodes
       SET status = CASE WHEN audio_url IS NULL THEN 'approved' ELSE 'published' END,
           published_at = CASE WHEN audio_url IS NULL THEN published_at ELSE COALESCE(published_at, CURRENT_TIMESTAMP) END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND owner_id = ?`,
    )
    .bind(episodeId, ownerId)
    .run();
}

export async function getPublicEpisodes(): Promise<Episode[]> {
  const db = await ensureDatabase();
  if (!db) return [];
  const rows = await db
    .prepare(
      "SELECT * FROM episodes WHERE status = 'published' AND audio_url IS NOT NULL ORDER BY published_at DESC",
    )
    .all();
  return (rows.results as Array<Record<string, unknown>>).map(mapEpisode);
}

export async function getPublicEpisode(episodeId: string): Promise<Episode | null> {
  const db = await ensureDatabase();
  if (!db) return null;
  const row = await db
    .prepare(
      "SELECT * FROM episodes WHERE id = ? AND status IN ('approved', 'published')",
    )
    .bind(episodeId)
    .first<Record<string, unknown>>();
  return row ? mapEpisode(row) : null;
}

export async function getMedia(key: string): Promise<R2ObjectBody | null> {
  const media = bindings().MEDIA;
  if (!media) return null;
  return media.get(key);
}

export async function recordJob(
  ownerId: string,
  job: {
    id: string;
    stage: string;
    status: JobRun["status"];
    provider?: string;
    costUsd?: number;
    error?: string;
  },
): Promise<void> {
  const db = await ensureDatabase();
  if (!db) return;
  await db
    .prepare(
      `INSERT OR REPLACE INTO job_runs
       (id, owner_id, stage, status, provider, cost_usd, error, idempotency_key, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IN ('completed', 'failed') THEN CURRENT_TIMESTAMP ELSE NULL END)`,
    )
    .bind(
      job.id,
      ownerId,
      job.stage,
      job.status,
      job.provider ?? null,
      job.costUsd ?? 0,
      job.error ?? null,
      job.id,
      job.status,
    )
    .run();
}
