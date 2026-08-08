import assert from "node:assert/strict";
import test from "node:test";
import {
  createStructuredPodcast,
  mapWithConcurrency,
} from "../lib/ollama.ts";
import { KERNELZERO_CLOSING_LINES } from "../lib/kernelzero-transcript-prompt.ts";
import {
  countScriptWords,
  episodeLengthAcceptanceRange,
  podcastWordAcceptanceRange,
  scriptMatchesEpisodeLength,
} from "../lib/podcast-length.ts";
import { podcastStyleFailureMessage } from "../lib/podcast-style.ts";
import type { ContentItem } from "../lib/types.ts";

function sourceItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: "source-1",
    kind: "blog",
    title: "Agent boundaries at Hugging Face",
    summary:
      "A controlled security report examines how agent isolation and outbound network boundaries interact.",
    authors: ["Security Researcher"],
    sourceName: "Hugging Face",
    sourceId: "feed-1",
    canonicalUrl: "https://example.com/agent-boundaries",
    publishedAt: "2026-08-05T00:00:00.000Z",
    accessLevel: "feed_content",
    peerReviewState: "unknown",
    topics: ["AI security"],
    score: 95,
    trend: "latest",
    citationCount: 0,
    readingMinutes: 8,
    saved: false,
    listened: false,
    processingState: "ready",
    ...overrides,
  };
}

function narration(sectionNumber: number, wordCount: number): string {
  return `${Array.from(
    { length: wordCount },
    (_, index) => `section${sectionNumber}word${index}`,
  ).join(" ")}.`;
}

function closingNarration(wordCount: number): string {
  const closing = KERNELZERO_CLOSING_LINES.join("\n\n");
  const bodyWords = wordCount - countScriptWords(closing);
  assert.ok(bodyWords > 0);
  return `${Array.from(
    { length: bodyWords },
    (_, index) => `section7word${index}`,
  ).join(" ")}.\n\n${closing}`;
}

const VALID_OPENING_ORIENTATION =
  "This episode follows agent boundaries at Hugging Face, so you'll understand why infrastructure isolation matters and what researchers learned.";

function openingBody(wordCount: number, attempt: number): string {
  const remaining = wordCount;
  assert.ok(remaining > 0);
  return `${Array.from(
    { length: remaining },
    (_, index) => `opening${attempt}word${index}`,
  ).join(" ")}.`;
}

function invalidOpeningBody(wordCount: number, attempt: number): string {
  const stockTransition =
    "To understand the risk, we need to look at the system boundary.";
  const remaining = wordCount - countScriptWords(stockTransition);
  assert.ok(remaining > 0);
  return `${stockTransition.slice(0, -1)} ${Array.from(
    { length: remaining },
    (_, index) => `opening${attempt}word${index}`,
  ).join(" ")}.`;
}

function ndjson(content: unknown): Response {
  return new Response(
    `${JSON.stringify({
      message: { content: JSON.stringify(content) },
      done: true,
      done_reason: "stop",
    })}\n`,
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
}

test("podcast word ranges consistently allow fifteen percent beyond both boundaries", () => {
  assert.deepEqual(podcastWordAcceptanceRange(158, 193), {
    minWords: 135,
    maxWords: 221,
  });
  assert.deepEqual(episodeLengthAcceptanceRange("brief"), {
    minWords: 345,
    maxWords: 569,
  });
  assert.deepEqual(episodeLengthAcceptanceRange("standard"), {
    minWords: 1_033,
    maxWords: 1_707,
  });
  assert.deepEqual(episodeLengthAcceptanceRange("deep"), {
    minWords: 1_722,
    maxWords: 2_846,
  });

  const atLowerBoundary = Array.from({ length: 1_033 }, () => "word").join(" ");
  const belowLowerBoundary = Array.from({ length: 1_032 }, () => "word").join(" ");
  const atUpperBoundary = Array.from({ length: 1_707 }, () => "word").join(" ");
  const aboveUpperBoundary = Array.from({ length: 1_708 }, () => "word").join(" ");
  assert.equal(scriptMatchesEpisodeLength(atLowerBoundary, "standard"), true);
  assert.equal(scriptMatchesEpisodeLength(belowLowerBoundary, "standard"), false);
  assert.equal(scriptMatchesEpisodeLength(atUpperBoundary, "standard"), true);
  assert.equal(scriptMatchesEpisodeLength(aboveUpperBoundary, "standard"), false);
});

test("Ollama workers stop scheduling new work and settle in-flight work before rejecting", async () => {
  const started: number[] = [];
  let secondFinished = false;
  const work = mapWithConcurrency([1, 2, 3, 4], 2, async (value) => {
    started.push(value);
    if (value === 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
      throw new Error("first worker failed");
    }
    if (value === 2) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      secondFinished = true;
    }
    return value;
  });

  await assert.rejects(work, /first worker failed/);
  assert.deepEqual(started, [1, 2]);
  assert.equal(secondFinished, true);
});

