export type AiProvider = "openai" | "gemini" | "ollama";
export type EpisodeTitleProvider = "gemini";

export function configuredEpisodeTitleProviderMode(): string {
  return (process.env.EPISODE_TITLE_PROVIDER ?? "").trim().toLowerCase();
}

function resolveAiProviderMode(mode: string): AiProvider | null {
  const normalizedMode = mode.trim().toLowerCase();
  if (normalizedMode === "openai") {
    return process.env.OPENAI_API_KEY ? "openai" : null;
  }
  if (normalizedMode === "gemini") {
    return process.env.GEMINI_API_KEY ? "gemini" : null;
  }
  if (normalizedMode === "ollama") return "ollama";
  if (normalizedMode === "auto") {
    if (process.env.GEMINI_API_KEY) return "gemini";
    if (process.env.OPENAI_API_KEY) return "openai";
    return "ollama";
  }
  return null;
}

export function resolveAiProvider(): AiProvider | null {
  return resolveAiProviderMode(process.env.AI_PROVIDER ?? "auto");
}

export function resolveLinkedInPostProvider(): AiProvider | null {
  const override = process.env.LINKEDIN_POST_PROVIDER;
  return override?.trim()
    ? resolveAiProviderMode(override)
    : resolveAiProvider();
}

export function resolveEpisodeTitleProvider(): EpisodeTitleProvider | null {
  const mode = configuredEpisodeTitleProviderMode();
  if (!mode) return null;
  if (mode === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  return null;
}

export function aiProviderLabel(provider: AiProvider | null): string {
  if (provider === "gemini") return "Gemini";
  if (provider === "openai") return "OpenAI";
  if (provider === "ollama") return "Local Ollama";
  return "Demo generator";
}

export function estimatedGenerationCostUsd(
  provider: AiProvider | null,
  includeAudio: boolean,
): number {
  if (!provider) return 0;
  if (provider === "ollama") return 0;
  if (provider === "gemini") return includeAudio ? 0.12 : 0.04;
  return includeAudio ? 0.16 : 0.06;
}

export function estimatedAudioCostUsd(provider: AiProvider | null): number {
  if (provider === "openai") return 0.1;
  if (provider === "gemini") return 0.08;
  return 0;
}

/** Conservative allowance for a final-title request plus bounded retries. */
export function estimatedEpisodeTitleCostUsd(
  provider: EpisodeTitleProvider | null,
): number {
  return provider === "gemini" ? 0.01 : 0;
}
