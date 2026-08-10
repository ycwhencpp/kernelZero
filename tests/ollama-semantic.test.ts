import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateSegmentWordTargets,
  buildSemanticPromptSourcePacket,
  compactSemanticBlockText,
  createFinalPodcastMetadata,
  createSemanticChunkPlan,
  createSemanticPodcast,
  consolidateSemanticSegments,
  cosineSimilarity,
  detectSemanticDuplicatePairs,
  ensureSemanticCorpusDepth,
  fallbackSemanticChunkPlan,
  finalizeSemanticSegments,
  generateSemanticSegments,
  NO_WRAP_UP_SEGMENT_RULE,
  ollamaSemanticRoleConfig,
  SEMANTIC_PLANNING_PACKET_MAX_CHARACTERS,
  semanticSentenceRecords,
  toPodcastSourceCorpus,
  validateFinalPodcastMetadata,
  validateSemanticChunkPlan,
  type PodcastSourceCorpus,
  type SemanticChunkPlan,
  type SemanticGeneratedSegment,
} from "../lib/ollama-semantic.ts";
import { KERNELZERO_CLOSING_LINES } from "../lib/kernelzero-transcript-prompt.ts";

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

function writerSizedScript(prefix: string, targetWords = 108): string {
  const existingWords = prefix.trim().split(/\s+/).filter(Boolean).length;
  const filler = Array.from(
    { length: Math.max(0, targetWords - existingWords) },
    (_, index) => `grounded${index + 1}`,
  ).join(" ");
  return `${prefix.trim()}${filler ? ` ${filler}` : ""}.`;
}

function corpus(): PodcastSourceCorpus {
  return {
    sources: [{
      sourceNumber: 1,
      contentItemId: "item-1",
      title: "Valkey memory policy report",
      sourceName: "Kernel Systems Lab",
      url: "https://example.com/valkey",
      blocks: Array.from({ length: 5 }, (_, index) => ({
        id: `block-${index + 1}`,
        kind: "paragraph",
        headingPath: [`Topic ${index + 1}`],
        text:
          `Valkey memory policy evidence number ${index + 1} explains a distinct operational result and its measured engineering consequence.`,
      })),
    }],
  };
}

function fourSegmentPlan(): SemanticChunkPlan {
  return {
    facts: [],
    segments: Array.from({ length: 4 }, (_, index) => ({
      id: `segment-${index + 1}`,
      title: index === 0
        ? "Why this matters"
        : index === 3
          ? "What to watch next"
          : `Technical chapter ${index + 1}`,
      focus: `Unique focus ${index + 1}`,
      sourceBlockIds: index === 3
        ? ["block-4", "block-5"]
        : [`block-${index + 1}`],
      factIds: [],
      targetWeight: 0.25,
    })),
  };
}

function segment(
  id: string,
  script: string,
): SemanticGeneratedSegment {
  return {
    id,
    title: id,
    focus: id,
    script,
    newCoverage: ["Coverage one", "Coverage two"],
    coveredFactIds: [],
    claims: [],
  };
}

test("semantic role configuration routes each stage independently", () => {
  const original = { ...process.env };
  process.env.OLLAMA_MODEL = "legacy-script";
  process.env.OLLAMA_SCRIPT_MODEL = "redbus-script";
  process.env.OLLAMA_CONSOLIDATION_MODEL = "redbus-editor";
  process.env.OLLAMA_REVIEW_MODEL = "safeguard-review";
  process.env.OLLAMA_METADATA_MODEL = "mistral-metadata";
  process.env.OLLAMA_EMBEDDING_MODEL = "nomic-embedding";
  process.env.OLLAMA_SCRIPT_CONTEXT_SIZE = "65536";
  process.env.OLLAMA_METADATA_CONTEXT_SIZE = "32768";

  try {
    assert.deepEqual(ollamaSemanticRoleConfig("script"), {
      model: "redbus-script",
      contextSize: 65_536,
      maxOutputTokens: 8_192,
      keepAlive: process.env.OLLAMA_SCRIPT_KEEP_ALIVE ||
        process.env.OLLAMA_KEEP_ALIVE || "30m",
    });
    assert.equal(
      ollamaSemanticRoleConfig("consolidation").model,
      "redbus-editor",
    );
    assert.equal(
      ollamaSemanticRoleConfig("consolidation").contextSize,
      65_536,
    );
    assert.equal(ollamaSemanticRoleConfig("review").model, "safeguard-review");
    assert.equal(ollamaSemanticRoleConfig("metadata").model, "mistral-metadata");
    assert.equal(ollamaSemanticRoleConfig("digest").model, "mistral-metadata");
    assert.equal(ollamaSemanticRoleConfig("digest").contextSize, 32_768);
    assert.equal(ollamaSemanticRoleConfig("embedding").model, "nomic-embedding");
  } finally {
    process.env = original;
  }
});

