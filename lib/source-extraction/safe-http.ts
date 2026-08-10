import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import ipaddr from "ipaddr.js";
import {
  SourceExtractionError,
  type SourceExtractionLimits,
  resolveExtractionLimits,
} from "./types";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const LOCAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export type SourceMediaType = "html" | "pdf" | "feed";

export type BoundedHttpResponse = {
  requestedUrl: string;
  resolvedUrl: string;
  status: number;
  headers: IncomingHttpHeaders;
  mediaType: SourceMediaType;
  body: Uint8Array;
  rawBytes: number;
};

export type SafeFetchOptions = {
  limits?: Partial<SourceExtractionLimits>;
  signal?: AbortSignal;
  userAgent?: string;
  allowedMediaTypes?: readonly SourceMediaType[];
};

type ResolvedTarget = {
  url: URL;
  addresses: LookupAddress[];
  selected: LookupAddress;
};

/** Reject mixed/special DNS answers and return the address that will be pinned. */
export function selectPinnedPublicAddress(
  addresses: readonly LookupAddress[],
): LookupAddress {
  if (!addresses.length) {
    throw new SourceExtractionError("dns_failed", "Source hostname returned no addresses.", {
      retryable: true,
    });
  }
  // Reject mixed answers instead of letting ordering or rebinding bypass the denylist.
  if (addresses.some((entry) => !isPublicIpAddress(entry.address))) {
    throw extractionError("unsafe_url", "Source hostname resolves to a non-public address.");
  }
  return addresses[0];
}

function extractionError(
  code: ConstructorParameters<typeof SourceExtractionError>[0],
  message: string,
  cause?: unknown,
): SourceExtractionError {
  return new SourceExtractionError(code, message, { cause });
}

