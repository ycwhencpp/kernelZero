import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTechRadar,
  canonicalIdentifier,
  deduplicateItems,
  escapeXml,
  formatDuration,
  hasBudgetForGeneration,
  scoreCandidate,
  selectDigestItems,
} from "../lib/domain.ts";
import {
  aiProviderLabel,
  estimatedGenerationCostUsd,
  resolveAiProvider,
} from "../lib/ai-config.ts";
import {
  naturalNarrationTempo,
  prepareChatterboxSegments,
  prepareForChatterbox,
  prepareForMacSpeech,
} from "../lib/narration-text.ts";
import { parseModelJson } from "../lib/model-json.ts";
import { parseMediaByteRange } from "../lib/media-range.ts";
import { clampPlaybackSeconds } from "../lib/playback.ts";
import {
  hasUsableAudioUrl,
  reconcileGeneratedEpisode,
  requireGeneratedAudio,
} from "../lib/generated-episode.ts";
import {
  createStructuredPodcast as createOllamaPodcast,
  isActionableEvidenceIssue,
  isActionableRepetitionIssue,
  mapWithConcurrency,
  normalizePodcastPlan,
  planSectionExpansions,
} from "../lib/ollama.ts";
import { chunkForSpeech, generatePodcast } from "../lib/openai.ts";
import {
  countScriptWords,
  episodeLengthInstruction,
  estimateScriptDurationSeconds,
  scriptMatchesEpisodeLength,
} from "../lib/podcast-length.ts";
import {
  buildRegenerateEpisodeRequest,
  parsePodcastRegenerationContext,
} from "../lib/podcast-regeneration.ts";
import {
  geminiPodcastSpeechPrompt,
  openAiSpeechModelSupportsInstructions,
  PODCAST_AUDIO_DELIVERY_INSTRUCTION,
  PODCAST_HOST_STYLE_INSTRUCTION,
  withPodcastHostStyle,
} from "../lib/podcast-style.ts";
import { normalizeEvidenceConfidence } from "../lib/podcast-schema.ts";
import { podcastSourcePacket } from "../lib/podcast-source.ts";
import { parseFeed } from "../lib/rss.ts";
import {
  findRepeatedParagraphs,
  removeClosestRepeatedSentence,
  removeRepeatedSentencesAgainstReference,
} from "../lib/script-repetition.ts";
import { splitNarrationSentences } from "../lib/sentence-segmentation.ts";
import { storedDurationSeconds } from "../lib/store.ts";
import type {
  ContentItem,
  Episode,
  InterestProfile,
  NormalizedCandidate,
} from "../lib/types.ts";

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

test("parses media byte ranges used for audio seeking", () => {
  assert.deepEqual(parseMediaByteRange("bytes=100-199", 1_000), {
    start: 100,
    end: 199,
    length: 100,
  });
  assert.deepEqual(parseMediaByteRange("bytes=900-", 1_000), {
    start: 900,
    end: 999,
    length: 100,
  });
  assert.deepEqual(parseMediaByteRange("bytes=-125", 1_000), {
    start: 875,
    end: 999,
    length: 125,
  });
  assert.equal(parseMediaByteRange("bytes=1000-", 1_000), null);
  assert.equal(parseMediaByteRange("bytes=0-10,20-30", 1_000), null);
});

test("playback positions stay within the encoded duration", () => {
  assert.equal(clampPlaybackSeconds(-10, 100), 0);
  assert.equal(clampPlaybackSeconds(140, 100), 100);
});

