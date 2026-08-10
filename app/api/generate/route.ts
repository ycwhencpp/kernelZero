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
import {
  hasUsableAudioUrl,
  reconcileGeneratedEpisode,
} from "../../../lib/generated-episode";
import {
  createEpisode,
  findItems,
  getActiveVoiceProfile,
  getDashboardState,
  recordJob,
  replaceEpisodeAudio,
} from "../../../lib/store";
import { normalizeEpisodeLength } from "../../../lib/podcast-length";
import {
  episodeSourceItemIds,
  parsePodcastRegenerationContext,
} from "../../../lib/podcast-regeneration";
import { createPipelineTraceId } from "../../../lib/pipeline-log";
import { hydratePodcastSources } from "../../../lib/source-documents";
import {
  limitPodcastSourceIds,
  MAX_OLLAMA_PODCAST_SOURCES,
  uniquePodcastSourceIds,
} from "../../../lib/podcast-source-selection";
import type {
  DashboardState,
  Episode,
  EpisodeLength,
  EvidenceClaim,
} from "../../../lib/types";

export const dynamic = "force-dynamic";

const NARRATION_RETRY_MESSAGE =
  "Narration could not be completed, but the evidence-checked draft was saved.";

function reconcileEpisodeCheckpoint(
  state: DashboardState,
  episode: Episode,
  evidence: EvidenceClaim[],
  stateIsAuthoritative = false,
): { episode: Episode; state: DashboardState } {
  const reconciled = reconcileGeneratedEpisode(state, episode, {
    stateIsAuthoritative,
  });
  return {
    episode: reconciled.episode,
    state: {
      ...reconciled.state,
      evidence: [
        ...evidence,
        ...reconciled.state.evidence.filter(
          (claim) => claim.episodeId !== episode.id,
        ),
      ],
    },
  };
}

