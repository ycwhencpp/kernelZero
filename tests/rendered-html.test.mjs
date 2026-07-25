import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the SignalCast product", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>SignalCast — Research, distilled daily<\/title>/i);
  assert.match(html, /signalcast/i);
  assert.match(html, /Good morning, Anurag/);
  assert.match(html, /Worth your attention/);
  assert.match(html, /Podcast studio/);
  assert.match(html, /Tech radar/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("removes the disposable starter preview", async () => {
  await assert.rejects(access(new URL("../app/_sites-preview", templateRoot)));
});