function stripIpv6Brackets(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

/** Returns true only for ordinary globally routable unicast addresses. */
export function isPublicIpAddress(value: string): boolean {
  try {
    return ipaddr.process(stripIpv6Brackets(value)).range() === "unicast";
  } catch {
    return false;
  }
}

export function normalizePublicHttpUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch (error) {
    throw extractionError("invalid_url", "Source URL is invalid.", error);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw extractionError("invalid_url", "Source URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw extractionError("unsafe_url", "Source URLs cannot contain credentials.");
  }
  const expectedPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== expectedPort) {
    throw extractionError("unsafe_url", "Source URL uses a disallowed port.");
  }
  const hostname = stripIpv6Brackets(url.hostname).toLocaleLowerCase().replace(/\.+$/, "");
  if (
    !hostname ||
    hostname === "localhost" ||
    (!ipaddr.isValid(hostname) && !hostname.includes(".")) ||
    LOCAL_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw extractionError("unsafe_url", "Source URL does not name a public host.");
  }
  if (ipaddr.isValid(hostname) && !isPublicIpAddress(hostname)) {
    throw extractionError("unsafe_url", "Source URL resolves to a non-public address.");
  }
  url.hash = "";
  return url;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(extractionError("timeout", message)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolvePublicTarget(
  url: URL,
  limits: SourceExtractionLimits,
): Promise<ResolvedTarget> {
  const hostname = stripIpv6Brackets(url.hostname);
  let addresses: LookupAddress[];
  if (ipaddr.isValid(hostname)) {
    const parsed = ipaddr.process(hostname);
    addresses = [{ address: parsed.toString(), family: parsed.kind() === "ipv4" ? 4 : 6 }];
  } else {
    try {
      addresses = await withTimeout(
        dnsLookup(hostname, { all: true, verbatim: true }),
        limits.dnsTimeoutMs,
        "DNS lookup timed out.",
      );
    } catch (error) {
      if (error instanceof SourceExtractionError) throw error;
      throw new SourceExtractionError("dns_failed", "Source hostname could not be resolved.", {
        cause: error,
        retryable: true,
      });
    }
  }
  return { url, addresses, selected: selectPinnedPublicAddress(addresses) };
}

export function detectSourceMediaType(
  contentType: string | undefined,
  body: Uint8Array,
): SourceMediaType {
  const declared = (contentType ?? "").split(";", 1)[0].trim().toLocaleLowerCase();
  const prefix = Buffer.from(body.subarray(0, Math.min(body.byteLength, 512)));
  const hasPdfMagic = prefix.subarray(0, 5).toString("ascii") === "%PDF-";
  const leading = prefix.toString("utf8").trimStart().toLocaleLowerCase();
  const markupRoot = leading.replace(/^<\?xml[^>]*>\s*/, "");
  const declaredPdf = ["application/pdf", "application/x-pdf"].includes(declared);
  const declaredHtml = declared === "text/html" || declared === "application/xhtml+xml";
  const declaredFeed = [
    "application/rss+xml",
    "application/atom+xml",
    "application/xml",
    "text/xml",
  ].includes(declared);
  const genericBinary = [
    "",
    "application/octet-stream",
    "binary/octet-stream",
    "application/binary",
    "application/download",
  ].includes(declared);
  const hasHtmlMagic =
    markupRoot.startsWith("<!doctype html") || markupRoot.startsWith("<html");
  const hasFeedMagic =
    /^<(?:rss|feed|rdf:rdf)\b/.test(markupRoot);

  if (hasPdfMagic) {
    if (!declaredPdf && !genericBinary) {
      throw extractionError("unsupported_media_type", "Response MIME type conflicts with its PDF signature.");
    }
    return "pdf";
  }
  if (declaredPdf) {
    throw extractionError("parse_failed", "Response claimed to be a PDF but had no PDF signature.");
  }
  if (hasHtmlMagic) {
    if (declaredFeed) {
      throw extractionError("unsupported_media_type", "Response MIME type conflicts with its HTML content.");
    }
    return "html";
  }
  if (hasFeedMagic) {
    if (declaredHtml) {
      throw extractionError("unsupported_media_type", "Response MIME type conflicts with its feed content.");
    }
    return "feed";
  }
  if (declaredHtml) return "html";
  if (declaredFeed) return "feed";
  throw extractionError("unsupported_media_type", "Source did not return HTML, feed XML, or PDF content.");
}

function responseByteLimit(
  headers: IncomingHttpHeaders,
  allowedMediaTypes: readonly SourceMediaType[],
  limits: SourceExtractionLimits,
): number {
  const contentType = String(headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLocaleLowerCase();
  if (contentType === "application/pdf" || contentType === "application/x-pdf") {
    return limits.maxPdfBytes;
  }
  if (
    contentType === "text/html" ||
    contentType === "application/xhtml+xml" ||
    contentType === "application/rss+xml" ||
    contentType === "application/atom+xml" ||
    contentType === "application/xml" ||
    contentType === "text/xml"
  ) {
    return limits.maxHtmlBytes;
  }
  return Math.max(
    ...allowedMediaTypes.map((mediaType) =>
      mediaType === "pdf" ? limits.maxPdfBytes : limits.maxHtmlBytes,
    ),
  );
}

function acceptHeader(allowedMediaTypes: readonly SourceMediaType[]): string {
  const values: string[] = [];
  if (allowedMediaTypes.includes("html")) {
    values.push("text/html", "application/xhtml+xml");
  }
  if (allowedMediaTypes.includes("feed")) {
    values.push("application/rss+xml", "application/atom+xml", "application/xml", "text/xml");
  }
  if (allowedMediaTypes.includes("pdf")) values.push("application/pdf");
  return values.map((value, index) => `${value};q=${Math.max(0.5, 1 - index * 0.05).toFixed(2)}`).join(",");
}

function bodyDecoder(response: IncomingMessage): NodeJS.ReadableStream {
  const encoding = String(response.headers["content-encoding"] ?? "")
    .trim()
    .toLocaleLowerCase();
  if (!encoding || encoding === "identity") return response;
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(createGunzip());
  if (encoding === "deflate") return response.pipe(createInflate());
  if (encoding === "br") return response.pipe(createBrotliDecompress());
  throw extractionError("unsupported_media_type", "Source used an unsupported content encoding.");
}

async function requestOnce(
  target: ResolvedTarget,
  requestedUrl: string,
  limits: SourceExtractionLimits,
  deadline: number,
  signal: AbortSignal | undefined,
  userAgent: string,
  allowedMediaTypes: readonly SourceMediaType[],
): Promise<{ redirect?: URL; response?: BoundedHttpResponse }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0 || signal?.aborted) {
    throw extractionError("timeout", "Source request timed out.", signal?.reason);
  }

  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? https : http;
    let settled = false;
    const timers: {
      header?: ReturnType<typeof setTimeout>;
      deadline?: ReturnType<typeof setTimeout>;
    } = {};
    const clearTimers = () => {
      if (timers.header) clearTimeout(timers.header);
      if (timers.deadline) clearTimeout(timers.deadline);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error instanceof SourceExtractionError) reject(error);
      else if (signal?.aborted) reject(extractionError("timeout", "Source request was aborted.", error));
      else reject(new SourceExtractionError("parse_failed", "Source request failed.", { cause: error, retryable: true }));
    };
    const succeed = (result: { redirect?: URL; response?: BoundedHttpResponse }) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(result);
    };
    const request = transport.request(target.url, {
      method: "GET",
      agent: false,
      signal,
      maxHeaderSize: 32 * 1024,
      headers: {
        Accept: acceptHeader(allowedMediaTypes),
        "Accept-Encoding": "gzip, deflate, br",
        "User-Agent": userAgent,
      },
      // Pin the connection to the vetted answer while preserving Host and TLS SNI.
      lookup: (_hostname, options, callback) => {
        if (typeof options === "object" && options.all) {
          callback(null, [target.selected]);
          return;
        }
        callback(null, target.selected.address, target.selected.family);
      },
    });
    timers.header = setTimeout(
      () => request.destroy(extractionError("timeout", "Source response headers timed out.")),
      Math.min(limits.headersTimeoutMs, remaining),
    );
    timers.header.unref?.();
    timers.deadline = setTimeout(
      () => request.destroy(extractionError("timeout", "Source request exceeded its total time limit.")),
      remaining,
    );
    timers.deadline.unref?.();
    request.setTimeout(limits.bodyIdleTimeoutMs, () => {
      request.destroy(extractionError("timeout", "Source response body became idle."));
    });
    request.once("error", fail);
    request.once("response", async (response) => {
      if (timers.header) clearTimeout(timers.header);
      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status)) {
        const location = response.headers.location;
        response.destroy();
        if (!location) {
          fail(extractionError("http_status", `Source redirect ${status} had no Location header.`));
          return;
        }
        try {
          const redirect = normalizePublicHttpUrl(new URL(location, target.url));
          if (target.url.protocol === "https:" && redirect.protocol !== "https:") {
            fail(extractionError("redirect_downgrade", "HTTPS source redirected to insecure HTTP."));
            return;
          }
          succeed({ redirect });
        } catch (error) {
          fail(error);
        }
        return;
      }
      if (status < 200 || status >= 300) {
        response.destroy();
        fail(new SourceExtractionError("http_status", `Source returned HTTP ${status}.`, {
          status,
          retryable: status === 408 || status === 429 || status >= 500,
        }));
        return;
      }

      const byteLimit = responseByteLimit(response.headers, allowedMediaTypes, limits);
      const declaredLength = Number(response.headers["content-length"] ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > byteLimit) {
        response.destroy();
        fail(extractionError("response_too_large", "Source response exceeds the byte limit."));
        return;
      }

      let rawBytes = 0;
      response.on("data", (chunk: Buffer) => {
        rawBytes += chunk.byteLength;
        if (rawBytes > byteLimit) {
          response.destroy(extractionError("response_too_large", "Source response exceeds the byte limit."));
        }
      });
      try {
        const chunks: Buffer[] = [];
        let decodedBytes = 0;
        const decoded = bodyDecoder(response);
        for await (const chunk of decoded as AsyncIterable<Buffer | Uint8Array | string>) {
          if (Date.now() >= deadline) {
            throw extractionError("timeout", "Source response timed out while reading.");
          }
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          decodedBytes += buffer.byteLength;
          if (decodedBytes > byteLimit) {
            throw extractionError("response_too_large", "Decoded source exceeds the byte limit.");
          }
          chunks.push(buffer);
        }
        const body = Buffer.concat(chunks, decodedBytes);
        const mediaType = detectSourceMediaType(
          Array.isArray(response.headers["content-type"])
            ? response.headers["content-type"][0]
            : response.headers["content-type"],
          body,
        );
        if (!allowedMediaTypes.includes(mediaType)) {
          throw extractionError(
            "unsupported_media_type",
            `Source returned disallowed ${mediaType.toUpperCase()} content.`,
          );
        }
        const mediaLimit = mediaType === "pdf" ? limits.maxPdfBytes : limits.maxHtmlBytes;
        if (body.byteLength > mediaLimit) {
          throw extractionError("response_too_large", `${mediaType.toUpperCase()} source exceeds its byte limit.`);
        }
        succeed({
          response: {
            requestedUrl,
            resolvedUrl: target.url.toString(),
            status,
            headers: response.headers,
            mediaType,
            body,
            rawBytes,
          },
        });
      } catch (error) {
        response.destroy();
        fail(error);
      }
    });
    request.end();
  });
}

