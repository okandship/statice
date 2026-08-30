#!/usr/bin/env node
// The dangling-hostname reconcile. Multi-tenant only.
//
// Binding registers the custom hostname BEFORE it writes domains/<host>, which
// is the order that keeps per-hostname billing non-grindable — the proof
// precedes the only step that spends money. That order can leak, invisibly to a
// reconcile that walks domains/ alone: registration succeeds and the R2 write
// fails, so a hostname bills monthly with no record naming it.
//
// So this runs BOTH ways:
//   1. list the zone's custom hostnames
//   2. subtract what domains/ accounts for
//   3. unregister the rest
//
// This is billing reconciliation, not garbage collection: there is none of the
// latter. It touches custom hostnames only and never an R2 object, so it can
// never delete content.
//
//   CF_API_TOKEN=...  CF_ZONE_ID=...  R2_ACCOUNT_ID=...  \
//   R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=...  \
//     node ops/reconcile.mjs [--apply]

import { makeClient } from "./r2.mjs";

const APPLY = process.argv.includes("--apply");
const BUCKET = process.env.R2_BUCKET ?? "statice";

function env(name) {
  const v = process.env[name];
  if (!v) { console.error(`ops/reconcile: ${name} is not set.`); process.exit(1); }
  return v;
}

const TOKEN = env("CF_API_TOKEN");
const ZONE = env("CF_ZONE_ID");
const API = `https://api.cloudflare.com/client/v4/zones/${ZONE}/custom_hostnames`;

const auth = { Authorization: `Bearer ${TOKEN}` };

async function listCustomHostnames() {
  const out = [];
  for (let page = 1; ; page++) {
    const res = await fetch(`${API}?page=${page}&per_page=50`, {
      headers: auth, signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json();
    if (!body.success) throw new Error(JSON.stringify(body.errors));
    out.push(...body.result.map((h) => ({ id: h.id, hostname: h.hostname })));
    const info = body.result_info ?? {};
    if (page * (info.per_page ?? 50) >= (info.total_count ?? 0)) break;
  }
  return out;
}

const client = makeClient({
  accountId: env("R2_ACCOUNT_ID"),
  accessKeyId: env("R2_ACCESS_KEY_ID"),
  secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
});

const bound = new Set(
  (await client.list(BUCKET, "domains/")).map((k) => k.slice("domains/".length)),
);
const registered = await listCustomHostnames();

console.log(`  ${bound.size} bound in domains/, ${registered.length} custom hostnames on the zone`);

const dangling = registered.filter((h) => !bound.has(h.hostname.toLowerCase()));
if (dangling.length === 0) {
  console.log("  nothing dangling.");
  process.exit(0);
}

let failed = 0;
for (const h of dangling) {
  if (!APPLY) {
    console.log(`  would unregister ${h.hostname}  (${h.id})`);
    continue;
  }
  let ok = false;
  try {
    const res = await fetch(`${API}/${h.id}`, {
      method: "DELETE", headers: auth, signal: AbortSignal.timeout(15_000),
    });
    ok = res.ok;
  } catch { /* counted below */ }
  if (!ok) failed++;
  console.log(`  ${ok ? "unregistered" : "FAILED     "} ${h.hostname}`);
}

if (!APPLY) console.log("\n  re-run with --apply to unregister.");
// A hostname that stayed registered is still billing; a scheduler has to see
// that as a failure rather than a log line.
if (failed > 0) {
  console.error(`  ${failed} of ${dangling.length} could not be unregistered.`);
  process.exit(1);
}
