import { DEMO_OWNER_ID } from "../../../../lib/demo-data";
import {
  deduplicateItems,
  hasBudgetForGeneration,
  scoreCandidate,
  selectDigestItems,
} from "../../../../lib/domain";
import { generatePodcast, resolveAiProvider, estimatedGenerationCostUsd } from "../../../../lib/openai";
import { discoverResearch } from "../../../../lib/research";
import { fetchFeed } from "../../../../lib/rss";
import {
  addSource,
  createEpisode,
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

  const ownerId = process.env.CRON_OWNER_EMAIL?.toLowerCase() || DEMO_OWNER_ID;
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
      provider: generated.provider === "openai" ? "OpenAI" : generated.provider === "gemini" ? "Gemini" : "Demo generator",
      costUsd: generated.provider === "demo" ? 0 : estimatedCostUsd,
    });

    return Response.json({
      status: "completed",
      discovered: discovered.length,
      warnings,
      episode,
    });
  } catch (error) {
    await recordJob(ownerId, {
      id: jobId,
      stage: "Daily research and digest",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      { error: error instanceof Error ? error.message : "Daily job failed." },
      { status: 500 },
    );
  }
}

// Retain a POST entry point for manual schedulers and local smoke testing.
export const POST = GET;
