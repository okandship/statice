#!/usr/bin/env node
// statice — type it in a folder, get a live URL.
//
// Single file, no dependencies. Every walk rule here is an input to the root,
// so each one is frozen: widening any of them mints new URLs from unchanged
// bytes with nothing detecting it.

import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync, chmodSync, createReadStream, existsSync, lstatSync, mkdirSync,
  readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse as parsePath, resolve } from "node:path";
import { createInterface } from "node:readline";

const API = process.env.STATICE_API ?? "https://api.statice.run";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The access key rides on every call, so the API is HTTPS -- or plain http on
 * a loopback address, which is what a stub under test is. Never http to a host
 * on the network: a typo'd STATICE_API would hand the key to whoever answers.
 */
function checkApi() {
  let u;
  try { u = new URL(API); } catch { die(`STATICE_API is not a URL: ${API}`); }
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return;
  die(`STATICE_API must be https, or http on loopback: ${API}`);
}
const HOME = join(homedir(), ".statice");
const KEY_FILE = join(HOME, "key");
const SLUG_DIR = join(HOME, "slugs");
const DEPLOYED = join(HOME, "deployed");

const MAX_BLOB = 64 * 1024 * 1024;
const MAX_DEPLOY = 512 * 1024 * 1024;
const MAX_FILES = 1000;
const DEPLOY_TIMEOUT_MS = 120_000;
const UPLOAD_WIDTH = 6;
// Above this many files a listing stops being a review and becomes a wall, so
// a shape takes over instead — the top-level breakdown for a first deploy, the
// extension tally for refusals. Presentation only: neither listing is an input
// to the root, unlike the walk rules and the type table.
const REVIEW_LIST_MAX = 20;

// ---------------------------------------------------------------- type table
// Mirrored byte-for-byte from worker/src/type-table.ts. FROZEN in both
// directions: the CLI admits files by it, so it decides which files a folder
// *has*.

const TYPES = {
  html: 1, htm: 1, css: 1, js: 1, mjs: 1, json: 1, wasm: 1, pck: 1, data: 1,
  map: 1,
  png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, avif: 1, bmp: 1, ico: 1, svg: 1,
  woff: 1, woff2: 1, ttf: 1, otf: 1,
  mp4: 1, webm: 1, mov: 1, ogv: 1, mp3: 1, wav: 1, ogg: 1, oga: 1, m4a: 1,
  flac: 1, aac: 1,
  obj: 1,
  pdf: 1, txt: 1, xml: 1, webmanifest: 1, vtt: 1, md: 1,
};

const WELL_KNOWN = {
  "cross-origin-isolated": 1, "apple-app-site-association": 1, assetlinks: 1,
  nodeinfo: 1, "host-meta": 1, webfinger: 1, "dnt-policy": 1, "change-password": 1,
};

// Flagged is a column on the type table, not a scanner: it admits the
// extension, names the file, reads no bytes, and carries the one line saying why.
const FLAGS = { map: "sourcemaps embed original source" };

const ISOLATION_MARKER = "/.well-known/cross-origin-isolated";

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
}

function admitted(path) {
  const ext = extensionOf(path);
  if (ext !== null) return Object.hasOwn(TYPES, ext);
  if (!path.startsWith("/.well-known/")) return false;
  const rest = path.slice("/.well-known/".length);
  return !rest.includes("/") && Object.hasOwn(WELL_KNOWN, rest.toLowerCase());
}

const flagOf = (path) => {
  const ext = extensionOf(path);
  return ext === null ? undefined : FLAGS[ext];
};

// ---------------------------------------------------------------- base32

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function encodeBase32(bytes) {
  let out = "", acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(acc >>> bits) & 31]; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

// ---------------------------------------------------------------- output

const ESC = "\u001b";
const isTTY = process.stdout.isTTY === true;
const dim = (s) => (isTTY ? `${ESC}[2m${s}${ESC}[0m` : s);
const bold = (s) => (isTTY ? `${ESC}[1m${s}${ESC}[0m` : s);
const out = (s = "") => process.stdout.write(s + "\n");
const err = (s) => process.stderr.write(s + "\n");

function die(message, code = 1) {
  err(`statice: ${message}`);
  process.exit(code);
}

const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

// ---------------------------------------------------------------- key & home

function ensureHome() {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  mkdirSync(SLUG_DIR, { recursive: true, mode: 0o700 });
  // Set at creation, and re-asserted: 0700 with 0600 files.
  try { chmodSync(HOME, 0o700); chmodSync(SLUG_DIR, 0o700); } catch { /* not ours */ }
}

const isSymlink = (path) => {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
};

/**
 * A private file is written whole to a sibling and renamed into place, never
 * through the path itself: a symlink left at ~/.statice/key or at
 * slugs/<label> would otherwise be followed, and the secret would land wherever
 * it points. The rename replaces a symlink rather than following it, and a
 * crash mid-write leaves a dotted temp file rather than a torn secret.
 */
function writePrivate(path, contents) {
  if (isSymlink(path)) die(`refusing to write through a symlink: ${path}`);
  const tmp = join(dirname(path), `.tmp-${randomBytes(8).toString("hex")}`);
  writeFileSync(tmp, contents, { mode: 0o600, flag: "wx" });
  try { chmodSync(tmp, 0o600); } catch { /* not ours */ }
  renameSync(tmp, path);
}

/** The project pointer is public, but it is still never written through a symlink. */
function writeLabel(label) {
  const path = STATICE_FILE();
  if (isSymlink(path)) die(`refusing to write through a symlink: ${path}`);
  writeFileSync(path, `${label}\n`);
}

