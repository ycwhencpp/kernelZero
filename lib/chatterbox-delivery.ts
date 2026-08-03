import { countScriptWords } from "./podcast-length";

export const CHATTERBOX_TTS_DELIVERY_PROMPT = `
You are the host of KernelZero, a premium daily technology podcast.

Read the transcript exactly as written.

Voice characteristics:
- Warm, confident, and conversational
- Calm, thoughtful, and technically knowledgeable
- Speak as if explaining something fascinating to a curious friend over coffee
- Sound genuinely interested in the topic, never overly excited
- Keep the delivery natural and human, never theatrical or like a news anchor

Speaking style:
- Medium pace (around 155–165 words per minute)
- Clear pronunciation
- Slightly slower when introducing difficult technical concepts
- Slightly more energetic when revealing interesting engineering insights
- Brief natural pauses between paragraphs and after important ideas
- Avoid rushing through lists or technical terms

Emotional tone:
- Curious rather than dramatic
- Intelligent rather than authoritative
- Friendly rather than corporate
- Relaxed rather than performative

Do not:
- Overact
- Sound like an advertisement
- Sound like a movie trailer
- Sound robotic
- Add emotion that isn't implied by the text
- Change or paraphrase the transcript
- Skip punctuation or paragraph pauses

Read naturally, as though recording a premium engineering podcast for developers and technology enthusiasts.
`.trim();

export const CHATTERBOX_TARGET_WORDS_PER_MINUTE = 160;
export const CHATTERBOX_MIN_WORDS_PER_MINUTE = 130;
export const CHATTERBOX_MAX_WORDS_PER_MINUTE = 190;
export const CHATTERBOX_MAX_TEMPO_ADJUSTMENT = 0.15;

function configuredWordsPerMinute(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${variableName} must be a positive number.`);
  }
  return parsed;
}

export function chatterboxWordsPerMinuteRange(
  minimum = process.env.CHATTERBOX_MIN_WPM,
  maximum = process.env.CHATTERBOX_MAX_WPM,
): { minWordsPerMinute: number; maxWordsPerMinute: number } {
  const minWordsPerMinute = configuredWordsPerMinute(
    minimum,
    CHATTERBOX_MIN_WORDS_PER_MINUTE,
    "CHATTERBOX_MIN_WPM",
  );
  const maxWordsPerMinute = configuredWordsPerMinute(
    maximum,
    CHATTERBOX_MAX_WORDS_PER_MINUTE,
    "CHATTERBOX_MAX_WPM",
  );
  if (minWordsPerMinute >= maxWordsPerMinute) {
    throw new Error("CHATTERBOX_MIN_WPM must be lower than CHATTERBOX_MAX_WPM.");
  }
  if (
    CHATTERBOX_TARGET_WORDS_PER_MINUTE < minWordsPerMinute ||
    CHATTERBOX_TARGET_WORDS_PER_MINUTE > maxWordsPerMinute
  ) {
    throw new Error(
      `The configured Chatterbox WPM range must include the ${CHATTERBOX_TARGET_WORDS_PER_MINUTE} WPM target.`,
    );
  }
  return { minWordsPerMinute, maxWordsPerMinute };
}

export function chatterboxMaxTempoAdjustment(
  value = process.env.CHATTERBOX_MAX_TEMPO_ADJUSTMENT,
): number {
  if (value === undefined || value.trim() === "") {
    return CHATTERBOX_MAX_TEMPO_ADJUSTMENT;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      "CHATTERBOX_MAX_TEMPO_ADJUSTMENT must be a non-negative number.",
    );
  }
  return Math.min(CHATTERBOX_MAX_TEMPO_ADJUSTMENT, parsed);
}

export function chatterboxTargetDurationSeconds(
  script: string,
): number | null {
  const words = countScriptWords(script);
  return words > 0
    ? Math.max(
        1,
        Math.round(
          (words / CHATTERBOX_TARGET_WORDS_PER_MINUTE) * 60,
        ),
      )
    : null;
}
