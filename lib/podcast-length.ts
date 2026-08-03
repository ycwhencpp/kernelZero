import type { Episode, EpisodeLength } from "./types";

export type EpisodeLengthProfile = {
  minutes: number;
  minWords: number;
  maxWords: number;
};

export const EPISODE_LENGTH_SOFT_TOLERANCE_WORDS = 100;

// Spoken narration averages roughly 150 words per minute. These are the target
// bands; validation adds the small absolute buffer above so near misses do not
// fail an otherwise complete episode.
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

export function episodeLengthAcceptanceRange(
  length: EpisodeLength,
): { minWords: number; maxWords: number } {
  const profile = profiles[length];
  return {
    minWords: Math.max(
      1,
      profile.minWords - EPISODE_LENGTH_SOFT_TOLERANCE_WORDS,
    ),
    maxWords: profile.maxWords + EPISODE_LENGTH_SOFT_TOLERANCE_WORDS,
  };
}

export function scriptMatchesEpisodeLength(script: string, length: EpisodeLength): boolean {
  const words = countScriptWords(script);
  const accepted = episodeLengthAcceptanceRange(length);
  return words >= accepted.minWords && words <= accepted.maxWords;
}

export function episodeLengthInstruction(
  type: Episode["type"],
  length: EpisodeLength,
): string {
  const profile = profiles[length];
  const accepted = episodeLengthAcceptanceRange(length);
  return `Create a complete ${profile.minutes}-minute ${type.replaceAll("_", " ")}. Target ${profile.minWords.toLocaleString("en-US")}–${profile.maxWords.toLocaleString("en-US")} spoken words. A soft deviation of up to ${EPISODE_LENGTH_SOFT_TOLERANCE_WORDS} words is allowed only when needed, so the final accepted range is ${accepted.minWords.toLocaleString("en-US")}–${accepted.maxWords.toLocaleString("en-US")} words. Aim for the target range rather than the tolerance boundary. Cover the full requested arc and end with a complete conclusion; never return only an introduction or an unfinished sentence.`;
}

export function estimateScriptDurationSeconds(script: string): number {
  return Math.max(1, Math.round((countScriptWords(script) / 150) * 60));
}
