import assert from "node:assert/strict";
import test from "node:test";
import { createFallbackSourceDocument, createPodcastSourceCorpus } from "../lib/source-extraction/hydrate";
import { extractHtmlBlocks } from "../lib/source-extraction/html";
import { extractPdfBlocks } from "../lib/source-extraction/pdf";
import {
  detectSourceMediaType,
  isPublicIpAddress,
  normalizePublicHttpUrl,
} from "../lib/source-extraction/safe-http";
import {
  SourceExtractionError,
  resolveExtractionLimits,
  resolveSourceDocumentBatchTimeoutMs,
} from "../lib/source-extraction/types";

test("public URL validation rejects local and unusual private addresses", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicIpAddress("127.0.0.1"), false);
  assert.equal(isPublicIpAddress("10.1.2.3"), false);
  assert.equal(isPublicIpAddress("100.64.0.1"), false);
  assert.equal(isPublicIpAddress("169.254.1.1"), false);
  assert.equal(isPublicIpAddress("192.0.2.1"), false);
  assert.equal(isPublicIpAddress("::ffff:127.0.0.1"), false);

  for (const url of [
    "http://localhost/article",
    "http://127.0.0.1/article",
    "http://2130706433/article",
    "http://[::1]/article",
    "http://service.internal/article",
    "https://example.com:8443/article",
    "https://example.com:80/article",
    "http://example.com:443/article",
    "https://user:secret@example.com/article",
  ]) {
    assert.throws(
      () => normalizePublicHttpUrl(url),
      (error: unknown) =>
        error instanceof SourceExtractionError && error.code === "unsafe_url",
      url,
    );
  }
  assert.equal(
    normalizePublicHttpUrl("https://example.com/article#fragment").toString(),
    "https://example.com/article",
  );
});

test("media detection rejects MIME spoofing and recognizes feeds", () => {
  const pdf = Buffer.from("%PDF-1.7\nmock", "ascii");
  assert.equal(detectSourceMediaType("application/octet-stream", pdf), "pdf");
  assert.throws(
    () => detectSourceMediaType("text/html", pdf),
    (error: unknown) =>
      error instanceof SourceExtractionError && error.code === "unsupported_media_type",
  );
  assert.throws(
    () => detectSourceMediaType("image/jpeg", pdf),
    (error: unknown) =>
      error instanceof SourceExtractionError && error.code === "unsupported_media_type",
  );
  assert.throws(
    () => detectSourceMediaType("application/pdf", Buffer.from("<html></html>")),
    (error: unknown) =>
      error instanceof SourceExtractionError && error.code === "parse_failed",
  );
  assert.equal(
    detectSourceMediaType(
      "application/rss+xml; charset=utf-8",
      Buffer.from("<?xml version='1.0'?><rss version='2.0'></rss>"),
    ),
    "feed",
  );
});

