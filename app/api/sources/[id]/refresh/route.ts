import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import { scoreCandidate } from "../../../../../lib/domain";
import { fetchFeed } from "../../../../../lib/rss";
import { storeSourceDocuments } from "../../../../../lib/source-documents";
import { addSource, getDashboardState, personalizeItems, upsertItems } from "../../../../../lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("editor");
    const { id } = await context.params;
    const state = await getDashboardState(ownerId);
    const source = state.sources.find((candidate) => candidate.id === id);
    if (!source) return Response.json({ error: "Source not found." }, { status: 404 });
    if (source.type !== "rss" && source.type !== "atom") return Response.json({ error: "This source refreshes during research discovery." }, { status: 400 });
    const parsed = await fetchFeed(source.url);
    const items = await personalizeItems(ownerId, parsed.items.map((candidate) => scoreCandidate({ ...candidate, sourceId: source.id, sourceName: source.name }, state.interests)));
    await upsertItems(ownerId, items);
    await storeSourceDocuments(ownerId, parsed.documents);
    await addSource(ownerId, { ...source, lastSuccessfulFetch: new Date().toISOString() });
    return Response.json({ imported: items.length, state: await getDashboardState(ownerId) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: error instanceof Error ? error.message : "Unable to refresh source." }, { status: 500 });
  }
}
