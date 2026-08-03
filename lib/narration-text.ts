import { chunkForSpeech } from "./speech-chunk";

export type ChatterboxNarrationSegment = {
  text: string;
  pauseAfterMs: number;
};

export const CHATTERBOX_NATIVE_DELIVERY_TAGS = [
  "[dramatic]",
  "[happy]",
  "[narration]",
  "[surprised]",
] as const;

const SOMBER_CONTEXT =
  /\b(?:died|death|killed|loss of life|tragic|devastating|suffering|grief|human cost|serious consequences|people were harmed|failed|failure|setback|disappointing|fell short)\b/i;
const SURPRISED_CONTEXT =
  /\b(?:unexpected(?:ly)?|surpris(?:e|ed|ing)|hard to believe|here(?:'s| is) the (?:twist|strange part)|the strange part|things took a turn)\b/i;
const UPBEAT_CONTEXT =
  /\b(?:good news|encouraging|promising|breakthrough|a real win|hopeful|remarkable progress)\b/i;
const DRAMATIC_CONTEXT =
  /\b(?:turn for the worse|critical turning point|broke out of (?:its|the) sandbox|the breach succeeded|the attack succeeded|danger became real|serious threat)\b/i;
const NEGATED_EMOTION_CONTEXT =
  /(?:\b(?:not|never|no|without|hardly|barely)\b[^.!?]{0,48}\b(?:unexpected|surprising|good news|encouraging|promising|breakthrough|win|hopeful|progress)\b|\b(?:unexpected|surprising|good news|encouraging|promising|breakthrough|win|hopeful|progress)\b[^.!?]{0,48}\b(?:never happened|did not happen|didn't happen|was not|wasn't|failed|fell through)\b)/i;
const SPEECH_MARKUP_TAG =
  /<\/?(?:speak|break|prosody|emphasis|say-as|sub|phoneme|voice|audio|p|s|mark|mstts:[a-z-]+)\b[^<>]*\/?>/gi;
const PERFORMANCE_CUE =
  /\b(?:pause|beat|breath|tone|voice|speak|speaks|speaking|whisper|whispering|narration|advertisement|angry|chuckle|clear throat|cough|crying|dramatic|fear|gasp|groan|happy|laugh|sarcastic|shush|sigh|sniff|surprised|sadly|happily|excited|excitedly|somber|softly|slowly|music|sound effect|sfx)\b/i;

function cleanBracketCue(_match: string, content: string): string {
  return PERFORMANCE_CUE.test(content) ? " " : content;
}

function cleanNarrationParagraph(paragraph: string): string {
  return paragraph
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[•▪◦]/g, ". ")
    .replace(/&/g, " and ")
    .replace(/%/g, " percent ")
    .replace(/\bAI\b/g, "A I")
    .replace(/[|_]/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

/**
 * Normalizes LLM prose into conservative, speech-friendly input while
 * preserving paragraph boundaries for performance pacing.
 */
export function prepareForChatterbox(script: string): string {
  const paragraphs = script
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)]+\)/gi, "$1")
    .replace(SPEECH_MARKUP_TAG, " ")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[(?:source|citation)?\s*\d+\]/gi, " ")
    // The saved transcript never controls the TTS tokenizer directly. Remove
    // performance directions, preserve legitimate bracketed prose, then add
    // only supported native tags to the audio-only segments below.
    .replace(/\[([^\]\n]+)\]/g, cleanBracketCue)
    .split(/\n\s*\n/)
    .map(cleanNarrationParagraph)
    .filter(Boolean)
    .map((paragraph) =>
      /[.!?]["']?$/.test(paragraph)
        ? paragraph
        : `${paragraph.replace(/[,;:–—-]+$/, "")}.`,
    );

  return paragraphs.join("\n\n");
}

