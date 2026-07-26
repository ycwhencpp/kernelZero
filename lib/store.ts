import { buildTechRadar } from "./domain";
import { getSupabase, MEDIA_BUCKET } from "./supabase";
import type { Collection, ContentItem, DashboardState, Episode, EvidenceClaim, InterestProfile, JobRun, Source, VoiceProfile } from "./types";

// Supabase rows are intentionally schema-flexible at this server boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const iso = (value: unknown) => value ? new Date(String(value)).toISOString() : null;
const array = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

function mapInterest(row: Row): InterestProfile { return { id: row.id, name: row.name, query: row.query, keywords: array(row.keywords_json), exclusions: array(row.exclusions_json), preferredSources: array(row.preferred_sources_json), freshnessDays: row.freshness_days, weight: Number(row.weight), enabled: Boolean(row.enabled) }; }
function mapSource(row: Row): Source { return { id: row.id, name: row.name, type: row.type, url: row.url, trustLevel: row.trust_level, rightsMode: row.rights_mode, enabled: Boolean(row.enabled), lastSuccessfulFetch: iso(row.last_successful_fetch) }; }
function mapItem(row: Row): ContentItem { return { id: row.id, kind: row.kind, title: row.title, summary: row.summary, authors: array(row.authors_json), sourceName: row.source_name, sourceId: row.source_id ?? undefined, canonicalUrl: row.canonical_url, doi: row.doi ?? undefined, arxivId: row.arxiv_id ?? undefined, publishedAt: iso(row.published_at)!, accessLevel: row.access_level, peerReviewState: row.peer_review_state, topics: array(row.topics_json), score: Number(row.score), trend: row.trend, citationCount: Number(row.citation_count), readingMinutes: Number(row.reading_minutes), saved: Boolean(row.saved), listened: Boolean(row.listened), processingState: row.processing_state }; }
function mapEpisode(row: Row): Episode { return { id: row.id, contentItemId: row.content_item_id ?? undefined, type: row.type, title: row.title, dek: row.dek, script: row.script, showNotes: row.show_notes, transcript: row.transcript, citations: array(row.citations_json), chapters: array(row.chapters_json), audioUrl: row.audio_url, audioKey: row.audio_key, audioBytes: row.audio_bytes, durationSeconds: Number(row.duration_seconds), status: row.status, publishedAt: iso(row.published_at), immutableGuid: row.immutable_guid, generation: Number(row.generation), createdAt: iso(row.created_at)! }; }
function mapEvidence(row: Row): EvidenceClaim { const rawConfidence = Number(row.confidence); return { id: row.id, episodeId: row.episode_id, contentItemId: row.content_item_id, claim: row.claim, support: row.support, sourceUrl: row.source_url, confidence: rawConfidence > 1 ? rawConfidence / 100 : rawConfidence, location: row.location }; }
function mapVoiceProfile(row: Row): VoiceProfile { return { id: row.id, name: row.display_name, provider: "chatterbox", active: Boolean(row.active), createdAt: iso(row.created_at)! }; }
function interestRow(ownerId: string, value: InterestProfile): Row { return { id: value.id, owner_id: ownerId, name: value.name, query: value.query, keywords_json: value.keywords, exclusions_json: value.exclusions, preferred_sources_json: value.preferredSources, freshness_days: value.freshnessDays, weight: value.weight, enabled: value.enabled, updated_at: new Date().toISOString() }; }
function sourceRow(ownerId: string, value: Source): Row { return { id: value.id, owner_id: ownerId, name: value.name, type: value.type, url: value.url, trust_level: value.trustLevel, rights_mode: value.rightsMode, enabled: value.enabled, last_successful_fetch: value.lastSuccessfulFetch, updated_at: new Date().toISOString() }; }
function itemRow(ownerId: string, value: ContentItem): Row { return { id: value.id, owner_id: ownerId, kind: value.kind, title: value.title, summary: value.summary, authors_json: value.authors, source_name: value.sourceName, source_id: value.sourceId ?? null, canonical_url: value.canonicalUrl, doi: value.doi ?? null, arxiv_id: value.arxivId ?? null, published_at: value.publishedAt, access_level: value.accessLevel, peer_review_state: value.peerReviewState, topics_json: value.topics, score: value.score, trend: value.trend, citation_count: value.citationCount, reading_minutes: value.readingMinutes, saved: value.saved, listened: value.listened, processing_state: value.processingState, updated_at: new Date().toISOString() }; }
function episodeRow(ownerId: string, value: Episode): Row { return { id: value.id, owner_id: ownerId, content_item_id: value.contentItemId ?? null, type: value.type, title: value.title, dek: value.dek, script: value.script, show_notes: value.showNotes, transcript: value.transcript, citations_json: value.citations, chapters_json: value.chapters, audio_url: value.audioUrl, audio_key: value.audioKey ?? null, audio_bytes: value.audioBytes ?? null, duration_seconds: value.durationSeconds, status: value.status, published_at: value.publishedAt, immutable_guid: value.immutableGuid, generation: value.generation, created_at: value.createdAt, updated_at: new Date().toISOString() }; }

