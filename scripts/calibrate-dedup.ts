import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  detectSemanticDuplicatePairs,
  semanticDuplicateThreshold,
} from "../lib/ollama-semantic";

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error(
      "Usage: npm run calibrate:dedup -- <transcript.txt> [threshold] [--show-text]",
    );
  }
  const configured = Number(process.argv[3]);
  const baseline = Number.isFinite(configured)
    ? configured
    : semanticDuplicateThreshold();
  if (baseline < 0.1 || baseline > 0.99) {
    throw new Error("Calibration threshold must be between 0.10 and 0.99.");
  }
  process.env.OLLAMA_PIPELINE_LOG_LEVEL = "off";
  const script = await readFile(resolve(inputPath), "utf8");
  const lowest = Math.max(0.1, baseline - 0.06);
  const result = await detectSemanticDuplicatePairs(
    [{ id: "calibration", script }],
    { threshold: lowest },
  );
  const thresholds = [baseline - 0.03, baseline, baseline + 0.03]
    .map((value) => Math.max(0.1, Math.min(0.99, value)));
  const showText = process.argv.includes("--show-text");

  for (const threshold of thresholds) {
    const pairs = result.pairs.filter((pair) => pair.similarity >= threshold);
    console.log(`threshold=${threshold.toFixed(2)} pairs=${pairs.length}`);
    for (const pair of pairs) {
      const positions =
        `${pair.earlier.paragraphIndex}:${pair.earlier.sentenceIndex}` +
        ` -> ${pair.later.paragraphIndex}:${pair.later.sentenceIndex}`;
      console.log(`  score=${pair.similarity.toFixed(4)} ${positions}`);
      if (showText) {
        console.log(`    A: ${pair.earlier.text}`);
        console.log(`    B: ${pair.later.text}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
