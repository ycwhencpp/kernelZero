export type AiProvider = "openai" | "gemini";

export function resolveAiProvider(): AiProvider | null {
  const mode = (process.env.AI_PROVIDER ?? "auto").toLowerCase();
  if (mode === "openai") {
    return process.env.OPENAI_API_KEY ? "openai" : null;
  }
  if (mode === "gemini") {
    return process.env.GEMINI_API_KEY ? "gemini" : null;
  }
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

export function aiProviderLabel(provider: AiProvider | null): string {
  if (provider === "gemini") return "Gemini";
  if (provider === "openai") return "OpenAI";
  return "Demo generator";
}

export function estimatedGenerationCostUsd(
  provider: AiProvider | null,
  includeAudio: boolean,
): number {
  if (!provider) return 0;
  if (provider === "gemini") return includeAudio ? 0.12 : 0.04;
  return includeAudio ? 0.16 : 0.06;
}
