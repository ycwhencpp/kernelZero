import {
  configuredEpisodeTitleProviderMode,
  resolveEpisodeTitleProvider,
  type EpisodeTitleProvider,
} from "./ai-config";
import { createPodcastTitle } from "./gemini";
import {
  findEpisode,
  updateGeneratedEpisodeTitle,
} from "./store";
import type { Episode, EpisodeGenerationWarning } from "./types";

export const EPISODE_TITLE_GENERATION_FALLBACK_MESSAGE =
  "Gemini could not create the final episode title, so the provisional title was kept.";

export type EpisodeTitleFinalizationResult = {
  episode: Episode;
  titleProvider: EpisodeTitleProvider | null;
  titleError: string | null;
  attempts: number;
};

export function warningAfterEpisodeTitleGeneration(
  currentWarning: EpisodeGenerationWarning | null | undefined,
  generatedTitleWarning: EpisodeGenerationWarning | null,
): EpisodeGenerationWarning | null {
  // A title-only operation cannot prove that a short transcript has become
  // long enough, so that durable publication gate remains authoritative.
  if (currentWarning === "length_below_target") return currentWarning;
  return generatedTitleWarning;
}

export async function finalizeEpisodeTitleAfterNarration(
  ownerId: string,
  episode: Episode,
  expected: Pick<Episode, "title" | "script">,
): Promise<EpisodeTitleFinalizationResult> {
  if (episode.titleProvenance !== "provisional") {
    return {
      episode,
      titleProvider: null,
      titleError: null,
      attempts: 0,
    };
  }

  const configuredMode = configuredEpisodeTitleProviderMode();
  if (!configuredMode) {
    return {
      episode,
      titleProvider: null,
      titleError: null,
      attempts: 0,
    };
  }

  const titleProvider = resolveEpisodeTitleProvider();
  if (!titleProvider) {
    const detail = configuredMode === "gemini"
      ? "GEMINI_API_KEY is not configured."
      : `EPISODE_TITLE_PROVIDER=${JSON.stringify(configuredMode)} is not supported.`;
    console.error(`[podcast-title] ${detail}`);
    return {
      episode,
      titleProvider: null,
      titleError: EPISODE_TITLE_GENERATION_FALLBACK_MESSAGE,
      attempts: 0,
    };
  }

  try {
    const transcript = episode.transcript?.trim() || episode.script;
    const generated = await createPodcastTitle(transcript, episode.type);
    const generationWarning = warningAfterEpisodeTitleGeneration(
      episode.generationWarning,
      generated.generationWarning,
    );
    const titledEpisode: Episode = {
      ...episode,
      title: generated.title,
      generationWarning,
      titleProvenance: "gemini",
    };
    const applied = await updateGeneratedEpisodeTitle(
      ownerId,
      episode.id,
      expected,
      {
        title: titledEpisode.title,
        generationWarning: titledEpisode.generationWarning,
      },
    );
    if (applied) {
      return {
        episode: titledEpisode,
        titleProvider,
        titleError: null,
        attempts: generated.attempts,
      };
    }

    // The editor changed the title or transcript while narration was running.
    // Keep that authoritative edit instead of overwriting it with generated metadata.
    const authoritativeEpisode = await findEpisode(ownerId, episode.id);
    return {
      episode: authoritativeEpisode ?? episode,
      titleProvider: null,
      titleError: null,
      attempts: generated.attempts,
    };
  } catch (error) {
    console.error(
      `[podcast-title] episode=${episode.id} final title generation failed:`,
      error instanceof Error ? error.message : String(error),
    );
    return {
      episode,
      titleProvider: null,
      titleError: EPISODE_TITLE_GENERATION_FALLBACK_MESSAGE,
      attempts: 0,
    };
  }
}
