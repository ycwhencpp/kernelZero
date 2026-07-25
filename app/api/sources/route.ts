import { authErrorResponse, currentOwner } from "../../../lib/auth";
import { scoreCandidate } from "../../../lib/domain";
import { fetchFeed, simpleHash } from "../../../lib/rss";
import {
  addSource,
  getDashboardState,
  personalizeItems,
  upsertItems,
} from "../../../lib/store";
import type { InterestProfile, Source } from "../../../lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const ownerId = await currentOwner();
    const body = (await request.json()) as { url?: string; name?: string };
    if (!body.url) {
      return Response.json({ error: "Feed URL is required." }, { status: 400 });
    }
    let url: URL;
    try {
      url = new URL(body.url);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    } catch {
      return Response.json(
        { error: "Enter a valid public RSS or Atom URL." },
        { status: 400 },
      );
    }

    const parsed = await fetchFeed(url.toString());
    const state = await getDashboardState(ownerId);
    const interests: InterestProfile[] = state.interests;
    const source: Source = {
      id: `source-${simpleHash(url.toString())}`,
      name: body.name?.trim() || parsed.title,
      type: "rss",
      url: url.toString(),
      trustLevel: "trusted",
      rightsMode: "feed_only",
      enabled: true,
      lastSuccessfulFetch: new Date().toISOString(),
    };
    const items = parsed.items.map((candidate) =>
      scoreCandidate(
        {
          ...candidate,
          sourceId: source.id,
          sourceName: source.name,
        },
        interests,
      ),
    );

    const personalized = await personalizeItems(ownerId, items);
    await addSource(ownerId, source);
    await upsertItems(ownerId, personalized);
    return Response.json({
      source,
      imported: personalized.length,
      state: await getDashboardState(ownerId),
    });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to add feed." },
        { status: 500 },
      )
    );
  }
}
