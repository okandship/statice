#!/usr/bin/env node
// The slugs/ and domains/ export — the two prefixes a redeploy cannot
// reconstruct.
//
// blobs/ and manifests/ are content-addressed and re-derivable from any folder
// that still exists; slugs/ and domains/ are not. Losing slugs/ breaks every
// name at once and cannot be undone, because the token that owns a label lives
// only on its holder's machine.
//
// This acts on the whole bucket, so it is a script on a schedule and never an
// endpoint. It is a `list` and a copy: its R2 token is scoped **Object
// Read-only**, so nothing that can delete runs unattended.
//
//   R2_ACCOUNT_ID=...  R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=...  \
//     node ops/export.mjs [outdir]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeClient } from "./r2.mjs";

const BUCKET = process.env.R2_BUCKET ?? "statice";
const PREFIXES = ["slugs/", "domains/"];

function env(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ops/export: ${name} is not set.`);
    console.error("Create an R2 API token scoped **Object Read-only** for the");
    console.error("statice bucket, then export R2_ACCOUNT_ID, R2_ACCESS_KEY_ID");
    console.error("and R2_SECRET_ACCESS_KEY.");
    process.exit(1);
  }
  return v;
}

const client = makeClient({
  accountId: env("R2_ACCOUNT_ID"),
  accessKeyId: env("R2_ACCESS_KEY_ID"),
  secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
});

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(process.argv[2] ?? "./exports", stamp);
mkdirSync(outDir, { recursive: true });

let total = 0;
for (const prefix of PREFIXES) {
  const keys = await client.list(BUCKET, prefix);
  const records = {};
  for (const key of keys) records[key] = await client.get(BUCKET, key);
  const name = prefix.replace(/\/$/, "") + ".json";
  writeFileSync(join(outDir, name), JSON.stringify(records, null, 2) + "\n");
  console.log(`  ${prefix.padEnd(9)} ${String(keys.length).padStart(5)} records -> ${name}`);
  total += keys.length;
}

console.log(`exported ${total} records to ${outDir}`);
