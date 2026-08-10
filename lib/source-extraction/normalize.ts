import type { SourceBlock, SourceBlockKind } from "../types";

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const DIRECTIONAL_CONTROLS = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

export function normalizeSourceText(value: string, preserveLines = false): string {
  const normalized = value
    .normalize("NFC")
    .replace(CONTROL_CHARACTERS, "")
    .replace(DIRECTIONAL_CONTROLS, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\f\v ]+/g, " ");
  return preserveLines
    ? normalized.replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()
    : normalized.replace(/\s+/g, " ").trim();
}

export function truncateAtBoundary(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 0) return "";
  const candidate = value.slice(0, limit);
  const boundary = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("? "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("; "),
  );
  return (boundary >= limit * 0.65 ? candidate.slice(0, boundary + 1) : candidate)
    .trim();
}

export class SourceBlockCollector {
  readonly blocks: SourceBlock[] = [];
  characters = 0;
  truncated = false;

  constructor(
    private readonly maxBlocks: number,
    private readonly maxCharacters: number,
  ) {}

  add(
    kind: SourceBlockKind,
    rawText: string,
    sectionPath: readonly string[],
    details: { level?: 1 | 2 | 3 | 4 | 5 | 6; page?: number; preserveLines?: boolean } = {},
  ): boolean {
    if (this.blocks.length >= this.maxBlocks || this.characters >= this.maxCharacters) {
      this.truncated = true;
      return false;
    }
    let text = normalizeSourceText(rawText, details.preserveLines);
    if (!text) return true;

    const previous = this.blocks.at(-1);
    if (
      previous &&
      previous.kind === kind &&
      previous.text.toLocaleLowerCase() === text.toLocaleLowerCase()
    ) {
      return true;
    }

    const remaining = this.maxCharacters - this.characters;
    if (text.length > remaining) {
      text = truncateAtBoundary(text, remaining);
      this.truncated = true;
    }
    if (!text) return false;

    const order = this.blocks.length;
    this.blocks.push({
      id: `b${String(order + 1).padStart(4, "0")}`,
      order,
      kind,
      text,
      sectionPath: [...sectionPath],
      ...(details.level ? { level: details.level } : {}),
      ...(details.page ? { page: details.page } : {}),
    });
    this.characters += text.length;
    return !this.truncated;
  }
}

export function blocksToText(blocks: readonly SourceBlock[]): string {
  return blocks.map((block) => block.text).join("\n\n");
}
