import { buildTechRadar } from "./domain";
import { mediaUrl } from "./media-path";
import { normalizeEpisodeLength } from "./podcast-length";
import { normalizeEvidenceConfidence } from "./podcast-schema";
import { loadAllPaginatedRows } from "./supabase-pagination";
import { getSupabase, MEDIA_BUCKET } from "./supabase";
import type { Collection, ContentItem, DashboardState, Episode, EpisodeAudioVariant, EpisodeGenerationWarning, EpisodeTitleProvenance, EvidenceClaim, InterestProfile, JobRun, Source, VoiceProfile, WorkspaceSettings } from "./types";

// Supabase rows are intentionally schema-flexible at this server boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
export class EpisodeNotFoundError extends Error {
  constructor(message = "Episode not found.") {
    super(message);
    this.name = "EpisodeNotFoundError";
  }
}
export class EpisodeGenerationWarningApprovalRequiredError extends Error {
  constructor(
    message = "This episode has a generation warning. Confirm the override before publishing.",
  ) {
    super(message);
    this.name = "EpisodeGenerationWarningApprovalRequiredError";
  }
}
export class EpisodeAudioVariantNotFoundError extends Error {
  constructor(message = "Audio variant not found for this episode.") {
    super(message);
    this.name = "EpisodeAudioVariantNotFoundError";
  }
}
const GENERATION_WARNINGS: readonly EpisodeGenerationWarning[] = [
  "title_validation_failed",
  "length_below_target",
];
function generationWarning(value: unknown): EpisodeGenerationWarning | null {
  return GENERATION_WARNINGS.find((warning) => warning === value) ?? null;
}
const TITLE_PROVENANCE: readonly EpisodeTitleProvenance[] = [
  "provisional",
  "gemini",
  "manual",
];
function episodeTitleProvenance(value: unknown): EpisodeTitleProvenance | null {
  return TITLE_PROVENANCE.find((provenance) => provenance === value) ?? null;
}
const iso = (value: unknown) => value ? new Date(String(value)).toISOString() : null;
const array = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
function mapInterest(row: Row): InterestProfile { return { id: row.id, name: row.name, query: row.query, keywords: array(row.keywords_json), exclusions: array(row.exclusions_json), preferredSources: array(row.preferred_sources_json), freshnessDays: row.freshness_days, weight: Number(row.weight), enabled: Boolean(row.enabled) }; }
function mapSource(row: Row): Source { return { id: row.id, name: row.name, type: row.type, url: row.url, trustLevel: row.trust_level, rightsMode: row.rights_mode, enabled: Boolean(row.enabled), lastSuccessfulFetch: iso(row.last_successful_fetch) }; }
function mapItem(row: Row): ContentItem { return { id: row.id, kind: row.kind, title: row.title, summary: row.summary, authors: array(row.authors_json), sourceName: row.source_name, sourceId: row.source_id ?? undefined, canonicalUrl: row.canonical_url, documentUrl: row.document_url ?? undefined, doi: row.doi ?? undefined, arxivId: row.arxiv_id ?? undefined, publishedAt: iso(row.published_at)!, accessLevel: row.access_level, peerReviewState: row.peer_review_state, topics: array(row.topics_json), score: Number(row.score), trend: row.trend, citationCount: Number(row.citation_count), readingMinutes: Number(row.reading_minutes), saved: Boolean(row.saved), listened: Boolean(row.listened), processingState: row.processing_state }; }
function legacyAudioVariant(row: Row, audioKey: string): EpisodeAudioVariant {
  const createdAt = iso(row.created_at) ?? new Date(0).toISOString();
  return {
    id: typeof row.default_audio_variant_id === "string"
      ? row.default_audio_variant_id
      : `audio-variant-legacy-${row.id}`,
    voiceId: null,
    voiceKey: `legacy:${audioKey}`,
    voiceName: "Original audio",
    provider: "legacy",
    audioUrl: mediaUrl(audioKey),
    audioKey,
    audioBytes: typeof row.audio_bytes === "number" ? row.audio_bytes : null,
    contentType: audioKey.toLowerCase().endsWith(".wav")
      ? "audio/wav"
      : "audio/mpeg",
    durationSeconds: storedDurationSeconds(Number(row.duration_seconds)),
    chapters: array(row.chapters_json),
    isDefault: true,
    createdAt,
    updatedAt: iso(row.updated_at) ?? createdAt,
  };
}
function mapEpisodeAudioVariant(
  row: Row,
  defaultAudioVariantId: string | null,
): EpisodeAudioVariant {
  const createdAt = iso(row.created_at) ?? new Date(0).toISOString();
  return {
    id: row.id,
    voiceId: typeof row.voice_profile_id === "string"
      ? row.voice_profile_id
      : null,
    voiceKey: row.voice_key,
    voiceName: row.voice_name,
    provider: row.provider,
    audioUrl: mediaUrl(row.audio_key),
    audioKey: row.audio_key,
    audioBytes: typeof row.audio_bytes === "number" ? row.audio_bytes : null,
    contentType: row.content_type,
    durationSeconds: storedDurationSeconds(Number(row.duration_seconds)),
    chapters: array(row.chapters_json),
    isDefault: row.id === defaultAudioVariantId,
    createdAt,
    updatedAt: iso(row.updated_at) ?? createdAt,
  };
}
function mapEpisode(row: Row, variantRows: Row[] = []): Episode {
  const storedAudioKey = typeof row.audio_key === "string" ? row.audio_key : null;
  const requestedDefaultId = typeof row.default_audio_variant_id === "string"
    ? row.default_audio_variant_id
    : null;
  const effectiveDefaultId =
    variantRows.some((variant) => variant.id === requestedDefaultId)
      ? requestedDefaultId
      : variantRows.find((variant) => variant.audio_key === storedAudioKey)?.id ??
        variantRows[0]?.id ??
        null;
  const mappedVariants = variantRows.map((variant) =>
    mapEpisodeAudioVariant(variant, effectiveDefaultId)
  );
  if (!mappedVariants.length && storedAudioKey) {
    mappedVariants.push(legacyAudioVariant(row, storedAudioKey));
  }
  const defaultVariant = mappedVariants.find((variant) => variant.isDefault) ??
    mappedVariants[0] ??
    null;
  const audioKey = defaultVariant?.audioKey ?? storedAudioKey;
  const rowChapters = array<Episode["chapters"][number]>(row.chapters_json);
  const titleProvenance = episodeTitleProvenance(row.title_provenance);
  return {
    id: row.id,
    contentItemId: row.content_item_id ?? undefined,
    type: row.type,
    title: row.title,
    dek: row.dek,
    script: row.script,
    showNotes: row.show_notes,
    transcript: row.transcript,
    linkedInPost: typeof row.linkedin_post === "string" ? row.linkedin_post : null,
    generationWarning: generationWarning(row.generation_warning),
    ...(titleProvenance ? { titleProvenance } : {}),
    citations: array(row.citations_json),
    chapters: defaultVariant?.chapters ?? rowChapters,
    audioUrl: defaultVariant?.audioUrl ?? (audioKey ? mediaUrl(audioKey) : row.audio_url),
    audioKey,
    audioBytes: defaultVariant?.audioBytes ?? row.audio_bytes,
    defaultAudioVariantId: defaultVariant?.id ?? null,
    audioVariants: mappedVariants,
    durationSeconds: defaultVariant?.durationSeconds ?? Number(row.duration_seconds),
    status: row.status,
    publishedAt: iso(row.published_at),
    immutableGuid: row.immutable_guid,
    generation: Number(row.generation),
    createdAt: iso(row.created_at)!,
  };
}
function mapEvidence(row: Row): EvidenceClaim { return { id: row.id, episodeId: row.episode_id, contentItemId: row.content_item_id, claim: row.claim, support: row.support, sourceUrl: row.source_url, confidence: normalizeEvidenceConfidence(row.confidence), location: row.location }; }
function mapVoiceProfile(row: Row): VoiceProfile { return { id: row.id, name: row.display_name, provider: "chatterbox", active: Boolean(row.active), createdAt: iso(row.created_at)! }; }
function workspaceSettings(row: Row | null | undefined): WorkspaceSettings { return { dailyGeneration: row?.daily_generation_enabled ?? true, episodeLength: normalizeEpisodeLength(row?.episode_length), publishTime: typeof row?.publish_time === "string" && /^\d{2}:\d{2}$/.test(row.publish_time) ? row.publish_time : "08:00" }; }
function interestRow(ownerId: string, value: InterestProfile): Row { return { id: value.id, owner_id: ownerId, name: value.name, query: value.query, keywords_json: value.keywords, exclusions_json: value.exclusions, preferred_sources_json: value.preferredSources, freshness_days: value.freshnessDays, weight: value.weight, enabled: value.enabled, updated_at: new Date().toISOString() }; }
function sourceRow(ownerId: string, value: Source): Row { return { id: value.id, owner_id: ownerId, name: value.name, type: value.type, url: value.url, trust_level: value.trustLevel, rights_mode: value.rightsMode, enabled: value.enabled, last_successful_fetch: value.lastSuccessfulFetch, updated_at: new Date().toISOString() }; }
function itemRow(ownerId: string, value: ContentItem): Row { return { id: value.id, owner_id: ownerId, kind: value.kind, title: value.title, summary: value.summary, authors_json: value.authors, source_name: value.sourceName, source_id: value.sourceId ?? null, canonical_url: value.canonicalUrl, document_url: value.documentUrl ?? null, doi: value.doi ?? null, arxiv_id: value.arxivId ?? null, published_at: value.publishedAt, access_level: value.accessLevel, peer_review_state: value.peerReviewState, topics_json: value.topics, score: value.score, trend: value.trend, citation_count: value.citationCount, reading_minutes: value.readingMinutes, saved: value.saved, listened: value.listened, processing_state: value.processingState, updated_at: new Date().toISOString() }; }
export function storedDurationSeconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
function episodeRow(ownerId: string, value: Episode): Row {
  const row: Row = { id: value.id, owner_id: ownerId, content_item_id: value.contentItemId ?? null, type: value.type, title: value.title, dek: value.dek, script: value.script, show_notes: value.showNotes, transcript: value.transcript, linkedin_post: value.linkedInPost ?? null, generation_warning: value.generationWarning ?? null, citations_json: value.citations, citation_count: value.citations.length, chapters_json: value.chapters, audio_url: value.audioUrl, audio_key: value.audioKey ?? null, audio_bytes: value.audioBytes ?? null, duration_seconds: storedDurationSeconds(value.durationSeconds), status: value.status, published_at: value.publishedAt, immutable_guid: value.immutableGuid, generation: value.generation, created_at: value.createdAt, updated_at: new Date().toISOString() };
  if (value.titleProvenance !== undefined) {
    row.title_provenance = value.titleProvenance;
  }
  if (value.defaultAudioVariantId !== undefined) {
    row.default_audio_variant_id = value.defaultAudioVariantId;
  }
  return row;
}

