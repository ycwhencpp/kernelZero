import assert from "node:assert/strict";
import test from "node:test";
import {
  audioGenerationJobId,
  isAnonymousEpisodeAudioAccess,
  isPublishedAudioDefaultConflict,
  parseApprovalAudioVariantSelection,
  parseRequiredAudioVariantSelection,
} from "../lib/audio-variant-api.ts";

function request(body?: unknown): Request {
  return new Request("http://localhost/api/episodes/episode-1/approve", {
    method: "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("approval parsing preserves the legacy empty-body contract", async () => {
  assert.deepEqual(await parseApprovalAudioVariantSelection(request()), {
    ok: true,
    overrideTitleWarning: false,
    defaultAudioVariantId: undefined,
  });
});

test("approval parsing accepts and trims a default audio variant", async () => {
  assert.deepEqual(
    await parseApprovalAudioVariantSelection(
      request({
        overrideTitleWarning: true,
        defaultAudioVariantId: "  variant-two  ",
      }),
    ),
    {
      ok: true,
      overrideTitleWarning: true,
      defaultAudioVariantId: "variant-two",
    },
  );
});

test("approval parsing rejects invalid default variant values", async () => {
  for (const defaultAudioVariantId of [null, false, 42, "  "]) {
    assert.deepEqual(
      await parseApprovalAudioVariantSelection(
        request({ defaultAudioVariantId }),
      ),
      {
        ok: false,
        error: "defaultAudioVariantId must be a non-empty string.",
      },
    );
  }
});

test("default-selection parsing requires a non-empty variant ID", async () => {
  assert.deepEqual(
    await parseRequiredAudioVariantSelection(
      new Request("http://localhost/api/episodes/episode-1/audio", {
        method: "PATCH",
        body: JSON.stringify({ audioVariantId: " variant-one " }),
      }),
    ),
    { ok: true, audioVariantId: "variant-one" },
  );
  assert.deepEqual(
    await parseRequiredAudioVariantSelection(
      new Request("http://localhost/api/episodes/episode-1/audio", {
        method: "PATCH",
        body: JSON.stringify({ audioVariantId: "" }),
      }),
    ),
    {
      ok: false,
      error: "audioVariantId must be a non-empty string.",
    },
  );
});

test("audio job IDs are scoped by episode and narrator without delimiter collisions", () => {
  const date = "2026-08-10";
  const first = audioGenerationJobId(date, "episode:a", "profile:b");
  assert.notEqual(
    first,
    audioGenerationJobId(date, "episode", "a:profile:b"),
  );
  assert.notEqual(first, audioGenerationJobId(date, "episode:b", "profile:b"));
  assert.notEqual(first, audioGenerationJobId(date, "episode:a", "profile:c"));
  assert.equal(
    first,
    "job-audio:2026-08-10:episode%3Aa:profile%3Ab",
  );
});

test("anonymous media access is limited to the canonical published variant", () => {
  assert.equal(
    isAnonymousEpisodeAudioAccess({
      status: "published",
      isCanonical: true,
    }),
    true,
  );
  assert.equal(
    isAnonymousEpisodeAudioAccess({
      status: "published",
      isCanonical: false,
    }),
    false,
  );
  assert.equal(
    isAnonymousEpisodeAudioAccess({
      status: "needs_approval",
      isCanonical: true,
    }),
    false,
  );
});

test("published default changes are recognized as conflicts", () => {
  assert.equal(
    isPublishedAudioDefaultConflict(
      new Error(
        "A published episode's default audio cannot be changed. Choose the default when publishing.",
      ),
    ),
    true,
  );
  assert.equal(isPublishedAudioDefaultConflict(new Error("Other failure")), false);
});
