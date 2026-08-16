import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatedEpisodeTitleCostUsd,
  resolveAiProvider,
  resolveEpisodeTitleProvider,
} from "../lib/ai-config.ts";
import {
  createPodcastTitle,
  podcastTitleSchema,
} from "../lib/gemini.ts";
import {
  EPISODE_TITLE_GENERATION_FALLBACK_MESSAGE,
  finalizeEpisodeTitleAfterNarration,
  warningAfterEpisodeTitleGeneration,
} from "../lib/podcast-title.ts";
import {
  updateGeneratedEpisodeTitle,
  updateRegeneratedEpisodeTitle,
} from "../lib/store.ts";
import type { Episode } from "../lib/types.ts";

const alignedTranscript = [
  "Cache stampedes overload an origin when many requests miss the cache together.",
  "Request coalescing prevents cache stampedes by sharing one origin request.",
].join("\n\n");

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: "episode-title-test",
    type: "paper_deep_dive",
    title: "Provisional provider title",
    dek: "A provisional description.",
    script: alignedTranscript,
    showNotes: "Source notes",
    transcript: alignedTranscript,
    generationWarning: null,
    titleProvenance: "provisional",
    citations: [],
    chapters: [{ title: "Opening", startSeconds: 0 }],
    audioUrl: "/api/media/audio/test.wav",
    durationSeconds: 60,
    status: "needs_approval",
    publishedAt: null,
    immutableGuid: "kernelzero:episode-title-test",
    generation: 1,
    createdAt: "2026-08-15T00:00:00.000Z",
    ...overrides,
  };
}

test("episode titles can use Gemini independently from the podcast provider", () => {
  const originalAiProvider = process.env.AI_PROVIDER;
  const originalTitleProvider = process.env.EPISODE_TITLE_PROVIDER;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  try {
    process.env.AI_PROVIDER = "ollama";
    delete process.env.EPISODE_TITLE_PROVIDER;
    delete process.env.GEMINI_API_KEY;
    assert.equal(resolveAiProvider(), "ollama");
    assert.equal(resolveEpisodeTitleProvider(), null);

    process.env.EPISODE_TITLE_PROVIDER = "gemini";
    assert.equal(resolveEpisodeTitleProvider(), null);
    process.env.GEMINI_API_KEY = "test-title-key";
    assert.equal(resolveAiProvider(), "ollama");
    assert.equal(resolveEpisodeTitleProvider(), "gemini");
    assert.equal(estimatedEpisodeTitleCostUsd("gemini"), 0.01);
  } finally {
    if (originalAiProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalAiProvider;
    if (originalTitleProvider === undefined) {
      delete process.env.EPISODE_TITLE_PROVIDER;
    } else {
      process.env.EPISODE_TITLE_PROVIDER = originalTitleProvider;
    }
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});

test("Gemini retries an unaligned title using the final transcript contract", async () => {
  const originalFetch = globalThis.fetch;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalTitleModel = process.env.GEMINI_EPISODE_TITLE_MODEL;
  const requests: Array<{
    url: string;
    body: Record<string, unknown>;
    signal: AbortSignal | null;
  }> = [];
  const titles = ["Quantum Bananas", "Cache Stampedes"];
  process.env.GEMINI_API_KEY = "test-title-key";
  process.env.GEMINI_EPISODE_TITLE_MODEL = "gemini-title-test";
  globalThis.fetch = (async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      signal: init?.signal instanceof AbortSignal ? init.signal : null,
    });
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ title: titles.shift() }) }],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await createPodcastTitle(
      alignedTranscript,
      "paper_deep_dive",
    );
    assert.deepEqual(result, {
      title: "Cache Stampedes",
      attempts: 2,
      generationWarning: null,
    });
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /models\/gemini-title-test:generateContent/);
    assert.ok(requests[0].signal);
    const config = requests[0].body.generationConfig as Record<string, unknown>;
    assert.deepEqual(config.responseJsonSchema, podcastTitleSchema());
    assert.match(JSON.stringify(requests[0].body), /UNTRUSTED FINAL TRANSCRIPT/);
    assert.match(JSON.stringify(requests[0].body), /catchy/);
    assert.match(
      JSON.stringify(requests[1].body),
      /deterministic validation problems/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (originalTitleModel === undefined) {
      delete process.env.GEMINI_EPISODE_TITLE_MODEL;
    } else {
      process.env.GEMINI_EPISODE_TITLE_MODEL = originalTitleModel;
    }
  }
});

test("Gemini returns its last title with a review warning after bounded retries", async () => {
  const originalFetch = globalThis.fetch;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  let calls = 0;
  process.env.GEMINI_API_KEY = "test-title-key";
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ title: "Quantum Bananas" }) }],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    assert.deepEqual(
      await createPodcastTitle(alignedTranscript, "paper_deep_dive"),
      {
        title: "Quantum Bananas",
        attempts: 3,
        generationWarning: "title_validation_failed",
      },
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});

test("title generation cannot clear a durable short-transcript warning", () => {
  assert.equal(
    warningAfterEpisodeTitleGeneration(
      "length_below_target",
      "title_validation_failed",
    ),
    "length_below_target",
  );
  assert.equal(
    warningAfterEpisodeTitleGeneration(
      "title_validation_failed",
      null,
    ),
    null,
  );
});