async function requireDb() { return getSupabase(); }
async function ensureOwner(ownerId: string) {
  const db = await requireDb();
  if (!db) return;
  const { data, error: lookupError } = await db.from("profiles").select("id").eq("id", ownerId).maybeSingle();
  if (lookupError) throw new Error(`Unable to initialize profile: ${lookupError.message}`);
  if (data) return;
  const { error } = await db.from("profiles").insert({ id: ownerId, email: ownerId, display_name: ownerId.split("@")[0] || "SignalCast user", timezone: "Asia/Kolkata", daily_budget_usd: 2 });
  if (error && !/duplicate key/i.test(error.message)) throw new Error(`Unable to initialize profile: ${error.message}`);
}

function emptyState(): DashboardState {
  return {
    interests: [], sources: [], items: [], collections: [], episodes: [], evidence: [], voiceProfile: null, radar: [], jobs: [],
    stats: { newToday: 0, savedItems: 0, listeningMinutes: 0, dailySpendUsd: 0, dailyBudgetUsd: 2, lastSync: "Never" },
  };
}

export async function getDashboardState(ownerId: string): Promise<DashboardState> {
  const db = await requireDb(); if (!db) return emptyState(); await ensureOwner(ownerId);
  const [interests, sources, items, collections, episodes, jobs, profile, voiceProfiles] = await Promise.all([
    db.from("interest_profiles").select().eq("owner_id", ownerId).order("weight", { ascending: false }), db.from("sources").select().eq("owner_id", ownerId).order("name"), db.from("content_items").select().eq("owner_id", ownerId).order("score", { ascending: false }).order("published_at", { ascending: false }), db.from("collections").select().eq("owner_id", ownerId), db.from("episodes").select().eq("owner_id", ownerId).order("created_at", { ascending: false }), db.from("job_runs").select().eq("owner_id", ownerId).order("started_at", { ascending: false }).limit(20), db.from("profiles").select().eq("id", ownerId).single(), db.from("voice_profiles").select().eq("owner_id", ownerId).eq("active", true).maybeSingle(),
  ]);
  if (interests.error || sources.error || items.error) throw new Error(interests.error?.message || sources.error?.message || items.error?.message || "Unable to load Supabase state.");
  const mappedItems = (items.data ?? []).map(mapItem); const mappedEpisodes = (episodes.data ?? []).map(mapEpisode);
  const collectionIds = (collections.data ?? []).map((row: Row) => row.id);
  const episodeIds = mappedEpisodes.map((episode) => episode.id);
  const [memberships, evidence] = await Promise.all([
    collectionIds.length ? db.from("collection_items").select().in("collection_id", collectionIds) : Promise.resolve({ data: [] as Row[] }),
    episodeIds.length ? db.from("evidence").select().in("episode_id", episodeIds) : Promise.resolve({ data: [] as Row[] }),
  ]);
  const membership = new Map<string, string[]>(); for (const row of memberships.data ?? []) membership.set(row.collection_id, [...(membership.get(row.collection_id) ?? []), row.content_item_id]);
  const today = new Date().toISOString().slice(0, 10);
  const mappedJobs: JobRun[] = (jobs.data ?? []).map((row: Row) => ({ id: row.id, stage: row.stage, status: row.status, provider: row.provider, costUsd: Number(row.cost_usd), startedAt: iso(row.started_at)!, completedAt: iso(row.completed_at) }));
  const lastSync = (sources.data ?? []).map((row: Row) => iso(row.last_successful_fetch)).filter(Boolean).sort().at(-1) ?? "Never";
  return { interests: (interests.data ?? []).map(mapInterest), sources: (sources.data ?? []).map(mapSource), items: mappedItems, collections: (collections.data ?? []).map((row: Row): Collection => ({ id: row.id, name: row.name, color: row.color, description: row.description, itemIds: membership.get(row.id) ?? [] })), episodes: mappedEpisodes, evidence: (evidence.data ?? []).map(mapEvidence), voiceProfile: voiceProfiles.data && typeof voiceProfiles.data.sample_key === "string" ? mapVoiceProfile(voiceProfiles.data) : null, radar: buildTechRadar(mappedItems), jobs: mappedJobs, stats: { newToday: mappedItems.filter((x) => x.publishedAt.startsWith(today)).length, savedItems: mappedItems.filter((x) => x.saved).length, listeningMinutes: mappedEpisodes.filter((x) => x.status === "approved" || x.status === "published").reduce((sum, x) => sum + Math.round(x.durationSeconds / 60), 0), dailySpendUsd: mappedJobs.filter((x) => x.startedAt.startsWith(today)).reduce((sum, x) => sum + x.costUsd, 0), dailyBudgetUsd: Number(profile.data?.daily_budget_usd ?? 2), lastSync } };
}