function accessKey() {
  if (process.env.STATICE_KEY) return process.env.STATICE_KEY;
  // Naming the address matters more than naming the command: `statice key`
  // stores a key, it cannot obtain one, so on its own it is a loop.
  if (!existsSync(KEY_FILE)) {
    die("no access key. keys are issued by hand — email access@statice.run for one, then run `statice key`.");
  }
  return readFileSync(KEY_FILE, "utf8").replace(/\n$/, "");
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// ---------------------------------------------------------------- http

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * `body` is always a plain object, so every caller can test fields without a
 * guard: a non-JSON or non-object answer is `{}`, which no success test ever
 * matches. The status comes back beside it; a success is the pair, never the
 * body alone.
 */
async function apiFetch(path, { method = "GET", body, headers = {}, timeoutMs } = {}) {
  checkApi();
  const h = { Authorization: `Bearer ${accessKey()}`, ...headers };
  if (body !== undefined) h["Content-Length"] = String(body.length);
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  let res;
  try {
    // Authenticated calls never follow a redirect: the key would follow too.
    res = await fetch(`${API}${path}`, { method, headers: h, body, signal, redirect: "manual" });
  } catch (e) {
    // A timed-out call is `upstream` from where the client sits, an attempt spent.
    return { status: 0, body: { error: "upstream", message: String(e?.message ?? e) } };
  }
  let parsed = null;
  const text = await res.text();
  if (text && text.length <= MAX_RESPONSE_BYTES) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  return { status: res.status, body: isObject(parsed) ? parsed : {} };
}

const jsonBody = (obj) => Buffer.from(JSON.stringify(obj), "utf8");

const HEX64 = /^[0-9a-f]{64}$/;
const isHex64 = (v) => typeof v === "string" && HEX64.test(v);
/** One host under one domain, https, nothing after it: the only URL shape the API mints. */
const isSiteUrl = (v) => typeof v === "string" && /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/.test(v);

// ---------------------------------------------------------------- the walk

const PRUNE = new Set([".git", "node_modules"]);

// Agent instructions, dropped by NAME at every depth. `.md` is an admitted
// type, so nothing else stops a CLAUDE.md being served beside the site it
// describes -- and it is written to be read by an agent standing in the folder,
// never by the web. Case-folded, because the name is a convention rather than
// an extension, and half the filesystems it is typed on cannot tell the
// spellings apart.
const AGENT_FILES = new Set(["claude.md", "agents.md"]);

function refuseWrongFolder(dir) {
  if (resolve(dir) === resolve(homedir())) die("refusing to deploy your home directory.");
  if (resolve(dir) === parsePath(resolve(dir)).root) die("refusing to deploy a filesystem root.");
}

/**
 * Walk cwd. Prune .git, node_modules and dotdirs except a TOP-LEVEL
 * .well-known; skip symlinks; drop agent instruction files by name; admit by
 * the type table; build the canonical path here, because the server will not;
 * record each file's size.
 *
 * Two leftover lists, not one. `refused` is what the type table turned away;
 * `skipped` is what the walk removed before the table ever saw it. Both are
 * returned, because a drop the listing cannot name is a drop nobody reviews.
 */
function walk(root) {
  const files = [];
  const refused = [];
  const skipped = [];

  const visit = (dir, depth, prefix) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      die(`cannot read ${dir}: ${e.message}`);
    }
    for (const entry of entries) {
      // Separators to /, leading /, NFC. Built before the drops rather than
      // after them, because a dropped path still has to be printable.
      const path = `${prefix}/${entry.name}`.normalize("NFC");
      const full = join(dir, entry.name);
      // Skipped symlinks — a frozen rule, so never followed and never hashed.
      if (entry.isSymbolicLink()) { skipped.push({ path, why: "symlink" }); continue; }
      if (entry.isDirectory()) {
        // A pruned tree is named with a trailing slash and no count: it is
        // never visited, so the count would cost exactly the work the prune
        // exists to avoid.
        if (PRUNE.has(entry.name)) { skipped.push({ path: `${path}/`, why: "pruned" }); continue; }
        if (entry.name.startsWith(".") && !(depth === 0 && entry.name === ".well-known")) {
          skipped.push({ path: `${path}/`, why: "dotfolder" });
          continue;
        }
        visit(full, depth + 1, path);
        continue;
      }
      if (!entry.isFile()) { skipped.push({ path, why: "not a regular file" }); continue; }
      if (AGENT_FILES.has(entry.name.toLowerCase())) {
        skipped.push({ path, why: "agent instructions" });
        continue;
      }
      if (!admitted(path)) { refused.push(path); continue; }
      let size;
      // A file that cannot be stat'd is dropped, so it is named — silently
      // publishing 129 of the 130 files you have is the failure this catches.
      try { size = statSync(full).size; } catch { skipped.push({ path, why: "unreadable" }); continue; }
      files.push({ path, full, size });
    }
  };

  visit(root, 0, "");
  // Sorted by path, strictly ascending, comparing UTF-8 bytes.
  const byBytes = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  files.sort((a, b) => byBytes(a.path, b.path));
  // Refusals are presentation, but readdir order is not stable across
  // filesystems, so they get the same ordering rather than an arbitrary one.
  refused.sort(byBytes);
  skipped.sort((a, b) => byBytes(a.path, b.path));
  return { files, refused, skipped };
}

function hashFile(full) {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    createReadStream(full)
      .on("data", (c) => h.update(c))
      .on("end", () => res(h.digest("hex")))
      .on("error", rej);
  });
}

async function hashAll(files) {
  // Bounded so a wide tree does not open a thousand descriptors.
  let next = 0;
  const workers = Array.from({ length: Math.min(16, files.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      files[i].hash = await hashFile(files[i].full);
    }
  });
  await Promise.all(workers);
  return files;
}