test("post-narration finalization preserves a length warning and reports Gemini", async () => {
  const originalFetch = globalThis.fetch;
  const originalTitleProvider = process.env.EPISODE_TITLE_PROVIDER;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.EPISODE_TITLE_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-title-key";
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify({ title: "Cache Stampedes" }) }],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;

  try {
    const provisional = episode({ generationWarning: "length_below_target" });
    const result = await finalizeEpisodeTitleAfterNarration(
      "owner-title-test",
      provisional,
      { title: provisional.title, script: provisional.script },
    );
    assert.equal(result.episode.title, "Cache Stampedes");
    assert.equal(result.episode.generationWarning, "length_below_target");
    assert.equal(result.episode.titleProvenance, "gemini");
    assert.equal(result.titleProvider, "gemini");
    assert.equal(result.titleError, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTitleProvider === undefined) {
      delete process.env.EPISODE_TITLE_PROVIDER;
    } else {
      process.env.EPISODE_TITLE_PROVIDER = originalTitleProvider;
    }
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    }
    if (originalServiceKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey;
    }
  }
});

test("episode title persistence loses a concurrent-edit race without overwriting it", async () => {
  const originalFetch = globalThis.fetch;
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let patchUrl: URL | null = null;
  let patchBody: Record<string, unknown> | null = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  globalThis.fetch = (async (input, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          title: "Provisional provider title",
          script: alignedTranscript,
          title_provenance: "provisional",
          updated_at: "2026-08-15T01:02:03.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    patchUrl = new URL(String(input));
    patchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    // Another edit changed updated_at after the read, so the conditional
    // update matched no row.
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    assert.equal(
      await updateGeneratedEpisodeTitle(
        "owner-title-test",
        "episode-title-test",
        {
          title: "Provisional provider title",
          script: alignedTranscript,
        },
        {
          title: "Cache Stampedes",
          generationWarning: null,
        },
      ),
      false,
    );
    const writtenUrl = patchUrl as URL | null;
    const writtenBody = patchBody as Record<string, unknown> | null;
    assert.ok(writtenUrl);
    assert.ok(writtenBody);
    assert.equal(writtenUrl.searchParams.get("id"), "eq.episode-title-test");
    assert.equal(writtenUrl.searchParams.get("owner_id"), "eq.owner-title-test");
    assert.equal(
      writtenUrl.searchParams.get("title_provenance"),
      "eq.provisional",
    );
    assert.equal(
      writtenUrl.searchParams.get("updated_at"),
      "eq.2026-08-15T01:02:03.000Z",
    );
    assert.equal(writtenBody.title, "Cache Stampedes");
    assert.equal(writtenBody.generation_warning, null);
    assert.equal(writtenBody.title_provenance, "gemini");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    }
    if (originalServiceKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey;
    }
  }
});

test("explicit title regeneration updates a manually titled episode with compare-and-set persistence", async () => {
  const originalFetch = globalThis.fetch;
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let patchUrl: URL | null = null;
  let patchBody: Record<string, unknown> | null = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  globalThis.fetch = (async (input, init) => {
    const method = init?.method ?? "GET";
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          title: "My manually reviewed title",
          script: alignedTranscript,
          transcript: alignedTranscript,
          status: "needs_approval",
          updated_at: "2026-08-15T02:03:04.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    patchUrl = new URL(String(input));
    patchBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ id: "episode-title-test" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    assert.equal(
      await updateRegeneratedEpisodeTitle(
        "owner-title-test",
        "episode-title-test",
        {
          title: "My manually reviewed title",
          transcript: alignedTranscript,
        },
        {
          title: "Cache Stampedes",
          generationWarning: null,
        },
      ),
      true,
    );
    const writtenUrl = patchUrl as URL | null;
    const writtenBody = patchBody as Record<string, unknown> | null;
    assert.ok(writtenUrl);
    assert.ok(writtenBody);
    assert.equal(writtenUrl.searchParams.get("id"), "eq.episode-title-test");
    assert.equal(writtenUrl.searchParams.get("owner_id"), "eq.owner-title-test");
    assert.equal(
      writtenUrl.searchParams.get("status"),
      "in.(draft,needs_approval)",
    );
    assert.equal(
      writtenUrl.searchParams.get("updated_at"),
      "eq.2026-08-15T02:03:04.000Z",
    );
    assert.equal(writtenUrl.searchParams.has("title_provenance"), false);
    assert.equal(writtenBody.title, "Cache Stampedes");
    assert.equal(writtenBody.generation_warning, null);
    assert.equal(writtenBody.title_provenance, "gemini");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    }
    if (originalServiceKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey;
    }
  }
});

