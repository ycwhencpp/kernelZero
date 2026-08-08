import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import { hasBudgetForGeneration } from "../../../../../lib/domain";
import {
  hasUsableAudioUrl,
  reconcileGeneratedEpisode,
} from "../../../../../lib/generated-episode";
import {
  aiProviderLabel,
  estimatedAudioCostUsd,
  resolveAiProvider,
  synthesizePodcastAudio,
} from "../../../../../lib/openai";
import {
  acquireJobLease,
  findEpisode,
  finishJobLease,
  getActiveVoiceProfile,
  getDashboardState,
  replaceEpisodeAudio,
} from "../../../../../lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const AUDIO_RETRY_LEASE_TIMEOUT_MS = 4 * 60 * 60 * 1_000;

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  let jobId: string | null = null;
  let ownerId: string | null = null;
  let leaseStartedAt: string | null = null;
  let jobProvider = "Podcast narrator";
  let estimatedCostUsd = 0;
  let reservedCostUsd = 0;
  let providerCallStarted = false;
  try {
    ownerId = await currentOwner("editor");
    const { id } = await context.params;
    const [episode, voiceProfile, initialState] = await Promise.all([
      findEpisode(ownerId, id),
      getActiveVoiceProfile(ownerId),
      getDashboardState(ownerId),
    ]);
    if (!episode) return Response.json({ error: "Episode not found." }, { status: 404 });
    const hasLocalChatterboxVoice = Boolean(
      voiceProfile?.active && voiceProfile.provider === "chatterbox",
    );
    if (process.env.REQUIRE_LOCAL_VOICE === "true" && !hasLocalChatterboxVoice) {
      return Response.json({ error: "Choose a local Chatterbox narrator before regenerating audio." }, { status: 400 });
    }
    if (hasLocalChatterboxVoice && process.env.VERCEL) return Response.json({ error: "Regenerate local Chatterbox audio from the local KernelZero server, not Vercel." }, { status: 400 });
    const provider = resolveAiProvider();
    if (!provider && !hasLocalChatterboxVoice) {
      return Response.json({ error: "No audio provider is configured." }, { status: 400 });
    }
    estimatedCostUsd = hasLocalChatterboxVoice
      ? 0
      : estimatedAudioCostUsd(provider);
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
    jobProvider = hasLocalChatterboxVoice
      ? "Local Chatterbox"
      : aiProviderLabel(provider);
    jobId = `job-audio-${new Date().toISOString().slice(0, 10)}`;
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
        { error: "Audio generation is already running for this workspace." },
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
    const updatedEpisode = await replaceEpisodeAudio(
      ownerId,
      episode,
      generated.audio,
      generated.audioContentType,
      generated.durationSeconds,
    );
    if (!hasUsableAudioUrl(updatedEpisode.audioUrl)) {
      throw new Error("The generated audio could not be stored with the episode.");
    }
    const completionToken = leaseStartedAt;
    leaseStartedAt = null;
    try {
      const finished = await finishJobLease(ownerId, completionToken, {
        id: jobId,
        stage: "Podcast narration",
        status: "completed",
        provider: jobProvider,
        costUsd: reservedCostUsd,
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
    return Response.json(reconciled);
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
            ? reservedCostUsd
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