const manifestBytes = (files) =>
  Buffer.from(files.map((f) => `${f.hash} ${f.path}\n`).join(""), "utf8");

// ---------------------------------------------------------------- the log

/**
 * `<iso-8601> <root-hex> <absolute path>\n`, sliced at BYTE OFFSETS because a
 * path may contain spaces. A log, never a source of truth — and the only way
 * back to a 52-character URL nobody can retype.
 */
function recordDeploy(root, dir) {
  ensureHome();
  const iso = new Date().toISOString(); // fixed width: 24 chars
  appendFileSync(DEPLOYED, `${iso} ${root} ${resolve(dir)}\n`, { mode: 0o600 });
}

function readLog() {
  if (!existsSync(DEPLOYED)) return [];
  return readFileSync(DEPLOYED, "utf8").split("\n").filter(Boolean).map((line) => ({
    when: line.slice(0, 24),
    root: line.slice(25, 89),
    dir: line.slice(90),
  }));
}

/** The most recent line whose path matches cwd. Advisory: stale costs one read. */
function baseFor(dir) {
  const target = resolve(dir);
  const lines = readLog();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].dir === target && /^[0-9a-f]{64}$/.test(lines[i].root)) return lines[i].root;
  }
  return undefined;
}

const deployedBefore = (dir) => readLog().some((l) => l.dir === resolve(dir));

// ---------------------------------------------------------------- review

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (a) => { rl.close(); res(a); }));
}

