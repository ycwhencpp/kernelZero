import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTechRadar,
  canonicalIdentifier,
  deduplicateItems,
  escapeXml,
  hasBudgetForGeneration,
  scoreCandidate,
  selectDigestItems,
} from "../lib/domain.ts";
import {
  aiProviderLabel,
  estimatedGenerationCostUsd,
  resolveAiProvider,
} from "../lib/ai-config.ts";
import { chunkForSpeech, generatePodcast } from "../lib/openai.ts";
import { parseFeed } from "../lib/rss.ts";
import type { ContentItem, InterestProfile, NormalizedCandidate } from "../lib/types.ts";

const interest: InterestProfile = {
  id: "i1",
  name: "Efficient models",
  query: "efficient language model inference quantization",
  keywords: ["inference", "quantization"],
  exclusions: ["marketing"],
  preferredSources: [],
  freshnessDays: 30,
  weight: 1,
  enabled: true,
};

const baseCandidate: NormalizedCandidate = {
  id: "candidate",
  kind: "paper",
  title: "Efficient language model inference",
  summary: "A quantization method for faster inference.",
  authors: ["A. Researcher"],
  sourceName: "Test journal",
  canonicalUrl: "https://example.com/paper",
  doi: "10.1000/test",
  publishedAt: "2026-07-01T00:00:00Z",
  accessLevel: "open_access",
  peerReviewState: "peer_reviewed",
  topics: ["Quantization"],
  citationCount: 35,
  readingMinutes: 20,
  sourceAuthority: 0.9,
};

function item(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    ...scoreCandidate(baseCandidate, [interest], {
      now: new Date("2026-07-25T00:00:00Z"),
    }),
    ...overrides,
  };
}

test("canonical identity prefers DOI and normalizes it", () => {
  assert.equal(
    canonicalIdentifier({
      doi: "https://doi.org/10.1000/Test",
      canonicalUrl: "https://example.com",
      title: "Test",
    }),
    "doi:10.1000/test",
  );
});

test("deduplicates DOI and normalized-title copies", () => {
  const first = item({ id: "one", score: 80 });
  const duplicate = item({
    id: "two",
    score: 92,
    canonicalUrl: "https://mirror.example.com/test",
  });
  const result = deduplicateItems([first, duplicate]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "two");
});

test("ranking rewards relevant, trusted and fresh material", () => {
  const scored = scoreCandidate(baseCandidate, [interest], {
    now: new Date("2026-07-25T00:00:00Z"),
    citationVelocity: 0.8,
    novelty: 0.9,
  });
  assert.ok(scored.score >= 75);
  assert.equal(scored.trend, "rising");
});

test("exclusion terms zero lexical relevance", () => {
  const scored = scoreCandidate(
    { ...baseCandidate, title: "Marketing guide to efficient inference" },
    [interest],
    { now: new Date("2026-07-25T00:00:00Z") },
  );
  assert.ok(scored.score < 65);
});

test("digest selection limits repeated sources and topics", () => {
  const candidates = [
    item({ id: "a", sourceName: "One", score: 99, topics: ["Agents"] }),
    item({ id: "b", sourceName: "One", score: 98, topics: ["Agents"] }),
    item({ id: "c", sourceName: "One", score: 97, topics: ["Agents"] }),
    item({ id: "d", sourceName: "Two", score: 96, topics: ["Systems"] }),
  ];
  const selected = selectDigestItems(candidates, 4);
  assert.deepEqual(selected.map((candidate) => candidate.id), ["a", "b", "d"]);
});

test("parses RSS items without retaining markup", () => {
  const parsed = parseFeed(
    `<?xml version="1.0"?><rss><channel><title>Trusted Lab</title>
      <item><title><![CDATA[Agents &amp; evaluation]]></title>
      <link>https://example.com/agents</link>
      <description><![CDATA[<p>A practical evaluation guide.</p>]]></description>
      <pubDate>Fri, 24 Jul 2026 05:00:00 GMT</pubDate></item>
    </channel></rss>`,
    "https://example.com/feed.xml",
  );
  assert.equal(parsed.title, "Trusted Lab");
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].title, "Agents & evaluation");
  assert.equal(parsed.items[0].summary, "A practical evaluation guide.");
});

