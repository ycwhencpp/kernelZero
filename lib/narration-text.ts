/** Normalizes LLM prose into conservative, speech-friendly input for local TTS. */
export function prepareForChatterbox(script: string): string {
  const prepared = script
    .normalize("NFKC")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?[^)]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[(?:source|citation)?\s*\d+\]/gi, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/[•▪◦]/g, ". ")
    .replace(/&/g, " and ")
    .replace(/%/g, " percent ")
    .replace(/\bAI\b/g, "A I")
    .replace(/[<>]/g, " ")
    .replace(/[|_]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();

  if (!prepared) return "";
  return /[.!?]$/.test(prepared)
    ? prepared
    : `${prepared.replace(/[,;:–—-]+$/, "")}.`;
}