test("explicit title regeneration never overwrites a transcript edited during the Gemini call", async () => {
  const originalFetch = globalThis.fetch;
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let patchCalls = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  globalThis.fetch = (async (_input, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") patchCalls += 1;
    return new Response(
      JSON.stringify({
        title: "My manually reviewed title",
        script: `${alignedTranscript}\n\nA newly saved paragraph.`,
        transcript: `${alignedTranscript}\n\nA newly saved paragraph.`,
        status: "needs_approval",
        updated_at: "2026-08-15T02:03:05.000Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    assert.equal(
      await updateRegeneratedEpisodeTitle(
        "owner-title-test",
        "episode-title-test",
        {
          title: "My manually reviewed title",
          transcript: alignedTranscript,
        },
        {
          title: "Cache Stampedes",
          generationWarning: null,
        },
      ),
      false,
    );
    assert.equal(patchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    }
    if (originalServiceKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey;
    }
  }
});

test("explicit title regeneration never rewrites an episode published during the Gemini call", async () => {
  const originalFetch = globalThis.fetch;
  const originalSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let patchCalls = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  globalThis.fetch = (async (_input, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") patchCalls += 1;
    return new Response(
      JSON.stringify({
        title: "My manually reviewed title",
        script: alignedTranscript,
        transcript: alignedTranscript,
        status: "published",
        updated_at: "2026-08-15T02:03:06.000Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    assert.equal(
      await updateRegeneratedEpisodeTitle(
        "owner-title-test",
        "episode-title-test",
        {
          title: "My manually reviewed title",
          transcript: alignedTranscript,
        },
        {
          title: "Cache Stampedes",
          generationWarning: null,
        },
      ),
      false,
    );
    assert.equal(patchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSupabaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = originalSupabaseUrl;
    }
    if (originalServiceKey === undefined) {
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
      process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey;
    }
  }
});

test("a Gemini transport failure keeps the durable provisional title", async () => {
  const originalFetch = globalThis.fetch;
  const originalTitleProvider = process.env.EPISODE_TITLE_PROVIDER;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  process.env.EPISODE_TITLE_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-title-key";
  globalThis.fetch = (async () =>
    new Response("unavailable", { status: 503 })) as typeof fetch;

  try {
    const provisional = episode();
    const result = await finalizeEpisodeTitleAfterNarration(
      "owner-title-test",
      provisional,
      { title: provisional.title, script: provisional.script },
    );
    assert.equal(result.episode.title, provisional.title);
    assert.equal(result.titleProvider, null);
    assert.equal(result.titleError, EPISODE_TITLE_GENERATION_FALLBACK_MESSAGE);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTitleProvider === undefined) {
      delete process.env.EPISODE_TITLE_PROVIDER;
    } else {
      process.env.EPISODE_TITLE_PROVIDER = originalTitleProvider;
    }
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});

test("a previously edited title is never sent to Gemini during an audio retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalTitleProvider = process.env.EPISODE_TITLE_PROVIDER;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  let calls = 0;
  process.env.EPISODE_TITLE_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-title-key";
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("Gemini must not be called for an edited title.");
  }) as typeof fetch;

  try {
    const edited = episode({
      title: "My reviewed cache title",
      titleProvenance: "manual",
    });
    const result = await finalizeEpisodeTitleAfterNarration(
      "owner-title-test",
      edited,
      { title: edited.title, script: edited.script },
    );
    assert.equal(result.episode.title, edited.title);
    assert.equal(result.episode.titleProvenance, "manual");
    assert.equal(result.titleProvider, null);
    assert.equal(result.titleError, null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTitleProvider === undefined) {
      delete process.env.EPISODE_TITLE_PROVIDER;
    } else {
      process.env.EPISODE_TITLE_PROVIDER = originalTitleProvider;
    }
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});

test("a stalled Gemini title request returns the non-fatal fallback on timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalTitleProvider = process.env.EPISODE_TITLE_PROVIDER;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  const originalTimeout = process.env.GEMINI_EPISODE_TITLE_TIMEOUT_MS;
  process.env.EPISODE_TITLE_PROVIDER = "gemini";
  process.env.GEMINI_API_KEY = "test-title-key";
  process.env.GEMINI_EPISODE_TITLE_TIMEOUT_MS = "10";
  globalThis.fetch = (async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        reject(new Error("The title request did not include an abort signal."));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
  const keepEventLoopAlive = setTimeout(() => undefined, 1_000);

  try {
    const provisional = episode();
    const result = await finalizeEpisodeTitleAfterNarration(
      "owner-title-test",
      provisional,
      { title: provisional.title, script: provisional.script },
    );
    assert.equal(result.episode.title, provisional.title);
    assert.equal(result.episode.titleProvenance, "provisional");
    assert.equal(result.titleError, EPISODE_TITLE_GENERATION_FALLBACK_MESSAGE);
  } finally {
    clearTimeout(keepEventLoopAlive);
    globalThis.fetch = originalFetch;
    if (originalTitleProvider === undefined) {
      delete process.env.EPISODE_TITLE_PROVIDER;
    } else {
      process.env.EPISODE_TITLE_PROVIDER = originalTitleProvider;
    }
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
    if (originalTimeout === undefined) {
      delete process.env.GEMINI_EPISODE_TITLE_TIMEOUT_MS;
    } else {
      process.env.GEMINI_EPISODE_TITLE_TIMEOUT_MS = originalTimeout;
    }
  }
});