/** A token never appears in argv or on stdout. */
function promptHidden(question) {
  return new Promise((res) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return res(value);
        }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * One rule: a deploy names what is new. A first deploy's new set is the whole
 * folder, and a listing of 847 files is not a review — so that case gets the
 * shape instead, plus the files a summary must never summarize away.
 *
 * Only the prompt is interactive, never the listing: CI keeps working and its
 * log still carries the record.
 *
 * Refusals are part of the listing rather than something printed after it. A
 * folder that yields one admitted file and 206 refusals is the wrong-folder
 * mistake wearing a disguise, and the question has to come after that, not
 * before it.
 *
 * And the listing accounts for the WHOLE folder: what the type table refused,
 * then what the walk dropped before the table saw it. Two lists rather than
 * one, because the reasons differ and so does the fix — but a count that
 * covered only the first is the count that lets a symlinked tree, or a folder
 * that is all dotfolders, leave without a word.
 */
async function review({ files, refused, skipped, isFirst, totalBytes, dryRun = false }) {
  if (!isFirst && !dryRun) {
    out(`  scanning ${plural(files.length, "file")}`);
    namedRefusals(refused);
    namedSkips(skipped);
    return true;
  }

  const why = dryRun ? "dry run, nothing leaves this machine" : "first deploy from this folder";
  out(`  scanning ${plural(files.length, "file")}, ${humanBytes(totalBytes)} — ${why}`);
  out();

  // A deploy names what is new, and on a first deploy everything is. The
  // top-level shape is a CONCESSION to volume -- 847 filenames are not a
  // review -- so it applies only where the listing would stop being one. Below
  // that, naming the files IS the review, and summarizing them hides the one
  // thing worth looking at.
  if (files.length <= REVIEW_LIST_MAX) {
    const width = Math.max(...files.map((f) => f.path.length));
    for (const f of files) {
      out(`    ${f.path.padEnd(width)}  ${humanBytes(f.size).padStart(9)}`);
    }
  } else {
    // Top-level breakdown: it catches the mistake that actually happens, which
    // is deploying the repo root instead of dist/.
    const groups = new Map();
    for (const f of files) {
      const slash = f.path.indexOf("/", 1);
      const top = slash === -1 ? "/" : f.path.slice(0, slash);
      const g = groups.get(top) ?? { count: 0, bytes: 0 };
      g.count++; g.bytes += f.size;
      groups.set(top, g);
    }
    const width = Math.max(...[...groups.keys()].map((k) => k.length));
    const countWidth = Math.max(...[...groups.values()].map((g) => plural(g.count, "file").length));
    for (const [top, g] of [...groups].sort((a, b) => b[1].bytes - a[1].bytes)) {
      const where = top === "/" ? "/ (top level)" : top;
      out(`    ${where.padEnd(Math.max(width, 13))}  ${plural(g.count, "file").padStart(countWidth)}  ${humanBytes(g.bytes).padStart(9)}`);
    }
  }

  namedFlags(files);
  namedRefusals(refused, { lead: true });
  namedSkips(skipped, { lead: true });

  out();
  // A dry run is the listing and nothing after it.
  if (dryRun) return true;
  // The total, and the word permanent. This line is part of the LISTING, so it
  // prints with no TTY too: a first deploy skips only the waiting, and CI's log
  // still carries the record.
  const question = `  deploy ${plural(files.length, "file")} to a ${bold("permanent")} URL?`;
  if (!process.stdin.isTTY) { out(question); return true; }
  const answer = await ask(`${question} [y/N] `);
  return /^y(es)?$/i.test(answer.trim());
}

/**
 * Name what the type table left behind. Usually that is two lines of editor
 * droppings and a `.statice`; occasionally it is the source tree you did not
 * mean to be standing in — and a bare count cannot tell those apart, which is
 * the whole reason to print the paths.
 *
 * Volume gets the same concession the review makes, but the useful shape here
 * is the EXTENSION tally rather than the top-level one: refusals cluster by
 * type, not by directory, so `.ts 188` answers "is this the set I expected to
 * be skipped?" in a glance that 188 paths does not.
 */
function namedRefusals(refused, { lead = false } = {}) {
  if (refused.length === 0) return;
  if (lead) out();
  out(`  ${dim(`${plural(refused.length, "file")} not an admitted type`)}`);

  if (refused.length <= REVIEW_LIST_MAX) {
    for (const path of refused) out(`    ${dim(path)}`);
    return;
  }

  const groups = new Map();
  for (const path of refused) {
    const ext = extensionOf(path);
    const key = ext === null ? "(no extension)" : `.${ext}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const rows = [...groups].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const width = Math.max(...rows.map(([key]) => key.length));
  const countWidth = Math.max(...rows.map(([, n]) => String(n).length));
  for (const [key, n] of rows) {
    out(`    ${dim(`${key.padEnd(width)}  ${String(n).padStart(countWidth)}`)}`);
  }
}

/** Every flagged file named, however many, on every deploy in which it is new. */
function namedFlags(files) {
  const flagged = files.filter((f) => flagOf(f.path));
  if (flagged.length === 0) return;
  out();
  out(`  flagged — ${flagOf(flagged[0].path)}:`);
  for (const f of flagged) out(`    ${f.path}   ${humanBytes(f.size)}`);
}

/**
 * Name what the WALK left behind — a different list from the table's, and a
 * different question. Refusals are droppings you scan for a surprise; these
 * were removed by a rule, so each line carries the rule that removed it,
 * because "why is /vendor not in my deploy" has exactly one answer per path.
 *
 * Volume gets the same concession the refusals make, tallied by REASON rather
 * than by extension: 40 skips is one symlink farm or one dotfolder-heavy repo,
 * and the tally is what tells those apart.
 */
function namedSkips(skipped, { lead = false } = {}) {
  if (skipped.length === 0) return;
  if (lead) out();
  out(`  ${dim(`${plural(skipped.length, "path")} skipped for other reasons`)}`);

  if (skipped.length <= REVIEW_LIST_MAX) {
    const width = Math.max(...skipped.map((s) => s.path.length));
    for (const s of skipped) out(`    ${dim(`${s.path.padEnd(width)}  ${s.why}`)}`);
    return;
  }

  const groups = new Map();
  for (const s of skipped) groups.set(s.why, (groups.get(s.why) ?? 0) + 1);
  const rows = [...groups].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const width = Math.max(...rows.map(([why]) => why.length));
  const countWidth = Math.max(...rows.map(([, n]) => String(n).length));
  for (const [why, n] of rows) {
    out(`    ${dim(`${why.padEnd(width)}  ${String(n).padStart(countWidth)}`)}`);
  }
}

// ---------------------------------------------------------------- uploads

function uploadTimeoutMs(size) {
  // A stall timeout rather than a deadline: 64 MB on a home uplink is
  // legitimate minutes, so the allowance scales with the bytes.
  return 120_000 + Math.ceil(size / 65536) * 1000;
}

/** Returns the hashes that did not land, so a caller that must be sure can retry them. */
async function uploadBlobs(byHash, hashes) {
  let next = 0;
  const failed = [];
  const workers = Array.from({ length: Math.min(UPLOAD_WIDTH, hashes.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= hashes.length) return;
      const file = byHash.get(hashes[i]);
      if (!file) continue;
      let body;
      try {
        body = readFileSync(file.full);
      } catch (e) {
        err(`  ! cannot read ${file.path}: ${e.message}`);
        failed.push(hashes[i]);
        continue;
      }
      // Send Uint8Array bodies, never streams, or every upload 411s from a
      // client that looks correct.
      const res = await apiFetch(`/v1/blobs/${hashes[i]}`, {
        method: "PUT", body, timeoutMs: uploadTimeoutMs(body.length),
      });
      // A failed blob PUT does not abort its round: the other uploads still
      // count, and on the ordinary path the next deploy call is the arbiter of
      // what is missing.
      if (res.status !== 201) failed.push(hashes[i]);
    }
  });
  await Promise.all(workers);
  return failed;
}

/** The 52-character label a root serves under, so a dry run can name the URL. */
const rootLabel = (root) => encodeBase32(Buffer.from(root, "hex"));

// ---------------------------------------------------------------- deploy

async function deploy(opts) {
  const dir = process.cwd();
  // Refuse the wrong folder before anything is hashed.
  refuseWrongFolder(dir);

  if (opts.isolated) {
    const wk = join(dir, ".well-known");
    const marker = join(wk, "cross-origin-isolated");
    if (opts.dryRun) {
      out(`  would write ${dim(ISOLATION_MARKER)}`);
    } else {
      mkdirSync(wk, { recursive: true });
      if (!existsSync(marker)) writeFileSync(marker, "");
      out(`  wrote ${dim(ISOLATION_MARKER)}`);
    }
  }

  const { files, refused, skipped } = walk(dir);
  if (files.length === 0) {
    // Nothing publishable is the wrong-folder mistake at its loudest, and the
    // listing that would have explained it never prints. So the refusal counts
    // what the folder DID hold, both leftover lists, rather than leaving you
    // to wonder where the 130 files went.
    const left = [
      refused.length ? `${plural(refused.length, "file")} not an admitted type` : null,
      skipped.length ? `${plural(skipped.length, "path")} skipped by the walk` : null,
    ].filter(Boolean).join(", ");
    die(`no publishable files here${left ? ` — ${left}` : ""}.`);
  }
  if (files.length > MAX_FILES) die(`${files.length} files; the cap is ${MAX_FILES}.`);

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    if (f.size > MAX_BLOB) die(`${f.path} is ${humanBytes(f.size)}; the cap is 64 MB.`);
  }

  await hashAll(files);

  const byHash = new Map();
  for (const f of files) if (!byHash.has(f.hash)) byHash.set(f.hash, f);
  let distinct = 0;
  for (const f of byHash.values()) distinct += f.size;
  if (distinct > MAX_DEPLOY) die(`${humanBytes(distinct)} of distinct blobs; the cap is 512 MB.`);

  const root = sha256(manifestBytes(files));
  const isFirst = !deployedBefore(dir);

  // base is advisory: stale, truncated or missing, it costs one wasted read.
  const base = opts.verify ? undefined : baseFor(dir);

  const filesField = {};
  for (const f of files) filesField[f.path] = [f.hash, f.size];
  const body = jsonBody({ files: filesField, ...(base ? { base } : {}) });
  if (body.length > 8 * 1024 * 1024) die("manifest over the 8 MB deploy-body cap.");

  const approved = await review({ files, refused, skipped, isFirst, totalBytes, dryRun: opts.dryRun });
  if (!approved) { out("  cancelled."); process.exit(1); }

  // A dry run stops here: the listing, the root, and the URL it would have --
  // no key read, no request made, no line in the log.
  if (opts.dryRun) return { root, url: `https://${rootLabel(root)}.statice.app`, dryRun: true };

  if (opts.verify) {
    // --verify skips both shortcuts by restoring every blob before it asks, so
    // the manifest-exists answer can no longer hide an operator's deletion.
    // Which is only true if every blob actually lands: one retry for the ones
    // that did not, then a refusal, because a deploy call after a failed
    // repair answers `deployed` from the manifest alone and would call the
    // site verified when it is not.
    out(`  verifying — re-uploading all ${byHash.size} blobs`);
    let failed = await uploadBlobs(byHash, [...byHash.keys()]);
    if (failed.length > 0) failed = await uploadBlobs(byHash, failed);
    if (failed.length > 0) {
      die(`${plural(failed.length, "blob")} of ${byHash.size} could not be re-uploaded; the site is not verified.`);
    }
  }

  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // The same body, byte for byte, every time.
    const res = await apiFetch("/v1/deploy", {
      method: "POST", body,
      headers: { "Content-Type": "application/json" },
      timeoutMs: DEPLOY_TIMEOUT_MS,
    });
    last = res;
    const b = res.body;

    // Success is the status AND the body, and the body has to name the root
    // this machine computed: a `deployed` beside a different root is a site
    // that is not this folder, and a URL is only ever printed for a site that
    // is there.
    if (res.status === 200 && b.status === "deployed") {
      if (b.root !== root) {
        die(`the server named a different root (${String(b.root).slice(0, 12)}…) for this folder's ${root.slice(0, 12)}…; refusing to trust it.`);
      }
      if (!isSiteUrl(b.url)) die("the server returned a malformed url.");
      recordDeploy(root, dir);
      return { root, url: b.url };
    }
    // The loop retries only what could change on its own: a network failure,
    // a 5xx, the API's own `upstream`. Every other error is deterministic on a
    // body that never changes, so asking again is asking louder.
    const transient = res.status === 0 || res.status >= 500 || b.error === "upstream";
    if (!transient) {
      if ("error" in b) die(`${b.error}: ${b.message ?? "(no message)"}`);
      if (res.status !== 200 || b.status !== "incomplete") die(`deploy failed: http ${res.status}.`);
    }
    // The third attempt uploads nothing: with no GC, bytes uploaded for a
    // deploy that never lands are permanent.
    if (attempt < 3) {
      const missing = b.status === "incomplete" && Array.isArray(b.missing)
        ? b.missing.filter(isHex64) : [];
      if (missing.length > 0 && !opts.verify) {
        const named = missing.map((h) => byHash.get(h)).filter(Boolean);
        out(`  uploading ${plural(named.length, "new blob")}`);
        // Name each new blob as it uploads, so a REDEPLOY lists only the
        // change. A first deploy's new set is the whole folder, which the
        // review has already shown -- as the files themselves when there are
        // few, and as the shape when a listing would stop being a review.
        // Reprinting it here would undo that choice.
        if (!isFirst) {
          for (const f of named) out(`    ${dim(f.path)}`);
          namedFlags(named);
        }
      }
      if (missing.length > 0) await uploadBlobs(byHash, missing);
    }
  }
  // Never a url for a site that is not there.
  const e = last?.body ?? {};
  die(`deploy did not complete: ${e.error ?? "incomplete"}${e.message ? ` — ${e.message}` : ""}`);
}

// ---------------------------------------------------------------- layer 2

const STATICE_FILE = () => join(process.cwd(), ".statice");

// A label is the one shape the server mints, and the one shape that can name
// a file under ~/.statice/slugs. Everything that arrives as a label -- the
// project's .statice, an argument, a claim response -- is held to it BEFORE
// it is joined to a path, because `../../.ssh/id_ed25519` is not a label and
// must never become a token file.
const LABEL = /^[a-z0-9-]{1,63}$/;
const isLabel = (v) => typeof v === "string" && LABEL.test(v);

function readLabel() {
  const path = STATICE_FILE();
  let text;
  try {
    // Not existsSync: it is true for a directory too, and in $HOME `.statice`
    // IS a directory -- this CLI's own config dir.
    if (!statSync(path).isFile()) return null;
    text = readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
  if (text === "") return null;
  if (!isLabel(text)) die(`.statice does not hold a label: ${JSON.stringify(text.slice(0, 80))}`);
  return text;
}

function tokenPath(label) {
  if (!isLabel(label)) die(`not a label: ${JSON.stringify(String(label).slice(0, 80))}`);
  return join(SLUG_DIR, label);
}

function readToken(label) {
  if (process.env.STATICE_TOKEN) return process.env.STATICE_TOKEN;
  const p = tokenPath(label);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").split("\n")[0].trim();
}

function tokenDir(label) {
  const p = tokenPath(label);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").split("\n")[1]?.trim() ?? null;
}

/** Lowercased, spaces to -, the rest dropped, runs collapsed, capped, trimmed LAST. */
const sanitizeSlug = (raw) =>
  raw.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-").slice(0, 55).replace(/^-+|-+$/g, "");

const AVOID = new Set(["dist", "build", "out", "public", "www", "site", "_site", "docs", ".output"]);

function defaultName() {
  const dir = process.cwd();
  const base = basename(dir);
  if (!AVOID.has(base)) return base;
  const parent = basename(dirname(dir));
  return parent === "" ? null : parent;
}

/**
 * A token reaches disk before the network is trusted: written to
 * .pending-<16 random hex> BEFORE the POST, promoted on success, and never
 * silently deleted — so a re-claim sends that file's auth and promotes that
 * same file rather than minting fresh bytes.
 */
function pendingPath(slug) {
  ensureHome();
  for (const name of readdirSync(SLUG_DIR).filter((n) => n.startsWith(".pending-"))) {
    const p = join(SLUG_DIR, name);
    const lines = readFileSync(p, "utf8").split("\n");
    if (lines[1]?.trim() === resolve(process.cwd()) && lines[2]?.trim() === slug) return p;
  }
  return join(SLUG_DIR, `.pending-${randomBytes(8).toString("hex")}`);
}

async function claimName(name, root) {
  const slug = sanitizeSlug(name);
  if (slug === "") return { ok: false, reason: "that name sanitizes to nothing" };

  const pending = pendingPath(slug);
  let token;
  if (existsSync(pending)) {
    token = readFileSync(pending, "utf8").split("\n")[0].trim();
  } else {
    // Generated locally; only SHA256(token) is ever sent.
    token = randomBytes(32).toString("hex");
    writePrivate(pending, `${token}\n${resolve(process.cwd())}\n${slug}\n`);
  }
  const auth = sha256(Buffer.from(token, "utf8"));

  const res = await apiFetch("/v1/slugs", {
    method: "POST", body: jsonBody({ slug, root, auth }),
    headers: { "Content-Type": "application/json" }, timeoutMs: 30_000,
  });
  if (res.status !== 201) {
    return { ok: false, code: res.body.error,
             reason: res.body.message ?? res.body.error ?? `http ${res.status}` };
  }
  const { label, url } = res.body;
  // The label names a file under ~/.statice/slugs, so the response is held to
  // the one shape the server mints before it touches the filesystem. The
  // pending file stays: a re-claim sends the same auth.
  if (!isLabel(label) || !label.startsWith(`${slug}-`) || !isSiteUrl(url)) {
    return { ok: false, reason: "the server returned a malformed claim; nothing was written" };
  }
  // Promote that same file.
  writePrivate(tokenPath(label), `${token}\n${resolve(process.cwd())}\n`);
  rmSync(pending, { force: true });
  writeLabel(label);
  return { ok: true, label, url };
}

async function updateName(label, root) {
  const token = readToken(label);
  // A label with no matching token is not an error: deploy to the hash URL and
  // say why.
  if (!token) return { ok: false, reason: `no token for ${label} on this machine` };

  const claimedIn = tokenDir(label);
  if (claimedIn && claimedIn !== resolve(process.cwd())) {
    // cp -r a project and the copy silently redeploys over the original's site.
    err(`  ! ${label} was claimed in ${claimedIn}`);
    err("  ! deploying from here replaces that site.");
  }
  // The slug update is unconditional, because layer 1's deploy has no answer
  // meaning *stop*.
  const res = await apiFetch(`/v1/slugs/${label}`, {
    method: "POST", body: jsonBody({ root }),
    headers: { "Content-Type": "application/json", "X-Statice-Token": token },
    timeoutMs: 30_000,
  });
  if (res.status !== 204) {
    return { ok: false, reason: res.body.message ?? res.body.error ?? `http ${res.status}` };
  }
  return { ok: true, label, url: `https://${label}.statice.app` };
}

// ---------------------------------------------------------------- commands

/**
 * Every argument is one of four flags or the value of --name, and anything else
 * is a refusal BEFORE the folder is read: a flag this version does not know is
 * a request it cannot honour, and `statice --dry-run` on a CLI that did not have
 * one used to be a deploy.
 */
function parseDeployArgs(args) {
  const opts = { isolated: false, verify: false, dryRun: false, wantsName: false, given: undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--name") {
      opts.wantsName = true;
      // `--name` with no value is the documented default, not an error. A
      // following flag is no value either, or `--name --isolated` claims
      // "--isolated".
      if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) opts.given = args[++i];
    } else if (a === "--isolated") opts.isolated = true;
    else if (a === "--verify") opts.verify = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a.startsWith("-")) die(`unknown flag: ${a}. \`statice --help\` lists them.`);
    else die(`unexpected argument: ${a}. \`statice --help\` lists the commands.`);
  }
  return opts;
}

