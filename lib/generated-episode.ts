import type { Episode } from "./types";

export function hasUsableAudioUrl(
  audioUrl: string | null | undefined,
): audioUrl is string {
  if (typeof audioUrl !== "string" || !audioUrl.trim()) return false;
  try {
    const url = new URL(audioUrl, "http://localhost");
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function requireGeneratedAudio(
  episode: Episode,
  audioRequested: boolean,
): void {
  if (audioRequested && !hasUsableAudioUrl(episode.audioUrl)) {
    throw new Error(
      "Audio was requested, but the generated episode has no stored audio URL.",
    );
  }
}

export function reconcileGeneratedEpisode<
  T extends { episodes: Episode[] },
>(
  state: T,
  returnedEpisode: Episode,
): { state: T; episode: Episode } {
  const storedEpisode = state.episodes.find(
    (episode) => episode.id === returnedEpisode.id,
  );
  const episode = storedEpisode
    ? { ...storedEpisode, ...returnedEpisode }
    : returnedEpisode;
  const hasStoredEpisode = Boolean(storedEpisode);
  const episodes = hasStoredEpisode
    ? state.episodes.map((candidate) =>
        candidate.id === episode.id ? episode : candidate,
      )
    : [episode, ...state.episodes];

  return {
    state: { ...state, episodes } as T,
    episode,
  };
}