test("source extraction limits honor bounded environment configuration", () => {
  const names = [
    "SOURCE_DOCUMENT_FETCH_TIMEOUT_MS",
    "SOURCE_DOCUMENT_BATCH_TIMEOUT_MS",
    "SOURCE_DOCUMENT_HTML_MAX_BYTES",
    "SOURCE_DOCUMENT_PDF_MAX_BYTES",
    "SOURCE_DOCUMENT_MAX_CHARACTERS",
    "SOURCE_DOCUMENT_MAX_BLOCKS",
    "SOURCE_DOCUMENT_MAX_PDF_PAGES",
  ] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.SOURCE_DOCUMENT_FETCH_TIMEOUT_MS = "12000";
    process.env.SOURCE_DOCUMENT_BATCH_TIMEOUT_MS = "23000";
    process.env.SOURCE_DOCUMENT_HTML_MAX_BYTES = "1000000";
    process.env.SOURCE_DOCUMENT_PDF_MAX_BYTES = "4000000";
    process.env.SOURCE_DOCUMENT_MAX_CHARACTERS = "42000";
    process.env.SOURCE_DOCUMENT_MAX_BLOCKS = "420";
    process.env.SOURCE_DOCUMENT_MAX_PDF_PAGES = "42";
    const limits = resolveExtractionLimits();
    assert.equal(limits.totalTimeoutMs, 12000);
    assert.equal(limits.maxHtmlBytes, 1000000);
    assert.equal(limits.maxPdfBytes, 4000000);
    assert.equal(limits.maxCharacters, 42000);
    assert.equal(limits.maxBlocks, 420);
    assert.equal(limits.maxPdfPages, 42);
    assert.equal(resolveSourceDocumentBatchTimeoutMs(), 23000);
    assert.equal(resolveExtractionLimits({ maxBlocks: 25 }).maxBlocks, 25);
  } finally {
    for (const name of names) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("HTML extraction preserves meaningful structure and removes navigation", () => {
  const repeated = "A concrete supported detail about the system. ".repeat(16);
  const extracted = extractHtmlBlocks({
    html: `<!doctype html>
      <html lang="en"><head><title>Agent Infrastructure</title></head><body>
        <nav>Account Pricing Sign in</nav>
        <article>
          <h1>Agent Infrastructure</h1>
          <p>${repeated}</p>
          <h2>Storage</h2>
          <ul><li>Valkey keeps the hot path responsive.</li><li>Postgres stores durable state.</li></ul>
          <blockquote>Measure the retrieval path before optimizing it.</blockquote>
        </article>
      </body></html>`,
    url: "https://example.com/article",
    limits: resolveExtractionLimits({ minUsefulCharacters: 100 }),
  });

  assert.ok(extracted.characters > 300);
  assert.equal(extracted.blocks.some((block) => block.text.includes("Account Pricing")), false);
  assert.ok(extracted.blocks.some((block) => block.kind === "heading" && block.text === "Storage"));
  assert.ok(extracted.blocks.some((block) => block.kind === "list_item"));
  assert.deepEqual(
    extracted.blocks.find((block) => block.text.includes("Valkey"))?.sectionPath,
    ["Agent Infrastructure", "Storage"],
  );
});

test("HTML extraction rejects a DOM beyond its parse budget", () => {
  assert.throws(
    () => extractHtmlBlocks({
      html: `<html><body>${"<div>text</div>".repeat(30)}</body></html>`,
      url: "https://example.com/oversized-dom",
      limits: resolveExtractionLimits({ maxHtmlElements: 10 }),
    }),
    (error: unknown) =>
      error instanceof SourceExtractionError &&
      error.code === "response_too_large",
  );
});

test("fallback documents strip markup and script content", () => {
  const document = createFallbackSourceDocument({
    contentItemId: "item-1",
    title: "Fallback",
    canonicalUrl: "https://example.com/fallback",
    fallbackText:
      "<article><h1>Safe heading</h1><p>Useful source text.</p><script>ignoreThis()</script></article>",
    retrievalPolicy: "metadata_only",
  });
  const text = document.blocks.map((block) => block.text).join(" ");
  assert.match(text, /Safe heading/);
  assert.match(text, /Useful source text/);
  assert.doesNotMatch(text, /ignoreThis|<article>/);
  assert.equal(document.status, "fallback");

  const corpus = createPodcastSourceCorpus([document]);
  assert.equal(corpus.totalCharacters, document.stats.characters);
  assert.equal(corpus.sources[0].contentItemId, "item-1");

  const inlineOnly = createFallbackSourceDocument({
    contentItemId: "item-2",
    title: "Inline markup",
    canonicalUrl: "https://example.com/inline",
    fallbackText: "A <em>useful</em> detail and <strong>another</strong> detail.",
    retrievalPolicy: "metadata_only",
  });
  assert.equal(inlineOnly.blocks[0]?.text, "A useful detail and another detail.");
  const scriptOnly = createFallbackSourceDocument({
    contentItemId: "item-3",
    title: "Script only",
    canonicalUrl: "https://example.com/script",
    fallbackText: "<script>doNotPersist()</script>",
    retrievalPolicy: "metadata_only",
  });
  assert.equal(scriptOnly.blocks.length, 0);
  assert.equal(scriptOnly.status, "failed");
});

function minimalTextPdf(lines: string[]): Uint8Array {
  const operations = ["BT", "/F1 18 Tf", "72 740 Td"];
  lines.forEach((line, index) => {
    if (index > 0) operations.push("0 -22 Td");
    operations.push(`(${line.replace(/[()\\]/g, "")}) Tj`);
  });
  operations.push("ET");
  const stream = `${operations.join("\n")}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

test("PDF extraction emits page-located text blocks", async () => {
  const bytes = minimalTextPdf([
    "Source Extraction",
    "This document contains a concrete implementation detail.",
    "The parser keeps page locations for evidence citations.",
    "The final paragraph supplies enough text for validation.",
  ]);
  const extracted = await extractPdfBlocks({
    bytes,
    limits: resolveExtractionLimits({ minUsefulCharacters: 40 }),
  });
  assert.equal(extracted.pages, 1);
  assert.ok(extracted.characters > 40);
  assert.ok(extracted.blocks.every((block) => block.page === 1));
  assert.match(extracted.blocks.map((block) => block.text).join(" "), /evidence citations/);
});

test("PDF extraction identifies image-only and malformed documents", async () => {
  await assert.rejects(
    extractPdfBlocks({
      bytes: minimalTextPdf([]),
      limits: resolveExtractionLimits({ minUsefulCharacters: 20 }),
    }),
    (error: unknown) =>
      error instanceof SourceExtractionError && error.code === "pdf_image_only",
  );
  await assert.rejects(
    extractPdfBlocks({
      bytes: Buffer.from("%PDF-not-a-document", "ascii"),
      limits: resolveExtractionLimits(),
    }),
    (error: unknown) =>
      error instanceof SourceExtractionError && error.code === "parse_failed",
  );
});
