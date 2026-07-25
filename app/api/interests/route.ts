import { authErrorResponse, currentOwner } from "../../../lib/auth";
import { simpleHash } from "../../../lib/rss";
import { addInterest, getDashboardState } from "../../../lib/store";
import type { InterestProfile } from "../../../lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const ownerId = await currentOwner();
    const body = (await request.json()) as Partial<InterestProfile>;
    const name = body.name?.trim();
    const query = body.query?.trim();
    if (!name || !query) {
      return Response.json(
        { error: "Name and research query are required." },
        { status: 400 },
      );
    }
    const interest: InterestProfile = {
      id: body.id || `interest-${simpleHash(`${ownerId}|${name}`)}`,
      name,
      query,
      keywords: body.keywords?.filter(Boolean) ?? [],
      exclusions: body.exclusions?.filter(Boolean) ?? [],
      preferredSources: body.preferredSources ?? [],
      freshnessDays: Math.max(1, Math.min(3650, body.freshnessDays ?? 30)),
      weight: Math.max(0.1, Math.min(2, body.weight ?? 1)),
      enabled: body.enabled ?? true,
    };
    await addInterest(ownerId, interest);
    return Response.json({ interest, state: await getDashboardState(ownerId) });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to save interest." },
        { status: 500 },
      )
    );
  }
}