export async function saveItem(ownerId: string, itemId: string, saved: boolean) { const db = await requireDb(); if (db) await db.from("content_items").update({ saved, updated_at: new Date().toISOString() }).eq("id", itemId).eq("owner_id", ownerId); }
export async function recordFeedback(ownerId: string, itemId: string, action: "saved" | "skipped" | "listened" | "rating", value?: number) { const db = await requireDb(); if (!db) return; const normalized = action === "rating" ? Math.max(1, Math.min(5, Math.round(value ?? 3))) : value ?? 1; const delta = action === "saved" ? (normalized > 0 ? 4 : -4) : action === "skipped" ? -14 : action === "listened" ? 5 : (normalized - 3) * 4; const { data } = await db.from("content_items").select("score, saved, listened").eq("id", itemId).eq("owner_id", ownerId).single(); await db.from("feedback").insert({ id: `feedback-${crypto.randomUUID()}`, owner_id: ownerId, content_item_id: itemId, action, value: normalized }); if (data) await db.from("content_items").update({ score: Math.max(0, Math.min(100, Math.round(Number(data.score) + delta))), saved: action === "saved" ? normalized > 0 : data.saved, listened: action === "listened" || data.listened, updated_at: new Date().toISOString() }).eq("id", itemId).eq("owner_id", ownerId); }
export async function personalizeItems(ownerId: string, items: ContentItem[]): Promise<ContentItem[]> { const db = await requireDb(); if (!db || !items.length) return items; const { data } = await db.from("feedback").select("action, value, content_item_id").eq("owner_id", ownerId).order("created_at", { ascending: false }).limit(200); const ids = [...new Set((data ?? []).map((x: Row) => x.content_item_id))]; const { data: prior } = ids.length ? await db.from("content_items").select("id, source_name, topics_json").in("id", ids) : { data: [] as Row[] }; const metadata = new Map((prior ?? []).map((x: Row) => [x.id, x])); const source = new Map<string, number>(), topics = new Map<string, number>(); for (const feedback of data ?? []) { const item = metadata.get(feedback.content_item_id); if (!item) continue; const signal = feedback.action === "saved" ? (feedback.value > 0 ? 2.5 : -1) : feedback.action === "skipped" ? -5 : feedback.action === "listened" ? 3 : (feedback.value - 3) * 2; source.set(item.source_name.toLowerCase(), (source.get(item.source_name.toLowerCase()) ?? 0) + signal); for (const topic of array<string>(item.topics_json)) topics.set(topic.toLowerCase(), (topics.get(topic.toLowerCase()) ?? 0) + signal); } return items.map((item) => ({ ...item, score: Math.max(0, Math.min(100, Math.round(item.score + (source.get(item.sourceName.toLowerCase()) ?? 0) + item.topics.reduce((sum, topic) => sum + (topics.get(topic.toLowerCase()) ?? 0), 0)))) })); }
export async function addInterest(ownerId: string, value: InterestProfile) { const db = await requireDb(); if (db) await db.from("interest_profiles").upsert(interestRow(ownerId, value)); }
export async function addSource(ownerId: string, value: Source) { const db = await requireDb(); if (db) await db.from("sources").upsert(sourceRow(ownerId, value)); }
export type ActiveVoiceProfile = VoiceProfile & { sampleKey: string };
export async function getActiveVoiceProfile(ownerId: string): Promise<ActiveVoiceProfile | null> {
  const db = await requireDb();
  if (!db) return null;
  const { data, error } = await db.from("voice_profiles").select().eq("owner_id", ownerId).eq("active", true).maybeSingle();
  if (error) return null; // Allows existing workspaces to start before the additive migration is applied.
  return data && typeof data.sample_key === "string" ? { ...mapVoiceProfile(data), sampleKey: data.sample_key } : null;
}
export async function saveVoiceProfile(ownerId: string, value: VoiceProfile, sampleKey: string): Promise<string | null> {
  const db = await requireDb();
  if (!db) throw new Error("Supabase is not configured. A voice profile needs durable workspace storage.");
  const { data: previous, error: previousError } = await db.from("voice_profiles").select("sample_key").eq("owner_id", ownerId).maybeSingle();
  if (previousError && !/does not exist|column/i.test(previousError.message)) throw new Error(previousError.message);
  const { error } = await db.from("voice_profiles").upsert({ id: value.id, owner_id: ownerId, provider: value.provider, display_name: value.name, sample_key: sampleKey, active: value.active, created_at: value.createdAt, updated_at: new Date().toISOString() }, { onConflict: "owner_id" });
  if (error) throw new Error(`Unable to save voice profile. Run the latest Supabase migration first: ${error.message}`);
  return typeof previous?.sample_key === "string" ? previous.sample_key : null;
}
export async function disconnectVoiceProfile(ownerId: string): Promise<string | null> {
  const db = await requireDb();
  if (!db) return null;
  const { data: previous, error: previousError } = await db.from("voice_profiles").select("sample_key").eq("owner_id", ownerId).maybeSingle();
  if (previousError && !/does not exist|column/i.test(previousError.message)) throw new Error(previousError.message);
  const { error } = await db.from("voice_profiles").delete().eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
  return typeof previous?.sample_key === "string" ? previous.sample_key : null;
}
export async function upsertItems(ownerId: string, items: ContentItem[]) { const db = await requireDb(); if (db && items.length) await db.from("content_items").upsert(items.map((x) => itemRow(ownerId, x))); }
export async function findItems(ownerId: string, ids: string[]) { const db = await requireDb(); if (!db || !ids.length) return []; const { data } = await db.from("content_items").select().eq("owner_id", ownerId).in("id", ids); const lookup = new Map((data ?? []).map((x: Row) => [x.id, mapItem(x)])); return ids.map((id) => lookup.get(id)).filter((x): x is ContentItem => Boolean(x)); }
export async function createEpisode(ownerId: string, episode: Episode, claims: EvidenceClaim[], audio?: ArrayBuffer | null, requestBaseUrl?: string, audioContentType = "audio/mpeg"): Promise<Episode> { void requestBaseUrl; const db = await requireDb(); if (!db) return episode; if (audio) { const extension = audioContentType.includes("wav") ? "wav" : "mp3"; const key = `audio/${ownerId.replace(/[^a-z0-9]/gi, "_")}/${episode.id}.${extension}`; const { error } = await db.storage.from(MEDIA_BUCKET).upload(key, new Uint8Array(audio), { contentType: audioContentType, cacheControl: "31536000", upsert: false }); if (error) throw new Error(`Unable to store episode audio: ${error.message}`); const { data } = db.storage.from(MEDIA_BUCKET).getPublicUrl(key); episode.audioKey = key; episode.audioBytes = audio.byteLength; episode.audioUrl = data.publicUrl; } await db.from("episodes").upsert(episodeRow(ownerId, episode)); if (claims.length) await db.from("evidence").upsert(claims.map((x) => ({ id: x.id, episode_id: x.episodeId, content_item_id: x.contentItemId, claim: x.claim, support: x.support, source_url: x.sourceUrl, confidence: x.confidence, location: x.location }))); return episode; }
export async function approveEpisode(ownerId: string, episodeId: string) { const db = await requireDb(); if (!db) return; const { data } = await db.from("episodes").select("audio_url, published_at").eq("id", episodeId).eq("owner_id", ownerId).single(); if (!data) return; await db.from("episodes").update({ status: data.audio_url ? "published" : "approved", published_at: data.audio_url ? (data.published_at ?? new Date().toISOString()) : null, updated_at: new Date().toISOString() }).eq("id", episodeId).eq("owner_id", ownerId); }
export async function updateEpisode(ownerId: string, episodeId: string, patch: Pick<Partial<Episode>, "script" | "transcript" | "showNotes">) {
  const db = await requireDb();
  if (!db) return;
  const updates: Row = { updated_at: new Date().toISOString() };
  if (typeof patch.script === "string") updates.script = patch.script;
  if (typeof patch.transcript === "string") updates.transcript = patch.transcript;
  if (typeof patch.showNotes === "string") updates.show_notes = patch.showNotes;
  const { error } = await db.from("episodes").update(updates).eq("id", episodeId).eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
}
export async function deleteWorkspace(ownerId: string): Promise<string | null> {
  const db = await requireDb();
  if (!db) return null;
  const { data: voiceProfile } = await db.from("voice_profiles").select("sample_key").eq("owner_id", ownerId).maybeSingle();
  const { data: episodes } = await db.from("episodes").select("id, audio_key").eq("owner_id", ownerId);
  const keys = (episodes ?? []).map((episode: Row) => episode.audio_key).filter(Boolean);
  if (keys.length) await db.storage.from(MEDIA_BUCKET).remove(keys);
  const episodeIds = (episodes ?? []).map((episode: Row) => episode.id);
  if (episodeIds.length) await db.from("evidence").delete().in("episode_id", episodeIds);
  await db.from("feedback").delete().eq("owner_id", ownerId);
  await db.from("job_runs").delete().eq("owner_id", ownerId);
  await db.from("episodes").delete().eq("owner_id", ownerId);
  const { data: collections } = await db.from("collections").select("id").eq("owner_id", ownerId);
  const collectionIds = (collections ?? []).map((row: Row) => row.id);
  if (collectionIds.length) await db.from("collection_items").delete().in("collection_id", collectionIds);
  await db.from("collections").delete().eq("owner_id", ownerId);
  await db.from("content_items").delete().eq("owner_id", ownerId);
  await db.from("sources").delete().eq("owner_id", ownerId);
  await db.from("interest_profiles").delete().eq("owner_id", ownerId);
  await db.from("voice_profiles").delete().eq("owner_id", ownerId);
  await db.from("profiles").delete().eq("id", ownerId);
  return typeof voiceProfile?.sample_key === "string" ? voiceProfile.sample_key : null;
}
/** Removes generated workspace data while preserving sources, interests, and the local narrator profile. */
export async function resetGeneratedWorkspaceData(ownerId: string): Promise<void> {
  const db = await requireDb();
  if (!db) return;
  const { data: episodes, error: episodesError } = await db.from("episodes").select("id, audio_key").eq("owner_id", ownerId);
  if (episodesError) throw new Error(episodesError.message);
  const keys = (episodes ?? []).map((episode: Row) => episode.audio_key).filter(Boolean);
  if (keys.length) await db.storage.from(MEDIA_BUCKET).remove(keys);
  const episodeIds = (episodes ?? []).map((episode: Row) => episode.id);
  if (episodeIds.length) await db.from("evidence").delete().in("episode_id", episodeIds);
  await db.from("feedback").delete().eq("owner_id", ownerId);
  await db.from("job_runs").delete().eq("owner_id", ownerId);
  await db.from("episodes").delete().eq("owner_id", ownerId);
  const { data: collections, error: collectionsError } = await db.from("collections").select("id").eq("owner_id", ownerId);
  if (collectionsError) throw new Error(collectionsError.message);
  const collectionIds = (collections ?? []).map((collection: Row) => collection.id);
  if (collectionIds.length) await db.from("collection_items").delete().in("collection_id", collectionIds);
  await db.from("collections").delete().eq("owner_id", ownerId);
  await db.from("content_items").delete().eq("owner_id", ownerId);
}
export async function getPublicEpisodes() { const db = await requireDb(); if (!db) return []; const { data, error } = await db.from("episodes").select().eq("status", "published").not("audio_url", "is", null).order("published_at", { ascending: false }); if (error) throw new Error(error.message); return (data ?? []).map(mapEpisode); }
export async function getPublicEpisode(id: string) { const db = await requireDb(); if (!db) return null; const { data } = await db.from("episodes").select().eq("id", id).in("status", ["approved", "published"]).maybeSingle(); return data ? mapEpisode(data) : null; }
export async function getMedia(key: string) { const db = await requireDb(); if (!db) return null; const { data, error } = await db.storage.from(MEDIA_BUCKET).download(key); if (error || !data) return null; return { body: data, contentType: data.type || "audio/mpeg" }; }
export async function recordJob(ownerId: string, job: { id: string; stage: string; status: JobRun["status"]; provider?: string; costUsd?: number; error?: string }) { const db = await requireDb(); if (db) await db.from("job_runs").upsert({ id: job.id, owner_id: ownerId, stage: job.stage, status: job.status, provider: job.provider ?? null, cost_usd: job.costUsd ?? 0, error: job.error ?? null, idempotency_key: job.id, completed_at: job.status === "completed" || job.status === "failed" ? new Date().toISOString() : null }); }
