// /v1 is api.statice.run's entire surface, and nothing on statice.app ever asks
// for a key, so a request is API or content by the time Host is read.

import { rootToLabel, B32_ALPHABET } from "./base32";
import {
  isCanonicalPath,
  serializeManifest,
  sha256Hex,
  manifestHashes,
  decodeUtf8,
  type Entry,
} from "./manifest";
import { isAdmitted } from "./type-table";
import {
  MAX_BLOB_BYTES,
  MAX_DEPLOY_BODY_BYTES,
  MAX_DEPLOY_BYTES,
  MAX_FILES,
  bearerKey,
  isHash,
  isLabel,
  isToken,
  isUnderOwnedZone,
  parseContentLength,
  validateHost,
} from "./validate";
import {
  apiEmpty,
  apiJson,
  badRequest,
  conflict,
  lengthRequired,
  methodNotAllowed,
  notFound,
  tooLarge,
  unauthorized,
  unavailable,
  upstream,
} from "./respond";
import { checkProof, proofName } from "./dns";
import { registerHostname, saasEnabled, unregisterHostname } from "./saas";
import type { Env } from "./serve";

const TOMBSTONE = "0".repeat(64);
const SWEEP_WIDTH = 6; // the runtime's number and not a choice
const enc = new TextEncoder();

// A claim, an update or a bind is a few hundred bytes of JSON. The deploy
// route reads its cap before its parse; these routes get the same treatment at
// a smaller number, so no /v1 endpoint buffers an arbitrary body.
const MAX_SMALL_BODY_BYTES = 16 * 1024;

type Parsed<T> = { ok: true; body: T } | { ok: false; res: Response };

async function smallJson<T>(request: Request): Promise<Parsed<T>> {
  const declared = parseContentLength(request.headers.get("Content-Length"));
  if (declared === null) return { ok: false, res: lengthRequired("Content-Length required") };
  if (declared > MAX_SMALL_BODY_BYTES) return { ok: false, res: tooLarge("body over 16 KB") };
  try {
    return { ok: true, body: JSON.parse(await request.text()) as T };
  } catch {
    return { ok: false, res: badRequest("body is not valid json") };
  }
}

const urlFor = (root: string) => `https://${rootToLabel(root)}.statice.app`;
const slugUrl = (label: string) => `https://${label}.statice.app`;

/**
 * The key is admission, not identity: validate and discard, so nothing records
 * which key wrote what and the gate stays removable. Empty or missing fails
 * closed.
 */
async function admitted(request: Request, env: Env): Promise<boolean> {
  const raw = env.KEY_HASHES;
  if (typeof raw !== "string" || raw.trim() === "") return false;
  const key = bearerKey(request.headers.get("Authorization"));
  if (key === null) return false;
  const digest = await sha256Hex(enc.encode(key));
  for (const candidate of raw.split(",")) {
    if (candidate.trim().toLowerCase() === digest) return true;
  }
  return false;
}

async function pool<T, R>(items: T[], width: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(width, items.length); w++) {
    workers.push(
      (async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          out[i] = await fn(items[i]);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith("/v1/") && path !== "/v1") {
    return notFound("no such route");
  }
  if (!(await admitted(request, env))) {
    return unauthorized("missing, malformed or unknown key");
  }

  try {
    if (path === "/v1/deploy") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await deploy(request, env);
    }
    if (path.startsWith("/v1/blobs/")) {
      const hash = path.slice("/v1/blobs/".length);
      if (request.method !== "PUT") return methodNotAllowed("PUT");
      return await putBlob(request, env, hash);
    }
    if (path === "/v1/slugs") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await claimSlug(request, env);
    }
    if (path.startsWith("/v1/slugs/")) {
      const label = path.slice("/v1/slugs/".length);
      if (request.method === "POST") return await updateSlug(request, env, label);
      if (request.method === "DELETE") return await updateSlug(request, env, label, TOMBSTONE);
      if (request.method === "HEAD") return await checkSlug(request, env, label);
      return methodNotAllowed("POST, DELETE, HEAD");
    }
    if (path === "/v1/domains") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await bindDomain(request, env);
    }
    if (path.startsWith("/v1/domains/")) {
      const host = path.slice("/v1/domains/".length);
      if (request.method !== "DELETE") return methodNotAllowed("DELETE");
      return await unbindDomain(request, env, host);
    }
    return notFound("no such route");
  } catch (e) {
    return upstream(`storage error: ${String(e)}`);
  }
}

// ---------------------------------------------------------------- layer 1

interface DeployBody {
  files?: unknown;
  base?: unknown;
}

