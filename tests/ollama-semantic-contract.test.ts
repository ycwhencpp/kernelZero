import assert from "node:assert/strict";
import test from "node:test";
import {
  consolidateSemanticSegments,
  finalizeSemanticSegments,
  validateSemanticPodcastDraft,
  type PodcastSourceCorpus,
  type SemanticChunkPlan,
  type SemanticDuplicateResult,
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

function provenanceFixture(): {
  corpus: PodcastSourceCorpus;
  plan: SemanticChunkPlan;
  segments: SemanticGeneratedSegment[];
} {
  const corpus: PodcastSourceCorpus = {
    sources: [
      {
        sourceNumber: 1,
        title: "First source",
        blocks: [{
          id: "source-1-block",
          kind: "paragraph",
          text: "The first source supports the first segment's factual claim.",
        }],
      },
      {
        sourceNumber: 2,
        title: "Second source",
        blocks: [{
          id: "source-2-block",
          kind: "paragraph",
          text: "The second source supports the second segment's factual claim.",
        }],
      },
    ],
  };
  const plan: SemanticChunkPlan = {
    facts: [],
    segments: [
      {
        id: "segment-1",
        title: "First chapter",
        focus: "First source evidence",
        sourceBlockIds: ["source-1-block"],
        factIds: [],
        targetWeight: 0.5,
      },
      {
        id: "segment-2",
        title: "Second chapter",
        focus: "Second source evidence",
        sourceBlockIds: ["source-2-block"],
        factIds: [],
        targetWeight: 0.5,
      },
    ],
  };
  const segments: SemanticGeneratedSegment[] = plan.segments.map((planned) => ({
    id: planned.id,
    title: planned.title,
    focus: planned.focus,
    script: `${planned.title} has a complete source-backed sentence.`,
    newCoverage: ["Coverage one", "Coverage two"],
    coveredFactIds: [],
    claims: [],
  }));
  return { corpus, plan, segments };
}

function claim(sourceBlockId: string, segmentId: string) {
  return {
    claim: `${segmentId} factual claim`,
    support: `${segmentId} source support`,
    confidence: 0.9,
    location: segmentId,
    sourceBlockId,
  };
}

function sizedSentence(label: string, targetWords: number): string {
  const prefix = `${label} explains one distinct source backed mechanism`;
  const prefixWords = prefix.split(/\s+/).length;
  const filler = Array.from(
    { length: Math.max(0, targetWords - prefixWords) },
    (_, index) => `${label.toLowerCase()}detail${index + 1}`,
  ).join(" ");
  return `${prefix}${filler ? ` ${filler}` : ""}.`;
}

function malformedConsolidationFixture(): {
  corpus: PodcastSourceCorpus;
  plan: SemanticChunkPlan;
  segments: SemanticGeneratedSegment[];
} {
  const corpus: PodcastSourceCorpus = {
    sources: Array.from({ length: 4 }, (_, index) => ({
      sourceNumber: index + 1,
      title: `Fallback source ${index + 1}`,
      blocks: [{
        id: `fallback-block-${index + 1}`,
        kind: "paragraph",
        text: `Source ${index + 1} supports one distinct operational mechanism for the episode.`,
      }],
    })),
  };
  const plan: SemanticChunkPlan = {
    facts: [],
    segments: Array.from({ length: 4 }, (_, index) => ({
      id: `segment-${index + 1}`,
      title: `Fallback chapter ${index + 1}`,
      focus: `Distinct fallback focus ${index + 1}`,
      sourceBlockIds: [`fallback-block-${index + 1}`],
      factIds: [],
      targetWeight: 0.25,
    })),
  };
  const rawScripts = [
    `This episode follows resilient cache design, so you'll understand how eviction choices shape recovery and why that matters for reliable services.\n\n${sizedSentence("Opening", 74)}`,
    sizedSentence("Mechanism", 104),
    sizedSentence("Operations", 104),
    sizedSentence("Outcome", 74),
  ];
  const segments = finalizeSemanticSegments(
    plan.segments.map((planned, index) => ({
      id: planned.id,
      title: planned.title,
      focus: planned.focus,
      script: rawScripts[index],
      newCoverage: [
        `${planned.id} first distinct coverage point`,
        `${planned.id} second distinct coverage point`,
      ],
      coveredFactIds: [],
      claims: [],
    })),
  );
  // This is the incident shape: invalid model-authored claim rows were already
  // discarded, leaving usable prose plus an optional-ledger repair marker.
  segments[0].claimProvenanceIssueCount = 2;
  return { corpus, plan, segments };
}

test("consolidation retries once when a claim names another segment's source block", async () => {
  const originalFetch = globalThis.fetch;
  const originalLogLevel = process.env.OLLAMA_PIPELINE_LOG_LEVEL;
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  const { corpus, plan, segments } = provenanceFixture();
  const prompts: string[] = [];
  let requestCount = 0;

  globalThis.fetch = (async (_input, init) => {
    requestCount += 1;
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    prompts.push(body.messages[1].content);
    return ndjson({
      segments: [
        {
          segmentId: "segment-1",
          script: "The first consolidated segment ends with evidence.",
          claims: [claim(
            requestCount === 1 ? "source-2-block" : "source-1-block",
            "segment-1",
          )],
        },
        {
          segmentId: "segment-2",
          script: "The second consolidated segment ends with evidence.",
          claims: [claim("source-2-block", "segment-2")],
        },
      ],
    });
  }) as typeof fetch;

  try {
    const consolidated = await consolidateSemanticSegments(
      corpus,
      plan,
      segments,
      { sentences: [], comparedPairCount: 0, threshold: 0.85, pairs: [] },
    );

    assert.equal(requestCount, 2, "one rejected response should cause one retry");
    assert.doesNotMatch(prompts[0], /RESPONSE CONTRACT REPAIR/);
    assert.match(
      prompts[1],
      /segment-1:claim_source_block_unassigned:0/,
    );
    assert.deepEqual(
      consolidated.map((segment) => segment.claims.map((entry) => entry.sourceNumber)),
      [[1], [2]],
    );
    assert.deepEqual(
      consolidated.map((segment) => segment.claimProvenanceIssueCount),
      [0, 0],
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OLLAMA_PIPELINE_LOG_LEVEL = originalLogLevel;
  }
});

test("consolidation omits persistently invalid claims and records provenance issues", async () => {
  const originalFetch = globalThis.fetch;
  const originalLogLevel = process.env.OLLAMA_PIPELINE_LOG_LEVEL;
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  const { corpus, plan, segments } = provenanceFixture();
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount += 1;
    return ndjson({
      segments: [
        {
          segmentId: "segment-1",
          script: "The first consolidated segment ends with evidence.",
          claims: [claim("source-2-block", "segment-1")],
        },
        {
          segmentId: "segment-2",
          script: "The second consolidated segment ends with evidence.",
          claims: [claim("source-2-block", "segment-2")],
        },
      ],
    });
  }) as typeof fetch;

  try {
    const consolidated = await consolidateSemanticSegments(
      corpus,
      plan,
      segments,
      { sentences: [], comparedPairCount: 0, threshold: 0.85, pairs: [] },
    );

    assert.equal(requestCount, 2, "persistent invalid provenance still gets one retry");
    assert.deepEqual(consolidated[0].claims, []);
    assert.equal(consolidated[0].claimProvenanceIssueCount, 1);
    assert.equal(consolidated[1].claims.length, 1);
    assert.equal(consolidated[1].claims[0].sourceNumber, 2);
    assert.equal(consolidated[1].claimProvenanceIssueCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OLLAMA_PIPELINE_LOG_LEVEL = originalLogLevel;
  }
});

test("omitted invalid claim metadata requests repair without becoming a fatal transcript error", () => {
  const { corpus, plan, segments } = provenanceFixture();
  segments[0].claimProvenanceIssueCount = 1;

  const validation = validateSemanticPodcastDraft(
    corpus,
    plan,
    segments,
    "brief",
    { sentences: [], comparedPairCount: 0, threshold: 0.85, pairs: [] },
    { issues: [] },
  );

  assert.equal(
    validation.hardFailures.some((failure) =>
      failure.includes("invalid claim provenance")
    ),
    false,
  );
  assert.equal(
    validation.repairFeedback.some((failure) =>
      failure.includes("omitted 1 invalid claim provenance")
    ),
    true,
  );
});

test("a surviving style-only failure remains a hard semantic gate", () => {
  const { corpus, plan, segments } = malformedConsolidationFixture();
  segments[0].claimProvenanceIssueCount = 0;
  // Simulate a model response that merges the valid orientation and hook into
  // one overlong opening paragraph after the deterministic finalizer has run.
  segments[0].script = segments[0].script.replace("\n\n", " ");

  const validation = validateSemanticPodcastDraft(
    corpus,
    plan,
    segments,
    "brief",
    { sentences: [], comparedPairCount: 0, threshold: 0.85, pairs: [] },
    { issues: [] },
  );

  assert.equal(validation.length.status, "within_range");
  assert.equal(validation.hardFailures.length, 1);
  assert.match(validation.hardFailures[0], /Podcast style validation failed/);
  assert.deepEqual(validation.qualityBlockers, validation.hardFailures);
});

test("repair preserves a gate-clean transcript after two malformed JSON responses", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  const { corpus, plan, segments } = malformedConsolidationFixture();
  const duplicates = {
    sentences: [],
    comparedPairCount: 0,
    threshold: 0.85,
    pairs: [],
  };
  const validation = validateSemanticPodcastDraft(
    corpus,
    plan,
    segments,
    "brief",
    duplicates,
    { issues: [] },
  );
  assert.deepEqual(validation.hardFailures, []);
  assert.deepEqual(validation.qualityBlockers, [
    "segment-1 omitted 2 invalid claim provenance record(s); return only claims tied to assigned sourceBlockIds.",
  ]);
  const prompts: string[] = [];
  let requestCount = 0;
  globalThis.fetch = (async (_input, init) => {
    requestCount += 1;
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    prompts.push(body.messages[1].content);
    return ndjsonText("{not valid json");
  }) as typeof fetch;

  try {
    const repaired = await consolidateSemanticSegments(
      corpus,
      plan,
      segments,
      duplicates,
      {
        episodeLength: "brief",
        repairFeedback: {
          reviewIssues: [],
          duplicatePairs: [],
          deterministicFailures: validation.repairFeedback,
        },
      },
    );

    assert.equal(requestCount, 2);
    assert.match(prompts[1], /structured_json_invalid/);
    assert.deepEqual(
      repaired.map((segment) => ({
        script: segment.script,
        claims: segment.claims,
        coveredFactIds: segment.coveredFactIds,
        missingFactIds: segment.missingFactIds,
        claimProvenanceIssueCount: segment.claimProvenanceIssueCount,
      })),
      segments.map((segment) => ({
        script: segment.script,
        claims: segment.claims,
        coveredFactIds: segment.coveredFactIds,
        missingFactIds: segment.missingFactIds,
        claimProvenanceIssueCount: segment.claimProvenanceIssueCount,
      })),
      "the fallback must preserve prose and every evidence ledger marker",
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("double-malformed consolidation remains fatal outside the repair pass", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  const { corpus, plan, segments } = malformedConsolidationFixture();
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount += 1;
    return ndjsonText("{not valid json");
  }) as typeof fetch;

  try {
    await assert.rejects(
      consolidateSemanticSegments(
        corpus,
        plan,
        segments,
        { sentences: [], comparedPairCount: 0, threshold: 0.85, pairs: [] },
        { episodeLength: "brief" },
      ),
      /Consolidation did not satisfy its structured response contract after two attempts/,
    );
    assert.equal(requestCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("malformed repair fallback rejects known style, safeguard, fact, and duplicate blockers", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  const { corpus, plan, segments } = malformedConsolidationFixture();
  let requestCount = 0;
  globalThis.fetch = (async () => {
    requestCount += 1;
    return ndjsonText("{not valid json");
  }) as typeof fetch;
  const emptyDuplicates = {
    sentences: [],
    comparedPairCount: 0,
    threshold: 0.85,
    pairs: [],
  };
  const repair = (overrides: {
    candidateSegments?: SemanticGeneratedSegment[];
    candidatePlan?: SemanticChunkPlan;
    duplicates?: SemanticDuplicateResult;
    reviewIssues?: Array<{
      segmentId: string;
      kind: "unsupported_fact";
      severity: "error";
      problem: string;
      instruction: string;
    }>;
  } = {}) => {
    const candidateDuplicates = overrides.duplicates ?? emptyDuplicates;
    return consolidateSemanticSegments(
      corpus,
      overrides.candidatePlan ?? plan,
      overrides.candidateSegments ?? segments,
      candidateDuplicates,
      {
        episodeLength: "brief",
        repairFeedback: {
          reviewIssues: overrides.reviewIssues ?? [],
          duplicatePairs: candidateDuplicates.pairs,
          deterministicFailures: ["repair the known blocker"],
        },
      },
    );
  };

  try {
    const styleBlocked = segments.map((segment, index) => index === 0
      ? { ...segment, script: segment.script.replace("\n\n", " ") }
      : segment);
    await assert.rejects(
      repair({ candidateSegments: styleBlocked }),
      /structured response contract after two attempts/,
    );

    await assert.rejects(
      repair({
        reviewIssues: [{
          segmentId: "segment-1",
          kind: "unsupported_fact",
          severity: "error",
          problem: "A factual statement is not supported.",
          instruction: "Remove the unsupported statement.",
        }],
      }),
      /structured response contract after two attempts/,
    );

    const factPlan: SemanticChunkPlan = {
      facts: [{
        id: "fallback-fact-1",
        statement: "The first source supports the assigned fallback fact.",
        sourceNumber: 1,
        sourceBlockIds: ["fallback-block-1"],
        segmentId: "segment-1",
      }],
      segments: plan.segments.map((segment, index) => index === 0
        ? { ...segment, factIds: ["fallback-fact-1"] }
        : segment),
    };
    const factBlocked = segments.map((segment, index) => index === 0
      ? { ...segment, missingFactIds: ["fallback-fact-1"] }
      : segment);
    await assert.rejects(
      repair({ candidatePlan: factPlan, candidateSegments: factBlocked }),
      /structured response contract after two attempts/,
    );

    const earlier = {
      index: 0,
      segmentId: "segment-1",
      segmentIndex: 0,
      paragraphIndex: 1,
      sentenceIndex: 0,
      text: "The earlier source-backed sentence.",
    };
    const later = {
      index: 1,
      segmentId: "segment-2",
      segmentIndex: 1,
      paragraphIndex: 0,
      sentenceIndex: 0,
      text: "The later source-backed sentence.",
    };
    await assert.rejects(
      repair({
        duplicates: {
          sentences: [earlier, later],
          comparedPairCount: 1,
          threshold: 0.85,
          pairs: [{ earlier, later, similarity: 0.91 }],
        },
      }),
      /structured response contract after two attempts/,
    );

    assert.equal(requestCount, 8, "each blocked repair must exhaust two attempts");
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});