async function cmdDeploy(args) {
  // Before ANYTHING reads or writes in cwd. `deploy()` checks again; this copy
  // is here because reading .statice comes first and must not run in $HOME,
  // where `~/.statice` is this CLI's own config DIRECTORY.
  refuseWrongFolder(process.cwd());
  const opts = parseDeployArgs(args);
  const { wantsName, given } = opts;
  // The default is basename(cwd), or the parent when that is a build-output
  // name. Resolved HERE rather than at the claim, because the rename comparison
  // below sanitizes it.
  const requested = !wantsName ? undefined : given !== undefined ? given : defaultName();

  const existing = readLabel();

  // --name beside an existing .statice compares SLUGS, not strings: a match is
  // an update, and anything else is a rename, which is a new claim.
  let rename = false;
  // `requested` is null only when the default had nowhere to walk up to; that
  // is not a rename, and sanitizing it would throw.
  if (wantsName && existing && requested !== null) {
    const existingSlug = existing.slice(0, existing.lastIndexOf("-"));
    if (sanitizeSlug(requested) !== existingSlug) {
      out(`  ${bold("rename")}: a new label, token and site.`);
      out(`  ${dim(`${existing} keeps serving, frozen at its last root.`)}`);
      if (!opts.dryRun) {
        const answer = await ask("  create a second site? [y/N] ");
        if (answer !== null && !/^y(es)?$/i.test(answer.trim())) {
          out("  cancelled."); process.exit(1);
        }
      }
      rename = true;
    }
  }

  const { root, url, dryRun } = await deploy(opts);

  if (dryRun) {
    // What a real run would do next, named and not done.
    out(`  would deploy to ${bold(url)}`);
    if (existing && !rename) out(`  would update ${bold(existing)}`);
    else if (requested) out(`  would claim ${bold(sanitizeSlug(requested) || "(nothing: that name sanitizes to nothing)")}`);
    out(`  ${dim(`root ${root}`)}`);
    return;
  }

  // Bare statice with no .statice: hash URL only — layer 1, untouched.
  if (!wantsName && !existing) { out(`  → ${bold(url)}`); return; }

  const result = existing && !rename
    ? await updateName(existing, root)
    : requested
      ? await claimName(requested, root)
      : { ok: false, reason: "no name to use" };

  if (result.ok) { out(`  → ${bold(result.url)}`); return; }
  out(`  → ${bold(url)}`);
  err(`  ! ${result.reason}`);
  // Exit codes split on what was asked for: --name on an unnamed folder wants a
  // NAME, so this exits non-zero; bare statice wants a DEPLOY, which it got.
  process.exit(wantsName ? 1 : 0);
}