function deliveryForText(text: string): {
  tag: (typeof CHATTERBOX_NATIVE_DELIVERY_TAGS)[number] | null;
  somber: boolean;
} {
  if (NEGATED_EMOTION_CONTEXT.test(text)) {
    return { tag: null, somber: true };
  }
  if (SOMBER_CONTEXT.test(text)) return { tag: null, somber: true };
  if (SURPRISED_CONTEXT.test(text)) {
    return { tag: "[surprised]", somber: false };
  }
  if (UPBEAT_CONTEXT.test(text)) return { tag: "[happy]", somber: false };
  if (DRAMATIC_CONTEXT.test(text)) {
    // The KernelZero delivery contract is curious and restrained rather than
    // dramatic. Slow down around danger instead of adding a theatrical tag.
    return { tag: null, somber: true };
  }
  return { tag: null, somber: false };
}

function pauseAfterSegment(
  text: string,
  paragraphEnd: boolean,
  delivery: ReturnType<typeof deliveryForText>,
): number {
  let pauseMs = paragraphEnd ? 580 : 270;
  if (/[?]["']?$/.test(text)) pauseMs += 70;
  else if (/[!]["']?$/.test(text)) pauseMs += 45;
  if (delivery.somber) pauseMs += paragraphEnd ? 200 : 120;
  else if (delivery.tag) pauseMs += paragraphEnd ? 80 : 40;
  return Math.max(180, Math.min(900, pauseMs));
}

/**
 * Builds an audio-only performance plan. Native Chatterbox tags never leak
 * into the saved transcript, and explicit silence carries the real pauses.
 */
export function prepareChatterboxSegments(
  script: string,
  maxCharacters = 260,
): ChatterboxNarrationSegment[] {
  const prepared = prepareForChatterbox(script);
  if (!prepared) return [];
  const textLimit = Math.max(40, Math.floor(maxCharacters));
  // Reserve room for the longest supported delivery tag and a separating space.
  const chunkLimit = Math.max(20, textLimit - 16);
  const segments: ChatterboxNarrationSegment[] = [];

  for (const paragraph of prepared.split(/\n{2,}/).filter(Boolean)) {
    const chunks = chunkForSpeech(paragraph, chunkLimit);
    chunks.forEach((chunk, index) => {
      const delivery = deliveryForText(chunk);
      const text = delivery.tag ? `${delivery.tag} ${chunk}` : chunk;
      segments.push({
        text,
        pauseAfterMs: pauseAfterSegment(
          chunk,
          index === chunks.length - 1,
          delivery,
        ),
      });
    });
  }
  return segments;
}

/** Adds non-spoken macOS `say` silence commands only between real paragraphs. */
export function prepareForMacSpeech(script: string): string {
  const prepared = prepareForChatterbox(script);
  const paragraphs = prepared.split(/\n{2,}/).filter(Boolean);
  return paragraphs
    .map((paragraph, index) => {
      if (index === paragraphs.length - 1) return paragraph;
      const delivery = deliveryForText(paragraph);
      const pauseMs = delivery.somber ? 780 : delivery.tag ? 660 : 580;
      return `${paragraph} [[slnc ${pauseMs}]]`;
    })
    .join(" ");
}

/**
 * Keeps duration correction subtle so a target estimate cannot flatten the
 * pauses and emotional pacing produced by the narrator.
 */
export function naturalNarrationTempo(
  generatedDurationSeconds: number,
  targetDurationSeconds: number,
  maxAdjustment = 0.08,
): number | null {
  if (
    !Number.isFinite(generatedDurationSeconds) ||
    !Number.isFinite(targetDurationSeconds) ||
    generatedDurationSeconds <= 0 ||
    targetDurationSeconds <= 0
  ) {
    return null;
  }
  const boundedAdjustment = Math.max(0, Math.min(0.15, maxAdjustment));
  const rawTempo = generatedDurationSeconds / targetDurationSeconds;
  const tempo = Math.max(
    1 - boundedAdjustment,
    Math.min(1 + boundedAdjustment, rawTempo),
  );
  return Math.abs(tempo - 1) > 0.02 ? tempo : null;
}
