import { authErrorResponse, currentOwner } from "../../../../../lib/auth";
import {
  getDashboardState,
  recordFeedback,
} from "../../../../../lib/store";

export const dynamic = "force-dynamic";

const actions = new Set(["saved", "skipped", "listened", "rating"]);

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("editor");
    const { id } = await context.params;
    const body = (await request.json()) as {
      action?: "saved" | "skipped" | "listened" | "rating";
      value?: number;
    };
    if (!body.action || !actions.has(body.action)) {
      return Response.json({ error: "Unknown feedback action." }, { status: 400 });
    }
    if (
      body.action === "rating" &&
      (!Number.isFinite(body.value) || (body.value ?? 0) < 1 || (body.value ?? 0) > 5)
    ) {
      return Response.json(
        { error: "Ratings must be between 1 and 5." },
        { status: 400 },
      );
    }

    await recordFeedback(ownerId, id, body.action, body.value);
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to record feedback." },
        { status: 500 },
      )
    );
  }
}
