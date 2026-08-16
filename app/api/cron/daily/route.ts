import {
  deduplicateItems,
  hasBudgetForGeneration,
  scoreCandidate,
  selectDigestItems,
} from "../../../../lib/domain";
import {
  aiProviderLabel,
  estimatedAudioCostUsd,
  estimatedEpisodeTitleCostUsd,
  estimatedGenerationCostUsd,
  generatePodcast,
  resolveAiProvider,
  resolveEpisodeTitleProvider,
  synthesizePodcastAudio,
} from "../../../../lib/openai";
import { hasUsableAudioUrl } from "../../../../lib/generated-episode";
import { discoverResearch } from "../../../../lib/research";
import { fetchFeed } from "../../../../lib/rss";
import { createPipelineTraceId } from "../../../../lib/pipeline-log";
import { finalizeEpisodeTitleAfterNarration } from "../../../../lib/podcast-title";
import {
  hydratePodcastSources,
  storeSourceDocuments,
} from "../../../../lib/source-documents";
import {
  acquireJobLease,
  addSource,
  createEpisode,
  finishJobLease,
  findAuthenticatedOwnerIdByEmail,
  getActiveVoiceProfile,
  getDashboardState,
  personalizeItems,
  recordJob,
  renewJobLease,
  replaceEpisodeAudio,
  upsertItems,
} from "../../../../lib/store";

export const dynamic = "force-dynamic";

const DEFAULT_DAILY_JOB_LEASE_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const MIN_DAILY_JOB_LEASE_TIMEOUT_MS = 10 * 60 * 1_000;

function dailyJobLeaseTimeoutMs(): number {
  const configured = Number(process.env.DAILY_JOB_LEASE_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= MIN_DAILY_JOB_LEASE_TIMEOUT_MS
    ? configured
    : DEFAULT_DAILY_JOB_LEASE_TIMEOUT_MS;
}

type JobLeaseHeartbeat = {
  assertOwned: () => Promise<void>;
  stop: () => Promise<string>;
};

function startJobLeaseHeartbeat(
  ownerId: string,
  jobId: string,
  initialStartedAt: string,
  leaseTimeoutMs: number,
): JobLeaseHeartbeat {
  let startedAt = initialStartedAt;
  let stopped = false;
  let failure: Error | null = null;
  let pending = Promise.resolve();

  const renew = (): Promise<void> => {
    const run = pending.then(async () => {
      if (stopped) return;
      if (failure) throw failure;
      const renewedAt = await renewJobLease(ownerId, jobId, startedAt);
      if (!renewedAt) {
        throw new Error(
          "Daily generation stopped because a newer scheduler run took over its lease.",
        );
      }
      startedAt = renewedAt;
    });
    pending = run.catch((error) => {
      failure = error instanceof Error ? error : new Error(String(error));
    });
    return run;
  };

  const interval = setInterval(() => {
    void renew().catch(() => {
      // assertOwned/stop surfaces the stored failure at an operation boundary.
    });
  }, Math.max(30_000, Math.floor(leaseTimeoutMs / 3)));
  interval.unref();

  return {
    assertOwned: renew,
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await pending;
      if (failure) throw failure;
      return startedAt;
    },
  };
}

function dailyEpisodeId(ownerId: string, dateKey: string): string {
  const ownerKey = ownerId.replace(/[^a-z0-9_-]/gi, "_");
  return `episode-daily-${ownerKey}-${dateKey}`;
}

async function finalizeDailyJob(
  ownerId: string,
  jobId: string,
  provider: string,
  costUsd: number,
  leaseStartedAt?: string | null,
): Promise<void> {
  try {
    const job = {
      id: jobId,
      stage: "Daily research and digest",
      status: "completed" as const,
      provider,
      costUsd,
    };
    if (leaseStartedAt) {
      const finished = await finishJobLease(ownerId, leaseStartedAt, job);
      if (!finished) {
        console.warn(
          `[cron/daily] ${jobId} did not finalize because a newer worker owns the lease.`,
        );
      }
    } else {
      await recordJob(ownerId, job);
    }
  } catch (jobError) {
    // Once the checkpoint/audio is durable, bookkeeping must not trigger a
    // second expensive run. A later cron invocation can reconcile this row.
    console.error(
      `[cron/daily] ${jobId} completed, but final job status could not be recorded:`,
      jobError,
    );
  }
}

