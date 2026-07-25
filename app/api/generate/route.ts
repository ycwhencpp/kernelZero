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
  getDashboardState,
  recordJob,
} from "../../../lib/store";
import type { Episode } from "../../../lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const jobId = `job-generate-${Date.now()}`;
  try {
    const ownerId = await currentOwner();
    const body = (await request.json()) as {
      type?: Episode["type"];
      itemIds?: string[];
      includeAudio?: boolean;
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

    await recordJob(ownerId, {
      id: jobId,
      stage: type === "daily_digest" ? "Daily digest" : "Deep-dive podcast",
      status: "running",
      provider: aiProviderLabel(provider),
    });
    const generated = await generatePodcast(items, type, {
      includeAudio: body.includeAudio ?? true,
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
      provider: aiProviderLabel(generated.provider === "demo" ? null : generated.provider),
      costUsd: generated.provider === "demo" ? 0 : estimatedCostUsd,
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