test("fallback chunk plans assign every block once with stable dynamic IDs", () => {
  const sourceCorpus = corpus();
  const brief = fallbackSemanticChunkPlan(sourceCorpus, "brief");
  const deep = fallbackSemanticChunkPlan(sourceCorpus, "deep");
  assert.equal(brief.segments.length, 4);
  assert.equal(deep.segments.length, 5);
  assert.deepEqual(
    deep.segments.map((entry) => entry.id),
    ["segment-1", "segment-2", "segment-3", "segment-4", "segment-5"],
  );
  assert.deepEqual(validateSemanticChunkPlan(brief, sourceCorpus, "brief"), []);
  assert.deepEqual(validateSemanticChunkPlan(deep, sourceCorpus, "deep"), []);
  assert.deepEqual(
    deep.segments.flatMap((entry) => entry.sourceBlockIds).sort(),
    ["block-1", "block-2", "block-3", "block-4", "block-5"],
  );
});

test("sparse one-paragraph evidence is split into non-empty segment inputs", () => {
  const sparse: PodcastSourceCorpus = {
    sources: [{
      sourceNumber: 1,
      title: "Sparse abstract",
      blocks: [{
        id: "abstract-1",
        kind: "paragraph",
        text: [
          "Valkey changes how the cache accounts for memory pressure.",
          "The benchmark measures eviction under a fixed workload.",
          "Operators compare recovery behavior after saturation.",
          "The report separates memory cost from request latency.",
          "Its final experiment records the operational trade-off.",
        ].join(" "),
      }],
    }],
  };
  const expanded = ensureSemanticCorpusDepth(sparse, 5);
  assert.equal(expanded.sources[0].blocks.length, 5);
  assert.equal(new Set(expanded.sources[0].blocks.map((block) => block.id)).size, 5);
  assert.ok(
    expanded.sources[0].blocks.every((block) =>
      block.id.startsWith("abstract-1") && block.text.trim().length > 0
    ),
  );
  const plan = fallbackSemanticChunkPlan(expanded, "standard");
  assert.ok(plan.segments.every((entry) => entry.sourceBlockIds.length > 0));
  assert.deepEqual(validateSemanticChunkPlan(plan, expanded, "standard"), []);
});

test("semantic finalization trims an incomplete tail to the last complete sentence", () => {
  const finalized = finalizeSemanticSegments([segment(
    "segment-1",
    "The benchmark records a complete source-backed result. A trailing fragment including.",
  )]);
  assert.match(finalized[0].script, /complete source-backed result\./);
  assert.doesNotMatch(finalized[0].script, /trailing fragment/i);
  assert.ok(finalized[0].script.startsWith("Welcome to KernelZero."));
  assert.ok(finalized[0].script.endsWith(KERNELZERO_CLOSING_LINES.at(-1)!));
});

test("block compaction preserves exact first, middle, and last source offsets", () => {
  const sourceText = Array.from(
    { length: 120 },
    (_, index) => String.fromCharCode(0x0100 + index),
  ).join("");
  const ranges = compactSemanticBlockText(sourceText, 30);
  assert.deepEqual(
    ranges.map(({ startChar, endChar }) => ({ startChar, endChar })),
    [
      { startChar: 0, endChar: 10 },
      { startChar: 55, endChar: 65 },
      { startChar: 110, endChar: 120 },
    ],
  );
  assert.equal(
    ranges.reduce((total, range) => total + range.text.length, 0),
    30,
  );
  for (const range of ranges) {
    assert.equal(
      range.text,
      sourceText.slice(range.startChar, range.endChar),
    );
  }
});

