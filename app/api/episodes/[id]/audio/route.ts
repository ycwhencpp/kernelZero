import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import {
  audioGenerationJobId,
  isPublishedAudioDefaultConflict,
  parseRequiredAudioVariantSelection,
} from "../../../../../lib/audio-variant-api";
import { parseAudioVoiceSelection } from "../../../../../lib/audio-voice-selection";
import { hasBudgetForGeneration } from "../../../../../lib/domain";
import {
  hasUsableAudioUrl,
  reconcileGeneratedEpisode,
} from "../../../../../lib/generated-episode";
import {
  aiProviderLabel,
  estimatedAudioCostUsd,
  estimatedEpisodeTitleCostUsd,
  resolveAiProvider,
  resolveEpisodeTitleProvider,
  synthesizePodcastAudio,
} from "../../../../../lib/openai";
import { finalizeEpisodeTitleAfterNarration } from "../../../../../lib/podcast-title";
import {
  acquireJobLease,
  EpisodeAudioVariantNotFoundError,
  EpisodeNotFoundError,
  findEpisode,
  finishJobLease,
  getActiveVoiceProfile,
  getDashboardState,
  getVoiceProfileById,
  replaceEpisodeAudio,
  setEpisodeDefaultAudioVariant,
} from "../../../../../lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const AUDIO_RETRY_LEASE_TIMEOUT_MS = 4 * 60 * 60 * 1_000;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let jobId: string | null = null;
  let ownerId: string | null = null;
  let leaseStartedAt: string | null = null;
  let jobProvider = "Podcast narrator";
  let estimatedCostUsd = 0;
  let titleEstimatedCostUsd = 0;
  let reservedCostUsd = 0;
  let providerCallStarted = false;
  let titleCallStarted = false;
  try {
    ownerId = await currentOwner("editor");
    const { id } = await context.params;
    const voiceSelection = await parseAudioVoiceSelection(request);
    if (!voiceSelection.ok) {
      return Response.json({ error: voiceSelection.error }, { status: 400 });
    }
    const requestedVoiceId = voiceSelection.voiceId;
    const [episode, voiceProfile, initialState] = await Promise.all([
      findEpisode(ownerId, id),
      requestedVoiceId
        ? getVoiceProfileById(ownerId, requestedVoiceId)
        : getActiveVoiceProfile(ownerId),
      getDashboardState(ownerId),
    ]);
    if (!episode) return Response.json({ error: "Episode not found." }, { status: 404 });
    const configuredTitleProvider = episode.titleProvenance === "provisional"
      ? resolveEpisodeTitleProvider()
      : null;
    titleEstimatedCostUsd = estimatedEpisodeTitleCostUsd(
      configuredTitleProvider,
    );
    if (requestedVoiceId && !voiceProfile) {
      return Response.json(
        { error: "The selected narrator was not found in this workspace." },
        { status: 400 },
      );
    }
    const hasLocalChatterboxVoice = Boolean(
      voiceProfile?.provider === "chatterbox",
    );
    if (process.env.REQUIRE_LOCAL_VOICE === "true" && !hasLocalChatterboxVoice) {
      return Response.json({ error: "Choose a local Chatterbox narrator before regenerating audio." }, { status: 400 });
    }
    if (hasLocalChatterboxVoice && process.env.VERCEL) return Response.json({ error: "Regenerate local Chatterbox audio from the local KernelZero server, not Vercel." }, { status: 400 });
    const provider = resolveAiProvider();
    if (!provider && !hasLocalChatterboxVoice) {
      return Response.json({ error: "No audio provider is configured." }, { status: 400 });
    }
    estimatedCostUsd = (hasLocalChatterboxVoice
      ? 0
      : estimatedAudioCostUsd(provider)) + titleEstimatedCostUsd;
    if (
      !hasBudgetForGeneration(
        initialState.stats.dailySpendUsd,
        initialState.stats.dailyBudgetUsd,
        estimatedCostUsd,
      )
    ) {
      return Response.json(
        {
          error: `Daily AI budget reached ($${initialState.stats.dailyBudgetUsd.toFixed(2)}).`,
        },
        { status: 429 },
      );
    }
    const narratorLabel = hasLocalChatterboxVoice
      ? "Local Chatterbox"
      : aiProviderLabel(provider);
    jobProvider = configuredTitleProvider === "gemini"
      ? `${narratorLabel} + Gemini title`
      : narratorLabel;
    const variantProvider = hasLocalChatterboxVoice
      ? "chatterbox" as const
      : provider!;
    const voiceKey = hasLocalChatterboxVoice
      ? `profile:${voiceProfile!.id}`
      : `provider:${variantProvider}`;
    const voiceName = hasLocalChatterboxVoice
      ? voiceProfile!.name
      : aiProviderLabel(provider);
    jobId = audioGenerationJobId(
      new Date().toISOString().slice(0, 10),
      episode.id,
      voiceKey,
    );
    const lease = await acquireJobLease(
      ownerId,
      {
        id: jobId,
        stage: "Podcast narration",
        provider: jobProvider,
        costUsd: estimatedCostUsd,
      },
      AUDIO_RETRY_LEASE_TIMEOUT_MS,
    );
    if (!lease.acquired) {
      return Response.json(
        { error: "Audio generation is already running for this episode and narrator." },
        { status: 409 },
      );
    }
    if (!lease.startedAt) {
      throw new Error("The audio job lease did not return a fencing token.");
    }
    leaseStartedAt = lease.startedAt;
    reservedCostUsd = lease.costUsd;

    // Re-read after the serialized reservation. This closes the race where
    // simultaneous retries all pass the same pre-reservation budget snapshot.
    const reservedState = await getDashboardState(ownerId);
    if (
      estimatedCostUsd > 0 &&
      reservedState.stats.dailySpendUsd >
      reservedState.stats.dailyBudgetUsd
    ) {
      const failureToken = leaseStartedAt;
      leaseStartedAt = null;
      await finishJobLease(ownerId, failureToken, {
        id: jobId,
        stage: "Podcast narration",
        status: "failed",
        provider: jobProvider,
        costUsd: Math.max(0, reservedCostUsd - estimatedCostUsd),
        error: "Daily AI budget reached before narration started.",
      });
      return Response.json(
        {
          error: `Daily AI budget reached ($${reservedState.stats.dailyBudgetUsd.toFixed(2)}).`,
        },
        { status: 429 },
      );
    }
    providerCallStarted = true;
    const generated = await synthesizePodcastAudio(
      episode.script,
      provider,
      voiceProfile,
      episode.durationSeconds,
    );
    let updatedEpisode = await replaceEpisodeAudio(
      ownerId,
      episode,
      generated.audio,
      generated.audioContentType,
      generated.durationSeconds,
      {
        voiceProfileId: hasLocalChatterboxVoice ? voiceProfile!.id : null,
        voiceKey,
        voiceName,
        provider: variantProvider,
      },
    );
    if (!hasUsableAudioUrl(updatedEpisode.audioUrl)) {
      throw new Error("The generated audio could not be stored with the episode.");
    }
    let titleProvider: "gemini" | null = null;
    let titleError: string | null = null;
    if (updatedEpisode.titleProvenance === "provisional") {
      titleCallStarted = true;
      const finalizedTitle = await finalizeEpisodeTitleAfterNarration(
        ownerId,
        updatedEpisode,
        {
          title: episode.title,
          script: episode.script,
        },
      );
      updatedEpisode = finalizedTitle.episode;
      titleProvider = finalizedTitle.titleProvider;
      titleError = finalizedTitle.titleError;
    }
    const generatedVariant = updatedEpisode.audioVariants?.find(
      (variant) => variant.voiceKey === voiceKey,
    ) ?? (updatedEpisode.audioVariants?.length === 1
      ? updatedEpisode.audioVariants[0]
      : undefined);
    if (!generatedVariant) {
      throw new Error("The generated audio variant could not be loaded.");
    }
    const completionToken = leaseStartedAt;
    leaseStartedAt = null;
    try {
      const finished = await finishJobLease(ownerId, completionToken, {
        id: jobId,
        stage: "Podcast narration",
        status: "completed",
        provider: jobProvider,
        costUsd: Math.max(
          0,
          reservedCostUsd - (titleCallStarted ? 0 : titleEstimatedCostUsd),
        ),
      });
      if (!finished) {
        console.warn(
          `[episodes/audio] ${updatedEpisode.id} stored audio, but a newer retry owns its job lease.`,
        );
      }
    } catch (jobError) {
      console.error(
        `[episodes/audio] ${updatedEpisode.id} stored audio, but its job could not be finalized:`,
        jobError,
      );
    }
    let state = initialState;
    let stateIsAuthoritative = false;
    try {
      state = await getDashboardState(ownerId);
      stateIsAuthoritative = true;
    } catch (stateError) {
      console.error(
        `[episodes/audio] ${updatedEpisode.id} stored audio, but the dashboard reread failed:`,
        stateError,
      );
    }
    const reconciled = reconcileGeneratedEpisode(state, updatedEpisode, {
      stateIsAuthoritative,
    });
    return Response.json({
      ...reconciled,
      audioVariantId: generatedVariant.id,
      titleProvider,
      titleError,
    });
  } catch (error) {
    if (ownerId && jobId && leaseStartedAt) {
      const failureToken = leaseStartedAt;
      leaseStartedAt = null;
      try {
        const finished = await finishJobLease(ownerId, failureToken, {
          id: jobId,
          stage: "Podcast narration",
          status: "failed",
          provider: jobProvider,
          costUsd: providerCallStarted
            ? Math.max(
                0,
                reservedCostUsd -
                  (titleCallStarted ? 0 : titleEstimatedCostUsd),
              )
            : Math.max(0, reservedCostUsd - estimatedCostUsd),
          error: error instanceof Error ? error.message : String(error),
        });
        if (!finished) {
          console.warn(
            `[episodes/audio] ${jobId} failure was ignored because a newer retry owns its lease.`,
          );
        }
      } catch (jobError) {
        console.error(`[episodes/audio] ${jobId} could not record failure:`, jobError);
      }
    }
    return authErrorResponse(error) ?? Response.json(
      { error: error instanceof Error ? error.message : "Unable to regenerate local audio." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("owner");
    const { id } = await context.params;
    const selection = await parseRequiredAudioVariantSelection(request);
    if (!selection.ok) {
      return Response.json({ error: selection.error }, { status: 400 });
    }
    await setEpisodeDefaultAudioVariant(
      ownerId,
      id,
      selection.audioVariantId,
    );
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    if (
      error instanceof EpisodeNotFoundError ||
      error instanceof EpisodeAudioVariantNotFoundError
    ) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (isPublishedAudioDefaultConflict(error)) {
      return Response.json(
        {
          code: "published_audio_default_locked",
          error: error.message,
        },
        { status: 409 },
      );
    }
    return authErrorResponse(error) ?? Response.json(
      {
        error: error instanceof Error
          ? error.message
          : "Unable to select the default audio variant.",
      },
      { status: 500 },
    );
  }
}
