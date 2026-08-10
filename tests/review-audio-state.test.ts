import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveReviewAudioVariantId,
  resolveReviewVoiceId,
  reviewAudioButtonLabel,
  reviewAudioStatusAfterRegenerationFailure,
  reviewAudioSyncAction,
} from "../lib/review-audio-state.ts";

const voices = [
  { id: "voice-primary", active: true },
  { id: "voice-alternate", active: false },
];

test("the review voice picker preserves a preferred alternate voice", () => {
  assert.equal(
    resolveReviewVoiceId(voices, "voice-alternate"),
    "voice-alternate",
  );
});

test("the review voice picker defaults to the active voice", () => {
  assert.equal(resolveReviewVoiceId(voices, null), "voice-primary");
});

test("the review voice picker falls back to the first profile without an active voice", () => {
  assert.equal(
    resolveReviewVoiceId(
      [
        { id: "voice-first", active: false },
        { id: "voice-second", active: false },
      ],
      null,
    ),
    "voice-first",
  );
});

test("the review voice picker replaces a stale preference with the active voice", () => {
  assert.equal(resolveReviewVoiceId(voices, "voice-removed"), "voice-primary");
});

test("the review voice picker returns null when no voices are available", () => {
  assert.equal(resolveReviewVoiceId([], "voice-removed"), null);
});

const audioVariants = [
  { id: "audio-default", audioUrl: "/api/media/default.mp3" },
  { id: "audio-alternate", audioUrl: "/api/media/alternate.mp3" },
];

test("the review player preserves a selected audio variant", () => {
  assert.equal(
    resolveReviewAudioVariantId(
      audioVariants,
      "audio-alternate",
      "audio-default",
    ),
    "audio-alternate",
  );
});

test("the review player falls back to the publish default then first usable variant", () => {
  assert.equal(
    resolveReviewAudioVariantId(audioVariants, "audio-stale", "audio-default"),
    "audio-default",
  );
  assert.equal(
    resolveReviewAudioVariantId(audioVariants, null, "audio-stale"),
    "audio-default",
  );
});

test("the review player ignores variants without playable URLs", () => {
  assert.equal(
    resolveReviewAudioVariantId(
      [{ id: "audio-missing", audioUrl: null }],
      "audio-missing",
      "audio-missing",
    ),
    null,
  );
});

test("a direct review load hydrates a persisted audio URL", () => {
  assert.equal(
    reviewAudioSyncAction({
      isReview: true,
      episodeId: "episode-1",
      audioUrl: "/api/media/audio/owner/episode-1.mp3",
      loadedEpisodeId: null,
      loadedAudioUrl: null,
    }),
    "load",
  );
});

test("a changed persisted audio URL reloads the selected episode", () => {
  assert.equal(
    reviewAudioSyncAction({
      isReview: true,
      episodeId: "episode-1",
      audioUrl: "/api/media/audio/owner/episode-1-voice-new.mp3",
      loadedEpisodeId: "episode-1",
      loadedAudioUrl: "/api/media/audio/owner/episode-1-voice-old.mp3",
    }),
    "load",
  );

  assert.equal(
    reviewAudioSyncAction({
      isReview: true,
      episodeId: "episode-1",
      audioUrl: "/api/media/audio/owner/episode-1-voice-new.mp3",
      loadedEpisodeId: "episode-1",
      loadedAudioUrl: "/api/media/audio/owner/episode-1-voice-new.mp3",
    }),
    "none",
  );
});

test("a changed variant identity reloads even when its URL is unchanged", () => {
  assert.equal(
    reviewAudioSyncAction({
      isReview: true,
      episodeId: "episode-1",
      variantId: "audio-alternate",
      audioUrl: "/api/media/shared.mp3",
      loadedEpisodeId: "episode-1",
      loadedVariantId: "audio-default",
      loadedAudioUrl: "/api/media/shared.mp3",
    }),
    "load",
  );
});

test("a review episode without a stored audio URL clears stale playback", () => {
  assert.equal(
    reviewAudioSyncAction({
      isReview: true,
      episodeId: "episode-2",
      audioUrl: null,
      loadedEpisodeId: "episode-1",
      loadedAudioUrl: "/api/media/audio/owner/episode-1.mp3",
    }),
    "clear",
  );
  assert.equal(
    reviewAudioButtonLabel({ hasAudio: false, status: "missing" }),
    "Generate Audio",
  );
});

test("Repair Audio is reserved for a real stored-audio load error", () => {
  assert.equal(
    reviewAudioButtonLabel({ hasAudio: true, status: "error" }),
    "Repair Audio",
  );
  assert.equal(
    reviewAudioButtonLabel({ hasAudio: true, status: "missing" }),
    "Loading Audio...",
  );
  assert.equal(
    reviewAudioButtonLabel({ hasAudio: true, status: "loading" }),
    "Loading Audio...",
  );
  assert.equal(
    reviewAudioButtonLabel({ hasAudio: false, status: "error" }),
    "Generate Audio",
  );
});

test("audio synchronization does not mutate playback outside review", () => {
  assert.equal(
    reviewAudioSyncAction({
      isReview: false,
      episodeId: "episode-1",
      audioUrl: "/api/media/audio/owner/episode-1.mp3",
      loadedEpisodeId: null,
      loadedAudioUrl: null,
    }),
    "none",
  );
});

test("a failed regeneration preserves valid stored-audio playback state", () => {
  assert.equal(
    reviewAudioStatusAfterRegenerationFailure(true, "ready"),
    "ready",
  );
  assert.equal(
    reviewAudioStatusAfterRegenerationFailure(true, "error"),
    "error",
  );
});

test("a failed first audio generation returns to the missing state", () => {
  assert.equal(
    reviewAudioStatusAfterRegenerationFailure(false, "loading"),
    "missing",
  );
});