/** Subcommands take exactly what they document; anything more is a refusal. */
function noMore(args, usage) {
  if (args.length > 0) die(`unexpected argument: ${args[0]}. usage: ${usage}`);
}

async function cmdKey(args) {
  ensureHome();
  noMore(args.filter((a) => a !== "--print-hash"), "statice key [--print-hash]");
  if (args.includes("--print-hash")) {
    if (!existsSync(KEY_FILE)) die("no key on this machine.");
    out(sha256(Buffer.from(readFileSync(KEY_FILE, "utf8").replace(/\n$/, ""), "utf8")));
    return;
  }
  // Takes no argument, prompting or reading stdin.
  const key = process.stdin.isTTY
    ? await promptHidden("access key: ")
    : readFileSync(0, "utf8").replace(/\n$/, "");
  if (!key) die("no key given.");
  writePrivate(KEY_FILE, key + "\n");
  // Prints the digest AS it writes the key. Note this is NOT
  // `echo "$KEY" | shasum -a 256`, which hashes a trailing newline and matches
  // nothing — indistinguishable from a missing secret.
  out(`wrote ${KEY_FILE}`);
  out(`sha256 ${sha256(Buffer.from(key, "utf8"))}`);
}

async function cmdClaim(label, rest) {
  if (!label) die("usage: statice claim <label>");
  noMore(rest, "statice claim <label>");
  if (!isLabel(label)) die("that is not a label.");
  ensureHome();
  let token = readToken(label);
  if (!token) {
    if (!process.stdin.isTTY) {
      die(`no token for ${label}. set STATICE_TOKEN, or copy ~/.statice/slugs/${label}.`);
    }
    token = await promptHidden(`token for ${label}: `);
  }
  if (!/^[0-9a-f]{64}$/.test(token)) die("that is not a token.");
  // Check answers 204 or 401, so a mistyped token fails where it was typed
  // rather than a day later.
  const res = await apiFetch(`/v1/slugs/${label}`, {
    method: "HEAD", headers: { "X-Statice-Token": token }, timeoutMs: 30_000,
  });
  if (res.status === 401) die("that token does not open that label.");
  if (res.status === 404) die(`no such label: ${label}`);
  if (res.status !== 204) die(`could not check the token: http ${res.status}`);
  writePrivate(tokenPath(label), `${token}\n${resolve(process.cwd())}\n`);
  writeLabel(label);
  out(`  adopted ${bold(label)} — https://${label}.statice.app`);
}