test("audio durations display whole zero-padded minutes and seconds", () => {
  assert.equal(formatDuration(486.0400000000000205), "8:06");
  assert.equal(formatDuration(6), "0:06");
  assert.equal(formatDuration(65.999), "1:05");
  assert.equal(formatDuration(60), "1:00");
  assert.equal(formatDuration(3_600), "60:00");
  assert.equal(formatDuration(-4), "0:00");
  assert.equal(formatDuration(Number.NaN), "0:00");
  assert.equal(formatDuration(Number.POSITIVE_INFINITY), "0:00");
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

test("sentence processing preserves decimal values and model versions", () => {
  assert.deepEqual(
    splitNarrationSentences(
      "GPT-5.5 achieved 120 successes. GPT-5.4 solved 54 tasks. Version 3.14 remained stable.",
    ),
    [
      "GPT-5.5 achieved 120 successes.",
      "GPT-5.4 solved 54 tasks.",
      "Version 3.14 remained stable.",
    ],
  );
  assert.equal(
    chunkForSpeech(
      "GPT-5.5 achieved 120 successes. GPT-5.4 solved 54 tasks.",
      500,
    ).join(" "),
    "GPT-5.5 achieved 120 successes. GPT-5.4 solved 54 tasks.",
  );
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

test("repetition audit allows framing continuity but blocks repeated concrete facts", () => {
  assert.equal(
    isActionableRepetitionIssue(
      {
        earlierSection: 1,
        laterSection: 2,
        rewriteSection: 1,
        repeatedIdea:
          "The opening introduces AI security and software reliability, while the background returns to those themes.",
      },
      7,
    ),
    false,
  );
  assert.equal(
    isActionableRepetitionIssue(
      {
        earlierSection: 1,
        laterSection: 2,
        rewriteSection: 1,
        repeatedIdea:
          "Both sections explain that the benchmark contains 898 real-world vulnerability cases.",
      },
      7,
    ),
    true,
  );
  assert.equal(
    isActionableRepetitionIssue(
      {
        earlierSection: 1,
        laterSection: 7,
        rewriteSection: 7,
        repeatedIdea:
          "The conclusion briefly returns to the opening theme of safer and more trustworthy AI systems.",
      },
      7,
    ),
    false,
  );
  assert.equal(
    isActionableRepetitionIssue(
      {
        earlierSection: 3,
        laterSection: 5,
        rewriteSection: 5,
        repeatedIdea:
          "Both sections explain the same sandbox escape mechanism using different words.",
      },
      7,
    ),
    true,
  );
});

test("final repetition guard catches copied and near-copied paragraphs", () => {
  const base = Array.from(
    { length: 45 },
    (_, index) => `distinctivetoken${index}`,
  ).join(" ");
  const script = [
    base,
    "A genuinely different paragraph about publication limits and missing evidence.",
    `${base} one additional closing thought`,
  ].join("\n\n");
  const issues = findRepeatedParagraphs(script);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].earlierParagraph, 1);
  assert.equal(issues[0].laterParagraph, 3);
  assert.ok(issues[0].containment > 0.95);
});

test("semantic repetition fallback removes only the closest flagged sentence", () => {
  const script = [
    "The system first turns each request into a structured layout.",
    "Using one generative model for layout construction and content generation simplifies management.",
    "The renderer then validates the completed representation before delivery.",
  ].join(" ");
  const pruned = removeClosestRepeatedSentence(
    script,
    "The use of a single generative model for layout construction and content generation simplifies management.",
  );
  assert.equal(
    pruned,
    "The system first turns each request into a structured layout. The renderer then validates the completed representation before delivery.",
  );
  assert.equal(
    removeClosestRepeatedSentence(
      script,
      "A separate benchmark reports a large accuracy improvement.",
    ),
    null,
  );
});

test("cross-section dedup removes a repeated paragraph without a model rewrite", () => {
  const repeated = [
    "The sandbox breach exposed a concrete security risk in the generated exploit.",
    "Performance also varied across repeated exploit-generation attempts.",
  ].join(" ");
  const target = [
    "The limitations require a cautious interpretation.",
    repeated,
    "Independent replication would clarify how consistently the behavior appears.",
  ].join(" ");
  assert.equal(
    removeRepeatedSentencesAgainstReference(target, repeated),
    "The limitations require a cautious interpretation. Independent replication would clarify how consistently the behavior appears.",
  );
  assert.equal(
    removeRepeatedSentencesAgainstReference(
      target,
      "A separate paper studies compiler optimization.",
    ),
    null,
  );
});

test("cross-section dedup never inserts spaces into model versions", () => {
  assert.equal(
    removeRepeatedSentencesAgainstReference(
      "GPT-5.5 achieved 120 successes. This result was already explained. A distinct conclusion remains.",
      "This result was already explained.",
    ),
    "GPT-5.5 achieved 120 successes. A distinct conclusion remains.",
  );
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

test("draft regeneration payload preserves the current topic, text, and sources", () => {
  const first = item({
    id: "source-a",
    canonicalUrl: "https://example.com/source-a",
  });
  const second = item({
    id: "source-b",
    canonicalUrl: "https://example.com/source-b",
  });
  const unrelated = item({
    id: "source-new",
    canonicalUrl: "https://example.com/new-top-story",
    score: 100,
  });
  const topic =
    "OpenAI’s Cyberattack Against Hugging Face: Science Fiction That Became Reality";
  const currentDraft = "Sentinel current draft text with an unsaved correction.";
  const episode: Episode = {
    id: "episode-current",
    type: "daily_digest",
    title: topic,
    dek: "The current dek.",
    script: "The persisted draft.",
    showNotes: "Current notes.",
    transcript: "The persisted draft.",
    citations: [
      { label: "1", title: second.title, url: second.canonicalUrl },
      { label: "2", title: first.title, url: first.canonicalUrl },
    ],
    chapters: [{ title: "Opening", startSeconds: 0 }],
    audioUrl: null,
    durationSeconds: 180,
    status: "needs_approval",
    publishedAt: null,
    immutableGuid: "signalcast:episode-current",
    generation: 3,
    createdAt: "2026-07-28T00:00:00.000Z",
  };

  const payload = buildRegenerateEpisodeRequest(
    {
      items: [unrelated, first, second],
      evidence: [
        {
          id: "claim-a",
          episodeId: episode.id,
          contentItemId: first.id,
          claim: "A supported claim.",
          support: "Source support.",
          sourceUrl: first.canonicalUrl,
          confidence: 0.9,
          location: "Summary",
        },
      ],
      settings: {
        dailyGeneration: true,
        episodeLength: "standard",
        publishTime: "08:00",
      },
    },
    episode,
    currentDraft,
  );

  assert.deepEqual(payload, {
    type: "daily_digest",
    itemIds: ["source-b", "source-a"],
    includeAudio: true,
    episodeLength: "standard",
    episodeId: "episode-current",
    topic,
    currentDraft,
  });
  assert.throws(
    () =>
      parsePodcastRegenerationContext({
        episodeId: episode.id,
        topic,
        currentDraft: " ",
      }),
    /requires episodeId, topic, and currentDraft/,
  );
});

test("generated audio duration is normalized for integer database storage", () => {
  assert.equal(storedDurationSeconds(488.007208), 488);
  assert.equal(storedDurationSeconds(-0.7), 0);
  assert.equal(storedDurationSeconds(Number.NaN), 0);
});

test("generation response keeps returned audio when refreshed state is stale", () => {
  const staleEpisode: Episode = {
    id: "episode-regenerated",
    type: "daily_digest",
    title: "Regenerated briefing",
    dek: "A regenerated briefing.",
    script: "The regenerated script.",
    showNotes: "Source notes.",
    transcript: "The regenerated script.",
    citations: [],
    chapters: [{ title: "Opening", startSeconds: 0 }],
    audioUrl: null,
    durationSeconds: 488,
    status: "needs_approval",
    publishedAt: null,
    immutableGuid: "signalcast:episode-regenerated",
    generation: 2,
    createdAt: "2026-07-28T00:00:00.000Z",
  };
  const returnedEpisode: Episode = {
    ...staleEpisode,
    audioUrl: "/api/media/episodes%2Fepisode-regenerated.mp3",
    audioKey: "episodes/episode-regenerated.mp3",
    audioBytes: 7_809_452,
  };

  const generated = reconcileGeneratedEpisode(
    { episodes: [staleEpisode] },
    returnedEpisode,
  );

  assert.equal(generated.episode.audioUrl, returnedEpisode.audioUrl);
  assert.equal(generated.state.episodes[0].audioUrl, returnedEpisode.audioUrl);
  assert.equal(hasUsableAudioUrl(returnedEpisode.audioUrl), true);
  assert.doesNotThrow(() => requireGeneratedAudio(generated.episode, true));
  assert.throws(
    () => requireGeneratedAudio(staleEpisode, true),
    /no stored audio URL/,
  );
});

test("narration cleanup removes markup and repairs unfinished punctuation", () => {
  assert.equal(
    prepareForChatterbox("## AI update\nRead [the paper](https://example.com) [source 2],"),
    "A I update Read the paper.",
  );
  assert.equal(
    prepareForChatterbox(
      'Hello [brief pause]. <break time="500ms"/> [sadly] Bad news.\n\nGood news.',
    ),
    "Hello. Bad news.\n\nGood news.",
  );
  assert.equal(
    prepareForChatterbox(
      "Error stayed <5 percent, while baseline was >10 percent. [Hugging Face] investigated.",
    ),
    "Error stayed <5 percent, while baseline was >10 percent. Hugging Face investigated.",
  );
});

test("Chatterbox performance plans use native cues and contextual pauses", () => {
  const segments = prepareChatterboxSegments(
    "Here's the twist: the breach succeeded.\n\nPeople died in the attack.",
  );

  assert.equal(segments.length, 2);
  assert.match(segments[0].text, /^\[surprised\] /);
  assert.doesNotMatch(segments.map((segment) => segment.text).join(" "), /\[(?:sadly|crying|brief pause)\]/);
  assert.ok(segments[1].pauseAfterMs > segments[0].pauseAfterMs);
  assert.ok(segments.every((segment) => segment.text.length <= 260));

  const negated = prepareChatterboxSegments(
    "It was not surprising. There was no good news. The breakthrough never happened.",
  );
  assert.doesNotMatch(
    negated.map((segment) => segment.text).join(" "),
    /\[(?:happy|surprised)\]/,
  );
});

test("macOS narration and duration correction preserve natural pacing", () => {
  assert.equal(
    prepareForMacSpeech(
      "People died in the attack.\n\nThe investigation continued.",
    ),
    "People died in the attack. [[slnc 780]] The investigation continued.",
  );
  assert.equal(naturalNarrationTempo(600, 480), 1.08);
  assert.equal(naturalNarrationTempo(400, 480), 0.92);
  assert.equal(naturalNarrationTempo(487, 480), null);
});

test("shared podcast prompts require a human male host and clean transcripts", () => {
  assert.match(PODCAST_HOST_STYLE_INSTRUCTION, /adult male podcast host/);
  assert.match(PODCAST_HOST_STYLE_INSTRUCTION, /Never include stage directions/);
  assert.match(PODCAST_AUDIO_DELIVERY_INSTRUCTION, /subtle lift in energy/);
  assert.match(
    withPodcastHostStyle("Base instruction."),
    /Base instruction\.[\s\S]*adult male podcast host/,
  );
  assert.match(
    geminiPodcastSpeechPrompt("This is the transcript."),
    /close-mic adult male podcast host[\s\S]*TRANSCRIPT:\nThis is the transcript\./,
  );
  assert.equal(openAiSpeechModelSupportsInstructions("gpt-4o-mini-tts"), true);
  assert.equal(
    openAiSpeechModelSupportsInstructions("gpt-4o-mini-tts-2025-03-20"),
    true,
  );
  assert.equal(openAiSpeechModelSupportsInstructions("tts-1-hd"), false);
});

test("escapes feed XML values", () => {
  assert.equal(escapeXml(`A & B < "C"`), "A &amp; B &lt; &quot;C&quot;");
});

test("model JSON parser accepts fenced JSON responses", () => {
  assert.deepEqual(
    parseModelJson<{ title: string; claims: number[] }>(`\
\`\`\`json
{"title":"Grounded draft","claims":[1,2]}
\`\`\`
`),
    { title: "Grounded draft", claims: [1, 2] },
  );
});

test("model JSON parser extracts JSON from extra provider chatter", () => {
  assert.deepEqual(
    parseModelJson<{ ok: boolean }>("Here is the repaired JSON:\n{\"ok\":true}\nLet me know if you want changes."),
    { ok: true },
  );
});

test("daily budget gate permits free work and rejects overspend", () => {
  assert.equal(hasBudgetForGeneration(1.8, 2, 0.16), true);
  assert.equal(hasBudgetForGeneration(1.9, 2, 0.16), false);
  assert.equal(hasBudgetForGeneration(2, 2, 0), true);
});

test("evidence confidence accepts fractions and percentages but rejects overflow", () => {
  assert.equal(normalizeEvidenceConfidence(0.87), 0.87);
  assert.equal(normalizeEvidenceConfidence(87), 0.87);
  assert.equal(normalizeEvidenceConfidence(350_871_806_470_679), 0);
  assert.equal(normalizeEvidenceConfidence("invalid"), 0);
});

test("local Ollama provider is key-free and has no API spend", () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  process.env.AI_PROVIDER = "ollama";
  process.env.OPENAI_API_KEY = "unused-openai-key";
  process.env.GEMINI_API_KEY = "unused-gemini-key";
  try {
    assert.equal(resolveAiProvider(), "ollama");
    assert.equal(aiProviderLabel("ollama"), "Local Ollama");
    assert.equal(estimatedGenerationCostUsd("ollama", true), 0);
  } finally {
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});

test("an invalid provider value fails closed instead of selecting a cloud key", () => {
  const originalProvider = process.env.AI_PROVIDER;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalGeminiKey = process.env.GEMINI_API_KEY;
  process.env.AI_PROVIDER = "ollmaa";
  process.env.OPENAI_API_KEY = "unused-openai-key";
  process.env.GEMINI_API_KEY = "unused-gemini-key";
  try {
    assert.equal(resolveAiProvider(), null);
  } finally {
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalGeminiKey;
  }
});

test("Ollama evidence review ignores source-backed model-name non-issues", () => {
  const source = item({
    title:
      "OpenAI’s accidental cyberattack against Hugging Face is science fiction that happened",
    summary:
      "Across all configurations, Claude Mythos Preview and GPT-5.5 achieve the highest success counts.",
  });
  const section =
    "Claude Mythos Preview and GPT-5.5 achieved the highest success counts in the supplied comparison.";
  const baseIssue = {
    sectionNumber: 4,
    problem:
      "The podcast mentions 'GPT-5.5' and 'Claude Mythos Preview'. The source text refers to both exact model names.",
    instruction: "Use only model names that appear in the source.",
  };

  assert.equal(
    isActionableEvidenceIssue(
      {
        ...baseIssue,
        kind: "entity_name",
        unsupportedDetail: "GPT-5.5 and Claude Mythos Preview",
      },
      [source],
      section,
    ),
    false,
  );
  assert.equal(
    isActionableEvidenceIssue(
      {
        ...baseIssue,
        kind: "entity_name",
        unsupportedDetail: "GPT-6",
      },
      [source],
      "GPT-6 achieved the highest success count.",
    ),
    true,
  );
  assert.equal(
    isActionableEvidenceIssue(
      {
        ...baseIssue,
        kind: "method_result",
        unsupportedDetail: "defeated every safeguard",
      },
      [source],
      "GPT-5.5 defeated every safeguard.",
    ),
    true,
  );
  assert.equal(
    isActionableEvidenceIssue(
      {
        ...baseIssue,
        kind: "entity_name",
        unsupportedDetail: "GPT-5.5 defeated every safeguard",
      },
      [source],
      "GPT-5.5 defeated every safeguard.",
    ),
    true,
  );
});

test("Ollama connection failures identify the local service", async () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  try {
    await assert.rejects(
      createOllamaPodcast([item()], "daily_digest", "standard"),
      /Unable to connect to Ollama at http:\/\/127\.0\.0\.1:11434.*ollama serve/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = originalBaseUrl;
  }
});

test("Ollama streaming progress replaces the first-token timeout with an idle timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalFirstTokenTimeout = process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS;
  const originalIdleTimeout = process.env.OLLAMA_IDLE_TIMEOUT_MS;
  process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS = "20";
  process.env.OLLAMA_IDLE_TIMEOUT_MS = "100";
  let requestCount = 0;

  globalThis.fetch = (async () => {
    requestCount += 1;
    if (requestCount > 1) throw new Error("Planner stream completed.");

    const content = JSON.stringify({
      title: "Progress-aware timeout",
      dek: "A slow stream can still be healthy.",
      facts: [],
      sections: [],
    });
    const line = `${JSON.stringify({
      message: { content },
      done: true,
      done_reason: "stop",
    })}\n`;
    const splitAt = Math.floor(line.length / 2);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          setTimeout(
            () => controller.enqueue(encoder.encode(line.slice(0, splitAt))),
            5,
          );
          setTimeout(() => {
            controller.enqueue(encoder.encode(line.slice(splitAt)));
            controller.close();
          }, 35);
        },
      }),
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      createOllamaPodcast([item()], "daily_digest", "standard"),
      /Planner stream completed/,
    );
    assert.ok(requestCount >= 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFirstTokenTimeout === undefined) {
      delete process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS;
    } else {
      process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS = originalFirstTokenTimeout;
    }
    if (originalIdleTimeout === undefined) {
      delete process.env.OLLAMA_IDLE_TIMEOUT_MS;
    } else {
      process.env.OLLAMA_IDLE_TIMEOUT_MS = originalIdleTimeout;
    }
  }
});

