import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import {
  generateLinkedInPost,
  LINKEDIN_POST_MAX_CHARACTERS,
} from "../../../../../lib/linkedin-post";
import {
  EpisodeNotFoundError,
  getDashboardState,
  saveLinkedInPost,
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
    await saveLinkedInPost(ownerId, id, generated.post);
    return Response.json({
      ...generated,
      state: await getDashboardState(ownerId),
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
              ? error.message
              : "Unable to generate a LinkedIn post.",
        },
        { status: 500 },
      )
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("editor");
    const { id } = await context.params;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "A LinkedIn post is required." }, { status: 400 });
    }

    const post =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).post
        : null;
    if (typeof post !== "string" || !post.trim()) {
      return Response.json({ error: "A LinkedIn post is required." }, { status: 400 });
    }
    const normalizedPost = post.trim();
    if (normalizedPost.length > LINKEDIN_POST_MAX_CHARACTERS) {
      return Response.json(
        {
          error: `LinkedIn posts must be no more than ${LINKEDIN_POST_MAX_CHARACTERS} characters.`,
        },
        { status: 400 },
      );
    }

    await saveLinkedInPost(ownerId, id, normalizedPost);
    return Response.json({
      post: normalizedPost,
      state: await getDashboardState(ownerId),
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
              ? error.message
              : "Unable to save the LinkedIn post.",
        },
        { status: 500 },
      )
    );
  }
}
