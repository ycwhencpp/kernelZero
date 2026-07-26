import { authErrorResponse, currentOwner } from "../../../../lib/auth";
import { getDashboardState, updateEpisode } from "../../../../lib/store";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner();
    const { id } = await context.params;
    const body = (await request.json()) as { script?: string; transcript?: string; showNotes?: string };
    if (!body.script?.trim()) return Response.json({ error: "Script cannot be empty." }, { status: 400 });
    await updateEpisode(ownerId, id, {
      script: body.script,
      transcript: body.transcript ?? body.script,
      showNotes: body.showNotes,
    });
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: error instanceof Error ? error.message : "Unable to update episode." }, { status: 500 });
  }
}