test("Ollama reports a stalled active stream separately from a queued request", async () => {
  const originalFetch = globalThis.fetch;
  const originalFirstTokenTimeout = process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS;
  const originalIdleTimeout = process.env.OLLAMA_IDLE_TIMEOUT_MS;
  process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS = "100";
  process.env.OLLAMA_IDLE_TIMEOUT_MS = "10";

  globalThis.fetch = (async (_input, init) => {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
      }),
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      createOllamaPodcast([item()], "daily_digest", "standard"),
      /Ollama stopped streaming the editorial plan/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalFirstTokenTimeout === undefined) {
      delete process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS;
    } else {
      process.env.OLLAMA_FIRST_TOKEN_TIMEOUT_MS = originalFirstTokenTimeout;
    }
    if (originalIdleTimeout === undefined) {
      delete process.env.OLLAMA_IDLE_TIMEOUT_MS;
    } else {
      process.env.OLLAMA_IDLE_TIMEOUT_MS = originalIdleTimeout;
    }
  }
});

test("Ollama worker pool bounds concurrency and preserves section order", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency(
    [1, 2, 3, 4, 5],
    2,
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return value * 10;
    },
  );
  assert.equal(peak, 2);
  assert.deepEqual(result, [10, 20, 30, 40, 50]);
});

