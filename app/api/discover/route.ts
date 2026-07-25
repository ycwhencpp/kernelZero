import { authErrorResponse, currentOwner } from "../../../lib/auth";
import { deduplicateItems } from "../../../lib/domain";
import { discoverResearch } from "../../../lib/research";
import {
  getDashboardState,
  personalizeItems,
  recordJob,
  upsertItems,
} from "../../../lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const jobId = `job-discover-${Date.now()}`;
  try {
    const ownerId = await currentOwner();
    const body = (await request.json().catch(() => ({}))) as {
      interestId?: string;
    };
    const state = await getDashboardState(ownerId);
    const interest =
      state.interests.find((candidate) => candidate.id === body.interestId) ??
      state.interests.find((candidate) => candidate.enabled);
    if (!interest) {
      return Response.json(
        { error: "Add an enabled interest before discovering papers." },
        { status: 400 },
      );
    }

    await recordJob(ownerId, {
      id: jobId,
      stage: `Discover: ${interest.name}`,
      status: "running",
      provider: "OpenAlex + Semantic Scholar + arXiv",
    });
    const result = await discoverResearch(interest);
    const personalized = await personalizeItems(ownerId, result.items);
    const merged = deduplicateItems([...state.items, ...personalized]);
    const previousIds = new Set(state.items.map((item) => item.id));
    const imported = merged.filter((item) => !previousIds.has(item.id));
    await upsertItems(ownerId, personalized);
    await recordJob(ownerId, {
      id: jobId,
      stage: `Discover: ${interest.name}`,
      status: "completed",
      provider: "OpenAlex + Semantic Scholar + arXiv",
    });

    return Response.json({
      imported: imported.length,
      warnings: result.warnings,
      state: await getDashboardState(ownerId),
    });
  } catch (error) {
    try {
      const ownerId = await currentOwner();
      await recordJob(ownerId, {
        id: jobId,
        stage: "Research discovery",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // Preserve the original request error.
    }
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Discovery failed." },
        { status: 500 },
      )
    );
  }
}
