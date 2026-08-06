import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import { generateLinkedInPost } from "../../../../../lib/linkedin-post";
import {
  appendLinkedInPostSource,
  containsLinkedInPostSourceReference,
  LINKEDIN_POST_MAX_CHARACTERS,
  linkedInPostCharacterCount,
  primaryLinkedInPostSource,
  resolveLinkedInSourceCta,
  splitLinkedInPostSource,
} from "../../../../../lib/linkedin-post-format";
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
    const source = primaryLinkedInPostSource(episode, state.items);
    if (!source) {
      return Response.json(
        { error: "This episode does not have a valid source citation." },
        { status: 400 },
      );
    }

    const generated = await generateLinkedInPost({
      title: episode.title,
      transcript,
      source,
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
    const state = await getDashboardState(ownerId);
    const episode = state.episodes.find((candidate) => candidate.id === id);
    if (!episode) {
      return Response.json({ error: "Episode not found." }, { status: 404 });
    }
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
    const source = primaryLinkedInPostSource(episode, state.items);
    if (!source) {
      return Response.json(
        { error: "This episode does not have a valid source citation." },
        { status: 400 },
      );
    }
    const normalizedPost = post.trim();
    const submittedParts = splitLinkedInPostSource(normalizedPost);
    const content = submittedParts.content.trim();
    if (!content) {
      return Response.json(
        { error: "A LinkedIn post is required before the source footer." },
        { status: 400 },
      );
    }
    if (containsLinkedInPostSourceReference(content)) {
      return Response.json(
        {
          error:
            "Keep source names and URLs in the source footer; post copy can contain only the generated source.",
        },
        { status: 400 },
      );
    }
    if (
      linkedInPostCharacterCount(normalizedPost) >
      LINKEDIN_POST_MAX_CHARACTERS
    ) {
      return Response.json(
        {
          error: `LinkedIn post copy must be no more than ${LINKEDIN_POST_MAX_CHARACTERS} characters (the source footer is excluded).`,
        },
        { status: 400 },
      );
    }
    const sourceCta = resolveLinkedInSourceCta(
      episode.linkedInPost,
      episode.title,
    );
    const postWithSource = appendLinkedInPostSource(
      content,
      source,
      sourceCta,
    );

    await saveLinkedInPost(ownerId, id, postWithSource);
    return Response.json({
      post: postWithSource,
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
