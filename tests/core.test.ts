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
import { prepareForChatterbox } from "../lib/narration-text.ts";
import { chunkForSpeech, generatePodcast } from "../lib/openai.ts";
import {
  countScriptWords,
  episodeLengthInstruction,
  estimateScriptDurationSeconds,
  scriptMatchesEpisodeLength,
} from "../lib/podcast-length.ts";
import { podcastSourcePacket } from "../lib/podcast-source.ts";
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

test("speech chunking also bounds a single overlong sentence", () => {
  const source = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
  const chunks = chunkForSpeech(source, 60);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 60));
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), source);
});

test("standard episode length is enforced as a complete nine-minute script", () => {
  const instruction = episodeLengthInstruction("daily_digest", "standard");
  const validScript = Array.from({ length: 1_350 }, () => "word").join(" ");
  assert.match(instruction, /9-minute/);
  assert.match(instruction, /1,215–1,485 words/);
  assert.equal(countScriptWords(validScript), 1_350);
  assert.equal(scriptMatchesEpisodeLength(validScript, "standard"), true);
  assert.equal(estimateScriptDurationSeconds(validScript), 540);
  assert.equal(scriptMatchesEpisodeLength("Only an introduction.", "standard"), false);
});

test("podcast source packets reserve context for long-form output", () => {
  const items = Array.from({ length: 5 }, (_, index) =>
    item({
      id: `source-${index}`,
      summary: `Source ${index}. ${"evidence ".repeat(8_000)}`,
    }),
  );
  const packet = podcastSourcePacket(items);
  const totalSourceCharacters = packet.reduce(
    (total, source) => total + source.abstractOrFeedText.length,
    0,
  );
  assert.ok(totalSourceCharacters < 19_000);
  assert.ok(packet.every((source) => source.sourceTextTruncated));
});

test("narration cleanup removes markup and repairs unfinished punctuation", () => {
  assert.equal(
    prepareForChatterbox("## AI update\nRead [the paper](https://example.com) [source 2],"),
    "A I update Read the paper.",
  );
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

test("generation rewrites an intro-sized response before creating an episode", async () => {
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.AI_PROVIDER;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalSkipVerification = process.env.SKIP_EVIDENCE_VERIFICATION;
  const requests: RequestInit[] = [];
  const packageFor = (script: string) => ({
    title: "Length checked",
    dek: "A complete briefing.",
    script,
    showNotes: "Source: https://example.com/paper",
    chapters: [{ title: "Opening", startSeconds: 0 }],
    claims: [{
      claim: "A quantization method supports faster inference.",
      support: "A quantization method for faster inference.",
      confidence: 0.9,
      location: "Abstract",
    }],
  });
  const responses = [
    packageFor("This response contains only a short introduction."),
    packageFor(Array.from({ length: 1_350 }, () => "word").join(" ")),
  ];

  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.SKIP_EVIDENCE_VERIFICATION = "true";
  globalThis.fetch = (async (_input, init) => {
    requests.push(init ?? {});
    const response = responses.shift();
    assert.notEqual(response, undefined);
    return new Response(JSON.stringify({ output_text: JSON.stringify(response) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const generated = await generatePodcast([item()], "daily_digest", {
      includeAudio: false,
      episodeLength: "standard",
    });
    assert.equal(countScriptWords(generated.episode.script), 1_350);
    assert.equal(generated.episode.durationSeconds, 540);
    assert.equal(requests.length, 2);
    const resizeBody = JSON.parse(String(requests[1].body)) as {
      input: Array<{ content: Array<{ text: string }> }>;
    };
    assert.match(resizeBody.input[1].content[0].text, /requiredWordRange/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalSkipVerification === undefined) delete process.env.SKIP_EVIDENCE_VERIFICATION;
    else process.env.SKIP_EVIDENCE_VERIFICATION = originalSkipVerification;
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
      `LLMs are broadly capable, while large models require substantial compute and inference has cost and latency trade-offs. ${Array.from({ length: 1_240 }, () => "context").join(" ")}`,
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
