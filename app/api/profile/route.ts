import { authErrorResponse, requireUser } from "../../../lib/auth";
import { getSupabase } from "../../../lib/supabase";

export async function PATCH(request: Request) {
  try {
    const user = await requireUser();
    const body = (await request.json()) as { displayName?: string };
    const displayName = body.displayName?.trim();
    if (!displayName || displayName.length < 2 || displayName.length > 80) {
      return Response.json(
        { error: "Display name must be between 2 and 80 characters." },
        { status: 400 },
      );
    }
    const db = getSupabase();
    if (db) {
      const { error } = await db
        .from("profiles")
        .update({
          display_name: displayName,
          updated_at: new Date().toISOString(),
        })
        .eq("auth_user_id", user.id);
      if (error) throw new Error(error.message);
    }

    return Response.json({ user: { ...user, displayName } });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: error instanceof Error ? error.message : "Unable to update profile." },
        { status: 500 },
      )
    );
  }
}
