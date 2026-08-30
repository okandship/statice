// One entrypoint, two reads: manifests/<root>, then blobs/<hash>.
// A lookup table, not a router.

import { ISOLATION_MARKER, lookupType } from "./type-table";
import { cacheGet, cachePut } from "./manifest-cache";
import { decodeUtf8 } from "./manifest";

export const IMMUTABLE = "public, max-age=31536000, immutable";
export const NO_CACHE = "no-cache";
export const ERROR_CACHE = "public, max-age=60";

export interface Env {
  BUCKET: R2Bucket;
  KEY_HASHES?: string;
  LANDING_ROOT?: string;
  OWNED_ZONES?: string;
  SAAS_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  DOH_ENDPOINT?: string;
}

/**
 * Everything here is unconditional on EVERY response the serving path produces,
 * 404s and redirects included. Cache-Control is the one header that is a
 * function of the host, not the bytes.
 */
function baseHeaders(cachePolicy: string, isolated: boolean): Headers {
  const h = new Headers();
  h.set("Accept-Ranges", "bytes");
  h.set("Cache-Control", cachePolicy);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Expose-Headers", "ETag, Content-Range");
  h.set("Cross-Origin-Resource-Policy", "cross-origin");
  // COEP must go on every response, not just documents, or threaded WASM in a
  // worker is `blocked` while crossOriginIsolated still reads true.
  if (isolated) h.set("Cross-Origin-Embedder-Policy", "require-corp");
  return h;
}

export function siteError(status: number, message: string, isolated = false): Response {
  const h = baseHeaders(ERROR_CACHE, isolated);
  h.set("Content-Type", "text/plain; charset=utf-8");
  return new Response(message + "\n", { status, headers: h });
}

export function siteRedirect(status: number, location: string, cachePolicy: string, isolated = false): Response {
  const h = baseHeaders(cachePolicy, isolated);
  h.set("Content-Type", "text/plain; charset=utf-8");
  h.set("Location", location);
  return new Response("", { status, headers: h });
}

/** OPTIONS answers 204 from the method alone, with a wildcard CORS preflight. */
export function preflight(): Response {
  const h = new Headers();
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  // Range is not CORS-safelisted; the wildcard admits it.
  h.set("Access-Control-Allow-Headers", "*");
  h.set("Access-Control-Max-Age", "86400");
  h.set("Cross-Origin-Resource-Policy", "cross-origin");
  return new Response(null, { status: 204, headers: h });
}

/**
 * Split on `/` first, then percent-decode each segment strictly, NFC-normalize
 * and rejoin. A malformed sequence is a 404, never a 500. A decoded segment
 * that itself contains `/` can match no canonical manifest entry, so it is a
 * 404 rather than a second URL for the same bytes.
 */
export function resolvePath(rawPath: string): string | null {
  const parts = rawPath.split("/");
  const out: string[] = [];
  for (const part of parts) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (decoded.includes("/") || decoded.includes("\0")) return null;
    out.push(decoded.normalize("NFC"));
  }
  return out.join("/");
}

export interface ParsedRange {
  kind: "none" | "unsupported" | "range" | "suffix";
  start?: number;
  end?: number;
  suffix?: number;
}

/**
 * Exactly `bytes=<start>-<end?>` or `bytes=-<suffix>`, one range, no list.
 * Every other shape of the header gets the full 200 -- the fallback the RFC
 * sanctions, and the one answer that cannot be wrong bytes. The parse is ours,
 * never delegated to R2.
 */
