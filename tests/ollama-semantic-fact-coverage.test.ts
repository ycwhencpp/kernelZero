import assert from "node:assert/strict";
import test from "node:test";
import {
  auditSemanticPodcast,
  consolidateSemanticSegments,
  generateSemanticSegments,
  type PodcastSourceCorpus,
  type SemanticChunkPlan,
  type SemanticGeneratedSegment,
} from "../lib/ollama-semantic.ts";

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

function ndjsonText(content: string): Response {
  return new Response(
    `${JSON.stringify({
      message: { content },
      done: true,
      done_reason: "stop",
    })}\n`,
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
}

function writerSizedScript(prefix: string, targetWords = 108): string {
  const existingWords = prefix.trim().split(/\s+/).filter(Boolean).length;
  const filler = Array.from(
    { length: Math.max(0, targetWords - existingWords) },
    (_, index) => `evidence${index + 1}`,
  ).join(" ");
  return `${prefix.trim()}${filler ? ` ${filler}` : ""}.`;
}

function factCoverageFixture(): {
  corpus: PodcastSourceCorpus;
  plan: SemanticChunkPlan;
} {
  const corpus: PodcastSourceCorpus = {
    sources: [{
      sourceNumber: 1,
      title: "Cache operations report",
      blocks: Array.from({ length: 4 }, (_, index) => ({
        id: `block-${index + 1}`,
        kind: "paragraph" as const,
        text: `Source-backed result ${index + 1} describes one distinct cache behavior.`,
      })),
    }],
  };
  const plan: SemanticChunkPlan = {
    facts: [{
      id: "fact-3",
      statement: "The third experiment measured recovery after cache saturation.",
      sourceNumber: 1,
      sourceBlockIds: ["block-3"],
      segmentId: "segment-3",
    }],
    segments: Array.from({ length: 4 }, (_, index) => ({
      id: `segment-${index + 1}`,
      title: `Chapter ${index + 1}`,
      focus: `Distinct focus ${index + 1}`,
      sourceBlockIds: [`block-${index + 1}`],
      factIds: index === 2 ? ["fact-3"] : [],
      targetWeight: 0.25,
    })),
  };
  return { corpus, plan };
}

test("a missing assigned fact retries only its owning segment before writing later segments", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_DIGEST_AUDIT_MODE = "midpoint";
  const { corpus, plan } = factCoverageFixture();
  const writerSequence: string[] = [];
  const writerPrompts: string[] = [];
  let segmentThreeAttempts = 0;
  let segmentThreeFormat: Record<string, unknown> | undefined;

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
      format: Record<string, unknown>;
    };
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    if (system.includes("coverage auditor")) {
      return ndjson({
        coverageDigest: [
          "The first chapter covered its assigned evidence",
          "The second chapter covered its assigned evidence",
        ],
      });
    }

    const segmentId = user.match(/Write (segment-\d+)/)?.[1];
    assert.ok(segmentId);
    writerSequence.push(segmentId);
    writerPrompts.push(user);
    if (segmentId === "segment-3") segmentThreeAttempts += 1;
    if (segmentId === "segment-3") segmentThreeFormat = body.format;
    const repaired = segmentId === "segment-3" && segmentThreeAttempts === 2;
    return ndjson({
      segmentId,
      script: repaired
        ? writerSizedScript(
          "The repaired chapter includes the assigned recovery experiment",
        )
        : writerSizedScript(
          `${segmentId} presents only the evidence represented by its coverage ledger`,
        ),
      newCoverage: [
        `${segmentId} coverage point one`,
        `${segmentId} coverage point two`,
      ],
      coveredFactIds: repaired ? ["fact-3"] : [],
      claims: [],
    });
  }) as typeof fetch;

  try {
    const generated = await generateSemanticSegments(
      corpus,
      plan,
      "daily_digest",
      "brief",
    );

    assert.deepEqual(writerSequence, [
      "segment-1",
      "segment-2",
      "segment-3",
      "segment-3",
      "segment-4",
    ]);
    assert.equal(segmentThreeAttempts, 2);
    assert.match(writerPrompts[3], /RESPONSE CONTRACT REPAIR/i);
    assert.match(writerPrompts[3], /fact-3/);
    const formatProperties = (segmentThreeFormat as {
      properties: {
        segmentId: { enum: string[] };
        coveredFactIds: { minItems: number; maxItems: number };
      };
    }).properties;
    assert.deepEqual(formatProperties.segmentId.enum, ["segment-3"]);
    assert.equal(formatProperties.coveredFactIds.minItems, 1);
    assert.equal(formatProperties.coveredFactIds.maxItems, 1);
    assert.deepEqual(generated[2].coveredFactIds, ["fact-3"]);
    assert.match(generated[2].script, /recovery experiment/i);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("an under-length writer retries only its segment with the allocated word band", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_DIGEST_AUDIT_MODE = "midpoint";
  const { corpus, plan } = factCoverageFixture();
  const writerSequence: string[] = [];
  const writerPrompts: string[] = [];
  let segmentTwoAttempts = 0;

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    if (system.includes("coverage auditor")) {
      return ndjson({
        coverageDigest: [
          "The first chapter covered its assigned evidence",
          "The repaired second chapter covered its assigned evidence",
        ],
      });
    }
    const segmentId = user.match(/Write (segment-\d+)/)?.[1];
    assert.ok(segmentId);
    writerSequence.push(segmentId);
    writerPrompts.push(user);
    if (segmentId === "segment-2") segmentTwoAttempts += 1;
    return ndjson({
      segmentId,
      script: segmentId === "segment-2" && segmentTwoAttempts === 1
        ? "This response is too short."
        : writerSizedScript(
          `${segmentId} provides its complete source-backed allocated narration`,
        ),
      newCoverage: [
        `${segmentId} coverage point one`,
        `${segmentId} coverage point two`,
      ],
      coveredFactIds: segmentId === "segment-3" ? ["fact-3"] : [],
      claims: [],
    });
  }) as typeof fetch;

  try {
    const generated = await generateSemanticSegments(
      corpus,
      plan,
      "daily_digest",
      "brief",
    );
    assert.deepEqual(writerSequence, [
      "segment-1",
      "segment-2",
      "segment-2",
      "segment-3",
      "segment-4",
    ]);
    assert.match(writerPrompts[2], /word_count_below_min/i);
    assert.match(writerPrompts[2], /EXPANSION REPAIR/);
    assert.match(writerPrompts[2], /expanded to 99-127 words/i);
    assert.match(
      writerPrompts[2],
      /PREVIOUS DRAFT:\n"This response is too short\."/,
      "the expansion attempt must receive the draft it has to grow",
    );
    assert.doesNotMatch(
      writerPrompts[2],
      /replace the rejected script/i,
      "a short draft must be expanded, never regenerated from scratch",
    );
    assert.equal(generated[1].wordCountIssue, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("invalid rolling coverage bullets are derived only from returned transcript sentences", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_DIGEST_AUDIT_MODE = "midpoint";
  const { corpus, plan } = factCoverageFixture();
  const writerSequence: string[] = [];

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    if (system.includes("coverage auditor")) {
      return ndjson({
        coverageDigest: [
          "The transcript supplied the first grounded result",
          "The transcript supplied the second grounded result",
        ],
      });
    }
    const segmentId = user.match(/Write (segment-\d+)/)?.[1];
    assert.ok(segmentId);
    writerSequence.push(segmentId);
    return ndjson({
      segmentId,
      script: writerSizedScript(
        `${segmentId} states its first grounded result. It then states a second distinct grounded result`,
      ),
      newCoverage: segmentId === "segment-1"
        ? ["Only one malformed bookkeeping bullet"]
        : [
          `${segmentId} coverage point one`,
          `${segmentId} coverage point two`,
        ],
      coveredFactIds: segmentId === "segment-3" ? ["fact-3"] : [],
      claims: [],
    });
  }) as typeof fetch;

  try {
    const generated = await generateSemanticSegments(
      corpus,
      plan,
      "daily_digest",
      "brief",
    );
    assert.deepEqual(writerSequence, [
      "segment-1",
      "segment-2",
      "segment-3",
      "segment-4",
    ]);
    assert.equal(generated[0].coverageDerived, true);
    assert.equal(generated[0].newCoverage.length >= 2, true);
    assert.match(generated[0].newCoverage[0], /first grounded result/i);
    assert.doesNotMatch(
      generated[0].newCoverage.join(" "),
      /malformed bookkeeping/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("a malformed repair response falls back to the earlier usable segment", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_DIGEST_AUDIT_MODE = "midpoint";
  const { corpus, plan } = factCoverageFixture();
  const writerSequence: string[] = [];
  let segmentTwoAttempts = 0;

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    if (system.includes("coverage auditor")) {
      return ndjson({
        coverageDigest: [
          "The first chapter covered its assigned evidence",
          "The short second chapter retained source-backed evidence",
        ],
      });
    }
    const segmentId = user.match(/Write (segment-\d+)/)?.[1];
    assert.ok(segmentId);
    writerSequence.push(segmentId);
    if (segmentId === "segment-2") {
      segmentTwoAttempts += 1;
      if (segmentTwoAttempts === 2) return ndjsonText("{not valid json");
    }
    return ndjson({
      segmentId,
      script: segmentId === "segment-2"
        ? "The usable first response remains short but source grounded."
        : writerSizedScript(
          `${segmentId} provides its complete source-backed allocated narration`,
        ),
      newCoverage: [
        `${segmentId} coverage point one`,
        `${segmentId} coverage point two`,
      ],
      coveredFactIds: segmentId === "segment-3" ? ["fact-3"] : [],
      claims: [],
    });
  }) as typeof fetch;

  try {
    const generated = await generateSemanticSegments(
      corpus,
      plan,
      "daily_digest",
      "brief",
    );
    assert.deepEqual(writerSequence, [
      "segment-1",
      "segment-2",
      "segment-2",
      "segment-3",
      "segment-4",
    ]);
    assert.match(generated[1].script, /usable first response/i);
    assert.equal(generated[1].wordCountIssue?.actualWords, 9);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("persistent missing fact metadata is never auto-credited from an invented fact ID", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_DIGEST_AUDIT_MODE = "midpoint";
  const { corpus, plan } = factCoverageFixture();
  const writerSequence: string[] = [];

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    if (system.includes("coverage auditor")) {
      return ndjson({
        coverageDigest: [
          "The first chapter covered its assigned evidence",
          "The second chapter covered its assigned evidence",
        ],
      });
    }

    const segmentId = user.match(/Write (segment-\d+)/)?.[1];
    assert.ok(segmentId);
    writerSequence.push(segmentId);
    return ndjson({
      segmentId,
      script: writerSizedScript(
        `${segmentId} remains limited to its source-backed chapter evidence`,
      ),
      newCoverage: [
        `${segmentId} coverage point one`,
        `${segmentId} coverage point two`,
      ],
      coveredFactIds: segmentId === "segment-3"
        ? ["model-invented-fact-id"]
        : [],
      claims: [],
    });
  }) as typeof fetch;

  try {
    const generated = await generateSemanticSegments(
      corpus,
      plan,
      "daily_digest",
      "brief",
    );

    assert.deepEqual(writerSequence, [
      "segment-1",
      "segment-2",
      "segment-3",
      "segment-3",
      "segment-4",
    ]);
    assert.deepEqual(
      generated[2].coveredFactIds,
      [],
      "an unknown fact ID must be discarded, never converted into assigned coverage",
    );
    assert.deepEqual(
      generated[2].missingFactIds,
      ["fact-3"],
      "the exact omission must remain available to consolidation and safeguard feedback",
    );
    assert.equal(generated.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("persistent missing fact IDs remain explicit in consolidation and safeguard packets", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  const { corpus, plan } = factCoverageFixture();
  const segments: SemanticGeneratedSegment[] = plan.segments.map((planned) => ({
    id: planned.id,
    title: planned.title,
    focus: planned.focus,
    script: `${planned.id} provides a complete source-backed spoken sentence.`,
    newCoverage: [
      `${planned.id} coverage point one`,
      `${planned.id} coverage point two`,
    ],
    coveredFactIds: [],
    claims: [],
    missingFactIds: planned.id === "segment-3" ? ["fact-3"] : [],
  }));
  let consolidationPrompt = "";
  let safeguardPrompt = "";
  let safeguardThinking: boolean | undefined;

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
      think?: boolean;
    };
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    if (system.includes("consolidation editor")) {
      consolidationPrompt = user;
      return ndjson({
        segments: segments.map((segment) => ({
          segmentId: segment.id,
          script: segment.script,
          claims: [],
        })),
      });
    }
    if (system.includes("read-only policy and evidence critic")) {
      safeguardPrompt = user;
      safeguardThinking = body.think;
      return ndjson({ issues: [] });
    }
    throw new Error(`Unexpected semantic model role: ${system.slice(0, 80)}`);
  }) as typeof fetch;

  try {
    const consolidated = await consolidateSemanticSegments(
      corpus,
      plan,
      segments,
      { sentences: [], comparedPairCount: 0, threshold: 0.85, pairs: [] },
    );
    await auditSemanticPodcast(corpus, plan, consolidated);

    assert.match(consolidationPrompt, /missingFactIds/);
    assert.match(consolidationPrompt, /fact-3/);
    assert.match(safeguardPrompt, /missingFactIds/);
    assert.match(safeguardPrompt, /fact-3/);
    assert.equal(
      safeguardThinking,
      true,
      "gpt-oss-safeguard requires its reasoning channel to produce final content",
    );
    assert.deepEqual(
      consolidated[2].missingFactIds,
      ["fact-3"],
      "a prose mutation must not silently claim that an omitted fact was covered",
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});