function cmdNames(rest) {
  noMore(rest, "statice names");
  ensureHome();
  // Dotted entries are pending claims and temp files, never labels.
  const labels = readdirSync(SLUG_DIR).filter((n) => isLabel(n)).sort();
  if (labels.length === 0) { out("  no names on this machine."); return; }
  const width = Math.max(...labels.map((l) => l.length));
  for (const label of labels) {
    out(`  ${label.padEnd(width)}  ${dim(tokenDir(label) ?? "(unknown folder)")}`);
  }
}

async function cmdRetire(label, rest) {
  noMore(rest, "statice retire [label]");
  if (label !== undefined && !isLabel(label)) die("that is not a label.");
  const target = label ?? readLabel();
  if (!target) die("no label here, and none given.");
  const token = readToken(target);
  if (!token) die(`no token for ${target} on this machine.`);
  const res = await apiFetch(`/v1/slugs/${target}`, {
    method: "DELETE", headers: { "X-Statice-Token": token }, timeoutMs: 30_000,
  });
  if (res.status !== 204) die(`could not retire: ${res.body.message ?? `http ${res.status}`}`);
  // Clear .statice but KEEP the token file: not clearing it would quietly
  // revive the name just retired, while deleting the token would make the
  // tombstone permanent.
  if (readLabel() === target) rmSync(STATICE_FILE(), { force: true });
  out(`  retired ${bold(target)}. the record survives, so nobody else can take it.`);
  // Not `--name`: with the pointer gone that is a NEW claim under a fresh
  // suffix. The token this machine kept is what revives the label, and `claim`
  // is the command that puts the pointer back from it.
  out(`  ${dim(`to revive it: statice claim ${target}, then deploy.`)}`);
}

