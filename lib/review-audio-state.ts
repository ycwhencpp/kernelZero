export type ReviewAudioStatus = "missing" | "loading" | "ready" | "error";

export type ReviewAudioSyncAction = "load" | "clear" | "none";

type ReviewVoiceProfile = {
  id: string;
  active: boolean;
};

type ReviewAudioVariant = {
  id: string;
  audioUrl?: string | null;
};

export function resolveReviewVoiceId(
  voiceProfiles: readonly ReviewVoiceProfile[],
  preferredVoiceId: string | null | undefined,
): string | null {
  if (
    preferredVoiceId &&
    voiceProfiles.some((voice) => voice.id === preferredVoiceId)
  ) {
    return preferredVoiceId;
  }
  return voiceProfiles.find((voice) => voice.active)?.id ??
    voiceProfiles[0]?.id ??
    null;
}

export function resolveReviewAudioVariantId(
  variants: readonly ReviewAudioVariant[],
  preferredVariantId: string | null | undefined,
  defaultVariantId: string | null | undefined,
): string | null {
  const usableVariants = variants.filter((variant) =>
    Boolean(variant.audioUrl?.trim())
  );
  if (
    preferredVariantId &&
    usableVariants.some((variant) => variant.id === preferredVariantId)
  ) {
    return preferredVariantId;
  }
  if (
    defaultVariantId &&
    usableVariants.some((variant) => variant.id === defaultVariantId)
  ) {
    return defaultVariantId;
  }
  return usableVariants[0]?.id ?? null;
}

export function reviewAudioSyncAction(input: {
  isReview: boolean;
  episodeId: string | null;
  variantId?: string | null;
  audioUrl: string | null;
  loadedEpisodeId: string | null;
  loadedVariantId?: string | null;
  loadedAudioUrl: string | null;
}): ReviewAudioSyncAction {
  if (!input.isReview || !input.episodeId) return "none";
  if (!input.audioUrl?.trim()) return "clear";
  return input.loadedEpisodeId === input.episodeId &&
      (input.variantId === undefined ||
        input.loadedVariantId === input.variantId) &&
      input.loadedAudioUrl === input.audioUrl
    ? "none"
    : "load";
}

export function reviewAudioButtonLabel(input: {
  hasAudio: boolean;
  status: ReviewAudioStatus;
}): "Loading Audio..." | "Repair Audio" | "Generate Audio" {
  if (
    input.status === "loading" ||
    (input.hasAudio && input.status === "missing")
  ) {
    return "Loading Audio...";
  }
  if (!input.hasAudio) return "Generate Audio";
  return "Repair Audio";
}

export function reviewAudioStatusAfterRegenerationFailure(
  hasStoredAudio: boolean,
  previousStatus: ReviewAudioStatus,
): ReviewAudioStatus {
  return hasStoredAudio ? previousStatus : "missing";
}