type AudioVariantTableResult = {
  rows: Row[];
  available: boolean;
};

function isMissingAudioVariantTableError(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" ||
    error.code === "PGRST205" ||
    /episode_audio_variants.*(?:does not exist|schema cache)|(?:does not exist|schema cache).*episode_audio_variants/i.test(error.message ?? "");
}

async function loadAudioVariantRowsForOwner(
  db: NonNullable<ReturnType<typeof getSupabase>>,
  ownerId: string,
): Promise<AudioVariantTableResult> {
  const result = await loadAllPaginatedRows<Row>((from, to) =>
    db
      .from("episode_audio_variants")
      .select()
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: true })
      .range(from, to)
  );
  if (result.error) {
    if (isMissingAudioVariantTableError(result.error)) {
      return { rows: [], available: false };
    }
    throw new Error(result.error.message);
  }
  return { rows: result.data, available: true };
}

async function loadAudioVariantRowsForEpisodes(
  db: NonNullable<ReturnType<typeof getSupabase>>,
  ownerId: string,
  episodeIds: string[],
): Promise<AudioVariantTableResult> {
  if (!episodeIds.length) return { rows: [], available: true };
  const result = await loadAllPaginatedRows<Row>((from, to) =>
    db
      .from("episode_audio_variants")
      .select()
      .eq("owner_id", ownerId)
      .in("episode_id", episodeIds)
      .order("created_at", { ascending: true })
      .range(from, to)
  );
  if (result.error) {
    if (isMissingAudioVariantTableError(result.error)) {
      return { rows: [], available: false };
    }
    throw new Error(result.error.message);
  }
  return { rows: result.data, available: true };
}

