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

function sourceItem(): ContentItem {
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

function invalidOpening(wordCount: number, attempt: number): string {
  const fixed =
    "Welcome to KernelZero. This episode follows agent boundaries at Hugging Face, so you'll understand why infrastructure isolation matters. To understand the risk, we need to look at the system boundary.";
  const remaining = wordCount - countScriptWords(fixed);
  assert.ok(remaining > 0);
  return `${fixed.slice(0, -1)} ${Array.from(
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

test("Ollama recovers repeated invalid openings and severely short structured sections", async () => {
  const originalFetch = globalThis.fetch;
  const originalParallelism = process.env.OLLAMA_PARALLELISM;
  process.env.OLLAMA_PARALLELISM = "1";
  const calls = Array.from(
    { length: 7 },
    () => ({ structured: 0, scriptOnly: 0 }),
  );
  const targetWords = [93, 147, 187, 231, 146, 231, 205];
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
    if (
      system.includes("source-fabrication checker") ||
      system.includes("podcast narrative editor")
    ) {
      return ndjson({ issues: [] });
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

    if (sectionNumber === 1) {
      const attempt = calls[0].structured + calls[0].scriptOnly;
      const script = invalidOpening(scriptOnly ? 95 : 93, attempt);
      return ndjson(scriptOnly ? { script } : { script, claims: [] });
    }
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
    assert.deepEqual(calls[0], { structured: 1, scriptOnly: 1 });
    assert.deepEqual(calls[1], { structured: 1, scriptOnly: 0 });
    for (const sectionNumber of [3, 4, 5, 6]) {
      assert.deepEqual(calls[sectionNumber - 1], {
        structured: 1,
        scriptOnly: 1,
      });
    }
    assert.deepEqual(calls[6], { structured: 1, scriptOnly: 1 });
    assert.match(
      generated.script,
      /^Welcome to KernelZero\. This episode follows Agent boundaries at Hugging Face,/,
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
