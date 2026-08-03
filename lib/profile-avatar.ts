export const MAX_AVATAR_BYTES = 3 * 1024 * 1024;

const AVATAR_USER_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
const AVATAR_ROUTE_PATTERN = /^\/api\/avatars\/([^/]+)$/;

export function isSafeAvatarUserId(value: string): boolean {
  return AVATAR_USER_ID_PATTERN.test(value);
}

export function avatarStorageKey(authUserId: string): string {
  if (!isSafeAvatarUserId(authUserId)) {
    throw new Error("Invalid avatar owner.");
  }
  return `avatars/${authUserId}/profile`;
}

export function createAvatarUrl(
  authUserId: string,
  version: number = Date.now(),
): string {
  if (!isSafeAvatarUserId(authUserId)) {
    throw new Error("Invalid avatar owner.");
  }
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("Invalid avatar version.");
  }
  return `/api/avatars/${encodeURIComponent(authUserId)}?v=${version}`;
}

export function safeAvatarUrl(
  value: unknown,
  expectedAuthUserId?: string,
): string | null {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value, "https://avatar.local");
  } catch {
    return null;
  }

  if (parsed.origin !== "https://avatar.local" || parsed.hash) return null;
  const match = AVATAR_ROUTE_PATTERN.exec(parsed.pathname);
  if (!match) return null;

  let authUserId: string;
  try {
    authUserId = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  if (
    !isSafeAvatarUserId(authUserId) ||
    (expectedAuthUserId && authUserId !== expectedAuthUserId)
  ) {
    return null;
  }

  const queryKeys = [...parsed.searchParams.keys()];
  if (
    queryKeys.some((key) => key !== "v") ||
    parsed.searchParams.getAll("v").length > 1
  ) {
    return null;
  }
  const version = parsed.searchParams.get("v");
  if (version !== null && !/^\d{1,20}$/.test(version)) return null;

  return `/api/avatars/${encodeURIComponent(authUserId)}${
    version === null ? "" : `?v=${version}`
  }`;
}
