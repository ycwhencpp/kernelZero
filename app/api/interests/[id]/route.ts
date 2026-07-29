import { authErrorResponse, currentOwner } from "../../../../lib/auth";
import { getSupabase } from "../../../../lib/supabase";
import { getDashboardState } from "../../../../lib/store";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const ownerId = await currentOwner("editor");
    const { id } = await context.params;
    const db = getSupabase();
    if (db) {
      const { error } = await db.from("interest_profiles").delete().eq("id", id).eq("owner_id", ownerId);
      if (error) throw new Error(error.message);
    }
    return Response.json({ state: await getDashboardState(ownerId) });
  } catch (error) {
    return authErrorResponse(error) ?? Response.json({ error: error instanceof Error ? error.message : "Unable to remove interest." }, { status: 500 });
  }
}
