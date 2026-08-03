import { buildTechRadar } from "./domain";
import { mediaUrl } from "./media-path";
import { normalizeEpisodeLength } from "./podcast-length";
import { normalizeEvidenceConfidence } from "./podcast-schema";
import { getSupabase, MEDIA_BUCKET } from "./supabase";
import type { Collection, ContentItem, DashboardState, Episode, EvidenceClaim, InterestProfile, JobRun, Source, VoiceProfile, WorkspaceSettings } from "./types";

// Supabase rows are intentionally schema-flexible at this server boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
export class EpisodeNotFoundError extends Error {
  constructor(message = "Episode not found.") {
    super(message);
    this.name = "EpisodeNotFoundError";
  }
}
const iso = (value: unknown) => value ? new Date(String(value)).toISOString() : null;
const array = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
function mapInterest(row: Row): InterestProfile { return { id: row.id, name: row.name, query: row.query, keywords: array(row.keywords_json), exclusions: array(row.exclusions_json), preferredSources: array(row.preferred_sources_json), freshnessDays: row.freshness_days, weight: Number(row.weight), enabled: Boolean(row.enabled) }; }
function mapSource(row: Row): Source { return { id: row.id, name: row.name, type: row.type, url: row.url, trustLevel: row.trust_level, rightsMode: row.rights_mode, enabled: Boolean(row.enabled), lastSuccessfulFetch: iso(row.last_successful_fetch) }; }
function mapItem(row: Row): ContentItem { return { id: row.id, kind: row.kind, title: row.title, summary: row.summary, authors: array(row.authors_json), sourceName: row.source_name, sourceId: row.source_id ?? undefined, canonicalUrl: row.canonical_url, doi: row.doi ?? undefined, arxivId: row.arxiv_id ?? undefined, publishedAt: iso(row.published_at)!, accessLevel: row.access_level, peerReviewState: row.peer_review_state, topics: array(row.topics_json), score: Number(row.score), trend: row.trend, citationCount: Number(row.citation_count), readingMinutes: Number(row.reading_minutes), saved: Boolean(row.saved), listened: Boolean(row.listened), processingState: row.processing_state }; }
function mapEpisode(row: Row): Episode { const audioKey = typeof row.audio_key === "string" ? row.audio_key : null; return { id: row.id, contentItemId: row.content_item_id ?? undefined, type: row.type, title: row.title, dek: row.dek, script: row.script, showNotes: row.show_notes, transcript: row.transcript, linkedInPost: typeof row.linkedin_post === "string" ? row.linkedin_post : null, citations: array(row.citations_json), chapters: array(row.chapters_json), audioUrl: audioKey ? mediaUrl(audioKey) : row.audio_url, audioKey, audioBytes: row.audio_bytes, durationSeconds: Number(row.duration_seconds), status: row.status, publishedAt: iso(row.published_at), immutableGuid: row.immutable_guid, generation: Number(row.generation), createdAt: iso(row.created_at)! }; }
function mapEvidence(row: Row): EvidenceClaim { return { id: row.id, episodeId: row.episode_id, contentItemId: row.content_item_id, claim: row.claim, support: row.support, sourceUrl: row.source_url, confidence: normalizeEvidenceConfidence(row.confidence), location: row.location }; }
function mapVoiceProfile(row: Row): VoiceProfile { return { id: row.id, name: row.display_name, provider: "chatterbox", active: Boolean(row.active), createdAt: iso(row.created_at)! }; }
function workspaceSettings(row: Row | null | undefined): WorkspaceSettings { return { dailyGeneration: row?.daily_generation_enabled ?? true, episodeLength: normalizeEpisodeLength(row?.episode_length), publishTime: typeof row?.publish_time === "string" && /^\d{2}:\d{2}$/.test(row.publish_time) ? row.publish_time : "08:00" }; }
function interestRow(ownerId: string, value: InterestProfile): Row { return { id: value.id, owner_id: ownerId, name: value.name, query: value.query, keywords_json: value.keywords, exclusions_json: value.exclusions, preferred_sources_json: value.preferredSources, freshness_days: value.freshnessDays, weight: value.weight, enabled: value.enabled, updated_at: new Date().toISOString() }; }
function sourceRow(ownerId: string, value: Source): Row { return { id: value.id, owner_id: ownerId, name: value.name, type: value.type, url: value.url, trust_level: value.trustLevel, rights_mode: value.rightsMode, enabled: value.enabled, last_successful_fetch: value.lastSuccessfulFetch, updated_at: new Date().toISOString() }; }
function itemRow(ownerId: string, value: ContentItem): Row { return { id: value.id, owner_id: ownerId, kind: value.kind, title: value.title, summary: value.summary, authors_json: value.authors, source_name: value.sourceName, source_id: value.sourceId ?? null, canonical_url: value.canonicalUrl, doi: value.doi ?? null, arxiv_id: value.arxivId ?? null, published_at: value.publishedAt, access_level: value.accessLevel, peer_review_state: value.peerReviewState, topics_json: value.topics, score: value.score, trend: value.trend, citation_count: value.citationCount, reading_minutes: value.readingMinutes, saved: value.saved, listened: value.listened, processing_state: value.processingState, updated_at: new Date().toISOString() }; }
export function storedDurationSeconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
function episodeRow(ownerId: string, value: Episode): Row { return { id: value.id, owner_id: ownerId, content_item_id: value.contentItemId ?? null, type: value.type, title: value.title, dek: value.dek, script: value.script, show_notes: value.showNotes, transcript: value.transcript, linkedin_post: value.linkedInPost ?? null, citations_json: value.citations, citation_count: value.citations.length, chapters_json: value.chapters, audio_url: value.audioUrl, audio_key: value.audioKey ?? null, audio_bytes: value.audioBytes ?? null, duration_seconds: storedDurationSeconds(value.durationSeconds), status: value.status, published_at: value.publishedAt, immutable_guid: value.immutableGuid, generation: value.generation, created_at: value.createdAt, updated_at: new Date().toISOString() }; }