test("observed five-source planning input stays bounded and submits capped plan arrays", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  delete process.env.OLLAMA_PLANNING_SOURCE_MAX_CHARACTERS;
  const observedLengths = [35_428, 23_860, 422, 1_182, 1_874];
  const observedCorpus: PodcastSourceCorpus = {
    sources: observedLengths.map((length, index) => {
      const sentence =
        `Source ${index + 1} records distinct evidence about a measured engineering result. `;
      return {
        sourceNumber: index + 1,
        title: `Observed feed source ${index + 1}`,
        blocks: [{
          id: `observed-block-${index + 1}`,
          kind: "paragraph",
          text: sentence.repeat(Math.ceil(length / sentence.length)).slice(0, length),
        }],
      };
    }),
  };
  assert.deepEqual(
    observedCorpus.sources.map((source) => source.blocks[0].text.length),
    observedLengths,
  );
  const expandedCorpus = ensureSemanticCorpusDepth(observedCorpus, 5);
  const validPlan = fallbackSemanticChunkPlan(expandedCorpus, "standard");
  const blockCharacters = new Map(
    expandedCorpus.sources.flatMap((source) =>
      source.blocks.map((block) => [block.id, block.text.length] as const)
    ),
  );
  const segmentCharacters = validPlan.segments.map((segment) =>
    segment.sourceBlockIds.reduce(
      (total, blockId) => total + (blockCharacters.get(blockId) ?? 0),
      0,
    )
  );
  assert.ok(
    Math.max(...segmentCharacters) / Math.min(...segmentCharacters) <= 2.1,
    `fallback segment characters were imbalanced: ${segmentCharacters.join(",")}`,
  );
  assert.ok(
    validPlan.segments.every((segment) =>
      segment.targetWeight >= 0.13 && segment.targetWeight <= 0.3
    ),
  );
  const wordRanges = allocateSegmentWordTargets(validPlan, "standard");
  assert.equal(
    wordRanges.reduce((total, range) => total + range.targetWords, 0),
    1_350,
  );
  assert.ok(wordRanges.every((range) => range.minWords >= 180));
  assert.ok(wordRanges.every((range) => range.maxWords <= 400));
  assert.ok(
    validPlan.segments.every((segment) => {
      const packet = buildSemanticPromptSourcePacket(
        expandedCorpus,
        segment.sourceBlockIds,
        24_000,
      );
      return packet && JSON.stringify(packet).length < 20_000;
    }),
    "balanced fallback writer packets must stay materially below the hard cap",
  );
  let sourcePacketText = "";
  let submittedFormat: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
      format: Record<string, unknown>;
    };
    submittedFormat = body.format;
    const marker = "SOURCE CORPUS:\n";
    const markerIndex = body.messages[1].content.indexOf(marker);
    assert.notEqual(markerIndex, -1);
    sourcePacketText = body.messages[1].content.slice(
      markerIndex + marker.length,
    );
    return ndjson(validPlan);
  }) as typeof fetch;
  try {
    const plan = await createSemanticChunkPlan(
      expandedCorpus,
      "daily_digest",
      "standard",
    );
    assert.equal(plan.segments.length, 5);
    assert.ok(sourcePacketText.length > 0);
    assert.ok(
      sourcePacketText.length <= SEMANTIC_PLANNING_PACKET_MAX_CHARACTERS,
      `planning source packet was ${sourcePacketText.length} characters`,
    );
    const packet = JSON.parse(sourcePacketText) as Array<{ sourceNumber: number }>;
    assert.deepEqual(
      packet.map((source) => source.sourceNumber),
      [1, 2, 3, 4, 5],
    );
    const properties = (submittedFormat as {
      properties: {
        facts: { maxItems: number };
        segments: { minItems: number; maxItems: number };
      };
    }).properties;
    assert.equal(properties.segments.minItems, 4);
    assert.equal(properties.segments.maxItems, 5);
    assert.equal(properties.facts.maxItems, 18);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("segment writers retry an unassigned claim source and keep only the repaired output", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_DIGEST_AUDIT_MODE = "midpoint";
  const sourceCorpus: PodcastSourceCorpus = {
    sources: [
      {
        sourceNumber: 1,
        title: "First source",
        blocks: [
          { id: "source-1-a", kind: "paragraph", text: "First source evidence one." },
          { id: "source-1-b", kind: "paragraph", text: "First source evidence two." },
        ],
      },
      {
        sourceNumber: 2,
        title: "Second source",
        blocks: [
          { id: "source-2-a", kind: "paragraph", text: "Second source evidence one." },
          { id: "source-2-b", kind: "paragraph", text: "Second source evidence two." },
        ],
      },
    ],
  };
  const plan: SemanticChunkPlan = {
    facts: [],
    segments: ["source-1-a", "source-1-b", "source-2-a", "source-2-b"]
      .map((blockId, index) => ({
        id: `segment-${index + 1}`,
        title: `Chapter ${index + 1}`,
        focus: `Focus ${index + 1}`,
        sourceBlockIds: [blockId],
        factIds: [],
        targetWeight: 0.25,
      })),
  };
  const writerPrompts: string[] = [];
  let firstSegmentAttempts = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    if (system.includes("coverage auditor")) {
      return ndjson({
        coverageDigest: [
          "The first assigned source supplied its first result",
          "The first assigned source supplied its second result",
        ],
      });
    }
    writerPrompts.push(user);
    const segmentId = user.match(/Write (segment-\d+)/)?.[1];
    assert.ok(segmentId);
    if (segmentId === "segment-1") firstSegmentAttempts += 1;
    const isInvalidAttempt = segmentId === "segment-1" &&
      firstSegmentAttempts === 1;
    return ndjson({
      segmentId,
      script: isInvalidAttempt
        ? writerSizedScript(
          "This draft attaches its evidence to the wrong source metadata",
        )
        : writerSizedScript(
          `Repaired ${segmentId} uses only the evidence assigned to this chapter`,
        ),
      newCoverage: [
        `${segmentId} coverage one`,
        `${segmentId} coverage two`,
      ],
      coveredFactIds: [],
      claims: segmentId === "segment-1"
        ? [{
            claim: isInvalidAttempt
              ? "Misattributed claim"
              : "Repaired claim",
            support: isInvalidAttempt
              ? "Wrong source"
              : "First source evidence one",
            confidence: 0.8,
            location: segmentId,
            sourceNumber: isInvalidAttempt ? 2 : 1,
          }]
        : [],
    });
  }) as typeof fetch;
  try {
    const generated = await generateSemanticSegments(
      sourceCorpus,
      plan,
      "daily_digest",
      "brief",
    );
    assert.equal(firstSegmentAttempts, 2);
    assert.equal(writerPrompts.length, 5);
    assert.match(
      writerPrompts[1],
      /(?:repair|correct|regeneration feedback)/i,
    );
    assert.match(writerPrompts[1], /source/i);
    assert.equal(generated[0].claims.length, 1);
    assert.equal(generated[0].claims[0].claim, "Repaired claim");
    assert.equal(generated[0].claims[0].sourceNumber, 1);
    assert.doesNotMatch(generated[0].script, /wrong source metadata/i);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("persistently invalid writer claims degrade to an empty claim ledger", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_DIGEST_AUDIT_MODE = "midpoint";
  const sourceCorpus: PodcastSourceCorpus = {
    sources: [
      {
        sourceNumber: 1,
        title: "First source",
        blocks: [
          { id: "source-1-a", kind: "paragraph", text: "First evidence." },
          { id: "source-1-b", kind: "paragraph", text: "Second evidence." },
        ],
      },
      {
        sourceNumber: 2,
        title: "Second source",
        blocks: [
          { id: "source-2-a", kind: "paragraph", text: "Third evidence." },
          { id: "source-2-b", kind: "paragraph", text: "Fourth evidence." },
        ],
      },
    ],
  };
  const plan: SemanticChunkPlan = {
    facts: [],
    segments: ["source-1-a", "source-1-b", "source-2-a", "source-2-b"]
      .map((blockId, index) => ({
        id: `segment-${index + 1}`,
        title: `Chapter ${index + 1}`,
        focus: `Focus ${index + 1}`,
        sourceBlockIds: [blockId],
        factIds: [],
        targetWeight: 0.25,
      })),
  };
  let firstSegmentAttempts = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    if (body.messages[0].content.includes("coverage auditor")) {
      return ndjson({
        coverageDigest: ["First result covered", "Second result covered"],
      });
    }
    const segmentId = body.messages[1].content.match(/Write (segment-\d+)/)?.[1];
    assert.ok(segmentId);
    if (segmentId === "segment-1") firstSegmentAttempts += 1;
    return ndjson({
      segmentId,
      script: writerSizedScript(
        `${segmentId} uses its assigned evidence in a complete sentence`,
      ),
      newCoverage: [`${segmentId} result one`, `${segmentId} result two`],
      coveredFactIds: [],
      claims: segmentId === "segment-1"
        ? [{
            claim: "Claim with persistently invalid provenance",
            support: "Evidence from an unassigned block",
            confidence: 0.8,
            location: segmentId,
            sourceBlockId: "source-2-a",
          }]
        : [],
    });
  }) as typeof fetch;
  try {
    const generated = await generateSemanticSegments(
      sourceCorpus,
      plan,
      "daily_digest",
      "brief",
    );
    assert.equal(firstSegmentAttempts, 2);
    assert.deepEqual(generated[0].claims, []);
    assert.equal(generated[0].claimProvenanceIssueCount, 1);
    assert.equal(generated.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("consolidation evidence includes assigned blocks beyond fact cards", async () => {
  const originalFetch = globalThis.fetch;
  const originalLogLevel = process.env.OLLAMA_PIPELINE_LOG_LEVEL;
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  let consolidationPrompt = "";
  const sourceCorpus = corpus();
  const plan = fallbackSemanticChunkPlan(sourceCorpus, "standard");
  // A deliberately small fact list must not hide later assigned blocks.
  plan.facts = plan.facts.slice(0, 1);
  plan.segments.forEach((entry) => {
    entry.factIds = entry.factIds.filter((id) =>
      plan.facts.some((fact) => fact.id === id)
    );
  });
  const segments = plan.segments.map((entry) => ({
    id: entry.id,
    title: entry.title,
    focus: entry.focus,
    script: "A complete evidence-grounded sentence.",
    newCoverage: ["Coverage one", "Coverage two"],
    coveredFactIds: entry.factIds,
    claims: [],
  }));
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    consolidationPrompt = body.messages[1].content;
    return ndjson({
      segments: segments.map((entry) => ({
        segmentId: entry.id,
        script: entry.script,
        claims: [],
      })),
    });
  }) as typeof fetch;
  try {
    await consolidateSemanticSegments(
      sourceCorpus,
      plan,
      segments,
      { sentences: [], comparedPairCount: 0, threshold: 0.85, pairs: [] },
    );
    assert.match(consolidationPrompt, /evidence number 5/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OLLAMA_PIPELINE_LOG_LEVEL = originalLogLevel;
  }
});

test("semantic planning retries one invalid plan then uses the deterministic fallback", async () => {
  const originalFetch = globalThis.fetch;
  const originalLogLevel = process.env.OLLAMA_PIPELINE_LOG_LEVEL;
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  const prompts: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    prompts.push(body.messages[1].content);
    return ndjson({ facts: [], segments: [] });
  }) as typeof fetch;
  try {
    const plan = await createSemanticChunkPlan(
      corpus(),
      "daily_digest",
      "standard",
    );
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /CORRECT THESE VALIDATION FAILURES/);
    assert.equal(plan.segments.length, 5);
    assert.deepEqual(
      validateSemanticChunkPlan(plan, corpus(), "standard"),
      [],
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OLLAMA_PIPELINE_LOG_LEVEL = originalLogLevel;
  }
});

