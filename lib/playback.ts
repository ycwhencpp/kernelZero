export const PLAYBACK_RATES = [0.75, 0.8, 1, 1.25, 2] as const;

export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export const PLAYBACK_RATE_OPTIONS: ReadonlyArray<{
  value: PlaybackRate;
  label: string;
}> = PLAYBACK_RATES.map((value) => ({
  value,
  label: value === 0.8 ? "0.80x" : `${value}x`,
}));

export function normalizePlaybackRate(value: unknown): PlaybackRate {
  return typeof value === "number" &&
    PLAYBACK_RATES.includes(value as PlaybackRate)
    ? (value as PlaybackRate)
    : 1;
}

export function applyPlaybackRate(
  media: {
    defaultPlaybackRate: number;
    playbackRate: number;
    preservesPitch?: boolean;
  },
  value: unknown,
): PlaybackRate {
  const rate = normalizePlaybackRate(value);
  media.defaultPlaybackRate = rate;
  media.playbackRate = rate;
  if ("preservesPitch" in media) media.preservesPitch = true;
  return rate;
}

export function clampPlaybackSeconds(
  seconds: number,
  durationSeconds: number,
): number {
  const duration =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : 1;
  return Math.max(0, Math.min(duration, Number.isFinite(seconds) ? seconds : 0));
}
