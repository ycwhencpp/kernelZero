import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http, { type IncomingHttpHeaders, type RequestOptions } from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  safeFetchBytes,
  selectPinnedPublicAddress,
} from "../lib/source-extraction/safe-http";
import { SourceExtractionError } from "../lib/source-extraction/types";

function hasExtractionCode(code: SourceExtractionError["code"]) {
  return (error: unknown) =>
    error instanceof SourceExtractionError && error.code === code;
}

test("DNS answers reject mixed private results before pinning", () => {
  assert.deepEqual(
    selectPinnedPublicAddress([
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]),
    { address: "8.8.8.8", family: 4 },
  );
  assert.throws(
    () => selectPinnedPublicAddress([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    hasExtractionCode("unsafe_url"),
  );
  assert.throws(
    () => selectPinnedPublicAddress([]),
    hasExtractionCode("dns_failed"),
  );
});

test("bounded downloader pins addresses and blocks redirect, size, MIME, and timeout attacks", async (t) => {
  const pinnedAddresses: string[] = [];
  class MockRequest extends EventEmitter {
    #idleCallback: (() => void) | null = null;
    #idleTimeoutMs = 0;
    #idleTimer: ReturnType<typeof setTimeout> | null = null;
    #response: PassThrough | null = null;

    constructor(
      private readonly logicalUrl: URL,
      private readonly options: RequestOptions,
    ) {
      super();
    }

    setTimeout(timeoutMs: number, callback: () => void) {
      this.#idleTimeoutMs = timeoutMs;
      this.#idleCallback = callback;
      return this;
    }

    #armIdleTimer() {
      if (!this.#idleCallback || this.#idleTimeoutMs <= 0) return;
      if (this.#idleTimer) clearTimeout(this.#idleTimer);
      this.#idleTimer = setTimeout(this.#idleCallback, this.#idleTimeoutMs);
    }

    destroy(error?: Error) {
      if (this.#idleTimer) clearTimeout(this.#idleTimer);
      this.#response?.destroy();
      if (error) queueMicrotask(() => this.emit("error", error));
      return this;
    }

    end() {
      this.options.lookup?.(
        this.logicalUrl.hostname,
        { all: false },
        (error, address) => {
          if (error) throw error;
          if (typeof address === "string") pinnedAddresses.push(address);
        },
      );
      if (this.logicalUrl.pathname === "/slow-headers") {
        this.#armIdleTimer();
        return this;
      }

      let statusCode = 200;
      let headers: IncomingHttpHeaders = { "content-type": "text/html" };
      let chunks: Array<Buffer | string> = ["<html><body>safe</body></html>"];
      let leaveOpen = false;
      switch (this.logicalUrl.pathname) {
        case "/private-redirect":
          statusCode = 302;
          headers = { location: "http://127.0.0.1/secret" };
          chunks = [];
          break;
        case "/downgrade":
          statusCode = 302;
          headers = { location: "http://93.184.216.34/ok" };
          chunks = [];
          break;
        case "/loop":
          statusCode = 302;
          headers = { location: "http://93.184.216.34/loop" };
          chunks = [];
          break;
        case "/stream-overflow":
          headers = {
            "content-type": "text/html",
            "transfer-encoding": "chunked",
          };
          chunks = ["<html><body>", "x".repeat(256), "</body></html>"];
          break;
        case "/compression-bomb":
          headers = {
            "content-type": "text/html",
            "content-encoding": "gzip",
          };
          chunks = [gzipSync(`<html><body>${"z".repeat(1_000)}</body></html>`)];
          break;
        case "/mime-spoof":
          chunks = ["%PDF-1.7\nspoof"];
          break;
        case "/slow-body":
          chunks = ["<html><body>"];
          leaveOpen = true;
          break;
      }
      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: IncomingHttpHeaders;
      };
      response.statusCode = statusCode;
      response.headers = headers;
      this.#response = response;
      response.once("end", () => {
        if (this.#idleTimer) clearTimeout(this.#idleTimer);
      });
      response.on("data", () => this.#armIdleTimer());
      this.emit("response", response);
      queueMicrotask(() => {
        for (const chunk of chunks) response.write(chunk);
        if (!leaveOpen) response.end();
        else this.#armIdleTimer();
      });
      return this;
    }
  }

  const mockRequest = (
    input: string | URL,
    options: RequestOptions = {},
  ) => {
    const logicalUrl = input instanceof URL ? input : new URL(String(input));
    return new MockRequest(logicalUrl, options);
  };
  t.mock.method(http, "request", mockRequest as unknown as typeof http.request);
  t.mock.method(https, "request", mockRequest as unknown as typeof https.request);

  const baseLimits = {
    maxHtmlBytes: 128,
    headersTimeoutMs: 40,
    bodyIdleTimeoutMs: 40,
    totalTimeoutMs: 500,
  };
  const ok = await safeFetchBytes("http://93.184.216.34/ok", {
    limits: baseLimits,
    allowedMediaTypes: ["html"],
  });
  assert.equal(ok.mediaType, "html");
  assert.deepEqual([...new Set(pinnedAddresses)], ["93.184.216.34"]);

  await assert.rejects(
    safeFetchBytes("http://93.184.216.34/private-redirect", {
      limits: baseLimits,
    }),
    hasExtractionCode("unsafe_url"),
  );
  await assert.rejects(
    safeFetchBytes("https://93.184.216.34/downgrade", {
      limits: baseLimits,
    }),
    hasExtractionCode("redirect_downgrade"),
  );
  await assert.rejects(
    safeFetchBytes("http://93.184.216.34/loop", {
      limits: { ...baseLimits, maxRedirects: 1 },
    }),
    hasExtractionCode("redirect_limit"),
  );
  await assert.rejects(
    safeFetchBytes("http://93.184.216.34/stream-overflow", {
      limits: baseLimits,
    }),
    hasExtractionCode("response_too_large"),
  );
  await assert.rejects(
    safeFetchBytes("http://93.184.216.34/compression-bomb", {
      limits: baseLimits,
    }),
    hasExtractionCode("response_too_large"),
  );
  await assert.rejects(
    safeFetchBytes("http://93.184.216.34/mime-spoof", {
      limits: baseLimits,
    }),
    hasExtractionCode("unsupported_media_type"),
  );
  await assert.rejects(
    safeFetchBytes("http://93.184.216.34/slow-headers", {
      limits: baseLimits,
    }),
    hasExtractionCode("timeout"),
  );
  await assert.rejects(
    safeFetchBytes("http://93.184.216.34/slow-body", {
      limits: baseLimits,
    }),
    hasExtractionCode("timeout"),
  );
});
