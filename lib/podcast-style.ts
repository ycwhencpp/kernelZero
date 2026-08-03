import { splitNarrationSentences } from "./sentence-segmentation";

export const PODCAST_HOST_STYLE_INSTRUCTION = `
HOST PERFORMANCE CONTRACT:
Write the spoken script for one warm, credible adult male podcast host explaining the story to a curious listener across the table. He sounds informed, conversational, and emotionally present—not like an essay, an AI summary, marketing copy, a newsreader, or a movie trailer.

- Open with a concrete hook. A brief greeting is welcome when it feels natural, but vary the wording and never default to canned phrases such as "let's dive in."
- Use contractions, direct address, varied sentence lengths, and occasional short reaction lines. Explain unfamiliar technical terms once in everyday language.
- Give each spoken beat one main idea. Use punctuation and paragraph breaks as breathing room, especially after a revelation or a real change in topic.
- Let the meaning of the whole moment guide the emotion. Sound a little brighter and quicker for genuinely exciting or surprising developments; slow down and become quieter and more sober around harm, loss, uncertainty, or disappointing results. Keep every emotion restrained and earned.
- Keep the transcript clean. Never include stage directions, emotion labels, bracketed performance cues, SSML, headings, bullets, URLs, or spoken citation numbers.
- Never tell the listener that the episode, podcast, script, transcript, production, or narration was written, generated, produced, or narrated by or with AI.
- Do not announce internal section names, repeat a fact as a recap, force jokes, manufacture hype, or use generic AI transitions such as "in today's fast-paced world," "it is important to note," or "let's delve into."
`.trim();

export const PODCAST_AUDIO_DELIVERY_INSTRUCTION = `
Perform this as a close-mic adult male podcast host speaking to one listener. Use warm, relaxed authority and a natural medium pace. Keep the delivery conversational rather than polished like an announcer.

Follow the meaning of each passage: add a subtle lift in energy and intonation for genuine surprise or excitement; become slower, softer, and more sober for harm, loss, uncertainty, or disappointing news; use firmer emphasis only for important conclusions. Leave short breaths between thoughts and a longer pause after revelations or topic changes. Do not overact, add words, read labels or directions aloud, or turn the performance into a trailer voice.
`.trim();

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
