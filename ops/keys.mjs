#!/usr/bin/env node
// The access-key roster — issue a key, revoke a key, and keep KEY_HASHES the
// set of exactly the ones still live.
//
// Worker secrets are write-only: `secret put` replaces the whole value and
// nothing reads it back, so the set has to have a source of truth on this side.
// That is the roster, an append-only log — issue and revoke are both appends,
// never an edit, so the active set is a replay. Nothing server-side has one:
// keys are validated and discarded, which is the property that makes them
// admission rather than identity, and the reason a roster names holders and
// never their deploys.
//
// A digest is not a credential — a one-way hash of 256 bits of randomness,
// useless to whoever holds it. The roster still lives OUTSIDE this repository:
// it names the people who hold keys, and a copy that a stranger syncs would
// admit them to the stranger's instance.
//
//   node ops/keys.mjs list
//   node ops/keys.mjs issue <name>     mint, put, probe, print the key
//   node ops/keys.mjs revoke <name>    tombstone, put
//   node ops/keys.mjs sync             re-put the set from the roster
//
// The key is the ONLY thing on stdout, so `issue <name> | pbcopy` puts it
// straight on the clipboard and never in the scrollback.
//
//   STATICE_ROSTER,  else ~/.statice-ops/keys
//   CF_API_TOKEN,    else ~/.statice-ops/cf-token
//   CF_ACCOUNT_ID,   else ~/.statice-ops/account

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OPS = join(homedir(), ".statice-ops");
const ROSTER = process.env.STATICE_ROSTER ?? join(OPS, "keys");
const SCRIPT = process.env.CF_WORKER_NAME ?? "statice";
const SECRET = "KEY_HASHES";
const API = "https://api.statice.run/v1/deploy";
const PROBE_BUDGET_MS = 60_000;
const PROBE_REQUEST_MS = 10_000; // one probe; the budget bounds the loop, this bounds a hang
const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

const say = (...a) => console.error(...a);
const die = (m) => { console.error(`ops/keys: ${m}`); process.exit(1); };
const sha256 = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);

// ------------------------------------------------------------------- roster

/**
 * Replay the log. `issue` sets a name's digest, `revoke` clears it, and the
 * active set is what is left — in issue order, so the put is stable and a diff
 * of two runs shows only what changed.
 */
function replay() {
  if (!existsSync(ROSTER)) return new Map();
  const held = new Map();
  let n = 0;
  for (const line of readFileSync(ROSTER, "utf8").split("\n")) {
    n++;
    const text = line.replace(/#.*$/, "").trim();
    if (text === "") continue;
    const [event, date, name, digest] = text.split(/\s+/);
    if (event === "issue") {
      if (!/^[0-9a-f]{64}$/.test(digest ?? "")) die(`${ROSTER}:${n}: not a digest.`);
      held.set(name, { digest, date });
    } else if (event === "revoke") {
      if (!held.delete(name)) die(`${ROSTER}:${n}: ${name} held no key here.`);
    } else {
      die(`${ROSTER}:${n}: unknown event ${JSON.stringify(event)}.`);
    }
  }
  return held;
}

const append = (row) => appendFileSync(ROSTER, row + "\n", { mode: 0o644 });

// -------------------------------------------------------------- credentials

function cfToken() {
  if (process.env.CF_API_TOKEN) return process.env.CF_API_TOKEN;
  const file = join(OPS, "cf-token");
  if (!existsSync(file)) die(`no Cloudflare token. set CF_API_TOKEN, or put one in ${file}.`);
  return readFileSync(file, "utf8").trim();
}

/** The account is operator state like the token: never a default in the code. */
function account() {
  if (process.env.CF_ACCOUNT_ID) return process.env.CF_ACCOUNT_ID;
  const file = join(OPS, "account");
  if (!existsSync(file)) die(`no account id. set CF_ACCOUNT_ID, or put one in ${file}.`);
  return readFileSync(file, "utf8").trim();
}

/** This machine's own key, so a put that would lock it out can be refused. */
function localKey() {
  if (process.env.STATICE_KEY) return process.env.STATICE_KEY;
  const file = join(homedir(), ".statice", "key");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").replace(/\n$/, "");
}

// ------------------------------------------------------------------ the put

async function put(held) {
  const digests = [...held.values()].map((h) => h.digest);
  if (digests.length === 0 && !FORCE) {
    die("that set is empty, which 401s every /v1 call. --force if you mean it.");
  }
  // The guard that matters: the secret is write-only, so a put that drops this
  // machine's digest is not noticed until the next deploy fails, and by then
  // the set it dropped is unrecoverable.
  const mine = localKey();
  if (mine === null) {
    say("!  no key on this machine — cannot check the set still admits you.");
  } else if (!digests.includes(sha256(mine)) && !FORCE) {
    die("that set does not admit this machine. --force if you mean it.");
  }

  if (DRY) {
    say(`would put ${SECRET} = ${digests.length} digest(s):`);
    for (const [name, h] of held) say(`     ${h.digest}  ${name}`);
    return;
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account()}/workers/scripts/${SCRIPT}/secrets`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${cfToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: SECRET, text: digests.join(","), type: "secret_text" }),
    },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success !== true) {
    die(`${SECRET} put failed (${res.status}): ${JSON.stringify(body.errors ?? body)}\n` +
        `        the roster is already written — fix the token and run \`sync\`.`);
  }
  say(`put ${SECRET} — ${digests.length} key(s) live`);
}

