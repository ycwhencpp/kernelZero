import assert from "node:assert/strict";
import test from "node:test";
import { fetchFeed, parseFeed } from "../lib/rss";
import type { SafeFetchOptions } from "../lib/source-extraction/safe-http";
import { SourceExtractionError } from "../lib/source-extraction/types";

test("RSS keeps a concise summary but extracts content:encoded into ordered blocks", () => {
  const detail = "A source-backed implementation detail about durable agent state. ".repeat(8);
  const parsed = parseFeed(
    `<?xml version="1.0"?><rss><channel><title>Systems Lab</title>
      <item><title>Agent state</title><link>https://example.com/agent-state</link>
        <description><![CDATA[<p>A concise feed summary.</p>]]></description>
        <content:encoded><![CDATA[
          <article><h1>Agent state</h1><p>${detail}</p>
          <h2>Storage boundary</h2><p>Valkey serves the hot path while Postgres keeps durable history.</p>
          <script>doNotPersist()</script></article>
        ]]></content:encoded>
      </item>
    </channel></rss>`,
    "https://example.com/feed.xml",
  );

  assert.equal(parsed.items[0].summary, "A concise feed summary.");
  assert.equal(parsed.documents.length, 1);
  const document = parsed.documents[0];
  assert.equal(document.contentItemId, parsed.items[0].id);
  assert.equal(document.format, "feed");
  assert.equal(document.canonicalUrl, "https://example.com/agent-state");
  assert.equal(document.retrievalUrl, document.canonicalUrl);
  assert.equal(document.resolvedUrl, document.canonicalUrl);
  assert.ok(document.blocks.some((block) =>
    block.kind === "heading" && block.text === "Storage boundary"
  ));
  const storage = document.blocks.find((block) => block.text.includes("Valkey"));
  assert.ok(storage?.sectionPath.includes("Storage boundary"));
  assert.equal(JSON.stringify(document).includes("<article>"), false);
  assert.equal(JSON.stringify(document).includes("doNotPersist"), false);
});

test("Atom escaped content takes precedence for documents while summary remains concise", () => {
  const parsed = parseFeed(
    `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
      <title>Atom Lab</title><entry><title>Evaluation loops</title>
      <link href="https://example.com/evaluation" />
      <summary>Short Atom summary.</summary>
      <content type="html">&lt;h2&gt;Measured loop&lt;/h2&gt;&lt;p&gt;The full body records latency and tool failure rates.&lt;/p&gt;</content>
      <author><name>Research Team</name></author></entry></feed>`,
    "https://example.com/atom.xml",
  );

  assert.equal(parsed.items[0].summary, "Short Atom summary.");
  assert.deepEqual(parsed.items[0].authors, ["Research Team"]);
  assert.ok(parsed.documents[0].blocks.some((block) =>
    block.text.includes("latency and tool failure rates")
  ));
  assert.ok(parsed.documents[0].blocks.some((block) =>
    block.kind === "heading" && block.text === "Measured loop"
  ));
});

test("fetchFeed delegates to the bounded SSRF-safe feed downloader", async () => {
  let receivedUrl = "";
  let receivedOptions: SafeFetchOptions | undefined;
  const xml = `<?xml version="1.0"?><rss><channel><title>Safe Feed</title>
    <item><title>One</title><link>https://example.com/one</link><description>Body</description></item>
  </channel></rss>`;
  const parsed = await fetchFeed("https://example.com/feed.xml", {
    fetchBytes: async (url, options) => {
      receivedUrl = url.toString();
      receivedOptions = options;
      return {
        requestedUrl: receivedUrl,
        resolvedUrl: receivedUrl,
        status: 200,
        headers: { "content-type": "application/rss+xml" },
        mediaType: "feed",
        body: Buffer.from(xml),
        rawBytes: Buffer.byteLength(xml),
      };
    },
  });

  assert.equal(receivedUrl, "https://example.com/feed.xml");
  assert.deepEqual(receivedOptions?.allowedMediaTypes, ["feed"]);
  assert.equal(receivedOptions?.limits?.maxHtmlBytes, 5 * 1024 * 1024);
  assert.equal(parsed.items.length, 1);
});

test("fetchFeed reports the five megabyte ingestion limit", async () => {
  await assert.rejects(
    () => fetchFeed("https://example.com/feed.xml", {
      fetchBytes: async () => {
        throw new SourceExtractionError(
          "response_too_large",
          "Source response exceeds the byte limit.",
        );
      },
    }),
    /5 MB ingestion limit/,
  );
});
