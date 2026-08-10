export type ApprovalAudioVariantSelection =
  | {
      ok: true;
      overrideTitleWarning: boolean;
      defaultAudioVariantId: string | undefined;
    }
  | { ok: false; error: string };

export type RequiredAudioVariantSelection =
  | { ok: true; audioVariantId: string }
  | { ok: false; error: string };

async function requestObject(
  request: Request,
  emptyAllowed: boolean,
  invalidMessage: string,
): Promise<
  | { ok: true; value: Record<string, unknown> | null }
  | { ok: false; error: string }
> {
  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return emptyAllowed
      ? { ok: true, value: null }
      : { ok: false, error: invalidMessage };
  }

  let value: unknown;
  try {
    value = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: invalidMessage };
  }
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return { ok: false, error: invalidMessage };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

/** Parses the owner-only publication request while keeping legacy empty bodies valid. */
export async function parseApprovalAudioVariantSelection(
  request: Request,
): Promise<ApprovalAudioVariantSelection> {
  const parsed = await requestObject(
    request,
    true,
    "Invalid approval request.",
  );
  if (!parsed.ok) return parsed;
  if (!parsed.value) {
    return {
      ok: true,
      overrideTitleWarning: false,
      defaultAudioVariantId: undefined,
    };
  }

  const override = parsed.value.overrideTitleWarning;
  if (override !== undefined && typeof override !== "boolean") {
    return {
      ok: false,
      error: "Generation warning override must be a boolean.",
    };
  }

  const variantId = parsed.value.defaultAudioVariantId;
  if (
    variantId !== undefined &&
    (typeof variantId !== "string" || !variantId.trim())
  ) {
    return {
      ok: false,
      error: "defaultAudioVariantId must be a non-empty string.",
    };
  }

  return {
    ok: true,
    overrideTitleWarning: override === true,
    defaultAudioVariantId:
      typeof variantId === "string" ? variantId.trim() : undefined,
  };
}

/** Parses the explicit default-selection request used before publication. */
export async function parseRequiredAudioVariantSelection(
  request: Request,
): Promise<RequiredAudioVariantSelection> {
  const parsed = await requestObject(
    request,
    false,
    "Invalid audio variant request.",
  );
  if (!parsed.ok) return parsed;

  const variantId = parsed.value?.audioVariantId;
  if (typeof variantId !== "string" || !variantId.trim()) {
    return {
      ok: false,
      error: "audioVariantId must be a non-empty string.",
    };
  }
  return { ok: true, audioVariantId: variantId.trim() };
}

/** Keeps narration leases independent across episodes and narrator choices. */
export function audioGenerationJobId(
  date: string,
  episodeId: string,
  voiceKey: string,
): string {
  return ["job-audio", date, episodeId, voiceKey]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

/** Only the selected publication snapshot is available without workspace auth. */
export function isAnonymousEpisodeAudioAccess(access: {
  status: string;
  isCanonical: boolean;
}): boolean {
  return access.status === "published" && access.isCanonical;
}

export function isPublishedAudioDefaultConflict(error: unknown): error is Error {
  return error instanceof Error &&
    error.message ===
      "A published episode's default audio cannot be changed. Choose the default when publishing.";
}