export function parseRange(header: string | null): ParsedRange {
  if (header === null) return { kind: "none" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (m === null) return { kind: "unsupported" };
  const [, a, b] = m;
  if (a === "" && b === "") return { kind: "unsupported" };
  if (a === "") {
    const suffix = Number(b);
    if (!Number.isSafeInteger(suffix)) return { kind: "unsupported" };
    return { kind: "suffix", suffix };
  }
  const start = Number(a);
  if (!Number.isSafeInteger(start)) return { kind: "unsupported" };
  if (b === "") return { kind: "range", start };
  const end = Number(b);
  if (!Number.isSafeInteger(end)) return { kind: "unsupported" };
  if (end < start) return { kind: "unsupported" };
  return { kind: "range", start, end };
}

/** The opaque-tag half of an entity tag, with any weakness prefix dropped. */
function opaqueTag(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

/**
 * Parsed as the list it is, compared WEAKLY -- the comparison RFC 9110 13.1.2
 * mandates for If-None-Match, and the one that keeps revalidation working in
 * production: Cloudflare rewrites our strong ETag to `W/"<hash>"` on every
 * response it compresses at the edge, and the browser echoes that weak form
 * back. Comparing strongly here missed it and resent the whole body on each
 * refresh -- html/css/js/svg 200ing forever while woff2 and obj, which the
 * edge leaves alone, 304ed. `If-Range` stays a strong compare on purpose.
 */
function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  const want = opaqueTag(etag);
  for (const raw of header.split(",")) {
    const tag = raw.trim();
    if (tag === "*") return true;
    if (opaqueTag(tag) === want) return true;
  }
  return false;
}

async function loadManifest(env: Env, root: string): Promise<Map<string, string> | null> {
  const cached = cacheGet(root);
  if (cached !== undefined) return cached;
  const obj = await env.BUCKET.get(`manifests/${root}`);
  if (obj === null) return null;
  const buf = await obj.arrayBuffer();
  return cachePut(root, decodeUtf8(buf), buf.byteLength);
}

/**
 * The serving path proper. `cachePolicy` is chosen by the caller from the host.
 */
export async function serveSite(
  request: Request,
  env: Env,
  root: string,
  cachePolicy: string,
): Promise<Response> {
  const manifest = await loadManifest(env, root);
  // A miss is a 404 with no invented fallback.
  if (manifest === null) return siteError(404, "not found");

  const isolated = manifest.has(ISOLATION_MARKER);
  const url = new URL(request.url);

  const resolved = resolvePath(url.pathname);
  if (resolved === null) return siteError(404, "not found", isolated);

  let lookup = resolved;
  if (lookup.endsWith("/")) {
    const html = lookup + "index.html";
    const htm = lookup + "index.htm";
    if (manifest.has(html)) lookup = html;
    else if (manifest.has(htm)) lookup = htm;
    else return siteError(404, "not found", isolated);
  } else if (!manifest.has(lookup)) {
    // A path whose `<path>/` exists gets a 301 whose Location is the RAW
    // request path plus `/`, taking the answering host's cache policy.
    if (manifest.has(lookup + "/index.html") || manifest.has(lookup + "/index.htm")) {
      const location = url.pathname + "/" + url.search;
      return siteRedirect(301, location, cachePolicy, isolated);
    }
    // No 404.html, no SPA fallback, no extensionless lookup.
    return siteError(404, "not found", isolated);
  }

  const hash = manifest.get(lookup);
  if (hash === undefined) return siteError(404, "not found", isolated);

  const entry = lookupType(lookup);
  const contentType = entry === null ? "application/octet-stream" : entry.type;
  const etag = `"${hash}"`;

  const headers = baseHeaders(cachePolicy, isolated);
  headers.set("Content-Type", contentType);
  headers.set("ETag", etag);
  // COOP goes on text/html only.
  if (isolated && contentType.startsWith("text/html")) {
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
  }

  // Conditionals outrank ranges; a 304 never carries a slice.
  if (etagMatches(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  const key = `blobs/${hash}`;

  if (request.method === "HEAD") {
    const meta = await env.BUCKET.head(key);
    // A miss is reachable only by an operator's deliberate deletion.
    if (meta === null) return siteError(404, "not found", isolated);
    headers.set("Content-Length", String(meta.size));
    return new Response(null, { status: 200, headers });
  }

  // If-Range is load-bearing: present and equal to the strong ETag, the range
  // is honored; present and anything else -- the date form always, nothing here
  // emitting Last-Modified -- the full 200.
  const ifRange = request.headers.get("If-Range");
  const rangeAllowed = ifRange === null || ifRange.trim() === etag;
  const parsed = rangeAllowed ? parseRange(request.headers.get("Range")) : { kind: "none" as const };

  if (parsed.kind === "range" || parsed.kind === "suffix") {
    const meta = await env.BUCKET.head(key);
    if (meta === null) return siteError(404, "not found", isolated);
    const size = meta.size;

    let start: number;
    let end: number;
    if (parsed.kind === "suffix") {
      const suffix = parsed.suffix!;
      // A zero suffix is unsatisfiable -- the zero-is-falsy family again.
      if (suffix === 0 || size === 0) return unsatisfiable(headers, size);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parsed.start!;
      // A start at or past the blob's size fits nothing.
      if (start >= size) return unsatisfiable(headers, size);
      end = parsed.end === undefined ? size - 1 : Math.min(parsed.end, size - 1);
    }

    const length = end - start + 1;
    const obj = await env.BUCKET.get(key, { range: { offset: start, length } });
    if (obj === null || obj.body === null) return siteError(404, "not found", isolated);

    // A ranged get() still reports the WHOLE object in obj.size. It is
    // Content-Range's denominator and never the 206's Content-Length.
    headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
    headers.set("Content-Length", String(length));
    return streamed(obj.body, length, 206, headers);
  }

  const obj = await env.BUCKET.get(key);
  if (obj === null || obj.body === null) return siteError(404, "not found", isolated);
  headers.set("Content-Length", String(obj.size));
  return streamed(obj.body, obj.size, 200, headers);
}

function unsatisfiable(headers: Headers, size: number): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "text/plain; charset=utf-8");
  h.set("Content-Range", `bytes */${size}`);
  h.set("Cache-Control", ERROR_CACHE); // 416 is on the error policy like any other 4xx
  h.delete("Content-Length");
  return new Response("range not satisfiable\n", { status: 416, headers: h });
}

/**
 * Content-Length on a streamed Response is dropped unless it goes through
 * FixedLengthStream, whose pipe must not be awaited and must carry a .catch().
 */
function streamed(body: ReadableStream, length: number, status: number, headers: Headers): Response {
  const { readable, writable } = new FixedLengthStream(length);
  body.pipeTo(writable).catch(() => {});
  return new Response(readable, { status, headers });
}
