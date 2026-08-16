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

function safeguardRetryFixture(): {
  corpus: PodcastSourceCorpus;
  plan: SemanticChunkPlan;
  segments: SemanticGeneratedSegment[];
} {
  const corpus: PodcastSourceCorpus = {
    sources: [{
      sourceNumber: 1,
      title: "Retry evidence source",
      blocks: [{
        id: "retry-block",
        kind: "paragraph",
        text: "The benchmark measured recovery latency after saturation.",
      }],
    }],
  };
  const plan: SemanticChunkPlan = {
    facts: [],
    segments: [{
      id: "segment-1",
      title: "Recovery",
      focus: "Recovery latency",
      sourceBlockIds: ["retry-block"],
      factIds: [],
      targetWeight: 1,
    }],
  };
  const segments: SemanticGeneratedSegment[] = [{
    id: "segment-1",
    title: "Recovery",
    focus: "Recovery latency",
    script: "The benchmark measured recovery latency after saturation.",
    newCoverage: ["Recovery latency", "Saturation behavior"],
    coveredFactIds: [],
    claims: [],
  }];
  return { corpus, plan, segments };
}

function waitForAbort(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (!signal) {
      reject(new Error("The safeguard request did not include an abort signal."));
    } else if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  });
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

test("safeguard retries one timeout with the identical read-only request", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const originalConsoleInfo = console.info;
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "info";
  process.env.OLLAMA_REVIEW_TIMEOUT_MS = "80";
  process.env.OLLAMA_REVIEW_RETRY_TIMEOUT_MS = "40";
  const { corpus, plan, segments } = safeguardRetryFixture();
  const requestBodies: unknown[] = [];
  const logLines: string[] = [];
  let requests = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  console.info = (...values: unknown[]) => {
    logLines.push(values.map(String).join(" "));
  };

  globalThis.fetch = (async (_input, init) => {
    requests += 1;
    requestBodies.push(JSON.parse(String(init?.body)));
    if (requests === 1) {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        return await waitForAbort(init?.signal);
      } finally {
        activeRequests -= 1;
      }
    }
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    activeRequests -= 1;
    return streamedSafeguardResponse();
  }) as typeof fetch;

  try {
    const review = await auditSemanticPodcast(corpus, plan, segments, {
      traceId: "safeguard-retry-clean",
    });
    assert.deepEqual(review, { issues: [] });
    assert.equal(requests, 2);
    assert.equal(maxActiveRequests, 1);
    assert.deepEqual(requestBodies[1], requestBodies[0]);
    const retryLog = logLines.find((line) =>
      line.includes('"event":"semantic_safeguard_retry"')
    );
    assert.ok(retryLog);
    assert.match(retryLog, /"reason":"model_timeout"/);
    assert.match(retryLog, /"retryTimeoutMs":40/);
    assert.doesNotMatch(retryLog, /Retry evidence source|recovery latency/i);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalConsoleInfo;
    process.env = originalEnv;
  }
});

test("safeguard fails closed after two timeouts", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_REVIEW_TIMEOUT_MS = "40";
  process.env.OLLAMA_REVIEW_RETRY_TIMEOUT_MS = "20";
  const { corpus, plan, segments } = safeguardRetryFixture();
  let requests = 0;
  globalThis.fetch = (async (_input, init) => {
    requests += 1;
    return await waitForAbort(init?.signal);
  }) as typeof fetch;

  try {
    await assert.rejects(
      auditSemanticPodcast(corpus, plan, segments),
      /Safeguard audit timed out after two attempts; the transcript was not accepted/,
    );
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("safeguard preserves a substantive issue returned after its timeout retry", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_REVIEW_TIMEOUT_MS = "60";
  process.env.OLLAMA_REVIEW_RETRY_TIMEOUT_MS = "30";
  const { corpus, plan, segments } = safeguardRetryFixture();
  const unsupportedIssue = {
    segmentId: "segment-1",
    kind: "unsupported_fact",
    severity: "error",
    problem: "The transcript adds a result absent from the assigned evidence.",
    instruction: "Remove the unsupported result.",
  };
  let requests = 0;
  globalThis.fetch = (async (_input, init) => {
    requests += 1;
    return requests === 1
      ? await waitForAbort(init?.signal)
      : safeguardIssuesResponse([unsupportedIssue]);
  }) as typeof fetch;

  try {
    const review = await auditSemanticPodcast(corpus, plan, segments);
    assert.equal(requests, 2);
    assert.deepEqual(review.issues, [unsupportedIssue]);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("safeguard does not retry malformed structured output", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  const { corpus, plan, segments } = safeguardRetryFixture();
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return new Response(
      `${JSON.stringify({
        message: { content: "not structured JSON" },
        done: true,
        done_reason: "stop",
      })}\n`,
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      auditSemanticPodcast(corpus, plan, segments),
      /invalid structured JSON for semantic_safeguard_audit/,
    );
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});
