import type { Chapter } from "./types";

export type TranscriptParagraph = {
  text: string;
  scriptStart: number;
};

export type ChapterMappedParagraph = TranscriptParagraph & {
  chapterIndex: number;
  startsChapter: boolean;
};

/** Semantic offsets are immutable-script coordinates and must not survive edits. */
export function chaptersForManuallyEditedScript(
  chapters: readonly Chapter[],
): Chapter[] {
  return chapters.map(({ title, startSeconds }) => ({ title, startSeconds }));
}

/** Split the displayed transcript without losing its offsets in the stored script. */
export function transcriptParagraphs(script: string): TranscriptParagraph[] {
  const paragraphs: TranscriptParagraph[] = [];
  const boundary = /\n{2,}/g;
  let start = 0;
  const append = (end: number) => {
    const raw = script.slice(start, end);
    const firstText = raw.search(/\S/);
    if (firstText < 0) return;
    paragraphs.push({
      text: raw.trim(),
      scriptStart: start + firstText,
    });
  };
  for (const match of script.matchAll(boundary)) {
    const boundaryStart = match.index ?? 0;
    append(boundaryStart);
    start = boundaryStart + match[0].length;
  }
  append(script.length);
  return paragraphs;
}

/**
 * Map semantic chapters by their stable script offsets. Older/manually edited
 * episodes lack offsets and retain a proportional paragraph-based fallback.
 */
export function mapTranscriptParagraphsToChapters(
  script: string,
  chapters: Pick<Chapter, "scriptStart">[],
): ChapterMappedParagraph[] {
  const paragraphs = transcriptParagraphs(script);
  if (!paragraphs.length) return [];
  if (!chapters.length) {
    return paragraphs.map((paragraph, index) => ({
      ...paragraph,
      chapterIndex: index,
      startsChapter: true,
    }));
  }

  const hasStableOffsets = chapters.every(
    (chapter) =>
      typeof chapter.scriptStart === "number" &&
      Number.isFinite(chapter.scriptStart) &&
      chapter.scriptStart >= 0,
  );
  const chapterIndices = paragraphs.map((paragraph, paragraphIndex) => {
    if (!hasStableOffsets) {
      return Math.min(
        chapters.length - 1,
        Math.floor((paragraphIndex * chapters.length) / paragraphs.length),
      );
    }
    return chapters.reduce(
      (active, chapter, chapterIndex) =>
        paragraph.scriptStart >= (chapter.scriptStart ?? 0)
          ? chapterIndex
          : active,
      0,
    );
  });

  return paragraphs.map((paragraph, index) => ({
    ...paragraph,
    chapterIndex: chapterIndices[index],
    startsChapter: index === 0 || chapterIndices[index - 1] !== chapterIndices[index],
  }));
}
