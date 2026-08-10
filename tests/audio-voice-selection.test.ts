import assert from "node:assert/strict";
import test from "node:test";
import { parseAudioVoiceSelection } from "../lib/audio-voice-selection.ts";

test("audio regeneration keeps active-voice behavior for an empty body", async () => {
  assert.deepEqual(
    await parseAudioVoiceSelection(
      new Request("http://localhost/api/episodes/episode-1/audio", {
        method: "POST",
      }),
    ),
    { ok: true, voiceId: undefined },
  );
});

test("audio regeneration accepts and trims a request-scoped voice ID", async () => {
  assert.deepEqual(
    await parseAudioVoiceSelection(
      new Request("http://localhost/api/episodes/episode-1/audio", {
        method: "POST",
        body: JSON.stringify({ voiceId: "  voice-alternate  " }),
      }),
    ),
    { ok: true, voiceId: "voice-alternate" },
  );
});

test("audio regeneration rejects malformed or empty voice IDs", async () => {
  assert.deepEqual(
    await parseAudioVoiceSelection(
      new Request("http://localhost/api/episodes/episode-1/audio", {
        method: "POST",
        body: "not-json",
      }),
    ),
    {
      ok: false,
      error: "Audio regeneration requires a valid JSON request body.",
    },
  );
  assert.deepEqual(
    await parseAudioVoiceSelection(
      new Request("http://localhost/api/episodes/episode-1/audio", {
        method: "POST",
        body: JSON.stringify({ voiceId: "  " }),
      }),
    ),
    { ok: false, error: "voiceId must be a non-empty string." },
  );
});
