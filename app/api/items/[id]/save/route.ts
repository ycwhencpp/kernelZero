import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import {
  getDashboardState,
  recordFeedback,
  saveItem,
} from "../../../../../lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("editor");
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { saved?: boolean };
    const saved = body.saved ?? true;
    await saveItem(ownerId, id, saved);
    await recordFeedback(ownerId, id, "saved", saved ? 1 : 0);
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to save item." },
        { status: 500 },
      )
    );
  }
}
