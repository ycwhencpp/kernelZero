import { authErrorResponse, currentOwner } from "../../../lib/auth";
import { getDashboardState } from "../../../lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ownerId = await currentOwner();
    const state = await getDashboardState(ownerId);
    return Response.json(state, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to load state." },
        { status: 500 },
      )
    );
  }
}