test("Ollama validates opening stages independently and recovers short body sections", async () => {
  const originalFetch = globalThis.fetch;
  const originalParallelism = process.env.OLLAMA_PARALLELISM;
  process.env.OLLAMA_PARALLELISM = "1";
  const calls = Array.from(
    { length: 7 },
    () => ({ structured: 0, scriptOnly: 0 }),
  );
  const targetWords = [93, 147, 187, 231, 146, 231, 205];
  const openingCalls = { orientation: 0, body: 0 };
  const openingPrompts: string[] = [];
  let narrativeCalls = 0;
  let closingRecoveryPrompt = "";

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      format?: { properties?: Record<string, unknown> };
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0]?.content ?? "";
    const user = body.messages[1]?.content ?? "";

    if (system.includes("planning editor")) {
      return ndjson({
        title: "Agent boundaries at Hugging Face",
        dek: "Why agent isolation depends on infrastructure boundaries.",
        facts: [],
        sections: Array.from({ length: 7 }, (_, index) => ({
          sectionNumber: index + 1,
          focus: `Unique section ${index + 1} focus.`,
        })),
      });
    }
    if (system.includes("source-fabrication checker")) {
      return ndjson({ issues: [] });
    }
    if (system.includes("podcast narrative editor")) {
      narrativeCalls += 1;
      if (narrativeCalls === 1) {
        return ndjson({
          issues: [{
            sectionNumber: 1,
            problem: "The opening body needs a sharper transition.",
            instruction: "Rewrite only the opening body and keep the orientation.",
          }],
        });
      }
      if (narrativeCalls === 2) {
        return ndjson({
          issues: [{
            sectionNumber: 1,
            problem: "The listener orientation needs a clearer topic.",
            instruction: "Rewrite only the listener orientation and keep the body.",
          }],
        });
      }
      return ndjson({ issues: [] });
    }
    if (user.includes('CURRENT_STAGE = "Opening Orientation"')) {
      openingCalls.orientation += 1;
      openingPrompts.push(user);
      return ndjson({
        orientation:
          `Welcome to KernelZero! ${VALID_OPENING_ORIENTATION}`,
      });
    }
    if (user.includes('CURRENT_STAGE = "Opening Body"')) {
      openingCalls.body += 1;
      openingPrompts.push(user);
      const script = openingCalls.body === 1
        ? invalidOpeningBody(68, openingCalls.body)
        : openingBody(68, openingCalls.body);
      return ndjson({ script });
    }
    if (!user.includes("The script field must contain")) {
      throw new Error(`Unexpected Ollama request: ${user.slice(0, 100)}`);
    }

    const sectionNumber = Number(user.match(/Section (\d+) focus:/)?.[1]);
    const scriptOnly = !Object.hasOwn(
      body.format?.properties ?? {},
      "claims",
    );
    calls[sectionNumber - 1][scriptOnly ? "scriptOnly" : "structured"] += 1;

    assert.notEqual(sectionNumber, 1, "section 1 should use staged generation");
    if (sectionNumber === 7) {
      if (!scriptOnly) return ndjson({ claims: [] });
      closingRecoveryPrompt = `${system}\n${user}`;
      return ndjson({ script: closingNarration(targetWords[6]) });
    }
    const severelyShort = sectionNumber >= 3 && sectionNumber <= 6;
    const wordCount = severelyShort && !scriptOnly
      ? 14
      : targetWords[sectionNumber - 1];
    const script = narration(sectionNumber, wordCount);
    return ndjson(scriptOnly ? { script } : { script, claims: [] });
  }) as typeof fetch;

  try {
    const generated = await createStructuredPodcast(
      [sourceItem()],
      "daily_digest",
      "standard",
    );

    assert.equal(podcastStyleFailureMessage(generated.script), null);
    assert.equal(scriptMatchesEpisodeLength(generated.script, "standard"), true);
    assert.deepEqual(openingCalls, { orientation: 2, body: 3 });
    assert.equal(narrativeCalls, 3);
    assert.deepEqual(calls[0], { structured: 0, scriptOnly: 0 });
    assert.deepEqual(calls[1], { structured: 1, scriptOnly: 0 });
    for (const sectionNumber of [3, 4, 5, 6]) {
      assert.deepEqual(calls[sectionNumber - 1], {
        structured: 1,
        scriptOnly: 1,
      });
    }
    assert.deepEqual(calls[6], { structured: 1, scriptOnly: 1 });
    assert.ok(
      generated.script.startsWith(
        `Welcome to KernelZero. ${VALID_OPENING_ORIENTATION}\n\n`,
      ),
    );
    assert.equal(
      generated.script.match(/Welcome\s+to\s+KernelZero[.!?]?/gi)?.length,
      1,
    );
    assert.ok(
      openingPrompts.every((prompt) =>
        !prompt.includes(sourceItem().summary) &&
        !prompt.includes("abstractOrFeedText")
      ),
    );
    assert.doesNotMatch(generated.script, /To understand the risk/);
    for (const line of KERNELZERO_CLOSING_LINES) {
      assert.ok(closingRecoveryPrompt.includes(line));
    }
    assert.ok(
      generated.script.endsWith(KERNELZERO_CLOSING_LINES.join("\n\n")),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalParallelism === undefined) {
      delete process.env.OLLAMA_PARALLELISM;
    } else {
      process.env.OLLAMA_PARALLELISM = originalParallelism;
    }
  }
});

