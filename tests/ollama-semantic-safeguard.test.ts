import assert from "node:assert/strict";
import test from "node:test";
import {
  auditSemanticPodcast,
  type PodcastSourceCorpus,
  type SemanticChunkPlan,
  type SemanticGeneratedSegment,
} from "../lib/ollama-semantic.ts";

function streamedSafeguardResponse(): Response {
  const chunks = [
    {
      message: {
        role: "assistant",
        content: "",
        thinking: "Inspecting the synthetic evidence without rewriting it.",
      },
      done: false,
    },
    {
      message: {
        role: "assistant",
        content: '{"issues":',
        thinking: "",
      },
      done: false,
    },
    {
      message: { role: "assistant", content: "[]}" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 120,
      eval_count: 6,
    },
  ];
  return new Response(
    `${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`,
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
}

function safeguardIssuesResponse(issues: unknown[]): Response {
  return new Response(
    `${JSON.stringify({
      message: { content: JSON.stringify({ issues }) },
      done: true,
      done_reason: "stop",
    })}\n`,
    { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
  );
}

test("safeguard preserves streamed final JSON while discarding reasoning chunks", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  let requestedThinking: boolean | undefined;

  const corpus: PodcastSourceCorpus = {
    sources: [{
      sourceNumber: 1,
      title: "Synthetic source",
      blocks: [{
        id: "synthetic-block",
        kind: "paragraph",
        text: "Pure water freezes at zero degrees Celsius at standard pressure.",
      }],
    }],
  };
  const plan: SemanticChunkPlan = {
    facts: [],
    segments: [{
      id: "segment-1",
      title: "Synthetic chapter",
      focus: "A source-backed physical property",
      sourceBlockIds: ["synthetic-block"],
      factIds: [],
      targetWeight: 1,
    }],
  };
  const segments: SemanticGeneratedSegment[] = [{
    id: "segment-1",
    title: "Synthetic chapter",
    focus: "A source-backed physical property",
    script: "Pure water freezes at zero degrees Celsius at standard pressure.",
    newCoverage: ["Water's freezing point", "The pressure condition"],
    coveredFactIds: [],
    claims: [],
  }];

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { think?: boolean };
    requestedThinking = body.think;
    return streamedSafeguardResponse();
  }) as typeof fetch;

  try {
    const review = await auditSemanticPodcast(corpus, plan, segments);
    assert.equal(requestedThinking, true);
    assert.deepEqual(review, { issues: [] });
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("safeguard may report fact omissions only for explicitly marked segments", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  const corpus: PodcastSourceCorpus = {
    sources: [{
      sourceNumber: 1,
      title: "Synthetic source",
      blocks: [{
        id: "synthetic-block",
        kind: "paragraph",
        text: "The benchmark measured recovery latency after saturation.",
      }],
    }],
  };
  const plan: SemanticChunkPlan = {
    facts: [{
      id: "fact-1",
      statement: "The benchmark measured recovery latency after saturation.",
      sourceNumber: 1,
      sourceBlockIds: ["synthetic-block"],
      segmentId: "segment-1",
    }],
    segments: [{
      id: "segment-1",
      title: "Recovery",
      focus: "Recovery latency",
      sourceBlockIds: ["synthetic-block"],
      factIds: ["fact-1"],
      targetWeight: 1,
    }],
  };
  const baseSegment: SemanticGeneratedSegment = {
    id: "segment-1",
    title: "Recovery",
    focus: "Recovery latency",
    script: "The benchmark measured recovery latency after saturation.",
    newCoverage: ["Recovery latency", "Saturation behavior"],
    coveredFactIds: ["fact-1"],
    claims: [],
  };
  const reportedIssue = {
    segmentId: "segment-1",
    kind: "fact_omission",
    severity: "error",
    problem: "Synthetic omission report",
    instruction: "Include fact-1",
  };
  globalThis.fetch = (async () => safeguardIssuesResponse([reportedIssue])) as typeof fetch;

  try {
    const unmarked = await auditSemanticPodcast(corpus, plan, [baseSegment]);
    assert.deepEqual(unmarked.issues, []);

    const marked = await auditSemanticPodcast(corpus, plan, [{
      ...baseSegment,
      coveredFactIds: [],
      missingFactIds: ["fact-1"],
    }]);
    assert.equal(marked.issues.length, 1);
    assert.equal(marked.issues[0].kind, "fact_omission");
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});