function audioVariantRowsByEpisode(rows: Row[]): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    grouped.set(row.episode_id, [...(grouped.get(row.episode_id) ?? []), row]);
  }
  return grouped;
}

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
  const [interests, sources, items, collections, episodes, jobs, profile, voiceProfiles, audioVariants] = await Promise.all([
    db.from("interest_profiles").select().eq("owner_id", ownerId).order("weight", { ascending: false }), db.from("sources").select().eq("owner_id", ownerId).order("name"), loadAllPaginatedRows<Row>((from, to) => db.from("content_items").select().eq("owner_id", ownerId).order("score", { ascending: false }).order("published_at", { ascending: false }).order("id").range(from, to)), db.from("collections").select().eq("owner_id", ownerId), db.from("episodes").select().eq("owner_id", ownerId).order("created_at", { ascending: false }), db.from("job_runs").select().eq("owner_id", ownerId).order("started_at", { ascending: false }).limit(20), db.from("profiles").select().eq("id", ownerId).single(), db.from("voice_profiles").select().eq("owner_id", ownerId).order("created_at", { ascending: false }), loadAudioVariantRowsForOwner(db, ownerId),
  ]);
  if (interests.error || sources.error || items.error || episodes.error) throw new Error(interests.error?.message || sources.error?.message || items.error?.message || episodes.error?.message || "Unable to load Supabase state.");
  const variantsByEpisode = audioVariantRowsByEpisode(audioVariants.rows);
  const mappedItems = (items.data ?? []).map(mapItem); const mappedEpisodes = (episodes.data ?? []).map((row: Row) => mapEpisode(row, variantsByEpisode.get(row.id) ?? []));
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
export async function getVoiceProfileById(
  ownerId: string,
  voiceId: string,
): Promise<ActiveVoiceProfile | null> {
  const db = await requireDb();
  if (!db) return null;
  const { data, error } = await db
    .from("voice_profiles")
    .select()
    .eq("owner_id", ownerId)
    .eq("id", voiceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data && typeof data.sample_key === "string"
    ? { ...mapVoiceProfile(data), sampleKey: data.sample_key }
    : null;
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
export async function findEpisode(ownerId: string, episodeId: string): Promise<Episode | null> {
  const db = await requireDb();
  if (!db) return null;
  const [{ data, error }, variants] = await Promise.all([
    db.from("episodes").select().eq("owner_id", ownerId).eq("id", episodeId).maybeSingle(),
    loadAudioVariantRowsForEpisodes(db, ownerId, [episodeId]),
  ]);
  if (error) throw new Error(error.message);
  return data ? mapEpisode(data, variants.rows) : null;
}
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

  if (uploadedAudioKey) {
    const now = new Date().toISOString();
    const variantId = `audio-variant-${crypto.randomUUID()}`;
    const voiceKey = "legacy";
    const variantRow = {
      id: variantId,
      owner_id: ownerId,
      episode_id: episode.id,
      voice_profile_id: null,
      voice_key: voiceKey,
      voice_name: "Original audio",
      provider: "legacy",
      audio_key: uploadedAudioKey,
      audio_bytes: audio?.byteLength ?? null,
      content_type: audioContentType,
      duration_seconds: storedDurationSeconds(episode.durationSeconds),
      chapters_json: episode.chapters,
      created_at: now,
      updated_at: now,
    };
    const variantInsert = await db
      .from("episode_audio_variants")
      .insert(variantRow);
    if (variantInsert.error && !isMissingAudioVariantTableError(variantInsert.error)) {
      await db.from("episodes").delete().eq("id", episode.id).eq("owner_id", ownerId);
      await db.storage.from(MEDIA_BUCKET).remove([uploadedAudioKey]);
      throw new Error(`Unable to store generated episode audio metadata: ${variantInsert.error.message}`);
    }
    if (!variantInsert.error) {
      const { error: defaultError } = await db
        .from("episodes")
        .update({ default_audio_variant_id: variantId })
        .eq("id", episode.id)
        .eq("owner_id", ownerId);
      if (defaultError) {
        await db.from("episodes").delete().eq("id", episode.id).eq("owner_id", ownerId);
        await db.storage.from(MEDIA_BUCKET).remove([uploadedAudioKey]);
        throw new Error(`Unable to select generated episode audio: ${defaultError.message}`);
      }
      const variant = mapEpisodeAudioVariant(variantRow, variantId);
      episode.defaultAudioVariantId = variantId;
      episode.audioVariants = [variant];
    } else {
      const fallback = legacyAudioVariant(
        {
          ...episodeRow(ownerId, episode),
          updated_at: now,
        },
        uploadedAudioKey,
      );
      episode.defaultAudioVariantId = fallback.id;
      episode.audioVariants = [fallback];
    }
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
export type EpisodeAudioVoiceMetadata = {
  voiceProfileId: string | null;
  voiceKey: string;
  voiceName: string;
  provider: string;
};

async function removeUploadedAudio(
  db: NonNullable<ReturnType<typeof getSupabase>>,
  key: string,
  message: string,
): Promise<void> {
  const { error } = await db.storage.from(MEDIA_BUCKET).remove([key]);
  if (error) {
    console.error(`[storage] ${message} bucket=${MEDIA_BUCKET} key=${key}`, error);
  }
}

async function replaceEpisodeAudioWithoutVariants(
  db: NonNullable<ReturnType<typeof getSupabase>>,
  ownerId: string,
  episode: Episode,
  audio: ArrayBuffer,
  audioContentType: string,
  persistedDurationSeconds: number,
  chapters: Episode["chapters"],
  previousAudioKey: string | null,
): Promise<Episode> {
  const extension = audioContentType.includes("wav") ? "wav" : "mp3";
  const key = `audio/${ownerId.replace(/[^a-z0-9]/gi, "_")}/${episode.id}-voice-${crypto.randomUUID()}.${extension}`;
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
  const { data: updatedEpisode, error } = await db
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
    .eq("owner_id", ownerId)
    .select("id")
    .maybeSingle();
  if (error || !updatedEpisode) {
    await removeUploadedAudio(db, key, "cleanup failed");
    throw new Error(
      error?.message ?? "Episode not found while storing regenerated audio.",
    );
  }
  if (previousAudioKey && previousAudioKey !== key) {
    await removeUploadedAudio(db, previousAudioKey, "previous audio cleanup failed");
  }
  const now = new Date().toISOString();
  const fallbackVariant: EpisodeAudioVariant = {
    id: `audio-variant-legacy-${episode.id}`,
    voiceId: null,
    voiceKey: `legacy:${key}`,
    voiceName: "Original audio",
    provider: "legacy",
    audioUrl: nextAudioUrl,
    audioKey: key,
    audioBytes: audio.byteLength,
    contentType: audioContentType,
    durationSeconds: persistedDurationSeconds,
    chapters,
    isDefault: true,
    createdAt: episode.createdAt,
    updatedAt: now,
  };
  return {
    ...episode,
    audioKey: key,
    audioUrl: nextAudioUrl,
    audioBytes: audio.byteLength,
    defaultAudioVariantId: fallbackVariant.id,
    audioVariants: [fallbackVariant],
    chapters,
    durationSeconds: persistedDurationSeconds,
  };
}

export async function replaceEpisodeAudio(
  ownerId: string,
  episode: Episode,
  audio: ArrayBuffer,
  audioContentType = "audio/mpeg",
  durationSeconds = episode.durationSeconds,
  voice?: EpisodeAudioVoiceMetadata,
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
  const [persistedEpisode, variants] = await Promise.all([
    db
      .from("episodes")
      .select("id, audio_key, default_audio_variant_id")
      .eq("id", episode.id)
      .eq("owner_id", ownerId)
      .maybeSingle(),
    loadAudioVariantRowsForEpisodes(db, ownerId, [episode.id]),
  ]);
  if (persistedEpisode.error) throw new Error(persistedEpisode.error.message);
  if (!persistedEpisode.data) {
    throw new EpisodeNotFoundError("Episode not found while storing regenerated audio.");
  }
  const persistedEpisodeRow = persistedEpisode.data;
  if (!variants.available) {
    return replaceEpisodeAudioWithoutVariants(
      db,
      ownerId,
      episode,
      audio,
      audioContentType,
      persistedDurationSeconds,
      chapters,
      typeof persistedEpisodeRow.audio_key === "string"
        ? persistedEpisodeRow.audio_key
        : null,
    );
  }

  const episodeVariantRows = variants.rows.filter(
    (variant) =>
      variant.owner_id === ownerId && variant.episode_id === episode.id,
  );
  const currentDefault = episodeVariantRows.find(
    (variant) => variant.id === persistedEpisodeRow.default_audio_variant_id,
  );
  const resolvedVoice: EpisodeAudioVoiceMetadata = voice ?? (currentDefault
    ? {
        voiceProfileId: typeof currentDefault.voice_profile_id === "string"
          ? currentDefault.voice_profile_id
          : null,
        voiceKey: currentDefault.voice_key,
        voiceName: currentDefault.voice_name,
        provider: currentDefault.provider,
      }
    : {
        voiceProfileId: null,
        voiceKey: `legacy:${persistedEpisodeRow.audio_key ?? episode.id}`,
        voiceName: "Original audio",
        provider: "legacy",
      });
  const voiceKey = resolvedVoice.voiceKey.trim();
  const voiceName = resolvedVoice.voiceName.trim();
  const provider = resolvedVoice.provider.trim();
  if (!voiceKey || !voiceName || !provider) {
    throw new Error("Audio voice metadata is incomplete.");
  }

  const extension = audioContentType.includes("wav") ? "wav" : "mp3";
  const voicePath = voiceKey.replace(/[^a-z0-9_-]/gi, "_").slice(0, 96) || "voice";
  const key = `audio/${ownerId.replace(/[^a-z0-9]/gi, "_")}/${episode.id}/${voicePath}-${crypto.randomUUID()}.${extension}`;
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

  const existingVariant = episodeVariantRows.find(
    (variant) => variant.voice_key === voiceKey,
  );
  const variantId = existingVariant?.id ?? `audio-variant-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const variantValues = {
    owner_id: ownerId,
    episode_id: episode.id,
    voice_profile_id: resolvedVoice.voiceProfileId,
    voice_key: voiceKey,
    voice_name: voiceName,
    provider,
    audio_key: key,
    audio_bytes: audio.byteLength,
    content_type: audioContentType,
    duration_seconds: persistedDurationSeconds,
    chapters_json: chapters,
    updated_at: now,
  };
  const variantWrite = existingVariant
    ? await db
        .from("episode_audio_variants")
        .update(variantValues)
        .eq("id", variantId)
        .eq("owner_id", ownerId)
        .eq("episode_id", episode.id)
        .select("id")
        .maybeSingle()
    : await db
        .from("episode_audio_variants")
        .insert({
          id: variantId,
          ...variantValues,
          created_at: now,
        })
        .select("id")
        .maybeSingle();
  if (variantWrite.error || !variantWrite.data) {
    await removeUploadedAudio(db, key, "cleanup failed");
    throw new Error(
      `Unable to store regenerated audio metadata: ${variantWrite.error?.message ?? "variant row was not written"}`,
    );
  }

  const restoreVariantAfterFailure = async () => {
    const result = existingVariant
      ? await db
          .from("episode_audio_variants")
          .update({
            voice_profile_id: existingVariant.voice_profile_id,
            voice_key: existingVariant.voice_key,
            voice_name: existingVariant.voice_name,
            provider: existingVariant.provider,
            audio_key: existingVariant.audio_key,
            audio_bytes: existingVariant.audio_bytes,
            content_type: existingVariant.content_type,
            duration_seconds: existingVariant.duration_seconds,
            chapters_json: existingVariant.chapters_json,
            updated_at: existingVariant.updated_at,
          })
          .eq("id", variantId)
          .eq("owner_id", ownerId)
          .eq("episode_id", episode.id)
      : await db
          .from("episode_audio_variants")
          .delete()
          .eq("id", variantId)
          .eq("owner_id", ownerId)
          .eq("episode_id", episode.id);
    if (result.error) {
      console.error(
        `[storage] audio variant rollback failed episode=${episode.id} variant=${variantId}`,
        result.error,
      );
    }
  };

  const nextAudioUrl = mediaUrl(key);
  const becomesDefault = !persistedEpisodeRow.default_audio_variant_id ||
    persistedEpisodeRow.default_audio_variant_id === variantId;
  if (becomesDefault) {
    const { data: updatedEpisode, error } = await db
      .from("episodes")
      .update({
        default_audio_variant_id: variantId,
        audio_key: key,
        audio_url: nextAudioUrl,
        audio_bytes: audio.byteLength,
        chapters_json: chapters,
        duration_seconds: persistedDurationSeconds,
        updated_at: now,
      })
      .eq("id", episode.id)
      .eq("owner_id", ownerId)
      .select("id")
      .maybeSingle();
    if (error || !updatedEpisode) {
      await restoreVariantAfterFailure();
      await removeUploadedAudio(db, key, "cleanup failed");
      throw new Error(
        error?.message ?? "Episode not found while storing regenerated audio.",
      );
    }
  }

  if (existingVariant?.audio_key && existingVariant.audio_key !== key) {
    await removeUploadedAudio(
      db,
      existingVariant.audio_key,
      "previous voice audio cleanup failed",
    );
  }
  const storedEpisode = await findEpisode(ownerId, episode.id);
  if (!storedEpisode) {
    throw new EpisodeNotFoundError(
      "Episode was removed while regenerated audio was being stored.",
    );
  }
  return storedEpisode;
}

function canonicalAudioVariantUpdates(
  variant: Row,
  updatedAt = new Date().toISOString(),
): Row {
  return {
    default_audio_variant_id: variant.id,
    audio_key: variant.audio_key,
    audio_url: mediaUrl(variant.audio_key),
    audio_bytes: variant.audio_bytes ?? null,
    chapters_json: array(variant.chapters_json),
    duration_seconds: storedDurationSeconds(Number(variant.duration_seconds)),
    updated_at: updatedAt,
  };
}

export async function setEpisodeDefaultAudioVariant(
  ownerId: string,
  episodeId: string,
  audioVariantId: string,
): Promise<Episode> {
  const db = await requireDb();
  if (!db) throw new Error("Supabase is not configured.");
  const { data: currentEpisode, error: episodeError } = await db
    .from("episodes")
    .select("id, status, default_audio_variant_id")
    .eq("id", episodeId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (episodeError) throw new Error(episodeError.message);
  if (!currentEpisode) throw new EpisodeNotFoundError();
  if (
    currentEpisode.status === "published" &&
    currentEpisode.default_audio_variant_id !== audioVariantId
  ) {
    throw new Error(
      "A published episode's default audio cannot be changed. Choose the default when publishing.",
    );
  }
  if (
    currentEpisode.status === "published" &&
    currentEpisode.default_audio_variant_id === audioVariantId
  ) {
    const episode = await findEpisode(ownerId, episodeId);
    if (!episode) throw new EpisodeNotFoundError();
    return episode;
  }
  const { data: variant, error: variantError } = await db
    .from("episode_audio_variants")
    .select()
    .eq("id", audioVariantId)
    .eq("owner_id", ownerId)
    .eq("episode_id", episodeId)
    .maybeSingle();
  if (variantError) {
    if (isMissingAudioVariantTableError(variantError)) {
      throw new Error("Audio variants are unavailable. Run the latest Supabase migration first.");
    }
    throw new Error(variantError.message);
  }
  if (!variant) throw new EpisodeAudioVariantNotFoundError();
  const { data: updated, error } = await db
    .from("episodes")
    .update(canonicalAudioVariantUpdates(variant))
    .eq("id", episodeId)
    .eq("owner_id", ownerId)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!updated) throw new EpisodeNotFoundError();
  const episode = await findEpisode(ownerId, episodeId);
  if (!episode) throw new EpisodeNotFoundError();
  return episode;
}

export async function approveEpisode(
  ownerId: string,
  episodeId: string,
  options: {
    overrideTitleWarning?: boolean;
    defaultAudioVariantId?: string;
  } = {},
) {
  const db = await requireDb();
  if (!db) return;
  const { data, error: lookupError } = await db
    .from("episodes")
    .select("audio_key, audio_url, published_at, generation_warning, default_audio_variant_id, status")
    .eq("id", episodeId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (lookupError) throw new Error(lookupError.message);
  if (!data) throw new EpisodeNotFoundError();
  if (data.generation_warning && !options.overrideTitleWarning) {
    throw new EpisodeGenerationWarningApprovalRequiredError();
  }
  const selectedVariantId = options.defaultAudioVariantId ??
    (typeof data.default_audio_variant_id === "string"
      ? data.default_audio_variant_id
      : null);
  if (
    data.status === "published" &&
    options.defaultAudioVariantId !== undefined &&
    options.defaultAudioVariantId !== data.default_audio_variant_id
  ) {
    throw new Error(
      "A published episode's default audio cannot be changed. Choose the default when publishing.",
    );
  }
  let selectedVariant: Row | null = null;
  if (selectedVariantId) {
    const { data: variant, error: variantError } = await db
      .from("episode_audio_variants")
      .select()
      .eq("id", selectedVariantId)
      .eq("owner_id", ownerId)
      .eq("episode_id", episodeId)
      .maybeSingle();
    if (variantError) {
      if (
        isMissingAudioVariantTableError(variantError) &&
        options.defaultAudioVariantId === undefined
      ) {
        selectedVariant = null;
      } else {
        throw new Error(variantError.message);
      }
    } else if (!variant) {
      throw new EpisodeAudioVariantNotFoundError();
    } else {
      selectedVariant = variant;
    }
  }
  const hasAudio = Boolean(selectedVariant || data.audio_key || data.audio_url);
  const now = new Date().toISOString();
  const updates: Row = {
    status: hasAudio ? "published" : "approved",
    published_at: hasAudio
      ? (data.published_at ?? now)
      : null,
    updated_at: now,
  };
  if (selectedVariant) {
    Object.assign(updates, canonicalAudioVariantUpdates(selectedVariant, now));
  }
  if (!options.overrideTitleWarning) {
    const { data: updated, error } = await db
      .from("episodes")
      .update(updates)
      .eq("id", episodeId)
      .eq("owner_id", ownerId)
      .is("generation_warning", null)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) {
      // An editor may have introduced a warning after the lookup. The write is
      // conditional so approval can never race past the owner override gate.
      throw new EpisodeGenerationWarningApprovalRequiredError();
    }
    return;
  }
  const { error } = await db
    .from("episodes")
    .update(updates)
    .eq("id", episodeId)
    .eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
}
export async function updateEpisode(
  ownerId: string,
  episodeId: string,
  patch: Pick<
    Partial<Episode>,
    | "title"
    | "dek"
    | "script"
    | "transcript"
    | "showNotes"
    | "linkedInPost"
    | "chapters"
    | "generationWarning"
    | "titleProvenance"
  >,
) {
  const db = await requireDb();
  if (!db) return;
  const updates: Row = { updated_at: new Date().toISOString() };
  if (typeof patch.title === "string") updates.title = patch.title;
  if (typeof patch.dek === "string") updates.dek = patch.dek;
  if (typeof patch.script === "string") updates.script = patch.script;
  if (typeof patch.transcript === "string") updates.transcript = patch.transcript;
  if (typeof patch.showNotes === "string") updates.show_notes = patch.showNotes;
  if (typeof patch.linkedInPost === "string" || patch.linkedInPost === null) updates.linkedin_post = patch.linkedInPost;
  if (patch.chapters !== undefined) updates.chapters_json = patch.chapters;
  if (patch.generationWarning !== undefined) updates.generation_warning = patch.generationWarning;
  if (patch.titleProvenance !== undefined) updates.title_provenance = patch.titleProvenance;
  const { error } = await db.from("episodes").update(updates).eq("id", episodeId).eq("owner_id", ownerId);
  if (error) throw new Error(error.message);
}

export async function updateGeneratedEpisodeTitle(
  ownerId: string,
  episodeId: string,
  expected: Pick<Episode, "title" | "script">,
  next: Pick<Episode, "title" | "generationWarning">,
): Promise<boolean> {
  const db = await requireDb();
  if (!db) return true;

  const { data: current, error: readError } = await db
    .from("episodes")
    .select("title, script, title_provenance, updated_at")
    .eq("id", episodeId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!current) throw new EpisodeNotFoundError();
  if (
    current.title !== expected.title ||
    current.script !== expected.script ||
    episodeTitleProvenance(current.title_provenance) !== "provisional"
  ) {
    return false;
  }

  let update = db
    .from("episodes")
    .update({
      title: next.title,
      generation_warning: next.generationWarning ?? null,
      title_provenance: "gemini",
      updated_at: new Date().toISOString(),
    })
    .eq("id", episodeId)
    .eq("owner_id", ownerId)
    .eq("title_provenance", "provisional");
  if (typeof current.updated_at === "string" && current.updated_at) {
    update = update.eq("updated_at", current.updated_at);
  }
  const { data: updated, error: updateError } = await update
    .select("id")
    .maybeSingle();
  if (updateError) throw new Error(updateError.message);
  return Boolean(updated);
}

/**
 * Applies an editor-requested Gemini title only while the title and transcript
 * used for generation are still current. Unlike the automatic finalizer, this
 * deliberately accepts manual, provisional, and previously generated titles.
 */
export async function updateRegeneratedEpisodeTitle(
  ownerId: string,
  episodeId: string,
  expected: { title: string; transcript: string },
  next: Pick<Episode, "title" | "generationWarning">,
): Promise<boolean> {
  const db = await requireDb();
  if (!db) return true;

  const { data: current, error: readError } = await db
    .from("episodes")
    .select("title, script, transcript, status, updated_at")
    .eq("id", episodeId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!current) throw new EpisodeNotFoundError();

  const currentTranscript =
    (typeof current.transcript === "string" && current.transcript.trim()) ||
    (typeof current.script === "string" ? current.script.trim() : "");
  if (
    (current.status !== "draft" && current.status !== "needs_approval") ||
    current.title !== expected.title ||
    currentTranscript !== expected.transcript.trim()
  ) {
    return false;
  }

  let update = db
    .from("episodes")
    .update({
      title: next.title,
      generation_warning: next.generationWarning ?? null,
      title_provenance: "gemini",
      updated_at: new Date().toISOString(),
    })
    .eq("id", episodeId)
    .eq("owner_id", ownerId)
    .in("status", ["draft", "needs_approval"]);
  if (typeof current.updated_at === "string" && current.updated_at) {
    update = update.eq("updated_at", current.updated_at);
  }
  const { data: updated, error: updateError } = await update
    .select("id")
    .maybeSingle();
  if (updateError) throw new Error(updateError.message);
  return Boolean(updated);
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

async function workspaceEpisodeAudioKeys(
  db: NonNullable<ReturnType<typeof getSupabase>>,
  ownerId: string,
  episodes: Row[],
): Promise<string[]> {
  const variants = await loadAudioVariantRowsForOwner(db, ownerId);
  return [...new Set([
    ...episodes
      .map((episode) => episode.audio_key)
      .filter((key): key is string => typeof key === "string"),
    ...variants.rows
      .map((variant) => variant.audio_key)
      .filter((key): key is string => typeof key === "string"),
  ])];
}

async function removeWorkspaceEpisodeAudio(
  db: NonNullable<ReturnType<typeof getSupabase>>,
  keys: string[],
): Promise<void> {
  const batchSize = 100;
  for (let index = 0; index < keys.length; index += batchSize) {
    const batch = keys.slice(index, index + batchSize);
    const { error } = await db.storage.from(MEDIA_BUCKET).remove(batch);
    if (error) {
      console.error(
        `[storage] workspace audio cleanup failed bucket=${MEDIA_BUCKET} objects=${batch.length}`,
        error,
      );
    }
  }
}

export async function deleteWorkspace(ownerId: string): Promise<string[]> {
  const db = await requireDb();
  if (!db) return [];
  const { data: voiceProfiles } = await db.from("voice_profiles").select("sample_key").eq("owner_id", ownerId);
  const { data: episodes, error: episodesError } = await db.from("episodes").select("id, audio_key").eq("owner_id", ownerId);
  if (episodesError) throw new Error(episodesError.message);
  const keys = await workspaceEpisodeAudioKeys(db, ownerId, episodes ?? []);
  await removeWorkspaceEpisodeAudio(db, keys);
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
  const keys = await workspaceEpisodeAudioKeys(db, ownerId, episodes ?? []);
  await removeWorkspaceEpisodeAudio(db, keys);
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
export async function getPublicEpisodes(): Promise<Episode[]> {
  const db = await requireDb();
  if (!db) return [];
  const { data, error } = await db
    .from("episodes")
    .select()
    .eq("status", "published")
    .not("audio_key", "is", null)
    .order("published_at", { ascending: false });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];
  const episodeIdsByOwner = new Map<string, string[]>();
  for (const row of rows) {
    episodeIdsByOwner.set(row.owner_id, [
      ...(episodeIdsByOwner.get(row.owner_id) ?? []),
      row.id,
    ]);
  }
  const loadedVariants = await Promise.all(
    [...episodeIdsByOwner.entries()].map(async ([ownerId, episodeIds]) => ({
      ownerId,
      result: await loadAudioVariantRowsForEpisodes(db, ownerId, episodeIds),
    })),
  );
  const variantsByOwnerAndEpisode = new Map<string, Row[]>();
  for (const { ownerId, result } of loadedVariants) {
    for (const variant of result.rows) {
      const compositeKey = `${ownerId}\u0000${variant.episode_id}`;
      variantsByOwnerAndEpisode.set(compositeKey, [
        ...(variantsByOwnerAndEpisode.get(compositeKey) ?? []),
        variant,
      ]);
    }
  }
  return rows.map((row) =>
    mapEpisode(
      row,
      variantsByOwnerAndEpisode.get(`${row.owner_id}\u0000${row.id}`) ?? [],
    )
  );
}
export async function getPublicEpisode(id: string): Promise<Episode | null> {
  const db = await requireDb();
  if (!db) return null;
  const { data, error } = await db
    .from("episodes")
    .select()
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const variants = await loadAudioVariantRowsForEpisodes(
    db,
    data.owner_id,
    [data.id],
  );
  return mapEpisode(data, variants.rows);
}
export async function getMediaEpisodeAccess(
  key: string,
): Promise<{
  ownerId: string;
  status: Episode["status"];
  isCanonical: boolean;
} | null> {
  const db = await requireDb();
  if (!db) return null;
  const variantLookup = await db
    .from("episode_audio_variants")
    .select("id, owner_id, episode_id")
    .eq("audio_key", key)
    .maybeSingle();
  if (variantLookup.error && !isMissingAudioVariantTableError(variantLookup.error)) {
    throw new Error(variantLookup.error.message);
  }
  if (variantLookup.data) {
    const { data: episode, error } = await db
      .from("episodes")
      .select("owner_id, status, default_audio_variant_id")
      .eq("owner_id", variantLookup.data.owner_id)
      .eq("id", variantLookup.data.episode_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!episode) return null;
    return {
      ownerId: episode.owner_id,
      status: episode.status,
      isCanonical: episode.default_audio_variant_id === variantLookup.data.id,
    };
  }
  const { data, error } = await db
    .from("episodes")
    .select("owner_id, status")
    .eq("audio_key", key)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data
    ? { ownerId: data.owner_id, status: data.status, isCanonical: true }
    : null;
}
export async function getSignedMediaUrl(key: string, expiresInSeconds = 60) { const db = await requireDb(); if (!db) return null; const { data, error } = await db.storage.from(MEDIA_BUCKET).createSignedUrl(key, expiresInSeconds); if (error || !data?.signedUrl) return null; return data.signedUrl; }
export type JobLeaseResult = {
  acquired: boolean;
  status: JobRun["status"] | null;
  startedAt: string | null;
  costUsd: number;
};

/**
 * Atomically starts a job, or takes over an existing terminal/stale run.
 * The compare-and-swap on started_at ensures only one stale-job contender wins.
 */
export async function acquireJobLease(
  ownerId: string,
  job: { id: string; stage: string; provider?: string; costUsd?: number },
  staleAfterMs: number,
): Promise<JobLeaseResult> {
  const db = await requireDb();
  if (!db) {
    return {
      acquired: true,
      status: "running",
      startedAt: new Date().toISOString(),
      costUsd: job.costUsd ?? 0,
    };
  }

  const startedAt = new Date().toISOString();
  const row = {
    id: job.id,
    owner_id: ownerId,
    stage: job.stage,
    status: "running" as const,
    attempts: 1,
    provider: job.provider ?? null,
    cost_usd: job.costUsd ?? 0,
    error: null,
    idempotency_key: job.id,
    started_at: startedAt,
    completed_at: null,
  };
  const inserted = await db
    .from("job_runs")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (!inserted.error && inserted.data) {
    return {
      acquired: true,
      status: "running",
      startedAt,
      costUsd: job.costUsd ?? 0,
    };
  }

  const existing = await db
    .from("job_runs")
    .select("status, started_at, attempts, cost_usd")
    .eq("owner_id", ownerId)
    .eq("id", job.id)
    .maybeSingle();
  if (existing.error || !existing.data) {
    throw new Error(
      `Unable to acquire job lease: ${existing.error?.message ?? inserted.error?.message ?? "job row was not found"}`,
    );
  }

  const existingStatus = existing.data.status as JobRun["status"];
  const existingStartedAt = String(existing.data.started_at);
  const existingCostUsd = Number(existing.data.cost_usd) || 0;
  const leaseAgeMs = Date.now() - new Date(existingStartedAt).getTime();
  if (
    existingStatus === "running" &&
    Number.isFinite(leaseAgeMs) &&
    leaseAgeMs < staleAfterMs
  ) {
    return {
      acquired: false,
      status: existingStatus,
      startedAt: null,
      costUsd: existingCostUsd,
    };
  }

  const claimedCostUsd = existingCostUsd + (job.costUsd ?? 0);

  const claimed = await db
    .from("job_runs")
    .update({
      ...row,
      attempts: Math.max(1, Number(existing.data.attempts) || 1) + 1,
      cost_usd: claimedCostUsd,
    })
    .eq("owner_id", ownerId)
    .eq("id", job.id)
    .eq("status", existingStatus)
    .eq("started_at", existingStartedAt)
    .select("id")
    .maybeSingle();
  if (claimed.error) {
    throw new Error(`Unable to acquire job lease: ${claimed.error.message}`);
  }
  return {
    acquired: Boolean(claimed.data),
    status: existingStatus,
    startedAt: claimed.data ? startedAt : null,
    costUsd: claimed.data ? claimedCostUsd : existingCostUsd,
  };
}

/** Renews a running lease and returns its next fencing token. */
export async function renewJobLease(
  ownerId: string,
  jobId: string,
  startedAt: string,
): Promise<string | null> {
  const previousTime = new Date(startedAt).getTime();
  const renewedAt = new Date(
    Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0),
  ).toISOString();
  const db = await requireDb();
  if (!db) return renewedAt;
  const renewed = await db
    .from("job_runs")
    .update({ started_at: renewedAt })
    .eq("owner_id", ownerId)
    .eq("id", jobId)
    .eq("status", "running")
    .eq("started_at", startedAt)
    .select("id")
    .maybeSingle();
  if (renewed.error) {
    throw new Error(`Unable to renew job lease: ${renewed.error.message}`);
  }
  return renewed.data ? renewedAt : null;
}

/** Records a terminal result only when the caller still owns the lease. */
export async function finishJobLease(
  ownerId: string,
  startedAt: string,
  job: {
    id: string;
    stage: string;
    status: "completed" | "failed";
    provider?: string;
    costUsd?: number;
    error?: string;
  },
): Promise<boolean> {
  const db = await requireDb();
  if (!db) return true;
  const finished = await db
    .from("job_runs")
    .update({
      stage: job.stage,
      status: job.status,
      provider: job.provider ?? null,
      cost_usd: job.costUsd ?? 0,
      error: job.error ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq("owner_id", ownerId)
    .eq("id", job.id)
    .eq("status", "running")
    .eq("started_at", startedAt)
    .select("id")
    .maybeSingle();
  if (finished.error) {
    throw new Error(`Unable to finish job lease: ${finished.error.message}`);
  }
  return Boolean(finished.data);
}

export async function recordJob(ownerId: string, job: { id: string; stage: string; status: JobRun["status"]; provider?: string; costUsd?: number; error?: string }) {
  const db = await requireDb();
  if (!db) return;
  const { error } = await db.from("job_runs").upsert({ id: job.id, owner_id: ownerId, stage: job.stage, status: job.status, provider: job.provider ?? null, cost_usd: job.costUsd ?? 0, error: job.error ?? null, idempotency_key: job.id, completed_at: job.status === "completed" || job.status === "failed" ? new Date().toISOString() : null }, { onConflict: "owner_id,id" });
  if (error) throw new Error(`Unable to record job status: ${error.message}`);
}