test("Ollama falls back deterministically after only the opening orientation exhausts retries", async () => {
  const originalFetch = globalThis.fetch;
  const originalParallelism = process.env.OLLAMA_PARALLELISM;
  process.env.OLLAMA_PARALLELISM = "1";
  const openingCalls = { orientation: 0, body: 0 };
  const fallbackSource = sourceItem({
    title: "GPT-5.4 agent boundaries at Hugging Face",
  });

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0]?.content ?? "";
    const user = body.messages[1]?.content ?? "";

    if (system.includes("planning editor")) {
      return ndjson({
        title: fallbackSource.title,
        dek: "Why agent isolation depends on infrastructure boundaries.",
        facts: [],
        sections: Array.from({ length: 7 }, (_, index) => ({
          sectionNumber: index + 1,
          focus: `Unique section ${index + 1} focus.`,
        })),
      });
    }
    if (
      system.includes("source-fabrication checker") ||
      system.includes("podcast narrative editor")
    ) {
      return ndjson({ issues: [] });
    }
    if (user.includes('CURRENT_STAGE = "Opening Orientation"')) {
      openingCalls.orientation += 1;
      return ndjson({
        orientation:
          "This episode follows the selected engineering story, so you'll understand how the pieces connect and why the result matters.",
      });
    }
    if (user.includes('CURRENT_STAGE = "Opening Body"')) {
      openingCalls.body += 1;
      return ndjson({ script: openingBody(68, openingCalls.body) });
    }
    if (!user.includes("The script field must contain")) {
      throw new Error(`Unexpected Ollama request: ${user.slice(0, 100)}`);
    }

    const sectionNumber = Number(user.match(/Section (\d+) focus:/)?.[1]);
    assert.ok(sectionNumber >= 2 && sectionNumber <= 7);
    return ndjson({
      script: sectionNumber === 7
        ? closingNarration([93, 147, 187, 231, 146, 231, 205][sectionNumber - 1])
        : narration(
            sectionNumber,
            [93, 147, 187, 231, 146, 231, 205][sectionNumber - 1],
          ),
      claims: [],
    });
  }) as typeof fetch;

  try {
    const generated = await createStructuredPodcast(
      [fallbackSource],
      "daily_digest",
      "standard",
    );

    assert.deepEqual(openingCalls, { orientation: 2, body: 1 });
    assert.equal(podcastStyleFailureMessage(generated.script), null);
    assert.match(
      generated.script,
      /^Welcome to KernelZero\. This episode follows GPT-5\.4 agent boundaries at Hugging Face,/,
    );
    assert.doesNotMatch(generated.script, /selected engineering story/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalParallelism === undefined) {
      delete process.env.OLLAMA_PARALLELISM;
    } else {
      process.env.OLLAMA_PARALLELISM = originalParallelism;
    }
  }
});