export async function POST(request: Request) {
  const jobId = `job-generate-${Date.now()}`;
  try {
    const ownerId = await currentOwner("editor");
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
    const requestedItemIds = sourceEpisode
      ? episodeSourceItemIds(state, sourceEpisode)
      : uniquePodcastSourceIds(body.itemIds);
    let sourceSelectionNotice: string | undefined;
    let itemIds = requestedItemIds;
    if (
      provider === "ollama" &&
      regeneration &&
      itemIds.length > MAX_OLLAMA_PODCAST_SOURCES
    ) {
      const limited = limitPodcastSourceIds(itemIds);
      itemIds = limited.itemIds;
      sourceSelectionNotice =
        `This Ollama regeneration used the first ${MAX_OLLAMA_PODCAST_SOURCES} sources from the original episode; ${limited.omittedCount} additional ${limited.omittedCount === 1 ? "source was" : "sources were"} omitted.`;
      console.info(
        `[generate] job=${jobId} limited legacy regeneration sources requested=${requestedItemIds.length} selected=${itemIds.length}`,
      );
    }
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
      items = selectDigestItems(state.items, MAX_OLLAMA_PODCAST_SOURCES);
    }
    if (items.length === 0) {
      return Response.json(
        { error: "Choose at least one source for the episode." },
        { status: 400 },
      );
    }
    if (
      provider === "ollama" &&
      items.length > MAX_OLLAMA_PODCAST_SOURCES
    ) {
      return Response.json(
        {
          error:
            `Choose no more than ${MAX_OLLAMA_PODCAST_SOURCES} ready sources for Ollama generation.`,
        },
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
    const traceId = createPipelineTraceId("manual-podcast");
    const sourceCorpus = provider === "ollama"
      ? await hydratePodcastSources(ownerId, items, { traceId })
      : undefined;
    let checkpointedEpisode: Episode | null = null;
    let checkpointedEvidence: EvidenceClaim[] = [];
    let checkpointProvider: "openai" | "gemini" | "ollama" | null = null;
    const recoverNarrationFailure = async (
      savedEpisode: Episode,
      savedEvidence: EvidenceClaim[],
      failedProvider: "openai" | "gemini" | "ollama",
      narrationError: unknown,
    ): Promise<Response> => {
      const internalError = narrationError instanceof Error
        ? narrationError.message
        : String(narrationError);
      console.error(
        `[generate] job=${jobId} narration failed after draft checkpoint: ${internalError}`,
      );
      try {
        await recordJob(ownerId, {
          id: jobId,
          stage: "Podcast narration",
          status: "failed",
          provider: aiProviderLabel(failedProvider),
          costUsd: estimatedCostUsd,
          error: internalError,
        });
      } catch (jobError) {
        console.error(
          `[generate] job=${jobId} could not record narration failure:`,
          jobError,
        );
      }
      let checkpointedState = state;
      let stateIsAuthoritative = false;
      try {
        checkpointedState = await getDashboardState(ownerId);
        stateIsAuthoritative = true;
      } catch (stateError) {
        console.error(
          `[generate] job=${jobId} saved its draft, but the dashboard reread failed:`,
          stateError,
        );
      }
      const reconciled = reconcileEpisodeCheckpoint(
        checkpointedState,
        savedEpisode,
        savedEvidence,
        stateIsAuthoritative,
      );
      return Response.json({
        episode: reconciled.episode,
        provider: failedProvider,
        state: reconciled.state,
        audioError: NARRATION_RETRY_MESSAGE,
        sourceSelectionNotice,
      });
    };

    let generated: Awaited<ReturnType<typeof generatePodcast>>;
    try {
      generated = await generatePodcast(items, type, {
        includeAudio: needsAudio,
        voiceProfile,
        episodeLength: normalizeEpisodeLength(body.episodeLength ?? state.settings.episodeLength),
        regeneration,
        sourceCorpus,
        traceId,
        onDraftReady: async (checkpoint) => {
          if (sourceEpisode) {
            checkpoint.episode.generation = sourceEpisode.generation + 1;
          }
          const savedDraft = await createEpisode(
            ownerId,
            checkpoint.episode,
            checkpoint.evidence,
          );
          checkpointedEpisode = {
            ...savedDraft,
            citations: savedDraft.citations.map((citation) => ({ ...citation })),
            chapters: savedDraft.chapters.map((chapter) => ({ ...chapter })),
          };
          checkpointedEvidence = checkpoint.evidence;
          checkpointProvider = checkpoint.provider;
        },
      });
    } catch (narrationError) {
      if (needsAudio && checkpointedEpisode && checkpointProvider) {
        return recoverNarrationFailure(
          checkpointedEpisode,
          checkpointedEvidence,
          checkpointProvider,
          narrationError,
        );
      }
      throw narrationError;
    }

    if (needsAudio && (!generated.audio || generated.audio.byteLength === 0)) {
      if (checkpointedEpisode && checkpointProvider) {
        return recoverNarrationFailure(
          checkpointedEpisode,
          checkpointedEvidence,
          checkpointProvider,
          new Error("Audio was requested, but the narrator returned no audio data."),
        );
      }
      throw new Error(
        "Audio was requested, but the narrator returned no audio data.",
      );
    }

    let episode = generated.episode;
    if (generated.audio) {
      try {
        episode = await replaceEpisodeAudio(
          ownerId,
          generated.episode,
          generated.audio,
          generated.audioContentType ?? undefined,
          generated.episode.durationSeconds,
          {
            voiceProfileId: voiceProfile?.id ?? null,
            voiceKey: voiceProfile
              ? `profile:${voiceProfile.id}`
              : `provider:${generated.provider}`,
            voiceName: voiceProfile?.name ?? aiProviderLabel(generated.provider),
            provider: voiceProfile?.provider ?? generated.provider,
          },
        );
        if (needsAudio && !hasUsableAudioUrl(episode.audioUrl)) {
          throw new Error(
            "Audio was generated, but it could not be stored with the episode.",
          );
        }
      } catch (audioStorageError) {
        if (checkpointedEpisode && checkpointProvider) {
          return recoverNarrationFailure(
            checkpointedEpisode,
            checkpointedEvidence,
            checkpointProvider,
            audioStorageError,
          );
        }
        throw audioStorageError;
      }
    }

    let refreshedState = state;
    let stateIsAuthoritative = false;
    try {
      refreshedState = await getDashboardState(ownerId);
      stateIsAuthoritative = true;
    } catch (stateError) {
      console.error(
        `[generate] job=${jobId} stored its episode, but the dashboard reread failed:`,
        stateError,
      );
    }
    const reconciled = reconcileEpisodeCheckpoint(
      refreshedState,
      episode,
      generated.evidence,
      stateIsAuthoritative,
    );
    const storedEpisode = reconciled.episode;
    refreshedState = reconciled.state;
    let responseState = refreshedState;
    try {
      const completedAt = new Date().toISOString();
      const stage = type === "daily_digest" ? "Daily digest" : "Deep-dive podcast";
      const providerLabel = aiProviderLabel(generated.provider);
      await recordJob(ownerId, {
        id: jobId,
        stage,
        status: "completed",
        provider: providerLabel,
        costUsd: estimatedCostUsd,
      });
      const previousJob = refreshedState.jobs.find(
        (candidate) => candidate.id === jobId,
      );
      const completedJob = {
        id: jobId,
        stage,
        status: "completed" as const,
        provider: providerLabel,
        costUsd: estimatedCostUsd,
        startedAt: previousJob?.startedAt ?? completedAt,
        completedAt,
      };
      responseState = {
        ...refreshedState,
        jobs: [
          completedJob,
          ...refreshedState.jobs.filter((candidate) => candidate.id !== jobId),
        ],
        stats: {
          ...refreshedState.stats,
          dailySpendUsd:
            refreshedState.stats.dailySpendUsd -
            (previousJob?.costUsd ?? 0) +
            estimatedCostUsd,
        },
      };
    } catch (jobError) {
      // The episode and its audio are already durable. A bookkeeping outage
      // must not turn a successful generation into a retry/duplicate episode.
      console.error(
        `[generate] job=${jobId} completed, but final job status could not be recorded:`,
        jobError,
      );
    }

    return Response.json({
      episode: storedEpisode,
      provider: generated.provider,
      state: responseState,
      sourceSelectionNotice,
    });
  } catch (error) {
    const errorMessage = error instanceof Error
      ? error.message
      : String(error);
    console.error(`[generate] job=${jobId} failed: ${errorMessage}`);
    try {
      const ownerId = await currentOwner("editor");
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
