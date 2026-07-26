import type { Episode, EpisodeLength } from "./types";

export type EpisodeLengthProfile = {
  minutes: number;
  minWords: number;
  maxWords: number;
};

// Spoken narration averages roughly 150 words per minute. Keep a narrow
// tolerance so the selected duration is a real generation contract, not a
// suggestion that a model can satisfy with an intro-sized response.
const profiles: Record<EpisodeLength, EpisodeLengthProfile> = {
  brief: {
    minutes: 3,
    minWords: 405,
    maxWords: 495,
  },
  standard: {
    minutes: 9,
    minWords: 1_215,
    maxWords: 1_485,
  },
  deep: {
    minutes: 15,
    minWords: 2_025,
    maxWords: 2_475,
  },
};

export function normalizeEpisodeLength(value: unknown): EpisodeLength {
  return value === "brief" || value === "deep" || value === "standard" ? value : "standard";
}

export function episodeLengthProfile(length: EpisodeLength): EpisodeLengthProfile {
  return profiles[length];
}

export function episodeDurationMinutes(type: Episode["type"], length: EpisodeLength): string {
  void type;
  return String(profiles[length].minutes);
}

export function countScriptWords(script: string): number {
  return script.trim() ? script.trim().split(/\s+/).length : 0;
}

export function scriptMatchesEpisodeLength(script: string, length: EpisodeLength): boolean {
  const words = countScriptWords(script);
  const profile = profiles[length];
  return words >= profile.minWords && words <= profile.maxWords;
}

export function episodeLengthInstruction(
  type: Episode["type"],
  length: EpisodeLength,
): string {
  const profile = profiles[length];
  return `Create a complete ${profile.minutes}-minute ${type.replaceAll("_", " ")}. The spoken script must contain ${profile.minWords.toLocaleString("en-US")}–${profile.maxWords.toLocaleString("en-US")} words. This word range is mandatory. Cover the full requested arc and end with a complete conclusion; never return only an introduction or an unfinished sentence.`;
}

export function estimateScriptDurationSeconds(script: string): number {
  return Math.max(1, Math.round((countScriptWords(script) / 150) * 60));
}