export async function GET(request: Request) {
  const authorization = request.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || authorization !== `Bearer ${secret}`) {
    return Response.json({ error: "Invalid scheduler credential." }, { status: 401 });
  }

  const ownerEmail =
    process.env.CRON_OWNER_EMAIL?.trim().toLowerCase() ||
    "local@kernelzero.local";
  const ownerId = await findAuthenticatedOwnerIdByEmail(ownerEmail);
  if (!ownerId) {
    return Response.json(
      {
        error:
          "CRON_OWNER_EMAIL must belong to an active account that has signed in at least once.",
      },
      { status: 409 },
    );
  }
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
  const checkpointId = dailyEpisodeId(ownerId, dateKey);
  let checkpointEpisode = initialState.episodes.find(
    (episode) => episode.id === checkpointId,
  );
  const existingJob = initialState.jobs.find((job) => job.id === jobId);
  if (!initialState.settings.dailyGeneration) {
    return Response.json({ status: "paused", message: "Daily generation is disabled in workspace settings." });
  }
  const provider = resolveAiProvider();
  const configuredTitleProvider = resolveEpisodeTitleProvider();
  const usesLocalNarrator = Boolean(initialState.voiceProfile);
  const titleEstimatedCostUsd = estimatedEpisodeTitleCostUsd(
    configuredTitleProvider,
  );
  const freshEstimatedCostUsd =
    estimatedGenerationCostUsd(provider, !usesLocalNarrator) +
    titleEstimatedCostUsd;
  const checkpointHasAudio = Boolean(
    checkpointEpisode && hasUsableAudioUrl(checkpointEpisode.audioUrl),
  );
  const checkpointNeedsTitle =
    checkpointEpisode?.titleProvenance === "provisional";
  const attemptEstimatedCostUsd = checkpointEpisode
    ? (checkpointHasAudio || usesLocalNarrator
        ? 0
        : estimatedAudioCostUsd(provider)) +
      (checkpointNeedsTitle ? titleEstimatedCostUsd : 0)
    : freshEstimatedCostUsd;
  const narratorLabel = initialState.voiceProfile
    ? "Local Chatterbox"
    : aiProviderLabel(provider);
  const configuredNarrator = configuredTitleProvider === "gemini" &&
      (checkpointEpisode ? checkpointNeedsTitle : true)
    ? `${narratorLabel} + Gemini title`
    : narratorLabel;
  if (
    checkpointHasAudio &&
    existingJob?.status === "completed" &&
    !checkpointNeedsTitle
  ) {
    return Response.json({
      status: "already_completed",
      episode: checkpointEpisode,
    });
  }
  if (
    !hasBudgetForGeneration(
      initialState.stats.dailySpendUsd,
      initialState.stats.dailyBudgetUsd,
      attemptEstimatedCostUsd,
    )
  ) {
    return Response.json(
      {
        error: `Daily AI budget reached ($${initialState.stats.dailyBudgetUsd.toFixed(2)}).`,
      },
      { status: 429 },
    );
  }

  let leaseStartedAt: string | null = null;
  let leaseCostUsd = attemptEstimatedCostUsd;
  let leaseHeartbeat: JobLeaseHeartbeat | null = null;
  try {
    const leaseTimeoutMs = dailyJobLeaseTimeoutMs();
    const lease = await acquireJobLease(
      ownerId,
      {
        id: jobId,
        stage: "Daily research and digest",
        provider: configuredNarrator,
        costUsd: attemptEstimatedCostUsd,
      },
      leaseTimeoutMs,
    );
    if (!lease.acquired) {
      return Response.json({
        status: "already_running",
        message: "Daily generation is already running for this workspace.",
      });
    }
    if (!lease.startedAt) {
      throw new Error("The daily job lease did not return a fencing token.");
    }
    leaseStartedAt = lease.startedAt;
    leaseCostUsd = lease.costUsd;
    leaseHeartbeat = startJobLeaseHeartbeat(
      ownerId,
      jobId,
      leaseStartedAt,
      leaseTimeoutMs,
    );
    const assertLeaseOwned = async (): Promise<void> => {
      if (!leaseHeartbeat) {
        throw new Error("The daily job lease is no longer available.");
      }
      await leaseHeartbeat.assertOwned();
    };
    const stopLeaseHeartbeat = async (): Promise<string> => {
      if (!leaseHeartbeat) {
        throw new Error("The daily job lease is no longer available.");
      }
      const heartbeat = leaseHeartbeat;
      leaseHeartbeat = null;
      const finalStartedAt = await heartbeat.stop();
      leaseStartedAt = finalStartedAt;
      return finalStartedAt;
    };

    // The pre-lease read is advisory: another worker may have checkpointed or
    // attached audio while this request waited to acquire the row.
    const leasedState = await getDashboardState(ownerId);
    checkpointEpisode = leasedState.episodes.find(
      (episode) => episode.id === checkpointId,
    );
    const voiceProfile = await getActiveVoiceProfile(ownerId);
    if (process.env.REQUIRE_LOCAL_VOICE === "true" && !voiceProfile) {
      throw new Error("No active local Chatterbox voice is configured for this cron owner. Save a voice in Settings before running the daily cron.");
    }
    if (voiceProfile && process.env.VERCEL) {
      throw new Error("The selected Chatterbox voice is stored on this local KernelZero machine. Run the daily cron locally; a Vercel function cannot read the local reference recording or run Chatterbox.");
    }
    if (checkpointEpisode) {
      let resumedEpisode = checkpointEpisode;
      let titleProvider: "gemini" | null = null;
      let titleError: string | null = null;
      if (!hasUsableAudioUrl(checkpointEpisode.audioUrl)) {
        const speech = await synthesizePodcastAudio(
          checkpointEpisode.script,
          provider,
          voiceProfile,
          checkpointEpisode.durationSeconds,
        );
        await assertLeaseOwned();
        resumedEpisode = await replaceEpisodeAudio(
          ownerId,
          checkpointEpisode,
          speech.audio,
          speech.audioContentType,
          speech.durationSeconds,
          {
            voiceProfileId: voiceProfile?.id ?? null,
            voiceKey: voiceProfile
              ? `profile:${voiceProfile.id}`
              : `provider:${provider ?? "configured"}`,
            voiceName: voiceProfile?.name ?? aiProviderLabel(provider),
            provider: voiceProfile?.provider ?? provider ?? "configured",
          },
        );
        await assertLeaseOwned();
      }
      const finalizedTitle = await finalizeEpisodeTitleAfterNarration(
        ownerId,
        resumedEpisode,
        {
          title: checkpointEpisode.title,
          script: checkpointEpisode.script,
        },
      );
      resumedEpisode = finalizedTitle.episode;
      titleProvider = finalizedTitle.titleProvider;
      titleError = finalizedTitle.titleError;
      await assertLeaseOwned();
      const completionToken = await stopLeaseHeartbeat();
      await finalizeDailyJob(
        ownerId,
        jobId,
        voiceProfile ? "Local Chatterbox" : aiProviderLabel(provider),
        leaseCostUsd,
        completionToken,
      );
      return Response.json({
        status: "completed",
        resumed: true,
        discovered: 0,
        warnings: titleError ? [titleError] : [],
        episode: resumedEpisode,
        titleProvider,
        titleError,
        narration: voiceProfile ? "local_chatterbox" : "system_voice",
      });
    }
    if (!provider) {
      throw new Error("No AI provider is configured for the daily podcast.");
    }
    const discovered: typeof leasedState.items = [];
    const feedDocuments: Awaited<ReturnType<typeof fetchFeed>>["documents"] = [];
    const warnings: string[] = [];
    for (const interest of leasedState.interests.filter((entry) => entry.enabled)) {
      const result = await discoverResearch(interest);
      discovered.push(...result.items);
      warnings.push(...result.warnings);
    }
    for (const source of leasedState.sources.filter(
      (entry) =>
        entry.enabled && (entry.type === "rss" || entry.type === "atom"),
    )) {
      try {
        const parsed = await fetchFeed(source.url);
        feedDocuments.push(...parsed.documents);
        discovered.push(
          ...parsed.items.map((candidate) =>
            scoreCandidate(
              {
                ...candidate,
                sourceId: source.id,
                sourceName: source.name,
              },
              leasedState.interests,
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
    const unique = deduplicateItems([...leasedState.items, ...personalized]);
    await upsertItems(ownerId, unique);
    // content_documents references content_items, so extracted feed bodies are
    // cached only after their corresponding items have been persisted.
    const persistedItemIds = new Set(unique.map((item) => item.id));
    const uniqueFeedDocuments = [
      ...new Map(
        feedDocuments
          .filter((document) => persistedItemIds.has(document.contentItemId))
          .map((document) => [document.contentItemId, document]),
      ).values(),
    ];
    await storeSourceDocuments(ownerId, uniqueFeedDocuments);

    const digestItems = selectDigestItems(unique, 5);
    const traceId = createPipelineTraceId("daily-podcast");
    const sourceCorpus = provider === "ollama"
      ? await hydratePodcastSources(ownerId, digestItems, { traceId })
      : undefined;
    const generated = await generatePodcast(digestItems, "daily_digest", {
      includeAudio: true,
      voiceProfile,
      episodeLength: leasedState.settings.episodeLength,
      episodeId: checkpointId,
      sourceCorpus,
      traceId,
      onDraftReady: async (checkpoint) => {
        await assertLeaseOwned();
        await createEpisode(ownerId, checkpoint.episode, checkpoint.evidence);
        await assertLeaseOwned();
      },
    });
    if (!generated.audio || generated.audio.byteLength === 0) {
      throw new Error("Audio was requested, but the narrator returned no audio data.");
    }
    await assertLeaseOwned();
    let episode = await replaceEpisodeAudio(
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
    await assertLeaseOwned();
    const finalizedTitle = await finalizeEpisodeTitleAfterNarration(
      ownerId,
      episode,
      {
        title: generated.episode.title,
        script: generated.episode.script,
      },
    );
    episode = finalizedTitle.episode;
    if (finalizedTitle.titleError) warnings.push(finalizedTitle.titleError);
    await assertLeaseOwned();
    const completionToken = await stopLeaseHeartbeat();
    await finalizeDailyJob(
      ownerId,
      jobId,
      configuredTitleProvider === "gemini"
        ? `${aiProviderLabel(generated.provider)} + Gemini title`
        : aiProviderLabel(generated.provider),
      leaseCostUsd,
      completionToken,
    );

    return Response.json({
      status: "completed",
      discovered: discovered.length,
      warnings,
      episode,
      titleProvider: finalizedTitle.titleProvider,
      titleError: finalizedTitle.titleError,
      narration: voiceProfile ? "local_chatterbox" : "system_voice",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[cron/daily] ${jobId} failed for ${ownerId}:`, error);
    let failureToken = leaseStartedAt;
    if (leaseHeartbeat) {
      const heartbeat = leaseHeartbeat;
      leaseHeartbeat = null;
      try {
        failureToken = await heartbeat.stop();
      } catch (heartbeatError) {
        failureToken = null;
        console.warn(
          `[cron/daily] ${jobId} no longer owns its lease:`,
          heartbeatError,
        );
      }
    }
    if (failureToken) {
      try {
        const finished = await finishJobLease(ownerId, failureToken, {
          id: jobId,
          stage: "Daily research and digest",
          status: "failed",
          provider: configuredNarrator,
          costUsd: leaseCostUsd,
          error: message,
        });
        if (!finished) {
          console.warn(
            `[cron/daily] ${jobId} failure was ignored because a newer worker owns the lease.`,
          );
        }
      } catch (jobError) {
        console.error(`[cron/daily] ${jobId} could not record failure:`, jobError);
      }
    }
    return Response.json({ error: message }, { status: 500 });
  } finally {
    if (leaseHeartbeat) {
      const heartbeat = leaseHeartbeat;
      leaseHeartbeat = null;
      try {
        await heartbeat.stop();
      } catch (heartbeatError) {
        console.warn(
          `[cron/daily] ${jobId} could not stop its lease heartbeat cleanly:`,
          heartbeatError,
        );
      }
    }
  }
}

// Retain a POST entry point for manual schedulers and local smoke testing.
export const POST = GET;