test("hydrated extraction corpora map ordered blocks and section paths", () => {
  const normalized = toPodcastSourceCorpus({
    schemaVersion: 1,
    totalCharacters: 100,
    truncated: false,
    sources: [{
      schemaVersion: 1,
      contentItemId: "item-hydrated",
      canonicalUrl: "https://example.com/citation",
      retrievalUrl: "https://example.com/full.pdf",
      resolvedUrl: "https://cdn.example.com/full.pdf",
      format: "pdf",
      title: "Hydrated paper",
      blocks: [
        {
          id: "later",
          order: 2,
          kind: "paragraph",
          text: "Second block text.",
          sectionPath: ["Results"],
          page: 2,
        },
        {
          id: "earlier",
          order: 1,
          kind: "heading",
          text: "Results",
          sectionPath: [],
          level: 1,
          page: 1,
        },
      ],
      status: "ready",
      stats: { rawBytes: 200, characters: 100, pages: 2, truncated: false },
      extraction: {
        extractor: "unpdf",
        version: "1",
        fetchedAt: "2026-08-08T00:00:00.000Z",
        warnings: [],
      },
    }],
  });
  assert.equal(normalized.sources[0].sourceNumber, 1);
  assert.deepEqual(
    normalized.sources[0].blocks.map((block) => block.id),
    ["item-hydrated:earlier", "item-hydrated:later"],
  );
  assert.deepEqual(normalized.sources[0].blocks[1].headingPath, ["Results"]);
});