async function requireDb() { return getSupabase(); }
export async function findAuthenticatedOwnerIdByEmail(
  email: string,
): Promise<string | null> {
  const db = await requireDb();
  if (!db) return null;
  const { data, error } = await db
    .from("profiles")
    .select("id, auth_user_id")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`Unable to resolve the cron owner: ${error.message}`);
  return data?.auth_user_id ? String(data.id) : null;
}
async function ensureOwner(ownerId: string) {
  const db = await requireDb();
  if (!db) return;
  const { data, error: lookupError } = await db.from("profiles").select("id").eq("id", ownerId).maybeSingle();
  if (lookupError) throw new Error(`Unable to initialize profile: ${lookupError.message}`);
  if (!data) {
    throw new Error("Workspace owner profile not found.");
  }
}

function emptyState(): DashboardState {
  return {
    interests: [], sources: [], items: [], collections: [], episodes: [], evidence: [], voiceProfile: null, voiceProfiles: [], settings: workspaceSettings(null), radar: [], jobs: [],
    stats: { newToday: 0, savedItems: 0, listeningMinutes: 0, dailySpendUsd: 0, dailyBudgetUsd: 2, lastSync: "Never" },
  };
}

export async function getDashboardState(ownerId: string): Promise<DashboardState> {
  const db = await requireDb(); if (!db) return emptyState(); await ensureOwner(ownerId);
  const [interests, sources, items, collections, episodes, jobs, profile, voiceProfiles] = await Promise.all([
    db.from("interest_profiles").select().eq("owner_id", ownerId).order("weight", { ascending: false }), db.from("sources").select().eq("owner_id", ownerId).order("name"), db.from("content_items").select().eq("owner_id", ownerId).order("score", { ascending: false }).order("published_at", { ascending: false }), db.from("collections").select().eq("owner_id", ownerId), db.from("episodes").select().eq("owner_id", ownerId).order("created_at", { ascending: false }), db.from("job_runs").select().eq("owner_id", ownerId).order("started_at", { ascending: false }).limit(20), db.from("profiles").select().eq("id", ownerId).single(), db.from("voice_profiles").select().eq("owner_id", ownerId).order("created_at", { ascending: false }),
  ]);
  if (interests.error || sources.error || items.error || episodes.error) throw new Error(interests.error?.message || sources.error?.message || items.error?.message || episodes.error?.message || "Unable to load Supabase state.");
  const mappedItems = (items.data ?? []).map(mapItem); const mappedEpisodes = (episodes.data ?? []).map(mapEpisode);
  const collectionIds = (collections.data ?? []).map((row: Row) => row.id);
  const episodeIds = mappedEpisodes.map((episode) => episode.id);
  const [memberships, evidence] = await Promise.all([
    collectionIds.length ? db.from("collection_items").select().eq("owner_id", ownerId).in("collection_id", collectionIds) : Promise.resolve({ data: [] as Row[] }),
    episodeIds.length ? db.from("evidence").select().in("episode_id", episodeIds) : Promise.resolve({ data: [] as Row[] }),
  ]);
  const membership = new Map<string, string[]>(); for (const row of memberships.data ?? []) membership.set(row.collection_id, [...(membership.get(row.collection_id) ?? []), row.content_item_id]);
  const today = new Date().toISOString().slice(0, 10);
  const mappedJobs: JobRun[] = (jobs.data ?? []).map((row: Row) => ({ id: row.id, stage: row.stage, status: row.status, provider: row.provider, costUsd: Number(row.cost_usd), startedAt: iso(row.started_at)!, completedAt: iso(row.completed_at) }));
  const lastSync = (sources.data ?? []).map((row: Row) => iso(row.last_successful_fetch)).filter(Boolean).sort().at(-1) ?? "Never";
  const mappedVoices = (voiceProfiles.data ?? []).filter((row: Row) => typeof row.sample_key === "string").map(mapVoiceProfile);
  return { interests: (interests.data ?? []).map(mapInterest), sources: (sources.data ?? []).map(mapSource), items: mappedItems, collections: (collections.data ?? []).map((row: Row): Collection => ({ id: row.id, name: row.name, color: row.color, description: row.description, itemIds: membership.get(row.id) ?? [] })), episodes: mappedEpisodes, evidence: (evidence.data ?? []).map(mapEvidence), voiceProfile: mappedVoices.find((voice) => voice.active) ?? null, voiceProfiles: mappedVoices, settings: workspaceSettings(profile.data), radar: buildTechRadar(mappedItems), jobs: mappedJobs, stats: { newToday: mappedItems.filter((x) => x.publishedAt.startsWith(today)).length, savedItems: mappedItems.filter((x) => x.saved).length, listeningMinutes: mappedEpisodes.filter((x) => x.status === "approved" || x.status === "published").reduce((sum, x) => sum + Math.round(x.durationSeconds / 60), 0), dailySpendUsd: mappedJobs.filter((x) => x.startedAt.startsWith(today)).reduce((sum, x) => sum + x.costUsd, 0), dailyBudgetUsd: Number(profile.data?.daily_budget_usd ?? 2), lastSync } };
}

