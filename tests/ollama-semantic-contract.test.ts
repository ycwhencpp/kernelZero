import assert from "node:assert/strict";
import test from "node:test";
import {
  consolidateSemanticSegments,
  validateSemanticPodcastDraft,
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
