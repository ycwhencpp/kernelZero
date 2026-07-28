import {
  deduplicateItems,
  hasBudgetForGeneration,
  scoreCandidate,
  selectDigestItems,
} from "../../../../lib/domain";
import { aiProviderLabel, generatePodcast, resolveAiProvider, estimatedGenerationCostUsd } from "../../../../lib/openai";
import { discoverResearch } from "../../../../lib/research";
import { fetchFeed } from "../../../../lib/rss";
import {
  addSource,
  createEpisode,
  getActiveVoiceProfile,
  getDashboardState,
  personalizeItems,
  recordJob,
  upsertItems,
} from "../../../../lib/store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || authorization !== `Bearer ${secret}`) {
    return Response.json({ error: "Invalid scheduler credential." }, { status: 401 });
  }

  const ownerId = process.env.CRON_OWNER_EMAIL?.toLowerCase() || "local@kernelzero.local";
  const dateParts = new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((parts, part) => {
      parts[part.type] = part.value;
      return parts;
    }, {});
  const dateKey = `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
  const jobId = `daily-${dateKey}`;
  const initialState = await getDashboardState(ownerId);
  if (!initialState.settings.dailyGeneration) {
    return Response.json({ status: "paused", message: "Daily generation is disabled in workspace settings." });
  }
  if (
    initialState.jobs.some(
      (job) => job.id === jobId && job.status === "completed",
    )
  ) {
    return Response.json({
      status: "already_completed",
      episode: initialState.episodes.find((episode) =>
        episode.createdAt.startsWith(dateKey),
      ),
    });
  }
  const estimatedCostUsd = estimatedGenerationCostUsd(resolveAiProvider(), true);
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

  await recordJob(ownerId, {
    id: jobId,
    stage: "Daily research and digest",
    status: "running",
    provider: "OpenAlex + Semantic Scholar + arXiv + AI",
  });

  try {
    const voiceProfile = await getActiveVoiceProfile(ownerId);
    if (process.env.REQUIRE_LOCAL_VOICE === "true" && !voiceProfile) {
      throw new Error("No active local Chatterbox voice is configured for this cron owner. Save a voice in Settings before running the daily cron.");
    }
    if (voiceProfile && process.env.VERCEL) {
      throw new Error("The selected Chatterbox voice is stored on this local KernelZero machine. Run the daily cron locally; a Vercel function cannot read the local reference recording or run Chatterbox.");
    }
    const discovered: typeof initialState.items = [];
    const warnings: string[] = [];
    for (const interest of initialState.interests.filter((entry) => entry.enabled)) {
      const result = await discoverResearch(interest);
      discovered.push(...result.items);
      warnings.push(...result.warnings);
    }
    for (const source of initialState.sources.filter(
      (entry) =>
        entry.enabled && (entry.type === "rss" || entry.type === "atom"),
    )) {
      try {
        const parsed = await fetchFeed(source.url);
        discovered.push(
          ...parsed.items.map((candidate) =>
            scoreCandidate(
              {
                ...candidate,
                sourceId: source.id,
                sourceName: source.name,
              },
              initialState.interests,
            ),
          ),
        );
        await addSource(ownerId, {
          ...source,
          lastSuccessfulFetch: new Date().toISOString(),
        });
      } catch (error) {
        warnings.push(
          `${source.name}: ${
            error instanceof Error ? error.message : "feed refresh failed"
          }`,
        );
      }
    }
    const personalized = await personalizeItems(ownerId, discovered);
    const unique = deduplicateItems([...initialState.items, ...personalized]);
    await upsertItems(ownerId, unique);

    const digestItems = selectDigestItems(unique, 5);
    const generated = await generatePodcast(digestItems, "daily_digest", {
      includeAudio: true,
      voiceProfile,
      episodeLength: initialState.settings.episodeLength,
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
      stage: "Daily research and digest",
      status: "completed",
      provider: aiProviderLabel(generated.provider),
      costUsd: estimatedCostUsd,
    });

    return Response.json({
      status: "completed",
      discovered: discovered.length,
      warnings,
      episode,
      narration: voiceProfile ? "local_chatterbox" : "system_voice",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cron/daily] ${jobId} failed for ${ownerId}:`, error);
    await recordJob(ownerId, {
      id: jobId,
      stage: "Daily research and digest",
      status: "failed",
      error: message,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}

// Retain a POST entry point for manual schedulers and local smoke testing.
export const POST = GET;