test("Ollama expansion planning allocates the deficit within section limits", () => {
  const words = (count: number, label: string) =>
    Array.from({ length: count }, () => label).join(" ");
  const sections = [70, 120, 200, 220, 130, 180, 120].map(
    (count, index) => ({
      script: words(count, `section${index + 1}`),
      claims: [],
    }),
  );
  const ranges = [104, 193, 267, 282, 178, 282, 179].map((maxWords) => ({
    minWords: 40,
    maxWords,
  }));
  const requests = planSectionExpansions(sections, ranges, 1_264);

  assert.deepEqual(
    requests.map((request) => request.sectionIndex),
    [2, 3, 5],
  );
  assert.ok(
    requests.reduce(
      (total, request) => total + request.minAdditionalWords,
      0,
    ) >= 224,
  );
  for (const request of requests) {
    const currentWords = countScriptWords(
      sections[request.sectionIndex].script,
    );
    assert.ok(
      currentWords + request.maxAdditionalWords <=
        ranges[request.sectionIndex].maxWords,
    );
  }
});

test("Ollama planner keeps valid fact ownership and fills all section contracts", () => {
  const plan = normalizePodcastPlan(
    {
      title: "Parallel quality",
      dek: "A planned briefing.",
      facts: [
        {
          id: "F1",
          statement: "The source reports a grounded result.",
          sourceNumber: 1,
          sectionNumber: 4,
        },
        {
          id: "bad-source",
          statement: "This references a missing source.",
          sourceNumber: 9,
          sectionNumber: 3,
        },
      ],
      sections: [{ sectionNumber: 4, focus: "Compare the reported result." }],
    },
    [item()],
  );
  assert.equal(plan.title, "Parallel quality");
  assert.equal(plan.facts.length, 1);
  assert.equal(plan.facts[0].sectionNumber, 4);
  assert.equal(plan.sections.length, 7);
  assert.equal(plan.sections[3].focus, "Compare the reported result.");
  assert.match(plan.sections[0].focus, /overview/i);
});

