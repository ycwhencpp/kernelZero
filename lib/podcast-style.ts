import { splitNarrationSentences } from "./sentence-segmentation";

export const PODCAST_HOST_STYLE_INSTRUCTION = `
HOST PERFORMANCE CONTRACT:
Write the spoken script for one warm, credible adult male podcast host explaining the story to a curious listener across the table. He sounds informed, conversational, and emotionally present—not like an essay, an AI summary, marketing copy, a newsreader, or a movie trailer.

- Always start with this listener-orientation beat before any technical claim or unexplained detail: the first spoken sentence must be exactly "Welcome to KernelZero." In the next one or two sentences, name the episode-specific story or topic and preview what the listener will understand and why it matters. Make the setup unmistakably listener-facing—for example, frame it as this episode or today's story, what we'll trace, what they'll understand, or what the next few minutes will connect—but vary the syntax instead of reusing one canned template. Keep the greeting and orientation together as the first paragraph, then insert a blank line before moving into the hook and technical story.
- Use contractions, direct address, varied sentence lengths, and occasional short reaction lines. Explain unfamiliar technical terms once in everyday language.
- Give each spoken beat one main idea. Use punctuation and paragraph breaks as breathing room, especially after a revelation or a real change in topic.
- Let the meaning of the whole moment guide the emotion. Sound a little brighter and quicker for genuinely exciting or surprising developments; slow down and become quieter and more sober around harm, loss, uncertainty, or disappointing results. Keep every emotion restrained and earned.
- Keep the transcript clean. Never include stage directions, emotion labels, bracketed performance cues, SSML, headings, bullets, URLs, or spoken citation numbers.
- Never tell the listener that the episode, podcast, script, transcript, production, or narration was written, generated, produced, or narrated by or with AI.
- Do not announce internal section names, repeat a fact as a recap, force jokes, manufacture hype, or use generic AI transitions such as "in today's fast-paced world," "it is important to note," or "let's delve into."
- Never use "To understand X, we need to look at Y," "To understand how X works, we have to look at Y," or close variants as stock transitions. State the concrete next idea directly.
`.trim();

export const PODCAST_AUDIO_DELIVERY_INSTRUCTION = `
Perform this as a close-mic adult male podcast host speaking to one listener. Use warm, relaxed authority and a natural medium pace. Keep the delivery conversational rather than polished like an announcer.

Follow the meaning of each passage: add a subtle lift in energy and intonation for genuine surprise or excitement; become slower, softer, and more sober for harm, loss, uncertainty, or disappointing news; use firmer emphasis only for important conclusions. Leave short breaths between thoughts and a longer pause after revelations or topic changes. Do not overact, add words, read labels or directions aloud, or turn the performance into a trailer voice.
`.trim();

export const STOCK_PODCAST_TRANSITION_REWRITE =
  /\bto understand(?:\s+how)?\s+[^.!?\n]{1,160},\s+we\s+(?:need|have)\s+to\s+look\s+at\s+/gi;

export function rewriteStockPodcastTransitions(script: string): string {
  return script.replace(STOCK_PODCAST_TRANSITION_REWRITE, (match, offset) => {
    const isSentenceStart = offset === 0 || /(?:^|[.!?\n])\s*$/.test(script.slice(Math.max(0, offset - 5), offset));
    return isSentenceStart ? "The evidence next points to " : "the evidence next points to ";
  });
}

/**
 * Normalizes LLM prose into safe, consistent podcast narration by rewriting stock
 * transitions and removing AI-production disclosures.
 */
export function normalizePodcastNarration(script: string): string {
  return rewriteStockPodcastTransitions(removeAiProductionDisclosures(script));
}

const STOCK_PODCAST_TRANSITION =
  /\bto understand(?:\s+how)?\s+[^.!?\n]{1,160},\s+we\s+(?:need|have)\s+to\s+look\s+at\b/i;
