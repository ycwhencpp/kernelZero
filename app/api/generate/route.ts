import { authErrorResponse, currentOwner } from "../../../lib/auth";
import {
  hasBudgetForGeneration,
  selectDigestItems,
} from "../../../lib/domain";
import {
  aiProviderLabel,
  estimatedGenerationCostUsd,
  generatePodcast,
  resolveAiProvider,
} from "../../../lib/openai";
import { hasUsableAudioUrl } from "../../../lib/generated-episode";
import {
  createEpisode,
  findItems,
  getActiveVoiceProfile,
  getDashboardState,
  recordJob,
} from "../../../lib/store";
import { normalizeEpisodeLength } from "../../../lib/podcast-length";
import {
  episodeSourceItemIds,
  parsePodcastRegenerationContext,
} from "../../../lib/podcast-regeneration";
import type { Episode, EpisodeLength } from "../../../lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const jobId = `job-generate-${Date.now()}`;
  try {
    const ownerId = await currentOwner();
    const body = (await request.json()) as {
      type?: Episode["type"];
      itemIds?: string[];
      includeAudio?: boolean;
      episodeLength?: EpisodeLength;
      episodeId?: string;
      topic?: string;
      currentDraft?: string;
    };
    let regeneration;
    try {
      regeneration = parsePodcastRegenerationContext(body);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid regeneration request." },
        { status: 400 },
      );
    }
    const state = await getDashboardState(ownerId);
    const sourceEpisode = regeneration
      ? state.episodes.find((episode) => episode.id === regeneration.episodeId)
      : undefined;
    if (regeneration && !sourceEpisode) {
      return Response.json(
        { error: "The draft being regenerated was not found." },
        { status: 404 },
      );
    }
    if (
      regeneration &&
      sourceEpisode &&
      regeneration.topic !== sourceEpisode.title
    ) {
      return Response.json(
        { error: "The regeneration topic must match the current draft title." },
        { status: 400 },
      );
    }
    if (
      body.type &&
      sourceEpisode &&
      body.type !== sourceEpisode.type
    ) {
      return Response.json(
        { error: "The regeneration type must match the current draft type." },
        { status: 400 },
      );
    }
    const type = sourceEpisode?.type ?? body.type ?? "paper_deep_dive";
    const provider = resolveAiProvider();
    const estimatedCostUsd = estimatedGenerationCostUsd(
      provider,
      body.includeAudio ?? true,
    );
    if (
      !hasBudgetForGeneration(
        state.stats.dailySpendUsd,
        state.stats.dailyBudgetUsd,
        estimatedCostUsd,
      )
    ) {
      return Response.json(
        {
          error: `Daily AI budget reached ($${state.stats.dailyBudgetUsd.toFixed(2)}).`,
        },
        { status: 429 },
      );
    }
    const itemIds = sourceEpisode
      ? episodeSourceItemIds(state, sourceEpisode)
      : body.itemIds ?? [];
    if (regeneration && itemIds.length === 0) {
      return Response.json(
        { error: "The original sources for this draft are no longer available." },
        { status: 400 },
      );
    }
    let items = await findItems(ownerId, itemIds);
    if (regeneration && items.length !== itemIds.length) {
      return Response.json(
        { error: "One or more original sources for this draft are no longer available." },
        { status: 400 },
      );
    }
    if (!regeneration && type === "daily_digest" && items.length === 0) {
      items = selectDigestItems(state.items, 5);
    }
    if (items.length === 0) {
      return Response.json(
        { error: "Choose at least one source for the episode." },
        { status: 400 },
      );
    }

    const needsAudio = body.includeAudio ?? true;
    const voiceProfile = needsAudio ? await getActiveVoiceProfile(ownerId) : null;
    if (needsAudio && process.env.REQUIRE_LOCAL_VOICE === "true" && !voiceProfile) {
      return Response.json(
        { error: "No active local Chatterbox voice is configured. Save a voice in Settings before generating audio." },
        { status: 400 },
      );
    }
    if (voiceProfile && process.env.VERCEL) {
      return Response.json(
        { error: "This Chatterbox voice is stored locally. Generate the podcast from the local KernelZero server, not Vercel." },
        { status: 400 },
      );
    }

    await recordJob(ownerId, {
      id: jobId,
      stage: type === "daily_digest" ? "Daily digest" : "Deep-dive podcast",
      status: "running",
      provider: aiProviderLabel(provider),
    });
    const generated = await generatePodcast(items, type, {
      includeAudio: needsAudio,
      voiceProfile,
      episodeLength: normalizeEpisodeLength(body.episodeLength ?? state.settings.episodeLength),
      regeneration,
    });
    if (needsAudio && (!generated.audio || generated.audio.byteLength === 0)) {
      throw new Error(
        "Audio was requested, but the narrator returned no audio data.",
      );
    }
    if (sourceEpisode) {
      generated.episode.generation = sourceEpisode.generation + 1;
    }
    const episode = await createEpisode(
      ownerId,
      generated.episode,
      generated.evidence,
      generated.audio,
      new URL(request.url).origin,
      generated.audioContentType ?? undefined,
    );
    if (needsAudio && !hasUsableAudioUrl(episode.audioUrl)) {
      throw new Error(
        "Audio was generated, but it could not be stored with the episode.",
      );
    }
    const refreshedState = await getDashboardState(ownerId);
    const storedEpisode = refreshedState.episodes.find(
      (candidate) => candidate.id === episode.id,
    );
    if (!storedEpisode) {
      throw new Error(
        "The generated episode could not be found after it was stored.",
      );
    }
    if (
      needsAudio &&
      (!hasUsableAudioUrl(storedEpisode.audioUrl) ||
        storedEpisode.audioUrl !== episode.audioUrl)
    ) {
      throw new Error(
        "The stored episode does not reference the generated audio.",
      );
    }
    await recordJob(ownerId, {
      id: jobId,
      stage: type === "daily_digest" ? "Daily digest" : "Deep-dive podcast",
      status: "completed",
      provider: aiProviderLabel(generated.provider),
      costUsd: estimatedCostUsd,
    });

    return Response.json({
      episode: storedEpisode,
      provider: generated.provider,
      state: refreshedState,
    });
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : String(error);
    console.error(`[generate] job=${jobId} failed: ${errorMessage}`);
    try {
      const ownerId = await currentOwner();
      await recordJob(ownerId, {
        id: jobId,
        stage: "Podcast generation",
        status: "failed",
        provider: aiProviderLabel(resolveAiProvider()),
        error: errorMessage,
      });
    } catch {
      // Preserve the generation error.
    }
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Generation failed." },
        { status: 500 },
      )
    );
  }
}