test("Ollama pipeline fans out writers and fans in parallel critics", async () => {
  const originalFetch = globalThis.fetch;
  const originalParallelism = process.env.OLLAMA_PARALLELISM;
  process.env.OLLAMA_PARALLELISM = "3";
  const sectionWords = [28, 53, 73, 77, 49, 77, 48];
  let active = 0;
  let peak = 0;
  let requestCount = 0;
  let criticCount = 0;

  const ndjson = (content: unknown) =>
    new Response(
      `${JSON.stringify({
        message: { content: JSON.stringify(content) },
        done: true,
        done_reason: "stop",
      })}\n`,
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    );

  globalThis.fetch = (async (_input, init) => {
    requestCount += 1;
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active -= 1;
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = body.messages[0]?.content ?? "";
    const user = body.messages[1]?.content ?? "";
    if (system.includes("planning editor")) {
      return ndjson({
        title: "Parallel SignalCast",
        dek: "A quality-preserving parallel briefing.",
        facts: [{
          id: "F1",
          statement: "The source describes a grounded method.",
          sourceNumber: 1,
          sectionNumber: 3,
        }],
        sections: Array.from({ length: 7 }, (_, index) => ({
          sectionNumber: index + 1,
          focus: `Section ${index + 1} owns its assigned material.`,
        })),
      });
    }
    if (system.includes("write one section")) {
      const sectionNumber = Number(
        user.match(/Section (\d+) focus:/)?.[1],
      );
      return ndjson({
        script: Array.from(
          { length: sectionWords[sectionNumber - 1] },
          () => `section${sectionNumber}word`,
        ).join(" "),
        claims: [],
      });
    }
    if (
      system.includes("source-fabrication checker") ||
      system.includes("podcast narrative editor")
    ) {
      criticCount += 1;
      return ndjson({ issues: [] });
    }
    throw new Error(`Unexpected mocked Ollama stage: ${system.slice(0, 80)}`);
  }) as typeof fetch;

  try {
    const generated = await createOllamaPodcast(
      [item()],
      "daily_digest",
      "brief",
    );
    assert.equal(generated.title, "Parallel SignalCast");
    assert.equal(countScriptWords(generated.script), 405);
    assert.equal(generated.script.split(/\n\s*\n/).length, 7);
    assert.equal(peak, 3);
    assert.equal(criticCount, 2);
    assert.equal(requestCount, 10);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalParallelism === undefined) delete process.env.OLLAMA_PARALLELISM;
    else process.env.OLLAMA_PARALLELISM = originalParallelism;
  }
});