export async function saveItem(ownerId: string, itemId: string, saved: boolean) { const db = await requireDb(); if (db) await db.from("content_items").update({ saved, updated_at: new Date().toISOString() }).eq("id", itemId).eq("owner_id", ownerId); }
export async function recordFeedback(ownerId: string, itemId: string, action: "saved" | "skipped" | "listened" | "rating", value?: number) { const db = await requireDb(); if (!db) return; const normalized = action === "rating" ? Math.max(1, Math.min(5, Math.round(value ?? 3))) : value ?? 1; const delta = action === "saved" ? (normalized > 0 ? 4 : -4) : action === "skipped" ? -14 : action === "listened" ? 5 : (normalized - 3) * 4; const { data } = await db.from("content_items").select("score, saved, listened").eq("id", itemId).eq("owner_id", ownerId).single(); await db.from("feedback").insert({ id: `feedback-${crypto.randomUUID()}`, owner_id: ownerId, content_item_id: itemId, action, value: normalized }); if (data) await db.from("content_items").update({ score: Math.max(0, Math.min(100, Math.round(Number(data.score) + delta))), saved: action === "saved" ? normalized > 0 : data.saved, listened: action === "listened" || data.listened, updated_at: new Date().toISOString() }).eq("id", itemId).eq("owner_id", ownerId); }
export async function personalizeItems(ownerId: string, items: ContentItem[]): Promise<ContentItem[]> { const db = await requireDb(); if (!db || !items.length) return items; const { data } = await db.from("feedback").select("action, value, content_item_id").eq("owner_id", ownerId).order("created_at", { ascending: false }).limit(200); const ids = [...new Set((data ?? []).map((x: Row) => x.content_item_id))]; const { data: prior } = ids.length ? await db.from("content_items").select("id, source_name, topics_json").eq("owner_id", ownerId).in("id", ids) : { data: [] as Row[] }; const metadata = new Map((prior ?? []).map((x: Row) => [x.id, x])); const source = new Map<string, number>(), topics = new Map<string, number>(); for (const feedback of data ?? []) { const item = metadata.get(feedback.content_item_id); if (!item) continue; const signal = feedback.action === "saved" ? (feedback.value > 0 ? 2.5 : -1) : feedback.action === "skipped" ? -5 : feedback.action === "listened" ? 3 : (feedback.value - 3) * 2; source.set(item.source_name.toLowerCase(), (source.get(item.source_name.toLowerCase()) ?? 0) + signal); for (const topic of array<string>(item.topics_json)) topics.set(topic.toLowerCase(), (topics.get(topic.toLowerCase()) ?? 0) + signal); } return items.map((item) => ({ ...item, score: Math.max(0, Math.min(100, Math.round(item.score + (source.get(item.sourceName.toLowerCase()) ?? 0) + item.topics.reduce((sum, topic) => sum + (topics.get(topic.toLowerCase()) ?? 0), 0)))) })); }
export async function addInterest(ownerId: string, value: InterestProfile) { const db = await requireDb(); if (db) await db.from("interest_profiles").upsert(interestRow(ownerId, value), { onConflict: "owner_id,id" }); }
export async function addSource(ownerId: string, value: Source) { const db = await requireDb(); if (db) await db.from("sources").upsert(sourceRow(ownerId, value), { onConflict: "owner_id,id" }); }
export async function saveWorkspaceSettings(ownerId: string, value: WorkspaceSettings) { const db = await requireDb(); if (!db) return; await ensureOwner(ownerId); const { error } = await db.from("profiles").update({ daily_generation_enabled: value.dailyGeneration, episode_length: value.episodeLength, publish_time: value.publishTime, updated_at: new Date().toISOString() }).eq("id", ownerId); if (error) throw new Error(error.message); }
export type ActiveVoiceProfile = VoiceProfile & { sampleKey: string };
export async function getActiveVoiceProfile(ownerId: string): Promise<ActiveVoiceProfile | null> {
  const db = await requireDb();
  if (!db) return null;
  const { data, error } = await db.from("voice_profiles").select().eq("owner_id", ownerId).eq("active", true).maybeSingle();
  if (error) return null; // Allows existing workspaces to start before the additive migration is applied.
  return data && typeof data.sample_key === "string" ? { ...mapVoiceProfile(data), sampleKey: data.sample_key } : null;
}
export async function saveVoiceProfile(ownerId: string, value: VoiceProfile, sampleKey: string): Promise<void> {
  const db = await requireDb();
  if (!db) throw new Error("Supabase is not configured. A voice profile needs durable workspace storage.");
  const { error: createError } = await db.from("voice_profiles").insert({ id: value.id, owner_id: ownerId, provider: value.provider, display_name: value.name, sample_key: sampleKey, active: false, created_at: value.createdAt, updated_at: new Date().toISOString() });
  if (createError) throw new Error(`Unable to save voice profile. Run the latest Supabase migration first: ${createError.message}`);
  const { error: deactivateError } = await db.from("voice_profiles").update({ active: false, updated_at: new Date().toISOString() }).eq("owner_id", ownerId).neq("id", value.id);
  if (deactivateError) throw new Error(deactivateError.message);
  const { error } = await db.from("voice_profiles").update({ active: true, updated_at: new Date().toISOString() }).eq("id", value.id).eq("owner_id", ownerId);
  if (error) throw new Error(`Unable to save voice profile. Run the latest Supabase migration first: ${error.message}`);
}
export async function selectVoiceProfile(ownerId: string, voiceId: string): Promise<void> { const db = await requireDb(); if (!db) throw new Error("Supabase is not configured."); const { data, error: lookupError } = await db.from("voice_profiles").select("id, sample_key").eq("id", voiceId).eq("owner_id", ownerId).maybeSingle(); if (lookupError || !data || typeof data.sample_key !== "string") throw new Error("Voice profile not found."); const { error: deactivateError } = await db.from("voice_profiles").update({ active: false, updated_at: new Date().toISOString() }).eq("owner_id", ownerId); if (deactivateError) throw new Error(deactivateError.message); const { error } = await db.from("voice_profiles").update({ active: true, updated_at: new Date().toISOString() }).eq("id", voiceId).eq("owner_id", ownerId); if (error) throw new Error(error.message); }
export async function disconnectVoiceProfile(ownerId: string): Promise<string | null> {
  const db = await requireDb();
  if (!db) return null;
  const { data: previous, error: previousError } = await db.from("voice_profiles").select("id, sample_key").eq("owner_id", ownerId).eq("active", true).maybeSingle();
  if (previousError && !/does not exist|column/i.test(previousError.message)) throw new Error(previousError.message);
  if (!previous) return null;
  const { error } = await db.from("voice_profiles").delete().eq("id", previous.id).eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
  const { data: fallback, error: fallbackError } = await db.from("voice_profiles").select("id").eq("owner_id", ownerId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (fallbackError) throw new Error(fallbackError.message);
  if (fallback) {
    const { error: activateError } = await db.from("voice_profiles").update({ active: true, updated_at: new Date().toISOString() }).eq("id", fallback.id).eq("owner_id", ownerId);
    if (activateError) throw new Error(activateError.message);
  }
  return typeof previous?.sample_key === "string" ? previous.sample_key : null;
}
export async function upsertItems(ownerId: string, items: ContentItem[]) { const db = await requireDb(); if (db && items.length) await db.from("content_items").upsert(items.map((x) => itemRow(ownerId, x)), { onConflict: "owner_id,id" }); }
export async function findItems(ownerId: string, ids: string[]) { const db = await requireDb(); if (!db || !ids.length) return []; const { data } = await db.from("content_items").select().eq("owner_id", ownerId).in("id", ids); const lookup = new Map((data ?? []).map((x: Row) => [x.id, mapItem(x)])); return ids.map((id) => lookup.get(id)).filter((x): x is ContentItem => Boolean(x)); }
export async function findEpisode(ownerId: string, episodeId: string): Promise<Episode | null> { const db = await requireDb(); if (!db) return null; const { data, error } = await db.from("episodes").select().eq("owner_id", ownerId).eq("id", episodeId).maybeSingle(); if (error) throw new Error(error.message); return data ? mapEpisode(data) : null; }
export async function createEpisode(
  ownerId: string,
  episode: Episode,
  claims: EvidenceClaim[],
  audio?: ArrayBuffer | null,
  requestBaseUrl?: string,
  audioContentType = "audio/mpeg",
): Promise<Episode> {
  void requestBaseUrl;
  episode.durationSeconds = storedDurationSeconds(episode.durationSeconds);
  const db = await requireDb();
  if (!db) return episode;

  let uploadedAudioKey: string | null = null;
  if (audio) {
    const extension = audioContentType.includes("wav") ? "wav" : "mp3";
    const key = `audio/${ownerId.replace(/[^a-z0-9]/gi, "_")}/${episode.id}.${extension}`;
    const { error } = await db.storage
      .from(MEDIA_BUCKET)
      .upload(key, new Uint8Array(audio), {
        contentType: audioContentType,
        cacheControl: "31536000",
        upsert: false,
      });
    if (error) {
      console.error(
        `[storage] upload failed bucket=${MEDIA_BUCKET} key=${key} bytes=${audio.byteLength}`,
        error,
      );
      throw new Error(`Unable to store episode audio: ${error.message}`);
    }
    uploadedAudioKey = key;
    episode.audioKey = key;
    episode.audioBytes = audio.byteLength;
    episode.audioUrl = mediaUrl(key);
  }

  const { error: episodeError } = await db
    .from("episodes")
    .insert(episodeRow(ownerId, episode));
  if (episodeError) {
    if (uploadedAudioKey) {
      const { error: cleanupError } = await db.storage
        .from(MEDIA_BUCKET)
        .remove([uploadedAudioKey]);
      if (cleanupError) {
        console.error(
          `[storage] cleanup failed bucket=${MEDIA_BUCKET} key=${uploadedAudioKey}`,
          cleanupError,
        );
      }
    }
    throw new Error(`Unable to store generated episode: ${episodeError.message}`);
  }

  if (claims.length) {
    const { error: evidenceError } = await db.from("evidence").insert(
      claims.map((claim) => ({
        id: claim.id,
        episode_id: claim.episodeId,
        content_item_id: claim.contentItemId,
        claim: claim.claim,
        support: claim.support,
        source_url: claim.sourceUrl,
        confidence: claim.confidence,
        location: claim.location,
      })),
    );
    if (evidenceError) {
      await db
        .from("episodes")
        .delete()
        .eq("id", episode.id)
        .eq("owner_id", ownerId);
      if (uploadedAudioKey) {
        await db.storage.from(MEDIA_BUCKET).remove([uploadedAudioKey]);
      }
      throw new Error(
        `Unable to store generated episode evidence: ${evidenceError.message}`,
      );
    }
  }
  return episode;
}
export async function replaceEpisodeAudio(
  ownerId: string,
  episode: Episode,
  audio: ArrayBuffer,
  audioContentType = "audio/mpeg",
  durationSeconds = episode.durationSeconds,
): Promise<Episode> {
  const persistedDurationSeconds = storedDurationSeconds(durationSeconds);
  const scale =
    persistedDurationSeconds / Math.max(1, episode.durationSeconds);
  const chapters = episode.chapters.map((chapter) => ({
    ...chapter,
    startSeconds: Math.min(
      persistedDurationSeconds,
      Math.round(chapter.startSeconds * scale),
    ),
  }));
  const db = await requireDb();
  if (!db) {
    return {
      ...episode,
      audioBytes: audio.byteLength,
      chapters,
      durationSeconds: persistedDurationSeconds,
    };
  }
  const extension = audioContentType.includes("wav") ? "wav" : "mp3";
  const key = `audio/${ownerId.replace(/[^a-z0-9]/gi, "_")}/${episode.id}-voice-${Date.now()}.${extension}`;
  const { error: uploadError } = await db.storage
    .from(MEDIA_BUCKET)
    .upload(key, new Uint8Array(audio), {
      contentType: audioContentType,
      cacheControl: "31536000",
      upsert: false,
    });
  if (uploadError) {
    throw new Error(`Unable to store regenerated audio: ${uploadError.message}`);
  }
  const nextAudioUrl = mediaUrl(key);
  const { error } = await db
    .from("episodes")
    .update({
      audio_key: key,
      audio_url: nextAudioUrl,
      audio_bytes: audio.byteLength,
      chapters_json: chapters,
      duration_seconds: persistedDurationSeconds,
      updated_at: new Date().toISOString(),
    })
    .eq("id", episode.id)
    .eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
  if (episode.audioKey) {
    await db.storage.from(MEDIA_BUCKET).remove([episode.audioKey]);
  }
  return {
    ...episode,
    audioKey: key,
    audioUrl: nextAudioUrl,
    audioBytes: audio.byteLength,
    chapters,
    durationSeconds: persistedDurationSeconds,
  };
}
export async function approveEpisode(ownerId: string, episodeId: string) { const db = await requireDb(); if (!db) return; const { data } = await db.from("episodes").select("audio_key, audio_url, published_at").eq("id", episodeId).eq("owner_id", ownerId).single(); if (!data) return; const hasAudio = Boolean(data.audio_key || data.audio_url); await db.from("episodes").update({ status: hasAudio ? "published" : "approved", published_at: hasAudio ? (data.published_at ?? new Date().toISOString()) : null, updated_at: new Date().toISOString() }).eq("id", episodeId).eq("owner_id", ownerId); }
export async function updateEpisode(ownerId: string, episodeId: string, patch: Pick<Partial<Episode>, "script" | "transcript" | "showNotes" | "linkedInPost">) {
  const db = await requireDb();
  if (!db) return;
  const updates: Row = { updated_at: new Date().toISOString() };
  if (typeof patch.script === "string") updates.script = patch.script;
  if (typeof patch.transcript === "string") updates.transcript = patch.transcript;
  if (typeof patch.showNotes === "string") updates.show_notes = patch.showNotes;
  if (typeof patch.linkedInPost === "string" || patch.linkedInPost === null) updates.linkedin_post = patch.linkedInPost;
  const { error } = await db.from("episodes").update(updates).eq("id", episodeId).eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
}
export async function saveLinkedInPost(ownerId: string, episodeId: string, post: string): Promise<Episode> {
  const db = await requireDb();
  if (!db) throw new Error("Supabase is not configured. A LinkedIn post needs durable workspace storage.");
  const { data, error } = await db
    .from("episodes")
    .update({ linkedin_post: post, updated_at: new Date().toISOString() })
    .eq("id", episodeId)
    .eq("owner_id", ownerId)
    .select()
    .maybeSingle();
  if (error) {
    const migrationHint =
      error.code === "PGRST204" || /linkedin_post/i.test(error.message)
        ? " Run the latest Supabase migration first."
        : "";
    throw new Error(
      `Unable to save the LinkedIn post.${migrationHint} ${error.message}`,
    );
  }
  if (!data) throw new EpisodeNotFoundError();
  return mapEpisode(data);
}
export async function deleteWorkspace(ownerId: string): Promise<string[]> {
  const db = await requireDb();
  if (!db) return [];
  const { data: voiceProfiles } = await db.from("voice_profiles").select("sample_key").eq("owner_id", ownerId);
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
  if (collectionIds.length) await db.from("collection_items").delete().eq("owner_id", ownerId).in("collection_id", collectionIds);
  await db.from("collections").delete().eq("owner_id", ownerId);
  await db.from("content_items").delete().eq("owner_id", ownerId);
  await db.from("sources").delete().eq("owner_id", ownerId);
  await db.from("interest_profiles").delete().eq("owner_id", ownerId);
  await db.from("voice_profiles").delete().eq("owner_id", ownerId);
  await db
    .from("profiles")
    .update({
      daily_generation_enabled: true,
      episode_length: "standard",
      publish_time: "08:00",
      daily_budget_usd: 2,
      updated_at: new Date().toISOString(),
    })
    .eq("id", ownerId);
  return (voiceProfiles ?? []).map((profile: Row) => profile.sample_key).filter((key): key is string => typeof key === "string");
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
  if (collectionIds.length) await db.from("collection_items").delete().eq("owner_id", ownerId).in("collection_id", collectionIds);
  await db.from("collections").delete().eq("owner_id", ownerId);
  await db.from("content_items").delete().eq("owner_id", ownerId);
}
export async function getPublicEpisodes() { const db = await requireDb(); if (!db) return []; const { data, error } = await db.from("episodes").select().eq("status", "published").not("audio_key", "is", null).order("published_at", { ascending: false }); if (error) throw new Error(error.message); return (data ?? []).map(mapEpisode); }
export async function getPublicEpisode(id: string) { const db = await requireDb(); if (!db) return null; const { data } = await db.from("episodes").select().eq("id", id).eq("status", "published").maybeSingle(); return data ? mapEpisode(data) : null; }
export async function getMediaEpisodeAccess(key: string): Promise<{ ownerId: string; status: Episode["status"] } | null> { const db = await requireDb(); if (!db) return null; const { data, error } = await db.from("episodes").select("owner_id, status").eq("audio_key", key).limit(1).maybeSingle(); if (error) throw new Error(error.message); return data ? { ownerId: data.owner_id, status: data.status } : null; }
export async function getSignedMediaUrl(key: string, expiresInSeconds = 60) { const db = await requireDb(); if (!db) return null; const { data, error } = await db.storage.from(MEDIA_BUCKET).createSignedUrl(key, expiresInSeconds); if (error || !data?.signedUrl) return null; return data.signedUrl; }
export async function recordJob(ownerId: string, job: { id: string; stage: string; status: JobRun["status"]; provider?: string; costUsd?: number; error?: string }) { const db = await requireDb(); if (db) await db.from("job_runs").upsert({ id: job.id, owner_id: ownerId, stage: job.stage, status: job.status, provider: job.provider ?? null, cost_usd: job.costUsd ?? 0, error: job.error ?? null, idempotency_key: job.id, completed_at: job.status === "completed" || job.status === "failed" ? new Date().toISOString() : null }, { onConflict: "owner_id,id" }); }