/**
 * Downloads a bounded HTML/PDF response. Every redirect is re-resolved and the
 * TCP connection is pinned to a validated public address to prevent DNS rebinding.
 */
export async function safeFetchBytes(
  value: string | URL,
  options: SafeFetchOptions = {},
): Promise<BoundedHttpResponse> {
  const limits = resolveExtractionLimits(options.limits);
  const allowedMediaTypes = options.allowedMediaTypes?.length
    ? [...new Set(options.allowedMediaTypes)]
    : (["html", "pdf"] as const);
  const requested = normalizePublicHttpUrl(value);
  const deadline = Date.now() + limits.totalTimeoutMs;
  let current = requested;

  for (let redirects = 0; redirects <= limits.maxRedirects; redirects += 1) {
    const target = await resolvePublicTarget(current, limits);
    const result = await requestOnce(
      target,
      requested.toString(),
      limits,
      deadline,
      options.signal,
      options.userAgent ?? "signalCast/1.0 source reader",
      allowedMediaTypes,
    );
    if (result.response) return result.response;
    if (!result.redirect) throw extractionError("parse_failed", "Source request ended unexpectedly.");
    if (redirects === limits.maxRedirects) {
      throw extractionError("redirect_limit", "Source exceeded the redirect limit.");
    }
    current = result.redirect;
  }
  throw extractionError("redirect_limit", "Source exceeded the redirect limit.");
}

export function safeFetchSource(
  value: string | URL,
  options: SafeFetchOptions = {},
): Promise<BoundedHttpResponse> {
  return safeFetchBytes(value, {
    ...options,
    allowedMediaTypes: options.allowedMediaTypes ?? ["html", "pdf"],
  });
}