test("Ollama fills a short episode with one parallel addendum pass", async () => {
  const originalFetch = globalThis.fetch;
  const originalParallelism = process.env.OLLAMA_PARALLELISM;
  process.env.OLLAMA_PARALLELISM = "3";
  let writerCalls = 0;
  let expansionCalls = 0;
  let activeExpansions = 0;
  let peakExpansions = 0;

  const ndjson = (content: unknown) =>
    new Response(
      `${JSON.stringify({
        message: { content: JSON.stringify(content) },
        done: true,
        done_reason: "stop",
      })}\n`,
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    );

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0]?.content ?? "";
    const user = body.messages[1]?.content ?? "";
    if (system.includes("planning editor")) {
      return ndjson({
        title: "Parallel expansion",
        dek: "Short sections gain distinct depth.",
        facts: [],
        sections: Array.from({ length: 7 }, (_, index) => ({
          sectionNumber: index + 1,
          focus: `Section ${index + 1} focus.`,
        })),
      });
    }
    if (system.includes("write one section")) {
      writerCalls += 1;
      const sectionNumber = Number(user.match(/Section (\d+) focus:/)?.[1]);
      return ndjson({
        script: Array.from(
          { length: 60 },
          (_, index) => `initial${sectionNumber}word${index}`,
        ).join(" ") + ".",
        claims: [],
      });
    }
    if (system.includes("add one new paragraph")) {
      expansionCalls += 1;
      activeExpansions += 1;
      peakExpansions = Math.max(peakExpansions, activeExpansions);
      const match = user.match(
        /Write (\d+)–(\d+) new words for section (\d+)/,
      );
      const additionalWords = Number(match?.[1]);
      const sectionNumber = Number(match?.[3]);
      await new Promise((resolve) => setTimeout(resolve, 3));
      activeExpansions -= 1;
      return ndjson({
        script: Array.from(
          { length: additionalWords },
          (_, index) => `addition${sectionNumber}word${index}`,
        ).join(" ") + ".",
      });
    }
    if (
      system.includes("source-fabrication checker") ||
      system.includes("podcast narrative editor")
    ) {
      return ndjson({ issues: [] });
    }
    throw new Error(`Unexpected mocked Ollama stage: ${system.slice(0, 80)}`);
  }) as typeof fetch;

  try {
    const generated = await createOllamaPodcast(
      [item()],
      "daily_digest",
      "standard",
    );
    assert.equal(writerCalls, 7);
    assert.equal(expansionCalls, 5);
    assert.equal(peakExpansions, 3);
    assert.equal(countScriptWords(generated.script), 1_264);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalParallelism === undefined) delete process.env.OLLAMA_PARALLELISM;
    else process.env.OLLAMA_PARALLELISM = originalParallelism;
  }
});

test("Ollama critics repair only flagged sections before the final review", async () => {
  const originalFetch = globalThis.fetch;
  const originalParallelism = process.env.OLLAMA_PARALLELISM;
  process.env.OLLAMA_PARALLELISM = "3";
  const sectionWords = [28, 53, 73, 77, 49, 77, 48];
  const writerCalls = Array.from({ length: 7 }, () => 0);
  let evidenceCalls = 0;
  let narrativeCalls = 0;

  const ndjson = (content: unknown) =>
    new Response(
      `${JSON.stringify({
        message: { content: JSON.stringify(content) },
        done: true,
        done_reason: "stop",
      })}\n`,
      { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
    );

  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>;
    };
    const system = body.messages[0]?.content ?? "";
    const user = body.messages[1]?.content ?? "";
    if (system.includes("planning editor")) {
      return ndjson({
        title: "Targeted repair",
        dek: "Only failed sections are regenerated.",
        facts: [{
          id: "F1",
          statement: "The source describes a grounded method.",
          sourceNumber: 1,
          sectionNumber: 3,
        }],
        sections: Array.from({ length: 7 }, (_, index) => ({
          sectionNumber: index + 1,
          focus: `Section ${index + 1} focus.`,
        })),
      });
    }
    if (system.includes("write one section")) {
      const sectionNumber = Number(user.match(/Section (\d+) focus:/)?.[1]);
      writerCalls[sectionNumber - 1] += 1;
      return ndjson({
        script: Array.from(
          { length: sectionWords[sectionNumber - 1] },
          () => `section${sectionNumber}revision${writerCalls[sectionNumber - 1]}`,
        ).join(" "),
        claims: [],
      });
    }
    if (system.includes("source-fabrication checker")) {
      evidenceCalls += 1;
      return ndjson({
        issues: evidenceCalls === 1
          ? [{
              sectionNumber: 3,
              problem: "One method detail is unsupported.",
              instruction: "Remove the unsupported method detail.",
            }]
          : [],
      });
    }
    if (system.includes("podcast narrative editor")) {
      narrativeCalls += 1;
      return ndjson({ issues: [] });
    }
    throw new Error(`Unexpected mocked Ollama stage: ${system.slice(0, 80)}`);
  }) as typeof fetch;

  try {
    const generated = await createOllamaPodcast(
      [item()],
      "daily_digest",
      "brief",
    );
    assert.equal(countScriptWords(generated.script), 405);
    assert.deepEqual(writerCalls, [1, 1, 2, 1, 1, 1, 1]);
    assert.equal(evidenceCalls, 2);
    assert.equal(narrativeCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalParallelism === undefined) delete process.env.OLLAMA_PARALLELISM;
    else process.env.OLLAMA_PARALLELISM = originalParallelism;
  }
});

