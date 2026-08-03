import { authErrorResponse, requireUser } from "../../../../lib/auth";
import {
  avatarStorageKey,
  isSafeAvatarUserId,
  safeAvatarUrl,
} from "../../../../lib/profile-avatar";
import { getSupabase, MEDIA_BUCKET } from "../../../../lib/supabase";

export const dynamic = "force-dynamic";

const SIGNED_URL_LIFETIME_SECONDS = 60;

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    await requireUser();
    const { id } = await context.params;
    if (!isSafeAvatarUserId(id)) {
      return new Response("Not found", { status: 404 });
    }

    const db = getSupabase();
    if (!db) return new Response("Not found", { status: 404 });
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("avatar_url")
      .eq("auth_user_id", id)
      .maybeSingle();
    if (
      profileError ||
      !profile ||
      !safeAvatarUrl(profile.avatar_url, id)
    ) {
      return new Response("Not found", { status: 404 });
    }

    const { data, error } = await db.storage
      .from(MEDIA_BUCKET)
      .createSignedUrl(avatarStorageKey(id), SIGNED_URL_LIFETIME_SECONDS);
    if (error || !data?.signedUrl) {
      return new Response("Not found", { status: 404 });
    }

    return new Response(null, {
      status: 302,
      headers: {
        "Cache-Control": "private, no-store",
        Location: data.signedUrl,
        "Referrer-Policy": "no-referrer",
      },
    });
  } catch (error) {
    return (
      authErrorResponse(error) ??
      Response.json(
        { error: "Unable to load profile picture." },
        { status: 500 },
      )
    );
  }
}
