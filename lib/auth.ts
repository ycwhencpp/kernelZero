import { getSupabase, getSupabaseAuthAdmin } from "./supabase";
import { getSupabaseServer } from "./supabase-server";
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

function normalizeRole(value: unknown): AppRole {
  return value === "owner" || value === "editor" ? value : "viewer";
}

function ownerEmail(): string | null {
  return (
    process.env.APP_OWNER_EMAIL?.trim().toLowerCase() ||
    process.env.CRON_OWNER_EMAIL?.trim().toLowerCase() ||
    null
  );
}

async function provisionProfile(user: {
  id: string;
  email: string;
  displayName: string;
}): Promise<AppUser> {
  const db = getSupabase();
  const configuredOwner = ownerEmail();
  const isConfiguredOwner = user.email === configuredOwner;
  const defaultWorkspaceOwner = configuredOwner || user.email;

  if (!db) {
    return {
      ...user,
      avatarUrl: null,
      role: isConfiguredOwner ? "owner" : "viewer",
      workspaceOwnerId: isConfiguredOwner ? user.email : defaultWorkspaceOwner,
    };
  }

  const { data: authProfile, error: authLookupError } = await db
    .from("profiles")
    .select("id, email, display_name, avatar_url, role, workspace_owner_id")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (
    authLookupError &&
    !/column .* does not exist/i.test(authLookupError.message)
  ) {
    throw new Error(`Unable to load your role: ${authLookupError.message}`);
  }

  const { data: emailProfile, error: emailLookupError } = authProfile
    ? { data: null, error: null }
    : await db
        .from("profiles")
        .select("id, email, display_name, avatar_url, role, workspace_owner_id")
        .eq("email", user.email)
        .maybeSingle();
  if (
    emailLookupError &&
    !/column .* does not exist/i.test(emailLookupError.message)
  ) {
    throw new Error(`Unable to load your role: ${emailLookupError.message}`);
  }
  const existing = authProfile || emailProfile;

  if (existing && "role" in existing) {
    const role = isConfiguredOwner ? "owner" : normalizeRole(existing.role);
    const workspaceOwnerId =
      (existing.workspace_owner_id as string | null) ||
      (role === "owner" ? existing.id : defaultWorkspaceOwner);
    const { error } = await db
      .from("profiles")
      .update({
        auth_user_id: user.id,
        display_name: existing.display_name || user.displayName,
        role,
        workspace_owner_id: workspaceOwnerId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);
    if (error) throw new Error(`Unable to update your profile: ${error.message}`);

    return {
      id: user.id,
      email: existing.email,
      displayName: existing.display_name || user.displayName,
      avatarUrl: existing.avatar_url,
      role,
      workspaceOwnerId,
    };
  }

  const role: AppRole = isConfiguredOwner ? "owner" : "viewer";
  const workspaceOwnerId =
    role === "owner" ? user.email : defaultWorkspaceOwner;
  const { error } = await db.from("profiles").upsert({
    id: user.email,
    email: user.email,
    display_name: user.displayName,
    auth_user_id: user.id,
    avatar_url: null,
    role,
    workspace_owner_id: workspaceOwnerId,
    timezone: "Asia/Kolkata",
    daily_budget_usd: 2,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    throw new Error(
      `Unable to create your profile. Run the latest Supabase migration: ${error.message}`,
    );
  }

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: null,
    role,
    workspaceOwnerId,
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

export async function updateUserRole(
  email: string,
  role: AppRole,
): Promise<void> {
  const admin = getSupabaseAuthAdmin();
  if (!admin) throw new Error("Supabase Auth admin is not configured.");
  const { data, error } = await admin.auth.admin.listUsers();
  if (error) throw new Error(error.message);
  const authUser = data.users.find(
    (candidate) => candidate.email?.toLowerCase() === email.toLowerCase(),
  );
  if (!authUser) throw new Error("No Supabase Auth user has that email.");
  const db = getSupabase();
  const { error: profileError } = await db!
    .from("profiles")
    .update({ role, updated_at: new Date().toISOString() })
    .eq("auth_user_id", authUser.id);
  if (profileError) throw new Error(profileError.message);
}
