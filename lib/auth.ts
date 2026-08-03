import { getSupabase } from "./supabase";
import { getSupabaseServer } from "./supabase-server";
import { safeAvatarUrl } from "./profile-avatar";
import type { AppRole, AppUser } from "./types";

const roleRank: Record<AppRole, number> = {
  viewer: 0,
  editor: 1,
  owner: 2,
};

export class AccessError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403,
  ) {
    super(message);
  }
}

async function provisionProfile(user: {
  id: string;
  email: string;
  displayName: string;
}): Promise<AppUser> {
  const db = getSupabase();

  if (!db) {
    return {
      ...user,
      avatarUrl: null,
      role: "owner",
      workspaceOwnerId: user.id,
    };
  }

  const { data: authProfile, error: authLookupError } = await db
    .from("profiles")
    .select(
      "id, email, display_name, avatar_url, auth_user_id, role, workspace_owner_id",
    )
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (
    authLookupError &&
    !/column .* does not exist/i.test(authLookupError.message)
  ) {
    throw new Error(`Unable to load your role: ${authLookupError.message}`);
  }

  const existing = authProfile;

  if (existing && "role" in existing) {
    const profileId = String(existing.id);
    const displayName = existing.display_name || user.displayName;
    const updates: Record<string, unknown> = {};
    if (existing.auth_user_id !== user.id) updates.auth_user_id = user.id;
    if (existing.email !== user.email) updates.email = user.email;
    if (!existing.display_name) updates.display_name = displayName;
    if (existing.role !== "owner") updates.role = "owner";
    if (existing.workspace_owner_id !== profileId) {
      updates.workspace_owner_id = profileId;
    }
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error } = await db
        .from("profiles")
        .update(updates)
        .eq("id", profileId);
      if (error) {
        throw new Error(`Unable to update your profile: ${error.message}`);
      }
    }

    return {
      id: user.id,
      email: user.email,
      displayName,
      avatarUrl: safeAvatarUrl(existing.avatar_url, user.id),
      role: "owner",
      workspaceOwnerId: profileId,
    };
  }

  const profileId = user.id;
  const { error } = await db.from("profiles").insert({
    id: profileId,
    email: user.email,
    display_name: user.displayName,
    auth_user_id: user.id,
    avatar_url: null,
    role: "owner",
    workspace_owner_id: profileId,
    timezone: "Asia/Kolkata",
    daily_budget_usd: 2,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    // Two first-render requests can provision the same immutable Auth UUID at
    // once. Treat the committed matching row as success, but never claim by
    // email or accept a row linked to a different Auth identity.
    const { data: concurrentProfile, error: concurrentLookupError } = await db
      .from("profiles")
      .select(
        "id, email, display_name, avatar_url, auth_user_id, role, workspace_owner_id",
      )
      .eq("id", profileId)
      .eq("auth_user_id", user.id)
      .maybeSingle();
    if (concurrentLookupError) {
      throw new Error(
        `Unable to verify your profile: ${concurrentLookupError.message}`,
      );
    }
    if (concurrentProfile) {
      return {
        id: user.id,
        email: user.email,
        displayName: concurrentProfile.display_name || user.displayName,
        avatarUrl: safeAvatarUrl(concurrentProfile.avatar_url, user.id),
        role: "owner",
        workspaceOwnerId: String(concurrentProfile.id),
      };
    }

    throw new Error(
      /profiles_email_key|duplicate key.*email/i.test(error.message)
        ? "This email belongs to a retired workspace and cannot be claimed automatically. Ask an administrator to remove or anonymize the retired profile."
        : `Unable to create your profile. Run the latest Supabase migration: ${error.message}`,
    );
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: null,
    role: "owner",
    workspaceOwnerId: profileId,
  };
}

export async function currentUser(): Promise<AppUser | null> {
  const authClient = await getSupabaseServer();
  if (!authClient) return null;

  const {
    data: { user },
  } = await authClient.auth.getUser();
  const email = user?.email?.trim().toLowerCase();
  if (!user || !email) return null;

  const metadataName =
    typeof user.user_metadata?.full_name === "string"
      ? user.user_metadata.full_name
      : typeof user.user_metadata?.name === "string"
        ? user.user_metadata.name
        : null;
  return provisionProfile({
    id: user.id,
    email,
    displayName: metadataName || email.split("@")[0] || "KernelZero user",
  });
}

export async function requireUser(
  minimumRole: AppRole = "viewer",
): Promise<AppUser> {
  const user = await currentUser();
  if (!user) throw new AccessError("Sign in is required.", 401);
  if (roleRank[user.role] < roleRank[minimumRole]) {
    throw new AccessError(
      minimumRole === "owner"
        ? "Only the workspace owner can perform this action."
        : "Your role does not allow this action.",
      403,
    );
  }
  return user;
}

export async function currentOwner(
  minimumRole: AppRole = "viewer",
): Promise<string> {
  return (await requireUser(minimumRole)).workspaceOwnerId;
}

export function authErrorResponse(error: unknown): Response | null {
  if (error instanceof AccessError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return null;
}