async function deploy(request: Request, env: Env): Promise<Response> {
  // Content-Length present, digits, <= 8 MB, READ BEFORE THE PARSE.
  const declared = parseContentLength(request.headers.get("Content-Length"));
  if (declared === null) return lengthRequired("Content-Length required");
  if (declared > MAX_DEPLOY_BODY_BYTES) return tooLarge("deploy body over 8 MB");

  let body: DeployBody;
  try {
    body = JSON.parse(await request.text()) as DeployBody;
  } catch {
    return badRequest("body is not valid json");
  }
  if (typeof body !== "object" || body === null) return badRequest("body must be an object");

  // ---- 1. Shape pass, zero I/O. Any failure rejects the whole request.
  const files = body.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    return badRequest("`files` must be an object");
  }
  const paths = Object.keys(files as Record<string, unknown>);
  if (paths.length < 1 || paths.length > MAX_FILES) {
    return badRequest(`\`files\` must hold 1..${MAX_FILES} entries`);
  }

  const entries: Entry[] = [];
  const sizeByHash = new Map<string, number>();
  for (const path of paths) {
    if (!isCanonicalPath(path)) return badRequest(`path is not canonical: ${JSON.stringify(path)}`);
    if (!isAdmitted(path)) return badRequest(`type not admitted: ${JSON.stringify(path)}`);
    const pair = (files as Record<string, unknown>)[path];
    if (!Array.isArray(pair) || pair.length !== 2) {
      return badRequest(`\`files\` values must be [hash, size]: ${JSON.stringify(path)}`);
    }
    const [hash, size] = pair as [unknown, unknown];
    if (!isHash(hash)) return badRequest(`bad hash for ${JSON.stringify(path)}`);
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) {
      return badRequest(`bad size for ${JSON.stringify(path)}`);
    }
    if (size > MAX_BLOB_BYTES) return tooLarge(`blob over 64 MB: ${JSON.stringify(path)}`);
    // One hash carries one size, with two declarations required to agree.
    const seen = sizeByHash.get(hash);
    if (seen !== undefined && seen !== size) {
      return badRequest(`hash ${hash} declared with two sizes`);
    }
    sizeByHash.set(hash, size);
    entries.push({ hash, path });
  }

  // 512 MB sums DISTINCT hashes; 1,000 counts entries.
  let total = 0;
  for (const size of sizeByHash.values()) total += size;
  if (total > MAX_DEPLOY_BYTES) return tooLarge("deploy over 512 MB of distinct blobs");

  // A shape failure rejects; a root that does not resolve is absent.
  const base = body.base;
  if (base !== undefined && !isHash(base)) return badRequest("`base` must be 64 hex");

  // ---- 2. Canonicalize, serialize once, hash those bytes -> root.
  //         The server computes it; a client-supplied root is never accepted.
  const canonical = serializeManifest(entries);
  if (canonical === null) return badRequest("duplicate path");
  const root = await sha256Hex(canonical);

  // ---- 3. If manifests/<root> exists, answer deployed and stop.
  const existing = await env.BUCKET.head(`manifests/${root}`);
  if (existing !== null) {
    return apiJson(200, { status: "deployed", root, url: urlFor(root) });
  }

  // ---- 4. base subtraction: presence, and presence only. Keyed on HASH,
  //         never on path.
  let remaining = new Set(sizeByHash.keys());
  if (typeof base === "string") {
    const baseObj = await env.BUCKET.get(`manifests/${base}`);
    if (baseObj !== null) {
      const known = manifestHashes(decodeUtf8(await baseObj.arrayBuffer()));
      const next = new Set<string>();
      for (const hash of remaining) if (!known.has(hash)) next.add(hash);
      remaining = next;
    }
  }

  // ---- 5. One head sweep, deduplicated, width 6.
  const sweep = [...remaining];
  const results = await pool(sweep, SWEEP_WIDTH, (hash) => env.BUCKET.head(`blobs/${hash}`));

  const missing: string[] = [];
  for (let i = 0; i < sweep.length; i++) {
    const meta = results[i];
    // Presence is non-null, never a truthy size.
    if (meta === null) {
      missing.push(sweep[i]);
      continue;
    }
    const declaredSize = sizeByHash.get(sweep[i])!;
    if (meta.size !== declaredSize) {
      return conflict(`stored size ${meta.size} contradicts declared ${declaredSize} for ${sweep[i]}`);
    }
  }

  // ---- 6.
  if (missing.length > 0) {
    missing.sort();
    return apiJson(200, { status: "incomplete", root, url: urlFor(root), missing });
  }
  await env.BUCKET.put(`manifests/${root}`, canonical);
  return apiJson(200, { status: "deployed", root, url: urlFor(root) });
}

