export type PipelineLogLevel = "off" | "info" | "debug";

function configuredLevel(): PipelineLogLevel {
  const value = process.env.OLLAMA_PIPELINE_LOG_LEVEL?.trim().toLowerCase();
  return value === "off" || value === "debug" || value === "info"
    ? value
    : "info";
}

function shouldLog(level: Exclude<PipelineLogLevel, "off">): boolean {
  const configured = configuredLevel();
  if (configured === "off") return false;
  return level === "info" || configured === "debug";
}

function safeDetails(
  details: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> {
  return Object.fromEntries(
    Object.entries(details).filter(
      (entry): entry is [string, string | number | boolean | null] =>
        entry[1] !== undefined,
    ),
  );
}

/**
 * Emits metadata-only pipeline events. Callers must pass counts, identifiers,
 * decisions, and timings rather than source, transcript, digest, or title text.
 */
export function logPipelineEvent(
  traceId: string,
  event: string,
  details: Record<string, string | number | boolean | null | undefined> = {},
  level: Exclude<PipelineLogLevel, "off"> = "info",
): void {
  if (!shouldLog(level)) return;
  console.info(
    `[pipeline] ${JSON.stringify({
      timestamp: new Date().toISOString(),
      traceId,
      event,
      ...safeDetails(details),
    })}`,
  );
}

export function createPipelineTraceId(prefix = "podcast"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export async function withPipelineStage<T>(
  traceId: string,
  stage: string,
  details: Record<string, string | number | boolean | null | undefined>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  logPipelineEvent(traceId, "stage_started", { stage, ...details });
  try {
    const result = await operation();
    logPipelineEvent(traceId, "stage_completed", {
      stage,
      durationMs: Math.round(performance.now() - startedAt),
      ...details,
    });
    return result;
  } catch (error) {
    logPipelineEvent(traceId, "stage_failed", {
      stage,
      durationMs: Math.round(performance.now() - startedAt),
      errorType: error instanceof Error ? error.name : "unknown",
      ...details,
    });
    throw error;
  }
}
