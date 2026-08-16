import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import { createPodcastTitle } from "../../../../../lib/gemini";
import { warningAfterEpisodeTitleGeneration } from "../../../../../lib/podcast-title";
import {
  EpisodeNotFoundError,
  findEpisode,
  getDashboardState,
  updateRegeneratedEpisodeTitle,
} from "../../../../../lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("editor");
    const { id } = await context.params;
    const episode = await findEpisode(ownerId, id);
    if (!episode) {
      return Response.json({ error: "Episode not found." }, { status: 404 });
    }
    if (episode.status !== "draft" && episode.status !== "needs_approval") {
      return Response.json(
        { error: "Only draft episodes can have their title regenerated." },
        { status: 409 },
      );
    }

    const transcript = episode.transcript?.trim() || episode.script?.trim();
    if (!transcript) {
      return Response.json(
        { error: "This episode does not have a transcript." },
        { status: 400 },
      );
    }
    if (!process.env.GEMINI_API_KEY?.trim()) {
      return Response.json(
        {
          error:
            "Gemini title generation is unavailable because GEMINI_API_KEY is not configured.",
        },
        { status: 503 },
      );
    }

    const generated = await createPodcastTitle(transcript, episode.type);
    const generationWarning = warningAfterEpisodeTitleGeneration(
      episode.generationWarning,
      generated.generationWarning,
    );
    const applied = await updateRegeneratedEpisodeTitle(
      ownerId,
      id,
      { title: episode.title, transcript },
      { title: generated.title, generationWarning },
    );
    if (!applied) {
      return Response.json(
        {
          error:
            "The title or transcript changed while Gemini was working. Review the latest draft and try again.",
        },
        { status: 409 },
      );
    }

    const state = await getDashboardState(ownerId);
    const updatedEpisode = state.episodes.find(
      (candidate) => candidate.id === id,
    ) ?? {
      ...episode,
      title: generated.title,
      generationWarning,
      titleProvenance: "gemini" as const,
    };

    return Response.json({
      episode: updatedEpisode,
      provider: "gemini" as const,
      attempts: generated.attempts,
      titleNeedsReview:
        generated.generationWarning === "title_validation_failed",
      state,
    });
  } catch (error) {
    if (error instanceof EpisodeNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    return (
      authErrorResponse(error) ??
      Response.json(
        {
          error:
            error instanceof Error
              ? `Gemini could not regenerate this title: ${error.message}`
              : "Gemini could not regenerate this title.",
        },
        { status: 502 },
      )
    );
  }
}
