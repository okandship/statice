// One Worker: API and serving, one entrypoint, a route per domain.
// Dispatch on Host first, `:port` and one trailing dot stripped.
//
//   api.statice.run        ->  /v1/* the API; anything else 404, no lookup
//   statice.app            ->  301 to https://statice.run, path and query kept
//   ends in .statice.app   ->  contains "-" = slug (L2); 52 chars = root (L1)
//   statice.run            ->  LANDING_ROOT if set  [retires when the record lands]
//   anything else          ->  domains/<host>, lowercased; no record -> 404

import { handleApi } from "./api";
import { labelToRoot } from "./base32";
import { decodeUtf8 } from "./manifest";
import { isHash } from "./validate";
import {
  ERROR_CACHE,
  IMMUTABLE,
  NO_CACHE,
  preflight,
  serveSite,
  siteError,
  siteRedirect,
  type Env,
} from "./serve";

const APP_SUFFIX = ".statice.app";
const TOMBSTONE = "0".repeat(64);

export function normalizeHost(raw: string): string {
  let host = raw;
  const colon = host.lastIndexOf(":");
  const bracket = host.lastIndexOf("]");
  if (colon > bracket) host = host.slice(0, colon);
  if (host.endsWith(".")) host = host.slice(0, -1); // one trailing dot
  return host;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let res: Response;
    try {
      res = await route(request, env);
    } catch (e) {
      // One catch at the entrypoint. Never `immutable`.
      const h = new Headers({
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": ERROR_CACHE,
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      res = new Response(`upstream error\n`, { status: 502, headers: h });
    }
    // Who served it, on every response this Worker makes. `Server` is not
    // available: Cloudflare's edge overwrites it with `cloudflare` on the way
    // out, whatever the Worker sets.
    res.headers.set("X-Served-By", "statice");
    return res;
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const host = normalizeHost(url.hostname);

  // --- the API has its own host.
  if (host === "api.statice.run") {
    return handleApi(request, env);
  }

  // --- everything below is the serving path. GET and HEAD serve, OPTIONS
  //     answers 204 from the method alone, and anything else is a 405 -- all
  //     before any read.
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "GET" && request.method !== "HEAD") {
    const res = siteError(405, "method not allowed");
    res.headers.set("Allow", "GET, HEAD, OPTIONS");
    return res;
  }

  // --- the apex redirect, never a domains/ lookup.
  if (host === "statice.app") {
    return siteRedirect(301, `https://statice.run${url.pathname}${url.search}`, ERROR_CACHE);
  }

  // --- layers 1 and 2. Case not folded.
  if (host.endsWith(APP_SUFFIX)) {
    const label = host.slice(0, -APP_SUFFIX.length);
    if (label === "" || label.includes(".")) return siteError(404, "not found");

    // The `-` test must run BEFORE the length test, or a 48-character slug at
    // width 3 makes a 52-character label that 404s a live site.
    if (label.includes("-")) {
      return serveSlug(request, env, label);
    }
    const root = labelToRoot(label);
    if (root === null) return siteError(404, "not found");
    // The root is in the name.
    return serveSite(request, env, root, IMMUTABLE);
  }

  // --- the landing pointer, until domains/statice.run lands.
  if (host === "statice.run" && isHash(env.LANDING_ROOT)) {
    return serveSite(request, env, env.LANDING_ROOT, NO_CACHE);
  }

  // --- the catch-all: layer 3.
  return serveDomain(request, env, host.toLowerCase());
}

async function serveSlug(request: Request, env: Env, label: string): Promise<Response> {
  // No server-side cache of the slug record, so a deploy is live the instant
  // the record is written.
  const obj = await env.BUCKET.get(`slugs/${label}`);
  if (obj === null) return siteError(404, "not found");
  const text = decodeUtf8(await obj.arrayBuffer());
  if (text.length < 129) return siteError(404, "not found");
  const root = text.slice(0, 64);
  // A root of 64 zeros is a tombstone: the label 404s.
  if (root === TOMBSTONE || !isHash(root)) return siteError(404, "not found");
  // A slug host proxies; redirecting would move the origin on every deploy.
  return serveSite(request, env, root, NO_CACHE);
}

async function serveDomain(request: Request, env: Env, host: string): Promise<Response> {
  const obj = await env.BUCKET.get(`domains/${host}`);
  if (obj === null) return siteError(404, "not found");
  // domains/ values carry a trailing newline -- take everything before the
  // first \n, or every bound domain 404s while the record sits correct in R2.
  const label = decodeUtf8(await obj.arrayBuffer()).split("\n")[0];
  if (label === "") return siteError(404, "not found");
  // From the record onward it IS a slug host.
  return serveSlug(request, env, label);
}
