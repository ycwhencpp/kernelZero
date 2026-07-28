const PRIVATE_USE_START = 0xe000;

function unusedSentinel(value: string): string {
  for (let codePoint = PRIVATE_USE_START; codePoint <= 0xf8ff; codePoint += 1) {
    const candidate = String.fromCodePoint(codePoint);
    if (!value.includes(candidate)) return candidate;
  }
  throw new Error("Unable to segment narration containing every private-use character.");
}

/**
 * Splits prose without treating decimal and version-number periods as sentence
 * boundaries. The protected periods are restored before any caller sees text.
 */
export function splitNarrationSentences(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const sentinel = unusedSentinel(trimmed);
  const protectedValue = trimmed.replace(
    /(\p{N})\.(?=\p{N})/gu,
    `$1${sentinel}`,
  );
  return (protectedValue.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [protectedValue])
    .map((sentence) => sentence.replaceAll(sentinel, ".").trim())
    .filter(Boolean);
}
