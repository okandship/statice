// The type table is mirrored in two files, in two languages, and the design
// freezes it in both directions:
//
//   "Client-side the table is frozen in both directions, because the CLI admits
//    files by it, so it decides which files a folder *has*."
//   "root = f(bytes, selection policy), and the policy is frozen as hard as the
//    encoding."
//
// Widening one copy alone mints new URLs from unchanged bytes with NOTHING
// DETECTING IT. This is that detection.
//
// It lives at the repo root rather than in either workspace because that is the
// only place both files exist at once -- and it is what would make splitting the
// CLI into its own repository safe, since nothing else would notice the drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const WORKER = read("../worker/src/type-table.ts");
const WORKER_ALL =
  WORKER + read("../worker/src/validate.ts") + read("../worker/src/base32.ts");
const CLI = read("../cli/statice.mjs");

/** Slice the object literal assigned to `name`, balancing braces. */
function objectLiteral(source, name) {
  const start = source.indexOf(name);
  assert.notEqual(start, -1, `${name} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced literal for ${name}`);
}

/**
 * Top-level keys of an object literal body, quoted or bare. Nested literals are
 * collapsed first -- the flagged entry is `map: { type, flag }`, and its inner
 * keys are not extensions.
 */
function keysOf(body) {
  let flat = body.replace(/\/\/[^\n]*/g, "");
  let previous;
  do {
    previous = flat;
    flat = flat.replace(/\{[^{}]*\}/g, "0");
  } while (flat !== previous);

  const keys = new Set();
  for (const m of flat.matchAll(/(?:^|,)\s*(?:"([^"]+)"|([A-Za-z_][\w-]*))\s*:/g)) {
    keys.add(m[1] ?? m[2]);
  }
  return keys;
}

const sorted = (set) => [...set].sort();

test("the admitted extension set is identical in both copies", () => {
  const worker = keysOf(objectLiteral(WORKER, "TYPE_TABLE"));
  const cli = keysOf(objectLiteral(CLI, "const TYPES"));
  assert.deepEqual(sorted(cli), sorted(worker),
    "worker/src/type-table.ts and cli/statice.mjs admit different extensions");
  assert.ok(worker.size > 30, "sanity: the table should not have parsed as near-empty");
});

test("the .well-known name set is identical in both copies", () => {
  const worker = keysOf(objectLiteral(WORKER, "WELL_KNOWN_TABLE"));
  const cli = keysOf(objectLiteral(CLI, "const WELL_KNOWN"));
  assert.deepEqual(sorted(cli), sorted(worker),
    "the extensionless /.well-known/ maps disagree");
  assert.ok(worker.has("cross-origin-isolated"),
    "the isolation marker must be admitted, or --isolated cannot deploy");
});

test("the same extensions are flagged, with the same reason", () => {
  // Flagged is a column on the type table, not a scanner.
  const workerFlags = new Map();
  for (const m of objectLiteral(WORKER, "TYPE_TABLE")
    .matchAll(/([A-Za-z_][\w-]*):\s*\{[^{}]*flag:\s*"([^"]+)"/g)) {
    workerFlags.set(m[1], m[2]);
  }
  const cliFlags = new Map();
  for (const m of objectLiteral(CLI, "const FLAGS").matchAll(/([A-Za-z_][\w-]*):\s*"([^"]+)"/g)) {
    cliFlags.set(m[1], m[2]);
  }
  assert.deepEqual([...cliFlags].sort(), [...workerFlags].sort(),
    "the flagged set or its wording drifted");
  // "the one flagged entry"
  assert.deepEqual([...workerFlags.keys()], ["map"]);
});

test("the isolation marker path is spelled the same in both", () => {
  const path = "/.well-known/cross-origin-isolated";
  assert.ok(WORKER.includes(`ISOLATION_MARKER = "${path}"`), "worker marker path");
  assert.ok(CLI.includes(`ISOLATION_MARKER = "${path}"`), "cli marker path");
});

test("the caps agree, since the CLI refuses before the server does", () => {
  const nums = (src, name) => {
    const m = new RegExp(`${name}\\s*=\\s*([^;]+);`).exec(src);
    assert.ok(m, `${name} not found`);
    // eslint-disable-next-line no-new-func
    return Function(`return (${m[1]})`)();
  };
  assert.equal(nums(CLI, "MAX_BLOB"), nums(WORKER_ALL, "MAX_BLOB_BYTES"), "64 MB blob cap");
  assert.equal(nums(CLI, "MAX_DEPLOY"), nums(WORKER_ALL, "MAX_DEPLOY_BYTES"), "512 MB deploy cap");
  assert.equal(nums(CLI, "MAX_FILES"), nums(WORKER_ALL, "MAX_FILES"), "1,000 entry cap");
});

test("base32 uses the same alphabet on both sides", () => {
  const alphabet = /"(abcdefghijklmnopqrstuvwxyz234567)"/;
  assert.match(WORKER_ALL, alphabet);
  assert.match(CLI, alphabet);
});
