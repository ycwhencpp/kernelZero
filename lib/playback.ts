export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2] as const;

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
