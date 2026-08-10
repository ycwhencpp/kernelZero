import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import {
  isPublishedAudioDefaultConflict,
  parseApprovalAudioVariantSelection,
} from "../../../../../lib/audio-variant-api";
import {
  approveEpisode,
  EpisodeAudioVariantNotFoundError,
  EpisodeGenerationWarningApprovalRequiredError,
  EpisodeNotFoundError,
  getDashboardState,
} from "../../../../../lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("owner");
    const { id } = await context.params;
    const selection = await parseApprovalAudioVariantSelection(request);
    if (!selection.ok) {
      return Response.json({ error: selection.error }, { status: 400 });
    }
    await approveEpisode(ownerId, id, {
      overrideTitleWarning: selection.overrideTitleWarning,
      defaultAudioVariantId: selection.defaultAudioVariantId,
    });
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    if (error instanceof EpisodeGenerationWarningApprovalRequiredError) {
      return Response.json(
        {
          code: "generation_warning_override_required",
          error: error.message,
        },
        { status: 409 },
      );
    }
    if (error instanceof EpisodeNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof EpisodeAudioVariantNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (isPublishedAudioDefaultConflict(error)) {
      return Response.json(
        {
          code: "published_audio_default_locked",
          error: error.message,
        },
        { status: 409 },
      );
    }
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to approve episode." },
        { status: 500 },
      )
    );
  }
}