test("Ollama disables thinking and retries bounded output by generation stage", async () => {
  const originalFetch = globalThis.fetch;
  const originalParallelism = process.env.OLLAMA_PARALLELISM;
  const requests: Array<{
    keep_alive: string;
    think: boolean;
    format?: Record<string, unknown>;
    options: { num_predict: number };
  }> = [];
  process.env.OLLAMA_PARALLELISM = "1";

  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) {
      return new Response(
        `${JSON.stringify({
          message: { content: "{\"title\":" },
          done: true,
          done_reason: "length",
        })}\n`,
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
      );
    }
    if (requests.length === 2) {
      return new Response(
        `${JSON.stringify({
          message: {
            content: JSON.stringify({
              title: "Bounded local generation",
              dek: "A grounded briefing.",
            }),
          },
          done: true,
          done_reason: "stop",
        })}\n`,
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
      );
    }
    throw new Error("Stop after inspecting the section request.");
  }) as typeof fetch;

  try {
    await assert.rejects(
      createOllamaPodcast([item()], "daily_digest", "standard"),
      /Stop after inspecting the section request/,
    );
    assert.equal(requests.length, 3);
    assert.equal(requests[0].think, false);
    assert.equal(requests[0].keep_alive, "30m");
    assert.equal(requests[0].options.num_predict, 2_048);
    assert.ok(requests[0].format);
    assert.equal(requests[1].think, false);
    assert.equal(requests[1].options.num_predict, 4_096);
    assert.ok(requests[1].format);
    assert.equal(requests[2].think, false);
    assert.ok(requests[2].options.num_predict >= 1_536);
    assert.ok(requests[2].options.num_predict <= 3_072);
    assert.ok(requests[2].format);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalParallelism === undefined) delete process.env.OLLAMA_PARALLELISM;
    else process.env.OLLAMA_PARALLELISM = originalParallelism;
  }
});