test("rejects malformed non-feed input", () => {
  assert.throws(
    () => parseFeed("<html>not a feed</html>", "https://example.com"),
    /recognizable RSS or Atom/,
  );
});

test("speech chunking preserves all paragraphs under the limit", () => {
  const source = Array.from({ length: 20 }, (_, index) =>
    `Paragraph ${index}. This is a complete sentence for narration.`,
  ).join("\n\n");
  const chunks = chunkForSpeech(source, 180);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 180));
  assert.match(chunks.join("\n"), /Paragraph 19/);
});

test("escapes feed XML values", () => {
  assert.equal(escapeXml(`A & B < "C"`), "A &amp; B &lt; &quot;C&quot;");
});

test("daily budget gate permits free work and rejects overspend", () => {
  assert.equal(hasBudgetForGeneration(1.8, 2, 0.16), true);
  assert.equal(hasBudgetForGeneration(1.9, 2, 0.16), false);
  assert.equal(hasBudgetForGeneration(2, 2, 0), true);
});

test("local Ollama provider is key-free and has no API spend", () => {
  const originalProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "ollama";
  try {
    assert.equal(resolveAiProvider(), "ollama");
    assert.equal(aiProviderLabel("ollama"), "Local Ollama");
    assert.equal(estimatedGenerationCostUsd("ollama", true), 0);
  } finally {
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
  }
});

test("tech radar requires corroboration and rewards cross-source momentum", () => {
  const radar = buildTechRadar(
    [
      item({
        id: "radar-a",
        sourceName: "Research API",
        topics: ["Agent observability"],
        publishedAt: "2026-07-20T00:00:00Z",
      }),
      item({
        id: "radar-b",
        kind: "blog",
        sourceName: "Trusted feed",
        topics: ["Agent observability"],
        publishedAt: "2026-07-18T00:00:00Z",
      }),
      item({
        id: "radar-c",
        sourceName: "Only one source",
        topics: ["Uncorroborated"],
        publishedAt: "2026-07-19T00:00:00Z",
      }),
    ],
    new Date("2026-07-25T00:00:00Z"),
  );
  assert.equal(radar.length, 1);
  assert.equal(radar[0].name, "Agent observability");
  assert.equal(radar[0].itemCount, 2);
  assert.ok(radar[0].confidence >= 75);
});

test("evidence verification allows generic context and retries a failed repair", async () => {
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.AI_PROVIDER;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const requests: RequestInit[] = [];
  const draft = (title: string) => ({
    title,
    dek: "A grounded briefing.",
    script:
      "LLMs are broadly capable, while large models require substantial compute and inference has cost and latency trade-offs.",
    showNotes: "Source: https://example.com/paper",
    chapters: [{ title: "Background", startSeconds: 0 }],
    claims: [
      {
        claim: "A quantization method supports faster inference.",
        support: "A quantization method for faster inference.",
        confidence: 0.9,
        location: "Abstract",
      },
    ],
  });
  const responseTexts = [
    JSON.stringify(draft("Initial draft")),
    "FAIL\n- Invented paper-specific result.",
    JSON.stringify(draft("First repair")),
    "FAIL\n- A second invented paper-specific result.",
    JSON.stringify(draft("Second repair")),
    "PASS",
  ];

  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  globalThis.fetch = (async (_input, init) => {
    requests.push(init ?? {});
    const outputText = responseTexts.shift();
    assert.notEqual(outputText, undefined);
    return new Response(JSON.stringify({ output_text: outputText }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const generated = await generatePodcast([item()], "daily_digest");
    assert.equal(generated.episode.title, "Second repair");
    assert.equal(requests.length, 6);

    const verifierBody = JSON.parse(String(requests[1].body)) as {
      input: Array<{ content: Array<{ text: string }> }>;
    };
    const verifierPrompt = verifierBody.input[0].content[0].text;
    assert.match(verifierPrompt, /generic qualitative background/);
    assert.match(verifierPrompt, /LLMs are broadly capable/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  }
});
