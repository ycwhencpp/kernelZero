export type AudioVoiceSelection =
  | { ok: true; voiceId: string | undefined }
  | { ok: false; error: string };

/** Parses the optional, request-scoped narrator choice for audio regeneration. */
export async function parseAudioVoiceSelection(
  request: Request,
): Promise<AudioVoiceSelection> {
  const rawBody = await request.text();
  if (!rawBody.trim()) return { ok: true, voiceId: undefined };

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return {
      ok: false,
      error: "Audio regeneration requires a valid JSON request body.",
    };
  }

  if (!payload || Array.isArray(payload) || typeof payload !== "object") {
    return {
      ok: false,
      error: "Audio regeneration requires a JSON object request body.",
    };
  }

  const voiceId = (payload as { voiceId?: unknown }).voiceId;
  if (voiceId === undefined) return { ok: true, voiceId: undefined };
  if (typeof voiceId !== "string" || !voiceId.trim()) {
    return {
      ok: false,
      error: "voiceId must be a non-empty string.",
    };
  }

  return { ok: true, voiceId: voiceId.trim() };
}