// ---------------------------------------------------------------- layer 3

async function cmdDomain(args) {
  if (args[0] === "rm") { noMore(args.slice(2), "statice domain rm <host>"); return cmdDomainRm(args[1]); }
  const host = args[0];
  if (!host) die("usage: statice domain <host> | statice domain rm <host>");
  noMore(args.slice(1), "statice domain <host>");
  const label = readLabel();
  if (!label) die('no .statice here. give this folder a name first: statice --name "..."');
  const token = readToken(label);
  if (!token) die(`no token for ${label} on this machine.`);

  // The word the CLI must not drop is *leave*.
  out(`  add this record at your DNS provider — and ${bold("leave it there")}:`);
  out();
  out(`      _statice.${host}   TXT   "${label}"`);
  out();
  out("  this is not a one-time check. the record is what keeps the binding");
  out(`  yours; removing it releases ${host}.`);
  out();
  // No DNS lookups in the CLI — the server owns the check — but it does not
  // POST until the record exists, because a lookup before then seeds the
  // resolver's negative cache for the zone's negative TTL.
  await ask("  press enter when it is in place … ");

  process.stdout.write("  checking the proof ... ");
  const deadline = Date.now() + 5 * 60_000; // both loops carry a deadline
  let bound = null;
  for (let attempt = 0; ; attempt++) {
    const res = await apiFetch("/v1/domains", {
      method: "POST", body: jsonBody({ host, label }),
      headers: { "Content-Type": "application/json", "X-Statice-Token": token },
      timeoutMs: 30_000,
    });
    if (res.status === 202) { bound = res.body; break; }
    const retryable = res.status === 422 || res.status === 503 || res.status === 0;
    if (!retryable || Date.now() > deadline) {
      out("no");
      if (res.body.record) {
        err("  the record is not there yet:");
        err(`      ${res.body.record.name}   TXT   "${res.body.record.value}"`);
        if (res.body.found?.length) err(`  found instead: ${res.body.found.join(", ")}`);
      } else {
        err(`  ${res.body.message ?? `http ${res.status}`}`);
      }
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, Math.min(5000 * (attempt + 1), 20_000)));
  }
  out("ok");
  // The 202 repeats it.
  out(`  ${bound.manual}`);

  // No status endpoint — the CLI polls the host and watches the handshake.
  // Ready means THIS Worker answered, which it says on every response it
  // makes: a 200 from whatever served the host yesterday is not readiness.
  process.stdout.write(`  waiting for https://${host} ... `);
  const liveBy = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      const probe = await fetch(`https://${host}/`, {
        redirect: "manual", signal: AbortSignal.timeout(10_000),
      });
      if (probe.status < 500 && probe.headers.get("x-served-by") === "statice") break;
    } catch { /* TLS or DNS still settling */ }
    if (Date.now() > liveBy) {
      out("not yet");
      out(`  ${dim("the binding is written; TLS or DNS is still settling.")}`);
      out(`  → ${bold(`https://${host}`)}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  out("ok");
  out(`  → ${bold(`https://${host}`)}`);
}

async function cmdDomainRm(host) {
  if (!host) die("usage: statice domain rm <host>");
  const label = readLabel();
  const token = label ? readToken(label) : null;
  const res = await apiFetch(`/v1/domains/${encodeURIComponent(host)}`, {
    method: "DELETE",
    headers: token ? { "X-Statice-Token": token } : {},
    timeoutMs: 30_000,
  });
  if (res.status !== 204) die(`could not unbind: ${res.body.message ?? `http ${res.status}`}`);
  out(`  unbound ${bold(host)}.`);
  // The word, inverted.
  out(`  ${dim(`the _statice.${host} TXT record can come out now.`)}`);
}

// ---------------------------------------------------------------- entry

const HELP = `statice — type it in a folder, get a live URL

  statice                       deploy this folder to a hash URL
  statice --name "my thing"     deploy, then claim or update a short name
  statice --name                same, named after this folder
  statice --isolated            add the cross-origin isolation marker, then deploy
  statice --verify              re-upload every blob, then deploy (the way back)
  statice --dry-run             list what would be published, and stop

  statice key                   store this machine's access key
  statice claim <label>         adopt a name on a second machine
  statice names                 every label with a token, and its folder
  statice retire [label]        take a label out of service

  statice domain <host>         bind a custom domain to this folder's name
  statice domain rm <host>      unbind it

files
  .statice                      the label. public, commit it if you like.
  ~/.statice/key                the access key. one per machine.
  ~/.statice/slugs/<label>      the token. losing it loses the name, permanently.

keys are issued by hand. email access@statice.run to get one.
there is no unpublish. hash URLs are permanent.
`;

/** One version, read from the manifest npm ships beside this file. */
function version() {
  try {
    return JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
  } catch {
    return "unknown";
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const verb = argv[0];

  if (verb === "--help" || verb === "-h" || verb === "help") { out(HELP); return; }
  if (verb === "--version" || verb === "-v") { out(`statice ${version()}`); return; }
  if (verb === "key") return cmdKey(argv.slice(1));
  if (verb === "claim") return cmdClaim(argv[1], argv.slice(2));
  if (verb === "names") return cmdNames(argv.slice(1));
  if (verb === "retire") return cmdRetire(argv[1], argv.slice(2));
  if (verb === "domain") return cmdDomain(argv.slice(1));
  if (verb !== undefined && !verb.startsWith("-")) die(`unknown command: ${verb}`);
  return cmdDeploy(argv);
}

main().catch((e) => die(e?.stack ?? String(e)));