const REQUIRED_PODCAST_GREETING = "Welcome to KernelZero.";
const MIN_PODCAST_ORIENTATION_WORDS = 12;
const MAX_PODCAST_ORIENTATION_WORDS = 70;
const COMPLETE_PODCAST_ORIENTATION = /[.!?]["”'’\)\]]?$/;
const DIRECT_LISTENER_PAYOFF =
  /\b(?:you(?:['’]ll| will)\s+(?:understand|learn|see|hear|discover|follow|know|grasp)|we(?:['’]ll| will)\s+(?:trace|unpack|examine|explore|connect|follow|break down|walk through|look at)|(?:the|in the|over the) next few minutes\s+(?:will\s+)?(?:trace|unpack|examine|explore|connect|follow|show|explain)|by the end\b[^.!?]{0,100}\b(?:understand|see|know|clear|make sense))\b/i;
const GENERIC_DIRECT_LISTENER_PAYOFF =
  /\b(?:(?:you(?:['’]ll| will)\s+(?:understand|learn|see|hear|discover|follow|know|grasp)|we(?:['’]ll| will)\s+(?:trace|unpack|examine|explore|connect|follow|break down|walk through|look at))\s+(?:(?:the|this)\s+)?(?:(?:full|whole|complete|entire|overall)\s+)?(?:story|topic|picture|details?|episode)(?:\s+by the end)?|you(?:['’]ll| will)\s+(?:understand|learn|see|hear|discover|follow|know|grasp)\s+(?:it|this|that))\b/i;
const EPISODE_FRAMED_TOPIC =
  /\b(?:this episode|today(?:['’]s)?(?: episode| story| topic)?|this story|(?:the|in the|over the) next few minutes)\b[^.!?]{0,220}\b(?:how|what|why)\b/i;
const ORIENTATION_PAYOFF_RELATION =
  /\b(?:and\s+why|why\b[^.!?]{0,100}\b(?:matters?|is important)|what\b[^.!?]{0,100}\bmeans\s+(?:for|to)\b|(?:matters?|is important)\s+(?:to|for|because)\b|and\s+(?:(?:the|its|their)\s+)?(?:impact|implications?|stakes?|risks?|consequences?)\s+(?:for|to|on)\b|(?:should|need|needs)\s+to\s+care\b)/i;
const SPELLED_PERCENTAGE =
  /\b(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|(?:one\s+)?hundred)\s+(?:percent(?:age)?|per cent)\b/i;
const EARLY_QUANTITATIVE_RESULT =
  /\b(?:accuracy|benchmark|failure|success) (?:rate|score)\b|\b\d+(?:[.,]\d+)?\s*(?:%|percent(?:age)?|per cent|milliseconds?|seconds?|minutes?|hours?|tokens?|requests?|operations?|trials?|cases?|samples?|points?|tasks?|times)\b|\b(?:achieved|scored)\s+\d+(?:[.,]\d+)?(?:\s+out of\s+\d+)?\b|\b(?:solved|completed|passed|failed|answered)\s+\d+\s+(?:out\s+)?of\s+\d+\b|\b(?:ranked|placed|finished)\s+(?:first|second|third|\d+(?:st|nd|rd|th))\s+(?:(?:among|out of)\s+(?:\w+|\d+)|overall|(?:on|in)\s+[A-Za-z0-9][\w.-]*)\b/i;
const EARLY_MECHANISM_CATEGORIES = [
  /\bbypass(?:ed|es|ing)?\b/i,
  /\bdisable(?:d|s|ing)?\b/i,
  /\b(?:escap(?:e|ed|es|ing)|sandbox escape)\b/i,
  /\bexfiltrat(?:e|ed|es|ing)\b/i,
  /\b(?:exploit(?:ed|s|ing)?|kernel exploit|V8 exploit)\b/i,
  /\binject(?:ed|s|ing)?\b/i,
  /\bexecut(?:e|ed|es|ing)\s+(?:arbitrary|remote)\s+code\b/i,
  /\bopen(?:ed|s|ing)?\s+(?:an?\s+)?(?:outbound\s+)?socket\b/i,
  /\b(?:reach(?:ed|es|ing)?\s+(?:an?\s+)?(?:private\s+)?control plane|control plane)\b/i,
  /\bbrowser automation\b/i,
  /\bshell access\b/i,
  /\b(?:unrestricted (?:networking|network access)|outbound (?:connectivity|network access))\b/i,
  /\bsystem call\b/i,
] as const;
const PODCAST_SENTENCE_SEGMENTER = new Intl.Segmenter("en", {
  granularity: "sentence",
});

function splitPodcastOrientationSentences(orientation: string): string[] {
  const sentinel = orientation.includes("\uE000") ? "\uE001" : "\uE000";
  const protectedOrientation = orientation
    .replace(
      /\b(?:Dr|Mr|Mrs|Ms|Mx|Prof)\./gi,
      (honorific) => `${honorific.slice(0, -1)}${sentinel}`,
    )
    .replace(
      /\b(?:[A-Z]\.\s*){2,}(?=[A-Z](?:[a-z]|[’'][A-Z]))/g,
      (initials) => initials.replaceAll(".", sentinel),
    );
  return Array.from(
    PODCAST_SENTENCE_SEGMENTER.segment(protectedOrientation),
    ({ segment }) => segment.replaceAll(sentinel, ".").trim(),
  ).filter(Boolean);
}

function hasListenerOrientationPayoff(orientation: string): boolean {
  return (DIRECT_LISTENER_PAYOFF.test(orientation) &&
      !GENERIC_DIRECT_LISTENER_PAYOFF.test(orientation)) ||
    (EPISODE_FRAMED_TOPIC.test(orientation) &&
      ORIENTATION_PAYOFF_RELATION.test(orientation));
}

function hasEarlyMechanismDetail(orientation: string): boolean {
  if (/\bCVE-\d{4}-\d{4,}\b/i.test(orientation)) return true;
  return EARLY_MECHANISM_CATEGORIES.filter((pattern) =>
    pattern.test(orientation)
  ).length >= 2;
}

function podcastOrientationFailures(
  orientation: string,
  maxWords = MAX_PODCAST_ORIENTATION_WORDS,
): string[] {
  const failures: string[] = [];
  const boundedMaxWords = Math.max(
    MIN_PODCAST_ORIENTATION_WORDS,
    Math.floor(maxWords),
  );
  const orientationSentences = splitPodcastOrientationSentences(orientation);
  const orientationWordCount = orientation
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  if (
    orientationSentences.length < 1 ||
    orientationSentences.length > 2 ||
    orientationWordCount < MIN_PODCAST_ORIENTATION_WORDS ||
    orientationWordCount > boundedMaxWords ||
    orientationSentences.some(
      (sentence) => !COMPLETE_PODCAST_ORIENTATION.test(sentence),
    ) ||
    !hasListenerOrientationPayoff(orientation)
  ) {
    failures.push(
      `use exactly one or two complete sentences (${MIN_PODCAST_ORIENTATION_WORDS}-${boundedMaxWords} spoken words total) to name this episode's concrete topic and preview what the listener will understand and why it matters before any technical detail; include a concrete listener payoff such as what they'll understand, what we'll trace, or what the next few minutes will connect`,
    );
  }
  if (
    EARLY_QUANTITATIVE_RESULT.test(orientation) ||
    SPELLED_PERCENTAGE.test(orientation)
  ) {
    failures.push(
      "reserve quantitative results, success rates, and detailed findings for the hook/body after the listener orientation",
    );
  }
  if (hasEarlyMechanismDetail(orientation)) {
    failures.push(
      "move vulnerability identifiers and multi-step technical mechanisms into the hook/body after the listener orientation",
    );
  }
  return failures;
}

/**
 * Validates the listener-orientation sentences without requiring the fixed
 * KernelZero greeting or the blank-line-delimited hook/body that follows it.
 */
export function podcastOrientationFailureMessage(
  orientation: string,
  maxWords = MAX_PODCAST_ORIENTATION_WORDS,
): string | null {
  const failures = podcastOrientationFailures(orientation.trim(), maxWords);
  if (!failures.length) return null;
  return `Podcast orientation validation failed: ${failures.join("; ")}.`;
}

export function podcastStyleFailureMessage(script: string): string | null {
  const failures: string[] = [];
  const trimmedScript = script.trim();
  const paragraphs = trimmedScript.split(/\n\s*\n/).filter(Boolean);
  const openingParagraph = paragraphs[0]?.trim() ?? "";
  const textAfterGreeting = openingParagraph.slice(
    REQUIRED_PODCAST_GREETING.length,
  );
  const hasRequiredGreeting =
    openingParagraph.startsWith(REQUIRED_PODCAST_GREETING) &&
    /^\s/.test(textAfterGreeting);
  if (!hasRequiredGreeting) {
    failures.push(
      `start the spoken script with the exact sentence "${REQUIRED_PODCAST_GREETING}"`,
    );
  }
  const greetingCount = script.match(/Welcome\s+to\s+KernelZero[.!?]?/gi)?.length ??
    0;
  if (greetingCount !== 1) {
    failures.push(
      `use "${REQUIRED_PODCAST_GREETING}" exactly once, at the start of the script`,
    );
  }
  const orientation = hasRequiredGreeting ? textAfterGreeting.trim() : "";
  failures.push(...podcastOrientationFailures(orientation));
  if (paragraphs.length < 2) {
    failures.push(
      "finish the greeting and listener orientation as the first paragraph, then insert a blank line before the hook and technical story",
    );
  }
  const stockTransition = script.match(STOCK_PODCAST_TRANSITION)?.[0];
  if (stockTransition) {
    failures.push(
      `replace the canned transition "${stockTransition}" with the concrete mechanism, event, or finding that comes next`,
    );
  }
  if (!failures.length) return null;
  return `Podcast style validation failed: ${failures.join("; ")}.`;
}

export function withPodcastHostStyle(instruction: string): string {
  return `${instruction.trim()}\n\n${PODCAST_HOST_STYLE_INSTRUCTION}`;
}

const AI_PRODUCTION_DISCLOSURE_PATTERNS = [
  /\b(?:this|the)\s+(?:episode|podcast|show|program|script|transcript|production|audio|narration)\b[^.!?]{0,120}\b(?:written|generated|created|produced|narrated|voiced)\b[^.!?]{0,80}\b(?:by|with|using)(?:\s+the\s+help\s+of)?\s+(?:an?\s+)?(?:ai|artificial intelligence)\b/i,
  /^(?:this\s+is\s+)?(?:an?\s+)?(?:ai|artificial intelligence)[ -](?:written|generated|created|produced|narrated|voiced)\s+(?:episode|podcast|show|program|script|transcript|production|audio|narration)\b/i,
  /\b(?:i am|i'm)\s+(?:an?\s+)?(?:ai|artificial intelligence)\s+(?:host|narrator|voice)\b/i,
] as const;

function isAiProductionDisclosure(sentence: string): boolean {
  const normalized = sentence.replace(/\bA\s+I\b/g, "AI");
  return AI_PRODUCTION_DISCLOSURE_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  );
}

/**
 * Removes model-authorship disclosures from spoken prose while preserving
 * ordinary reporting about AI systems or AI-generated material in the sources.
 */
export function removeAiProductionDisclosures(script: string): string {
  return script
    .split(/\n\s*\n/)
    .map((paragraph) =>
      splitNarrationSentences(paragraph)
        .filter((sentence) => !isAiProductionDisclosure(sentence))
        .join(" ")
        .trim()
    )
    .filter(Boolean)
    .join("\n\n");
}

export function geminiPodcastSpeechPrompt(script: string): string {
  return `${PODCAST_AUDIO_DELIVERY_INSTRUCTION}

Speak only the transcript below. Do not announce these instructions or the transcript label.

TRANSCRIPT:
${script.trim()}`;
}

export function openAiSpeechModelSupportsInstructions(model: string): boolean {
  return /^gpt-4o-mini-tts(?:-|$)/.test(model.trim());
}
