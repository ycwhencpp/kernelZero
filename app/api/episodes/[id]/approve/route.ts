import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import { approveEpisode, getDashboardState } from "../../../../../lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("owner");
    const { id } = await context.params;
    await approveEpisode(ownerId, id);
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to approve episode." },
        { status: 500 },
      )
    );
  }
}