test("Ollama falls back to script-only JSON when a section runs away", async () => {
  const originalFetch = globalThis.fetch;
  const originalParallelism = process.env.OLLAMA_PARALLELISM;
  const requests: Array<{
    format?: {
      properties?: {
        script?: Record<string, unknown>;
        claims?: { maxItems?: number };
      };
    };
    options: { num_predict: number };
  }> = [];
  process.env.OLLAMA_PARALLELISM = "1";

  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    if (requests.length === 1) {
      return new Response(
        `${JSON.stringify({
          message: {
            content: JSON.stringify({
              title: "Fallback generation",
              dek: "A grounded briefing.",
            }),
          },
          done: true,
          done_reason: "stop",
        })}\n`,
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
      );
    }
    if (requests.length === 2) {
      return new Response(
        `${JSON.stringify({
          message: { content: "{\"script\":\"runaway" },
          done: true,
          done_reason: "length",
        })}\n`,
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
      );
    }
    if (requests.length === 3) {
      return new Response(
        `${JSON.stringify({
          message: {
            content: JSON.stringify({
              script: Array.from({ length: 90 }, () => "word").join(" "),
            }),
          },
          done: true,
          done_reason: "stop",
        })}\n`,
        { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
      );
    }
    throw new Error("Stop after the script-only fallback.");
  }) as typeof fetch;

  try {
    await assert.rejects(
      createOllamaPodcast([item()], "daily_digest", "standard"),
      /Stop after the script-only fallback/,
    );
    assert.equal(requests.length, 4);
    assert.ok(requests[1].format?.properties?.claims);
    assert.equal(requests[1].format?.properties?.claims?.maxItems, undefined);
    assert.ok(requests[1].format?.properties?.script);
    assert.doesNotMatch(
      JSON.stringify(requests[1].format),
      /maxLength|maxItems|minimum|maximum|additionalProperties/,
    );
    assert.equal(requests[2].format?.properties?.claims, undefined);
    assert.doesNotMatch(
      JSON.stringify(requests[2].format),
      /maxLength|maxItems|minimum|maximum|additionalProperties/,
    );
    assert.ok(requests[2].options.num_predict < requests[1].options.num_predict);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalParallelism === undefined) delete process.env.OLLAMA_PARALLELISM;
    else process.env.OLLAMA_PARALLELISM = originalParallelism;
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
    const initialBody = JSON.parse(String(requests[0].body)) as {
      input: Array<{ content: Array<{ text: string }> }>;
    };
    const resizeBody = JSON.parse(String(requests[1].body)) as {
      input: Array<{ content: Array<{ text: string }> }>;
    };
    assert.match(
      initialBody.input[0].content[0].text,
      /adult male podcast host/,
    );
    assert.match(
      initialBody.input[1].content[0].text,
      /After that hook, include one brief, naturally worded sentence disclosing/,
    );
    assert.doesNotMatch(
      initialBody.input[1].content[0].text,
      /Open with an AI-narration disclosure|Put the AI-writing and narration disclosure in showNotes/,
    );
    assert.match(
      resizeBody.input[0].content[0].text,
      /adult male podcast host/,
    );
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

test("OpenAI regeneration prompt uses the supplied topic and current draft", async () => {
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.AI_PROVIDER;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalSkipVerification = process.env.SKIP_EVIDENCE_VERIFICATION;
  const requests: RequestInit[] = [];
  const topic =
    "OpenAI’s Cyberattack Against Hugging Face: Science Fiction That Became Reality";
  const currentDraft =
    "This exact current-draft sentinel must reach the revision prompt.";
  const script = Array.from(
    { length: 405 },
    (_, index) => `regenerated${index}`,
  ).join(" ");

  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.SKIP_EVIDENCE_VERIFICATION = "true";
  globalThis.fetch = (async (_input, init) => {
    requests.push(init ?? {});
    return new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          title: topic,
          dek: "A regenerated, evidence-grounded briefing.",
          script,
          showNotes: "Source: https://example.com/paper",
          chapters: [{ title: "Opening", startSeconds: 0 }],
          claims: [],
        }),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    await generatePodcast([item()], "daily_digest", {
      includeAudio: false,
      episodeLength: "brief",
      regeneration: {
        episodeId: "episode-current",
        topic,
        currentDraft,
      },
    });

    assert.equal(requests.length, 1);
    const body = JSON.parse(String(requests[0].body)) as {
      input: Array<{ content: Array<{ text: string }> }>;
    };
    assert.match(body.input[0].content[0].text, /adult male podcast host/);
    const prompt = body.input[1].content[0].text;
    assert.match(prompt, /REGENERATION REQUEST/);
    assert.match(prompt, /not as factual evidence/);
    assert.ok(prompt.includes(topic));
    assert.ok(prompt.includes(currentDraft));
    assert.match(prompt, /SOURCE PACKET/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalSkipVerification === undefined) {
      delete process.env.SKIP_EVIDENCE_VERIFICATION;
    } else {
      process.env.SKIP_EVIDENCE_VERIFICATION = originalSkipVerification;
    }
  }
});

test("OpenAI speech receives the podcast performance direction", async () => {
  const originalFetch = globalThis.fetch;
  const originalProvider = process.env.AI_PROVIDER;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;
  const originalSkipVerification = process.env.SKIP_EVIDENCE_VERIFICATION;
  const originalTtsModel = process.env.OPENAI_TTS_MODEL;
  const originalTtsVoice = process.env.OPENAI_TTS_VOICE;
  let speechRequest: Record<string, unknown> | null = null;
  const script = Array.from(
    { length: 405 },
    (_, index) => `spoken${index}`,
  ).join(" ");

  process.env.AI_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.SKIP_EVIDENCE_VERIFICATION = "true";
  process.env.OPENAI_TTS_MODEL = "gpt-4o-mini-tts";
  process.env.OPENAI_TTS_VOICE = "onyx";
  globalThis.fetch = (async (input, init) => {
    if (String(input).endsWith("/v1/audio/speech")) {
      speechRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        output_text: JSON.stringify({
          title: "Human podcast delivery",
          dek: "A conversational, evidence-grounded briefing.",
          script,
          showNotes: "Source: https://example.com/paper",
          chapters: [{ title: "Opening", startSeconds: 0 }],
          claims: [],
        }),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const generated = await generatePodcast([item()], "daily_digest", {
      includeAudio: true,
      episodeLength: "brief",
    });
    assert.equal(generated.audioContentType, "audio/mpeg");
    assert.equal(speechRequest?.model, "gpt-4o-mini-tts");
    assert.equal(speechRequest?.voice, "onyx");
    assert.equal(
      speechRequest?.instructions,
      PODCAST_AUDIO_DELIVERY_INSTRUCTION,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProvider === undefined) delete process.env.AI_PROVIDER;
    else process.env.AI_PROVIDER = originalProvider;
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
    if (originalSkipVerification === undefined) {
      delete process.env.SKIP_EVIDENCE_VERIFICATION;
    } else {
      process.env.SKIP_EVIDENCE_VERIFICATION = originalSkipVerification;
    }
    if (originalTtsModel === undefined) delete process.env.OPENAI_TTS_MODEL;
    else process.env.OPENAI_TTS_MODEL = originalTtsModel;
    if (originalTtsVoice === undefined) delete process.env.OPENAI_TTS_VOICE;
    else process.env.OPENAI_TTS_VOICE = originalTtsVoice;
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