test("Ollama keeps a max-length brief orientation and builds an eight-word body fallback", async () => {
  const originalFetch = globalThis.fetch;
  const originalParallelism = process.env.OLLAMA_PARALLELISM;
  process.env.OLLAMA_PARALLELISM = "1";
  const sectionWords = [28, 53, 73, 77, 49, 77, 48];
  const orientation =
    "This episode follows agent boundaries at Hugging Face, so you'll understand how isolation choices shape the story, what the sources establish, and why that boundary matters to infrastructure teams.";
  assert.equal(countScriptWords(orientation), 29);
  const openingCalls = { orientation: 0, body: 0 };

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0]?.content ?? "";
    const user = body.messages[1]?.content ?? "";

    if (system.includes("planning editor")) {
      return ndjson({
        title: "Agent boundaries at Hugging Face",
        dek: "Why agent isolation depends on infrastructure boundaries.",
        facts: [],
        sections: Array.from({ length: 7 }, (_, index) => ({
          sectionNumber: index + 1,
          focus: `Unique section ${index + 1} focus.`,
        })),
      });
    }
    if (
      system.includes("source-fabrication checker") ||
      system.includes("podcast narrative editor")
    ) {
      return ndjson({ issues: [] });
    }
    if (user.includes('CURRENT_STAGE = "Opening Orientation"')) {
      openingCalls.orientation += 1;
      return ndjson({ orientation });
    }
    if (user.includes('CURRENT_STAGE = "Opening Body"')) {
      openingCalls.body += 1;
      return ndjson({ script: "Too short." });
    }
    if (!user.includes("The script field must contain")) {
      throw new Error(`Unexpected Ollama request: ${user.slice(0, 100)}`);
    }

    const sectionNumber = Number(user.match(/Section (\d+) focus:/)?.[1]);
    assert.ok(sectionNumber >= 2 && sectionNumber <= 7);
    return ndjson({
      script: sectionNumber === 7
        ? closingNarration(sectionWords[sectionNumber - 1])
        : narration(sectionNumber, sectionWords[sectionNumber - 1]),
      claims: [],
    });
  }) as typeof fetch;

  try {
    const generated = await createStructuredPodcast(
      [sourceItem()],
      "daily_digest",
      "brief",
    );

    assert.deepEqual(openingCalls, { orientation: 1, body: 2 });
    assert.equal(podcastStyleFailureMessage(generated.script), null);
    assert.equal(scriptMatchesEpisodeLength(generated.script, "brief"), true);
    assert.ok(
      generated.script.startsWith(
        `Welcome to KernelZero. ${orientation}\n\nThe sources frame that question with useful context.`,
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalParallelism === undefined) {
      delete process.env.OLLAMA_PARALLELISM;
    } else {
      process.env.OLLAMA_PARALLELISM = originalParallelism;
    }
  }
});
