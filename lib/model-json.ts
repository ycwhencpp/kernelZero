function fencedJsonBody(text: string): string | null {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : null;
}

function extractBalancedSegment(
  text: string,
  opener: "{" | "[",
  closer: "}" | "]",
): string | null {
  const start = text.indexOf(opener);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === opener) {
      depth += 1;
      continue;
    }
    if (char === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
}

export function parseModelJson<T>(text: string): T {
  const trimmed = text.trim();
  const candidates = [
    trimmed,
    fencedJsonBody(trimmed),
    extractBalancedSegment(trimmed, "{", "}"),
    extractBalancedSegment(trimmed, "[", "]"),
  ].filter((candidate, index, all): candidate is string =>
    Boolean(candidate) && all.indexOf(candidate) === index,
  );

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  throw new Error(
    `Model returned invalid JSON: ${trimmed.slice(0, 120)}`,
  );
}
