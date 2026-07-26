import { authErrorResponse, currentOwner } from "../../../lib/auth";
import { deleteVoiceSample } from "../../../lib/local-voice";
import { deleteWorkspace, getDashboardState } from "../../../lib/store";

export const dynamic = "force-dynamic";

export async function DELETE() {
  try {
    const ownerId = await currentOwner();
    await Promise.all((await deleteWorkspace(ownerId)).map((sampleKey) => deleteVoiceSample(sampleKey)));
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: error instanceof Error ? error.message : "Unable to delete workspace." }, { status: 500 });
  }
}