async function putBlob(request: Request, env: Env, hash: string): Promise<Response> {
  if (!isHash(hash)) return badRequest("blob key must be 64 hex");
  const declared = parseContentLength(request.headers.get("Content-Length"));
  if (declared === null) return lengthRequired("Content-Length required");
  if (declared > MAX_BLOB_BYTES) return tooLarge("blob over 64 MB");

  // Never buffer a blob body to hash it -- the key goes in put()'s sha256
  // option and R2 refuses a mismatch, writing nothing.
  const value = declared === 0 ? new Uint8Array(0) : request.body;
  try {
    await env.BUCKET.put(`blobs/${hash}`, value, { sha256: hash });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    // R2's refusal must be told apart from R2 being down, or a corrupt upload
    // reads as an outage.
    if (/checksum|sha-?256|did not match|does not match/i.test(message)) {
      return badRequest("body does not hash to the key");
    }
    return upstream(`storage error: ${message}`);
  }
  return apiEmpty(201);
}

// ---------------------------------------------------------------- layer 2

/**
 * Lowercased, spaces to `-`, anything outside [a-z0-9-] dropped, runs
 * collapsed, capped at 55 -- 63 minus the ladder's widest rung minus the
 * separator -- and trimmed of leading/trailing `-` LAST.
 */
export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .slice(0, 55)
    .replace(/^-+|-+$/g, "");
}

function randomSuffix(width: number): string {
  const bytes = new Uint8Array(width);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < width; i++) s += B32_ALPHABET[bytes[i] & 31];
  return s;
}

function parseSlugRecord(text: string): { root: string; auth: string } | null {
  if (text.length < 129) return null;
  const root = text.slice(0, 64);
  const auth = text.slice(65, 129);
  if (!isHash(root) && root !== TOMBSTONE) return null;
  if (!isHash(auth)) return null;
  return { root, auth };
}

const slugRecord = (root: string, auth: string) => `${root} ${auth}\n`;

async function claimSlug(request: Request, env: Env): Promise<Response> {
  const parsed = await smallJson<{ slug?: unknown; root?: unknown; auth?: unknown }>(request);
  if (!parsed.ok) return parsed.res;
  const body = parsed.body;
  if (typeof body?.slug !== "string") return badRequest("`slug` must be a string");
  if (!isHash(body.root)) return badRequest("`root` must be 64 hex");
  // auth is the field that must not skip validation, the claim being the only
  // place it is ever examined.
  if (!isToken(body.auth)) return badRequest("`auth` must be 64 hex");

  const slug = sanitizeSlug(body.slug);
  if (slug === "") return badRequest("`slug` sanitizes to nothing");

  if ((await env.BUCKET.head(`manifests/${body.root}`)) === null) {
    return conflict("no such root");
  }

  const value = slugRecord(body.root, body.auth);
  // Any fixed width has a population at which claims start failing; a ladder
  // does not.
  for (const width of [3, 4, 5, 6, 7]) {
    const label = `${slug}-${randomSuffix(width)}`;
    // onlyIf returns null; it does not throw. The object form's
    // etagDoesNotMatch: "*" has a filed bug treating * as a literal etag.
    const written = await env.BUCKET.put(`slugs/${label}`, value, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
    });
    if (written !== null) {
      return apiJson(201, { label, url: slugUrl(label) });
    }
  }
  return unavailable("could not find a free label");
}

async function loadSlug(env: Env, label: string) {
  const obj = await env.BUCKET.get(`slugs/${label}`);
  if (obj === null) return null;
  const record = parseSlugRecord(decodeUtf8(await obj.arrayBuffer()));
  if (record === null) return null;
  return { ...record, etag: obj.etag };
}

async function tokenAuthorizes(token: string, auth: string): Promise<boolean> {
  return (await sha256Hex(enc.encode(token))) === auth;
}

async function updateSlug(
  request: Request,
  env: Env,
  label: string,
  forcedRoot?: string,
): Promise<Response> {
  if (!isLabel(label)) return badRequest("bad label");
  const token = request.headers.get("X-Statice-Token");
  if (!isToken(token)) return badRequest("X-Statice-Token must be 64 hex");

  let root = forcedRoot;
  if (root === undefined) {
    const parsed = await smallJson<{ root?: unknown }>(request);
    if (!parsed.ok) return parsed.res;
    const body = parsed.body;
    if (!isHash(body?.root)) return badRequest("`root` must be 64 hex");
    root = body.root;
  }

  const record = await loadSlug(env, label);
  if (record === null) return notFound("no such label");
  if (!(await tokenAuthorizes(token, record.auth))) return unauthorized("token mismatch");

  // An update racing an operator takedown loses rather than resurrecting the
  // record.
  const written = await env.BUCKET.put(`slugs/${label}`, slugRecord(root, record.auth), {
    onlyIf: { etagMatches: record.etag },
  });
  if (written === null) return unavailable("record changed under the update");
  return apiEmpty(204);
}

