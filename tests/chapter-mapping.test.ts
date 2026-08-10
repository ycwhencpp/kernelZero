import assert from "node:assert/strict";
import test from "node:test";
import {
  chaptersForManuallyEditedScript,
  mapTranscriptParagraphsToChapters,
  transcriptParagraphs,
} from "../lib/chapter-mapping";

test("semantic chapter offsets group every paragraph under its stable segment", () => {
  const script = [
    "Opening orientation.",
    "Opening detail.",
    "A second topic begins here.",
    "A second-topic example.",
  ].join("\n\n");
  const secondStart = script.indexOf("A second topic");
  const mapped = mapTranscriptParagraphsToChapters(script, [
    { scriptStart: 0 },
    { scriptStart: secondStart },
  ]);

  assert.deepEqual(mapped.map((paragraph) => paragraph.chapterIndex), [0, 0, 1, 1]);
  assert.deepEqual(mapped.map((paragraph) => paragraph.startsChapter), [true, false, true, false]);
});

test("legacy chapters without offsets retain paragraph-based mapping", () => {
  const script = Array.from(
    { length: 7 },
    (_, index) => `Legacy section ${index + 1}.`,
  ).join("\n\n");
  const mapped = mapTranscriptParagraphsToChapters(
    script,
    Array.from({ length: 7 }, () => ({})),
  );

  assert.deepEqual(mapped.map((paragraph) => paragraph.chapterIndex), [0, 1, 2, 3, 4, 5, 6]);
});

test("transcript paragraph splitting preserves stored script offsets", () => {
  const script = "  First paragraph.\n\n\nSecond paragraph.  ";
  assert.deepEqual(transcriptParagraphs(script), [
    { text: "First paragraph.", scriptStart: 2 },
    { text: "Second paragraph.", scriptStart: script.indexOf("Second") },
  ]);
});

test("manual transcript edits discard immutable semantic offsets", () => {
  assert.deepEqual(
    chaptersForManuallyEditedScript([
      { title: "Opening", startSeconds: 0, scriptStart: 0 },
      { title: "Evidence", startSeconds: 120, scriptStart: 640 },
    ]),
    [
      { title: "Opening", startSeconds: 0 },
      { title: "Evidence", startSeconds: 120 },
    ],
  );
});
