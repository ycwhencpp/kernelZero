import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import { generateLinkedInPost } from "../../../../../lib/linkedin-post";
import { getDashboardState } from "../../../../../lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("editor");
    const { id } = await context.params;
    const state = await getDashboardState(ownerId);
    const episode = state.episodes.find((candidate) => candidate.id === id);
    if (!episode) {
      return Response.json({ error: "Episode not found." }, { status: 404 });
    }

    const transcript = episode.transcript?.trim() || episode.script?.trim();
    if (!transcript) {
      return Response.json(
        { error: "This episode does not have a transcript." },
        { status: 400 },
      );
    }

    const generated = await generateLinkedInPost({
      title: episode.title,
      transcript,
    });
    return Response.json(generated);
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Unable to generate a LinkedIn post.",
        },
        { status: 500 },
      )
    );
  }
}
