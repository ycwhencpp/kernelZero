import { authErrorResponse, currentOwner } from "../../../lib/auth";
import { getDashboardState, saveWorkspaceSettings } from "../../../lib/store";
import { normalizeEpisodeLength } from "../../../lib/podcast-length";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  try {
    const ownerId = await currentOwner();
    const current = await getDashboardState(ownerId);
    const body = (await request.json()) as Partial<typeof current.settings>;
    const publishTime = typeof body.publishTime === "string" ? body.publishTime : current.settings.publishTime;
    if (!/^\d{2}:\d{2}$/.test(publishTime)) {
      return Response.json({ error: "Publish time must use HH:MM format." }, { status: 400 });
    }
    await saveWorkspaceSettings(ownerId, {
      dailyGeneration: typeof body.dailyGeneration === "boolean" ? body.dailyGeneration : current.settings.dailyGeneration,
      episodeLength: normalizeEpisodeLength(body.episodeLength ?? current.settings.episodeLength),
      publishTime,
    });
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json(
      { error: error instanceof Error ? error.message : "Unable to save configuration." },
      { status: 500 },
    );
  }
}
