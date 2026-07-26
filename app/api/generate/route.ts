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
  createEpisode,
  findItems,
  getActiveVoiceProfile,
  getDashboardState,
  recordJob,
} from "../../../lib/store";
import { normalizeEpisodeLength } from "../../../lib/podcast-length";
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
    };
    const type = body.type ?? "paper_deep_dive";
    const state = await getDashboardState(ownerId);
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
    let items = await findItems(ownerId, body.itemIds ?? []);
    if (type === "daily_digest" && items.length === 0) {
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
        { error: "This Chatterbox voice is stored locally. Generate the podcast from the local SignalCast server, not Vercel." },
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
    });
    const episode = await createEpisode(
      ownerId,
      generated.episode,
      generated.evidence,
      generated.audio,
      new URL(request.url).origin,
      generated.audioContentType ?? undefined,
    );
    await recordJob(ownerId, {
      id: jobId,
      stage: type === "daily_digest" ? "Daily digest" : "Deep-dive podcast",
      status: "completed",
      provider: aiProviderLabel(generated.provider),
      costUsd: estimatedCostUsd,
    });

    return Response.json({
      episode,
      provider: generated.provider,
      state: await getDashboardState(ownerId),
    });
  } catch (error) {
    try {
      const ownerId = await currentOwner();
      await recordJob(ownerId, {
        id: jobId,
        stage: "Podcast generation",
        status: "failed",
        provider: aiProviderLabel(resolveAiProvider()),
        error: error instanceof Error ? error.message : String(error),
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