test("Intl sentence records preserve abbreviations, versions, decimals, and indices", () => {
  const records = semanticSentenceRecords([
    segment(
      "segment-1",
      "Welcome to KernelZero. Here is the listener orientation for this episode.",
    ),
    segment(
      "segment-2",
      'Welcome to KernelZero. Dr. Rao tested v1.2.3 against the baseline. It cost 2.50 dollars per request.\n\nBut still. "The measured result held," she said.',
    ),
  ]);
  assert.deepEqual(
    records.map((record) => record.text),
    [
      "Dr. Rao tested v1.2.3 against the baseline.",
      "It cost 2.50 dollars per request.",
      '"The measured result held," she said.',
    ],
  );
  assert.deepEqual(
    records.map((record) => [record.paragraphIndex, record.sentenceIndex]),
    [[0, 1], [0, 2], [1, 1]],
  );
});

test("semantic dedup sends one batched embed request and flags unique pairs without deletion", async () => {
  const originalFetch = globalThis.fetch;
  const originalLogLevel = process.env.OLLAMA_PIPELINE_LOG_LEVEL;
  const originalModel = process.env.OLLAMA_EMBEDDING_MODEL;
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_EMBEDDING_MODEL = "nomic-test";
  const requestBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (input, init) => {
    assert.match(String(input), /\/api\/embed$/);
    requestBodies.push(
      JSON.parse(String(init?.body)) as Record<string, unknown>,
    );
    return Response.json({
      embeddings: [
        [1, 0],
        [0.99, 0.01],
        [0, 1],
      ],
    });
  }) as typeof fetch;

  try {
    assert.ok(
      Math.abs(
        cosineSimilarity([1, 0], [0.85, Math.sqrt(1 - (0.85 ** 2))]) -
          0.85,
      ) < 1e-12,
    );
    const segments = [
      segment("segment-1", "Valkey cut cache memory cost through a tighter eviction policy."),
      segment("segment-2", "A tighter Valkey eviction policy reduced the cache memory bill."),
      segment("segment-3", "The benchmark also measured recovery latency after a regional failure."),
    ];
    const result = await detectSemanticDuplicatePairs(segments, {
      threshold: 0.95,
    });
    const requestBody = requestBodies[0];
    assert.ok(requestBody);
    assert.equal(requestBody.model, "nomic-test");
    assert.equal(requestBody.truncate, false);
    assert.equal((requestBody.input as unknown[]).length, 3);
    assert.equal(result.comparedPairCount, 3);
    assert.equal(result.pairs.length, 1);
    assert.deepEqual(
      [result.pairs[0].earlier.index, result.pairs[0].later.index],
      [0, 1],
    );
    assert.equal(segments[1].script.includes("Valkey"), true);

    globalThis.fetch = (async () => Response.json({ embeddings: [[1, 0]] })) as typeof fetch;
    await assert.rejects(
      detectSemanticDuplicatePairs(segments, { threshold: 0.95 }),
      /1 embeddings for 3 sentences/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OLLAMA_PIPELINE_LOG_LEVEL = originalLogLevel;
    process.env.OLLAMA_EMBEDDING_MODEL = originalModel;
  }
});

