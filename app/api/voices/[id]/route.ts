import { authErrorResponse, currentOwner } from "../../../../lib/auth";
import { getDashboardState, selectVoiceProfile } from "../../../../lib/store";

export const dynamic = "force-dynamic";

export async function PATCH(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ownerId = await currentOwner("owner");
    const { id } = await context.params;
    await selectVoiceProfile(ownerId, id);
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json(
      { error: error instanceof Error ? error.message : "Unable to select the local narrator." },
      { status: 500 },
    );
  }
}
