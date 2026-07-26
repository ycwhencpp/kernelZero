import { authErrorResponse, currentOwner } from "../../../../lib/auth";
import { getDashboardState, resetGeneratedWorkspaceData } from "../../../../lib/store";

export const dynamic = "force-dynamic";

/** Clears generated library, podcast, feedback, and job data without deleting cron inputs or the local voice. */
export async function POST() {
  try {
    const ownerId = await currentOwner();
    await resetGeneratedWorkspaceData(ownerId);
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json(
      { error: error instanceof Error ? error.message : "Unable to reset generated workspace data." },
      { status: 500 },
    );
  }
}