test("segment writers run sequentially with digest-only carry-forward and midpoint Mistral audit", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_SCRIPT_MODEL = "redbus-test";
  process.env.OLLAMA_METADATA_MODEL = "mistral-test";
  process.env.OLLAMA_DIGEST_AUDIT_MODE = "midpoint";
  const calls: Array<{ model: string; system: string; user: string }> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    const call = {
      model: body.model,
      system: body.messages[0].content,
      user: body.messages[1].content,
    };
    calls.push(call);
    if (call.system.includes("coverage auditor")) {
      return ndjson({
        coverageDigest: [
          "Segment one covered its assigned operating evidence",
          "Segment two covered its distinct mechanism evidence",
        ],
      });
    }
    const segmentId = call.user.match(/Write (segment-\d+)/)?.[1];
    assert.ok(segmentId);
    const index = Number(segmentId.split("-")[1]);
    const base = index === 1
      ? "Welcome to KernelZero. This episode follows Valkey memory policy, so you'll understand its operating tradeoffs and why they matter.\n\n"
      : "";
    const close = index === 4
      ? `\n\n${KERNELZERO_CLOSING_LINES.join("\n\n")}`
      : "";
    const closingWords = close.trim().split(/\s+/).filter(Boolean).length;
    return ndjson({
      segmentId,
      script: `${writerSizedScript(
        `${base}UniqueTranscriptToken${index} explains assigned evidence with enough concrete words to form a complete spoken sentence`,
        108 - closingWords,
      )}${close}`,
      newCoverage: [
        `Coverage ${index} first distinct point`,
        `Coverage ${index} second distinct point`,
      ],
      coveredFactIds: ["model-invented-fact-id"],
      claims: [],
    });
  }) as typeof fetch;

  try {
    const generated = await generateSemanticSegments(
      corpus(),
      fourSegmentPlan(),
      "daily_digest",
      "brief",
    );
    assert.equal(generated.length, 4);
    assert.ok(
      generated.every((entry) => entry.coveredFactIds.length === 0),
      "unassigned coverage metadata must not trigger retries or manufacture fact coverage",
    );
    assert.deepEqual(
      calls.map((call) => call.model),
      ["redbus-test", "redbus-test", "mistral-test", "redbus-test", "redbus-test"],
    );
    const writerCalls = calls.filter((call) => call.model === "redbus-test");
    assert.ok(writerCalls.every((call) => call.system.includes(NO_WRAP_UP_SEGMENT_RULE)));
    assert.doesNotMatch(writerCalls[1].user, /UniqueTranscriptToken1/);
    assert.doesNotMatch(writerCalls[2].user, /UniqueTranscriptToken2/);
    assert.match(writerCalls[1].user, /Coverage 1 first distinct point/);
    assert.match(writerCalls[2].user, /Segment two covered its distinct mechanism evidence/);
    assert.ok(generated[0].script.startsWith("Welcome to KernelZero."));
    assert.ok(
      generated.at(-1)?.script.endsWith(KERNELZERO_CLOSING_LINES.at(-1)!),
    );

    calls.length = 0;
    process.env.OLLAMA_DIGEST_AUDIT_MODE = "every_segment";
    await generateSemanticSegments(
      corpus(),
      fourSegmentPlan(),
      "daily_digest",
      "brief",
    );
    assert.equal(
      calls.filter((call) => call.system.includes("coverage auditor")).length,
      3,
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("final Mistral metadata retries deterministic alignment and returns a verdict", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_METADATA_MODEL = "mistral-test";
  const requests: string[] = [];
  let attempt = 0;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    assert.equal(body.model, "mistral-test");
    requests.push(body.messages[1].content);
    attempt += 1;
    return ndjson(attempt === 1
      ? {
          title: "Ollama in VS Code",
          dek: "A narrow title unrelated to most of the transcript.",
          anchorPhrase: "AI",
        }
      : {
          title: "Valkey Memory Policy",
          dek: "How Valkey memory policy changes operating cost and recovery behavior.",
          anchorPhrase: "Valkey memory policy",
        });
  }) as typeof fetch;

  const scripts = [
    segment(
      "segment-1",
      "Valkey memory policy changes the economics of a busy cache deployment.",
    ),
    segment(
      "segment-2",
      "The Valkey memory policy also affects recovery behavior under pressure.",
    ),
  ];
  try {
    const result = await createFinalPodcastMetadata(scripts);
    assert.equal(result.attempts, 2);
    assert.equal(result.generationWarning, null);
    assert.equal(result.alignment.valid, true);
    assert.match(requests[1], /CORRECT THESE DETERMINISTIC VALIDATION FAILURES/);
    assert.ok(requests.every((request) => request.includes("FINAL TRANSCRIPT:")));
    assert.equal(
      validateFinalPodcastMetadata(result.metadata, scripts).valid,
      true,
    );

    attempt = 0;
    globalThis.fetch = (async () => {
      attempt += 1;
      return ndjson({
        title: "Ollama in VS Code",
        dek: "A schema-valid but persistently misaligned candidate.",
        anchorPhrase: "AI",
      });
    }) as typeof fetch;
    const warned = await createFinalPodcastMetadata(scripts);
    assert.equal(warned.attempts, 3);
    assert.equal(warned.generationWarning, "title_validation_failed");
    assert.equal(warned.alignment.valid, false);

    attempt = 0;
    globalThis.fetch = (async () => {
      attempt += 1;
      if (attempt > 1) throw new TypeError("fetch failed");
      return ndjson({
        title: "Ollama in VS Code",
        dek: "The latest schema-valid candidate survives a later transport outage.",
        anchorPhrase: "AI",
      });
    }) as typeof fetch;
    const warnedAfterTransportFailure = await createFinalPodcastMetadata(scripts);
    assert.equal(warnedAfterTransportFailure.metadata.title, "Ollama in VS Code");
    assert.equal(
      warnedAfterTransportFailure.generationWarning,
      "title_validation_failed",
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});

test("semantic pipeline generates metadata only after final consolidation and validation", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  process.env.OLLAMA_SCRIPT_MODEL = "redbus-test";
  process.env.OLLAMA_CONSOLIDATION_MODEL = "redbus-test";
  process.env.OLLAMA_REVIEW_MODEL = "safeguard-test";
  process.env.OLLAMA_METADATA_MODEL = "mistral-test";
  process.env.OLLAMA_EMBEDDING_MODEL = "nomic-test";
  process.env.OLLAMA_DIGEST_AUDIT_MODE = "midpoint";
  const events: string[] = [];
  const draftedScripts = new Map<string, string>();
  const draftedClaims = new Map<string, Array<Record<string, unknown>>>();
  const filler = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");

  globalThis.fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      input?: string[];
      messages?: Array<{ content: string }>;
    };
    if (String(input).endsWith("/api/embed")) {
      events.push("embed");
      const inputs = body.input ?? [];
      return Response.json({
        embeddings: inputs.map((_, row) =>
          Array.from({ length: inputs.length }, (__, column) =>
            row === column ? 1 : 0
          )
        ),
      });
    }
    const system = body.messages?.[0]?.content ?? "";
    const user = body.messages?.[1]?.content ?? "";
    if (system.includes("planning editor")) {
      events.push("plan");
      return ndjson(fourSegmentPlan());
    }
    if (system.includes("coverage auditor")) {
      events.push("digest");
      return ndjson({
        coverageDigest: [
          "Valkey memory policy changes operating cost",
          "Eviction mechanics shape recovery behavior",
        ],
      });
    }
    if (system.includes("write exactly one segment")) {
      const segmentId = user.match(/Write (segment-\d+)/)?.[1];
      assert.ok(segmentId);
      const index = Number(segmentId.split("-")[1]);
      events.push(segmentId);
      const script = index === 1
        ? `Welcome to KernelZero. This episode follows Valkey memory policy, so you'll understand how eviction changes operating cost and why that matters.\n\n${filler("opening", 80)}.`
        : index === 2
          ? `Valkey memory policy changes recovery behavior under pressure. ${filler("mechanism", 92)}.`
          : index === 3
            ? `${filler("evidence", 100)}. This podcast was generated by AI.`
            : `${filler("impact", 75)}.\n\n${KERNELZERO_CLOSING_LINES.join("\n\n")}`;
      draftedScripts.set(segmentId, script);
      const claims = index === 1
        ? [{
            claim: "Valkey memory policy changes cache operating cost.",
            support: "Valkey memory policy evidence explains an operational result.",
            confidence: 0.9,
            location: segmentId,
            sourceNumber: 1,
          }]
        : [];
      draftedClaims.set(segmentId, claims);
      return ndjson({
        segmentId,
        script,
        newCoverage: [
          `Segment ${index} first covered idea`,
          `Segment ${index} second covered idea`,
        ],
        coveredFactIds: [],
        claims,
      });
    }
    if (system.includes("consolidation editor")) {
      events.push("consolidate");
      return ndjson({
        segments: [...draftedScripts].map(([segmentId, script]) => ({
          segmentId,
          script,
          claims: draftedClaims.get(segmentId) ?? [],
        })),
      });
    }
    if (system.includes("read-only policy and evidence critic")) {
      events.push("safeguard");
      return ndjson({ issues: [] });
    }
    if (system.includes("metadata editor")) {
      events.push("metadata");
      return ndjson({
        title: "Valkey Memory Policy",
        dek: "How Valkey memory policy changes operating cost and recovery behavior.",
        anchorPhrase: "Valkey memory policy",
      });
    }
    throw new Error(`Unexpected semantic request: ${system.slice(0, 80)}`);
  }) as typeof fetch;

  try {
    const draft = await createSemanticPodcast(
      corpus(),
      "daily_digest",
      "brief",
    );
    assert.equal(draft.generationWarning, null);
    assert.equal(draft.segments.length, 4);
    assert.equal(draft.chapters.length, 4);
    assert.equal(draft.chapters[0].scriptStart, 0);
    assert.equal(draft.claims[0].sourceNumber, 1);
    assert.doesNotMatch(draft.script, /generated by AI/i);
    assert.equal(events.filter((event) => event === "consolidate").length, 1);
    assert.equal(events.filter((event) => event === "safeguard").length, 1);
    assert.equal(events.filter((event) => event === "embed").length, 2);
    assert.equal(events.at(-1), "metadata");
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
});