/**
 * Admission, proved rather than assumed. Auth runs before the route dispatch
 * and before the body parse, and validation precedes the first R2 operation, so
 * an empty object is a 400 for an admitted key, a 401 for anything else — and
 * writes nothing either way.
 *
 * It retries, because a secret put is eventually consistent: the first probe
 * after one routinely lands on an edge still holding the old set. Measured at
 * a few seconds, so the budget is generous — a false REFUSED here is worse than
 * a slow success, having no failure it can distinguish itself from.
 */
async function probe(key, label) {
  const started = Date.now();
  for (;;) {
    let res;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(PROBE_REQUEST_MS),
      });
    } catch (e) {
      // A network failure is neither a refusal nor a verdict, and it must not
      // throw: the put already happened, so an exception here would exit
      // `issue` before the only print of a key that is already live. It is
      // one more attempt spent against the budget, nothing else.
      res = { status: 0, why: String(e?.message ?? e) };
    }
    const waited = Math.round((Date.now() - started) / 1000);
    if (res.status === 400) {
      say(`probe ${label}: admitted${waited ? ` (after ${waited}s)` : ""}`);
      return true;
    }
    if (res.status !== 401 && res.status !== 0) {
      say(`probe ${label}: unexpected ${res.status}`);
      return false;
    }
    if (Date.now() - started > PROBE_BUDGET_MS) {
      say(`probe ${label}: ${res.status === 0 ? `unreachable (${res.why})` : "still refused"} after ${waited}s`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function putAndProve(held, extra) {
  await put(held);
  if (DRY) return true;
  let ok = true;
  if (extra) ok = await probe(extra.key, extra.label);
  const mine = localKey();
  if (mine) ok = (await probe(mine, "this machine")) && ok;
  return ok;
}

// ----------------------------------------------------------------- commands

async function issue(name) {
  if (!name) die("usage: node ops/keys.mjs issue <name>");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) die("a name is letters, digits, dot, dash, underscore.");
  const held = replay();
  if (held.has(name)) die(`${name} already holds a key, issued ${held.get(name).date}. revoke it first.`);

  const key = randomBytes(32).toString("base64url");
  const digest = sha256(key);
  // Recorded before it is live, never after: a key the roster does not name
  // cannot be revoked without rotating everyone, while a row whose put failed
  // is one `sync` away.
  if (!DRY) append(`issue   ${today()}  ${name}  ${digest}`);
  say(`${DRY ? "would record" : "recorded"} ${name}  ${digest}`);

  const ok = await putAndProve(held.set(name, { digest, date: today() }), { key, label: name });

  if (DRY) return;
  say("");
  if (!ok) {
    // The put succeeded, so this key is live whether or not it is printed, and
    // this line is the only place it exists. Withholding it strands a key that
    // admits and that nothing can hand over — worse than printing a suspect one
    // beside a warning, which is at least revocable by name.
    say("!  the probe never came back admitted, and the put SUCCEEDED — so this");
    say("!  key is live and nothing else has it. `revoke` it if you distrust it.");
    say("");
  }
  say(`send this to ${name}, then have them run \`npx -y @statice/cli key\` and paste it:`);
  process.stdout.write(key + "\n");
  if (!ok) process.exit(1);
}

async function revoke(name) {
  if (!name) die("usage: node ops/keys.mjs revoke <name>");
  const held = replay();
  if (!held.has(name)) die(`${name} holds no key.`);
  if (!DRY) append(`revoke  ${today()}  ${name}`);
  say(`${DRY ? "would record" : "recorded"} revoke ${name}`);
  held.delete(name);
  const ok = await putAndProve(held);
  if (!DRY) {
    say("");
    // The revoked key cannot be probed from here — the roster keeps digests,
    // not keys — so this says what was done and not what is already true.
    say(`${name}'s key is out of the set. it stops admitting within seconds, as`);
    say("the put reaches every edge; there is no way to watch that from here,");
    say("since the roster holds digests and never keys.");
    say("everything they already deployed still serves — serving never asks for");
    say("a key, and nothing here deletes.");
  }
  if (!ok) process.exit(1);
}

function list() {
  const held = replay();
  if (held.size === 0) { say("no keys."); return; }
  const w = Math.max(...[...held.keys()].map((k) => k.length));
  for (const [name, h] of held) say(`${name.padEnd(w)}  ${h.digest}  issued ${h.date}`);
  say("");
  say(`${held.size} key(s). \`sync\` re-puts exactly this set.`);
}

const [verb, arg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (verb === "issue") await issue(arg);
else if (verb === "revoke") await revoke(arg);
else if (verb === "sync") await putAndProve(replay());
else if (verb === "list" || verb === undefined) list();
else die(`unknown command ${JSON.stringify(verb)}. try list, issue, revoke, sync.`);