async function checkSlug(request: Request, env: Env, label: string): Promise<Response> {
  if (!isLabel(label)) return apiEmpty(400);
  const token = request.headers.get("X-Statice-Token");
  if (!isToken(token)) return apiEmpty(400);
  const record = await loadSlug(env, label);
  if (record === null) return apiEmpty(404);
  if (!(await tokenAuthorizes(token, record.auth))) return apiEmpty(401);
  return apiEmpty(204);
}

// ---------------------------------------------------------------- layer 3

async function bindDomain(request: Request, env: Env): Promise<Response> {
  const parsed = await smallJson<{ host?: unknown; label?: unknown }>(request);
  if (!parsed.ok) return parsed.res;
  const body = parsed.body;
  const host = validateHost(body?.host);
  if (host === null) return badRequest("`host` is not a bindable hostname");
  if (!isLabel(body?.label)) return badRequest("`label` must be [a-z0-9-]{1,63}");
  const label = body.label;
  const token = request.headers.get("X-Statice-Token");
  if (!isToken(token)) return badRequest("X-Statice-Token must be 64 hex");

  const record = await loadSlug(env, label);
  if (record === null) return notFound("no such label");
  if (!(await tokenAuthorizes(token, record.auth))) return unauthorized("token mismatch");

  // The proof precedes the only step that spends money.
  const proof = await checkProof(host, label, env.DOH_ENDPOINT);
  if (proof.state === "unknown") return unavailable(`could not resolve the proof: ${proof.reason}`);
  if (proof.state !== "match") {
    return conflict("the proof record is missing or names another label", {
      record: { name: proofName(host), type: "TXT", value: label },
      found: proof.state === "other" ? proof.found : [],
      note: "this is not a one-time check. leave the record in place; removing it releases the hostname.",
    });
  }

  const ownZone = isUnderOwnedZone(host, env.OWNED_ZONES ?? "");
  let manual: string;
  if (ownZone) {
    manual = `own zone — attach ${host} to the Worker as a custom domain`;
  } else {
    if (!saasEnabled(env)) {
      return conflict("multi-tenant custom hostnames are not enabled on this deployment");
    }
    const registered = await registerHostname(env, host);
    if (!registered.ok) return upstream(registered.message);
    manual = `multi-tenant — point ${host} CNAME connect.statice.app (DNS-only if your zone is on Cloudflare)`;
  }

  await env.BUCKET.put(`domains/${host}`, `${label}\n`);
  return apiJson(202, {
    host,
    label,
    url: `https://${host}`,
    mode: ownZone ? "own-zone" : "multi-tenant",
    manual,
    note: "leave the _statice TXT record in place. it is what keeps the binding yours.",
  });
}

async function unbindDomain(request: Request, env: Env, rawHost: string): Promise<Response> {
  const host = validateHost(decodeURIComponent(rawHost));
  if (host === null) return badRequest("`host` is not a bindable hostname");

  const obj = await env.BUCKET.get(`domains/${host}`);
  // Unbinding a host with no record is a 204, not a 404. No tombstone.
  if (obj === null) return apiEmpty(204);
  // domains/ values carry a trailing newline.
  const label = decodeUtf8(await obj.arrayBuffer()).split("\n")[0];

  const token = request.headers.get("X-Statice-Token");
  if (token !== null) {
    if (!isToken(token)) return badRequest("X-Statice-Token must be 64 hex");
    const record = await loadSlug(env, label);
    if (record === null || !(await tokenAuthorizes(token, record.auth))) {
      return unauthorized("token mismatch");
    }
  } else {
    // Or nothing at all, once the proof is gone: the TXT's absence IS the
    // domain saying it no longer wants the binding.
    const proof = await checkProof(host, label, env.DOH_ENDPOINT);
    if (proof.state === "unknown") return unavailable(`could not resolve the proof: ${proof.reason}`);
    if (proof.state === "match") return unauthorized("the proof still stands; a token is required");
  }

  // Unbind reverses the order, deleting the record first, so both fail toward a
  // state the reconcile can see.
  await env.BUCKET.delete(`domains/${host}`);
  await unregisterHostname(env, host);
  return apiEmpty(204);
}
