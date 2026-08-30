// CLI tests. Node's built-in runner, so the CLI keeps its no-dependencies
// property: `node --test cli/test/`.
//
// These run the real binary as a subprocess against a stub API. That is the
// honest level for this file -- the things worth holding are what the process
// REFUSES to do and what bytes it puts on the wire, and both were invisible to
// any test that imported functions instead.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../statice.mjs", import.meta.url));
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
/** The root the Worker would compute for a deploy body: the manifest is `<hash> <path>\\n`, in the order the CLI sent. */
const rootOf = (files) => sha256(Object.entries(files).map(([path, [hash]]) => `${hash} ${path}\n`).join(""));

/**
 * Enough of /v1 to drive the client loop, recording every deploy body so the
 * tests can assert on the manifest the CLI actually built.
 */
async function startStub(t) {
  const deploys = [];
  const slugs = [];
  const uploaded = new Set();
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const json = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/v1/deploy") {
        const parsed = JSON.parse(body);
        deploys.push(parsed);
        const hashes = [...new Set(Object.values(parsed.files).map(([h]) => h))];
        const missing = hashes.filter((h) => !uploaded.has(h));
        const root = rootOf(parsed.files);
        return missing.length
          ? json(200, { status: "incomplete", root, url: `https://x.statice.app`, missing })
          : json(200, { status: "deployed", root, url: `https://x.statice.app` });
      }
      if (req.url.startsWith("/v1/blobs/")) {
        uploaded.add(req.url.slice("/v1/blobs/".length));
        res.writeHead(201).end();
        return;
      }
      if (req.url === "/v1/slugs") {
        // The label echoes the claimed slug, so a test can assert on the NAME
        // the CLI chose rather than on a constant the stub made up.
        const parsed = JSON.parse(body);
        slugs.push(parsed);
        const label = `${parsed.slug}-abc`;
        return json(201, { label, url: `https://${label}.statice.app` });
      }
      if (req.url.startsWith("/v1/slugs/")) {
        res.writeHead(204).end();
        return;
      }
      json(404, { error: "not-found", message: "stub" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const stub = {
    url: `http://127.0.0.1:${server.address().port}`,
    deploys,
    slugs,
    close: () => new Promise((r) => {
      // undici keeps connections alive, so close() alone never resolves.
      server.closeAllConnections();
      server.close(r);
    }),
  };
  // Teardown runs even when an assertion throws, so a failure cannot wedge the
  // runner by leaving the listener open.
  t.after(() => stub.close());
  return stub;
}

/**
 * Async on purpose. spawnSync would block this process's event loop, and the
 * stub server lives in it -- the child's request could never be served.
 */
function run(args, { cwd, api, home }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home ?? mkdtempSync(join(tmpdir(), "statice-home-")),
          STATICE_API: api ?? "http://127.0.0.1:1", // refused if ever reached
          STATICE_KEY: "test-key",
        },
      },
      (error, stdout, stderr) =>
        resolve({ status: error?.code ?? 0, stdout, stderr }),
    );
  });
}

const scratch = () => mkdtempSync(join(tmpdir(), "statice-site-"));

// ---------------------------------------------------------------- the guard

test("refuses to deploy the home directory", async () => {
  // $HOME is the sharp case: `~/.statice` is the CLI's own config DIRECTORY,
  // and the per-project marker is a FILE of the same name. Reading the marker
  // must not happen before the refusal.
  const r = await run([], { cwd: homedir(), home: homedir() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to deploy your home directory/);
  assert.doesNotMatch(r.stderr, /EISDIR|stack|at readLabel/i);
});

test("refuses to deploy a filesystem root", async () => {
  const r = await run([], { cwd: parsePath(process.cwd()).root });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to deploy a filesystem root/);
});

test("refuses before touching the network", async () => {
  // STATICE_API points at a closed port; a refusal that reached the wire would
  // report a connection error instead.
  const r = await run([], { cwd: homedir(), home: homedir() });
  assert.doesNotMatch(r.stderr, /ECONNREFUSED|fetch failed/i);
});

// ---------------------------------------------------------------- the walk

test("the selection policy is frozen: prunes, symlinks, and the type table", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  mkdirSync(join(dir, "assets"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "node_modules"));
  mkdirSync(join(dir, ".hidden"));
  mkdirSync(join(dir, ".well-known"));

  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "assets/app.js"), "console.log(1)");
  writeFileSync(join(dir, "assets/app.js.map"), '{"version":3}');
  writeFileSync(join(dir, "assets/glyph.obj"), "v 0 0 0\n");
  writeFileSync(join(dir, ".well-known/cross-origin-isolated"), "");
  // excluded by the type table
  writeFileSync(join(dir, "src.ts"), "export const a = 1");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  writeFileSync(join(dir, "Makefile"), "all:");
  writeFileSync(join(dir, "deploy.sh"), "#!/bin/sh");
  writeFileSync(join(dir, "key.pem"), "-----BEGIN");
  // pruned directories
  writeFileSync(join(dir, ".git/config.json"), "{}");
  writeFileSync(join(dir, "node_modules/pkg.json"), "{}");
  writeFileSync(join(dir, ".hidden/x.html"), "<i>no</i>");
  // skipped symlinks
  symlinkSync(join(dir, "index.html"), join(dir, "link.html"));

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);

  const paths = Object.keys(stub.deploys[0].files).sort();
  assert.deepEqual(paths, [
    "/.well-known/cross-origin-isolated",
    "/assets/app.js",
    "/assets/app.js.map",
    "/assets/glyph.obj",
    "/index.html",
  ]);
});

test("agent instructions never publish, at any depth or spelling", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, "CLAUDE.md"), "all changes on main");
  writeFileSync(join(dir, "AGENTS.md"), "run the tests first");
  // Depth and case: a nested instruction file is one too, and the name is a
  // convention rather than an extension.
  writeFileSync(join(dir, "docs/claude.md"), "nested instructions count");
  writeFileSync(join(dir, "docs/readme.md"), "# real content");

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);

  const paths = Object.keys(stub.deploys[0].files).sort();
  assert.deepEqual(paths, ["/docs/readme.md", "/index.html"]);
  // Dropped by the walk, not by the table -- `.md` is admitted, so naming them
  // among "files not an admitted type" would be a lie. They are named under
  // the heading that is true of them, carrying the rule that dropped them.
  assert.doesNotMatch(r.stdout, /not an admitted type/);
  assert.match(r.stdout, /3 paths skipped for other reasons/);
  assert.match(r.stdout, /^\s+\/CLAUDE\.md\s+agent instructions$/m);
  assert.match(r.stdout, /^\s+\/docs\/claude\.md\s+agent instructions$/m);
});

test("paths are canonical, and the manifest is sorted by UTF-8 bytes", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  mkdirSync(join(dir, "b"));
  writeFileSync(join(dir, "index.html"), "root");
  writeFileSync(join(dir, "b/a.html"), "nested");
  writeFileSync(join(dir, "a.html"), "flat");

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);

  const paths = Object.keys(stub.deploys[0].files);
  for (const p of paths) {
    assert.ok(p.startsWith("/"), `${p} must have a leading slash`);
    assert.ok(!p.includes("\\"), `${p} must use / separators`);
    assert.equal(p.normalize("NFC"), p, `${p} must be NFC`);
  }
  const sorted = [...paths].sort((x, y) =>
    Buffer.compare(Buffer.from(x, "utf8"), Buffer.from(y, "utf8")),
  );
  assert.deepEqual(paths, sorted, "entries must be strictly ascending by UTF-8 bytes");
});

test("declared sizes and hashes match the bytes on disk", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  const body = "<h1>exact</h1>";
  writeFileSync(join(dir, "index.html"), body);

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);
  const [hash, size] = stub.deploys[0].files["/index.html"];
  assert.equal(hash, sha256(Buffer.from(body)));
  assert.equal(size, Buffer.byteLength(body));
});

// ---------------------------------------------------------------- the review

test("a first deploy prints its listing AND the word permanent with no TTY", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  writeFileSync(join(dir, "assets/app.js.map"), '{"version":3}');

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);
  // Gating the whole block on isatty leaves CI publishing unreviewed folders
  // in silence; only the prompt is skipped.
  assert.match(r.stdout, /first deploy from this folder/);
  assert.match(r.stdout, /permanent/);
  // Every flagged file named, with the one line saying why.
  assert.match(r.stdout, /sourcemaps embed original source/);
  assert.match(r.stdout, /\/assets\/app\.js\.map/);
});

test("a small first deploy names the files rather than summarizing them", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  writeFileSync(join(dir, "hello.txt"), "hello\n");

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);
  // Summarizing one file hides the only thing worth looking at.
  assert.match(r.stdout, /\/hello\.txt/);
  // And the count is not "1 files".
  assert.match(r.stdout, /scanning 1 file,/);
  assert.match(r.stdout, /deploy 1 file to a/);
  assert.doesNotMatch(r.stdout, /1 files/);
});

test("a large first deploy falls back to the top-level shape", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  for (let i = 0; i < 40; i++) {
    writeFileSync(join(dir, `assets/f${i}.js`), `export const n = ${i};`);
  }

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);
  // 41 filenames are not a review, so the shape takes over.
  assert.match(r.stdout, /\/assets\s+40 files/);
  // Root-level files are labelled, not left as a bare slash.
  assert.match(r.stdout, /\/ \(top level\)\s+1 file\b/);
  assert.doesNotMatch(r.stdout, /\/assets\/f7\.js/);
});

test("refusals are named, not just counted", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "node_modules"));

  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  writeFileSync(join(dir, "src.ts"), "export const a = 1");
  writeFileSync(join(dir, ".env"), "SECRET=1");
  writeFileSync(join(dir, "Makefile"), "all:");
  // Pruned directories are never visited, so their contents are not refusals —
  // naming them would make every repo's listing a wall of node_modules. The
  // tree gets named under the walk's own heading; nothing inside it does.
  writeFileSync(join(dir, ".git/config.json"), "{}");
  writeFileSync(join(dir, "node_modules/pkg.json"), "{}");
  // A skipped symlink is not a refusal either: the walk drops it before the
  // type table ever sees it.
  symlinkSync(join(dir, "index.html"), join(dir, "link.html"));

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);

  assert.match(r.stdout, /3 files not an admitted type/);
  assert.match(r.stdout, /^\s+\/\.env$/m);
  assert.match(r.stdout, /^\s+\/Makefile$/m);
  assert.match(r.stdout, /^\s+\/src\.ts$/m);
  assert.doesNotMatch(r.stdout, /config\.json|pkg\.json/);
});

test("many refusals become an extension tally rather than a wall", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  for (let i = 0; i < 25; i++) writeFileSync(join(dir, `m${i}.ts`), "export const a = 1");
  for (let i = 0; i < 3; i++) writeFileSync(join(dir, `c${i}.yml`), "a: 1");

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);

  assert.match(r.stdout, /28 files not an admitted type/);
  // Refusals cluster by type, not by directory, so the tally is by extension
  // and ordered by count.
  assert.match(r.stdout, /\.ts\s+25/);
  assert.match(r.stdout, /\.yml\s+3/);
  assert.doesNotMatch(r.stdout, /\/m7\.ts/);
});

test("what the walk drops is named too, with the rule that dropped it", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "node_modules"));
  mkdirSync(join(dir, ".cache"));

  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  writeFileSync(join(dir, "CLAUDE.md"), "all changes on main");
  symlinkSync(join(dir, "index.html"), join(dir, "link.html"));
  // Never visited, so never counted: the tree is named, its contents are not.
  writeFileSync(join(dir, ".git/config.json"), "{}");
  writeFileSync(join(dir, "node_modules/pkg.json"), "{}");
  writeFileSync(join(dir, ".cache/build.html"), "<i>no</i>");

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);

  // The listing accounts for the whole folder, not just the part the type
  // table saw. A silent drop is a drop nobody reviews.
  assert.match(r.stdout, /5 paths skipped for other reasons/);
  assert.match(r.stdout, /^\s+\/\.git\/\s+pruned$/m);
  assert.match(r.stdout, /^\s+\/node_modules\/\s+pruned$/m);
  assert.match(r.stdout, /^\s+\/\.cache\/\s+dotfolder$/m);
  assert.match(r.stdout, /^\s+\/link\.html\s+symlink$/m);
  assert.match(r.stdout, /^\s+\/CLAUDE\.md\s+agent instructions$/m);
  // A pruned tree is named with a trailing slash and no count, because the
  // count would cost exactly the work the prune exists to avoid.
  assert.doesNotMatch(r.stdout, /config\.json|pkg\.json|build\.html/);
});

test("many skips become a reason tally rather than a wall", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  for (let i = 0; i < 22; i++) mkdirSync(join(dir, `.d${i}`));
  for (let i = 0; i < 3; i++) symlinkSync(join(dir, "index.html"), join(dir, `l${i}.html`));

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);

  assert.match(r.stdout, /25 paths skipped for other reasons/);
  // Skips cluster by rule, not by directory or type, so the tally is by reason
  // and ordered by count: 25 skips is one symlink farm or one dotfolder-heavy
  // repo, and this is the line that tells those apart.
  assert.match(r.stdout, /dotfolder\s+22/);
  assert.match(r.stdout, /symlink\s+3/);
  assert.doesNotMatch(r.stdout, /\/\.d7\//);
});

test("a first deploy names what it left behind BEFORE it asks", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  for (let i = 0; i < 30; i++) writeFileSync(join(dir, `src/m${i}.ts`), "export const a = 1");

  const r = await run([], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);

  // One admitted file beside thirty refusals is the wrong-folder mistake, and
  // the question is worthless if it comes first.
  const refused = r.stdout.indexOf("not an admitted type");
  const skipped = r.stdout.indexOf("skipped for other reasons");
  const question = r.stdout.indexOf("to a permanent URL?");
  assert.ok(refused !== -1 && skipped !== -1 && question !== -1, r.stdout);
  assert.ok(refused < question, `refusals must precede the prompt:\n${r.stdout}`);
  assert.ok(skipped < question, `skips must precede the prompt:\n${r.stdout}`);
});

test("base is absent on a first deploy and present on the next from that folder", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  writeFileSync(join(dir, "index.html"), "<h1>one</h1>");

  assert.equal((await run([], { cwd: dir, api: stub.url, home })).status, 0);
  assert.equal(stub.deploys.at(-1).base, undefined, "nothing to hint with yet");

  writeFileSync(join(dir, "index.html"), "<h1>two</h1>");
  assert.equal((await run([], { cwd: dir, api: stub.url, home })).status, 0);
  assert.match(stub.deploys.at(-1).base ?? "", /^[0-9a-f]{64}$/);
});

test("--verify sends no base and re-uploads regardless", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  writeFileSync(join(dir, "index.html"), "<h1>v</h1>");

  assert.equal((await run([], { cwd: dir, api: stub.url, home })).status, 0);
  const r = await run(["--verify"], { cwd: dir, api: stub.url, home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.deploys.at(-1).base, undefined, "--verify skips the base shortcut");
  assert.match(r.stdout, /verifying/);
});

// ---------------------------------------------------------------- the name

/**
 * The folder NAME is the thing under test, so these cannot use `scratch()`.
 * Real-pathed because the token file records the claiming directory and macOS
 * resolves /var to /private/var, which would otherwise look like a copied
 * project and print the "claimed in" warning.
 */
const namedScratch = (...segments) => {
  const dir = join(realpathSync(mkdtempSync(join(tmpdir(), "statice-nest-"))), ...segments);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("--name with no value claims the folder name", async (t) => {
  const stub = await startStub(t);
  const dir = namedScratch("my-portfolio");
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");

  const r = await run(["--name"], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.slugs.at(-1).slug, "my-portfolio");
});

test("--name with a value still wins, and sanitizes an explicit name", async (t) => {
  const stub = await startStub(t);
  const dir = namedScratch("ignored-folder-name");
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");

  const r = await run(["--name", "Cool 3D Generator!"], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.slugs.at(-1).slug, "cool-3d-generator");
});

test("a build-output folder name walks up to the parent", async (t) => {
  const stub = await startStub(t);
  const dir = namedScratch("mysite", "dist");
  writeFileSync(join(dir, "index.html"), "<h1>built</h1>");

  const r = await run(["--name"], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.slugs.at(-1).slug, "mysite", "dist is in AVOID, so the parent names it");
});

test("--name followed by a flag takes the default, never the flag", async (t) => {
  const stub = await startStub(t);
  const dir = namedScratch("flagged");
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");

  const r = await run(["--name", "--verify"], { cwd: dir, api: stub.url });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stub.slugs.at(-1).slug, "flagged");
});

test("--name with no value beside an existing .statice updates rather than renames", async (t) => {
  // The default must resolve BEFORE the rename comparison sanitizes it, or this
  // path dies in `raw.toLowerCase()` on an undefined name -- and it dies in
  // exactly the folders the default is for.
  const stub = await startStub(t);
  const dir = namedScratch("demo");
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  writeFileSync(join(dir, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(dir, ".statice"), "demo-abc\n");
  mkdirSync(join(home, ".statice", "slugs"), { recursive: true });
  writeFileSync(join(home, ".statice", "slugs", "demo-abc"), `${"f".repeat(64)}\n${dir}\n`);

  const r = await run(["--name"], { cwd: dir, api: stub.url, home });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /TypeError|toLowerCase/);
  assert.doesNotMatch(r.stdout, /rename/);
  assert.equal(stub.slugs.length, 0, "an update, not a second claim");
});

// ---------------------------------------------------------------- misc

test("refuses a folder with nothing publishable, and says what it held", async () => {
  const dir = scratch();
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "notes.ts"), "const a = 1");
  const r = await run([], { cwd: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no publishable files/);
  // The listing that would have accounted for the folder never prints here, so
  // the refusal carries the counts instead of leaving you to guess.
  assert.match(r.stderr, /1 file not an admitted type/);
  assert.match(r.stderr, /1 path skipped by the walk/);
});

test("--help and --version do not need a key or a network", async () => {
  const help = await run(["--help"], { cwd: scratch() });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /there is no unpublish/);
  assert.match((await run(["--version"], { cwd: scratch() })).stdout, /^statice \d+\.\d+\.\d+/);
});

test("rejects an unknown command rather than deploying", async () => {
  const r = await run(["destroy"], { cwd: scratch() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command: destroy/);
});

// ---------------------------------------------------------------- the boundaries

import { existsSync, readFileSync } from "node:fs";

/**
 * A stub whose every answer the test chooses, for the responses the real API
 * never sends -- and which the CLI has to refuse anyway.
 */
async function startCustom(t, handle) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body });
      const [status, obj] = handle(req, body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** run(), plus stdin and an environment the test can unset things in. */
function runWith(args, { cwd, api, home, env = {}, input = "" }) {
  const e = {
    ...process.env,
    HOME: home ?? mkdtempSync(join(tmpdir(), "statice-home-")),
    STATICE_API: api ?? "http://127.0.0.1:1",
    STATICE_KEY: "test-key",
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete e[k]; else e[k] = v;
  }
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: e },
      (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr }),
    );
    child.stdin.end(input);
  });
}

const deployedOk = (body) => [200, {
  status: "deployed", root: rootOf(JSON.parse(body).files), url: "https://x.statice.app",
}];

test("a .statice that is not a label is refused before any file or request", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  writeFileSync(join(dir, ".statice"), "../../outside\n");
  // Where a joined path would land, holding what a token read would take.
  writeFileSync(join(home, "outside"), `${"e".repeat(64)}\n`);

  const r = await run([], { cwd: dir, api: stub.url, home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\.statice does not hold a label/);
  assert.equal(stub.deploys.length, 0, "refused before the network");
});

test("a claim response naming a path is refused, and nothing is written", async (t) => {
  const stub = await startCustom(t, (req, body) => {
    if (req.url === "/v1/deploy") return deployedOk(body);
    if (req.url === "/v1/slugs") return [201, { label: "../evil", url: "https://evil.statice.app" }];
    return [404, { error: "not-found", message: "stub" }];
  });
  const dir = namedScratch("hostile");
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");

  const r = await runWith(["--name"], { cwd: dir, api: stub.url, home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /malformed claim/);
  assert.ok(!existsSync(join(home, ".statice", "evil")), "no file outside slugs/");
  assert.ok(!existsSync(join(dir, ".statice")), "no pointer to a label that is not one");
});

test("a symlink where a secret would be written is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  mkdirSync(join(home, ".statice"), { recursive: true });
  const target = join(home, "elsewhere");
  writeFileSync(target, "untouched\n");
  symlinkSync(target, join(home, ".statice", "key"));

  const r = await runWith(["key"], { cwd: scratch(), home, input: "the-key\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to write through a symlink/);
  assert.equal(readFileSync(target, "utf8"), "untouched\n");
});

test("--dry-run lists, names the URL it would have, and sends nothing", async () => {
  const dir = scratch();
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  writeFileSync(join(dir, "src.ts"), "const a = 1");

  // No key, and an API that refuses connections: neither may matter.
  const r = await runWith(["--dry-run", "--name", "preview"], {
    cwd: dir, home, env: { STATICE_KEY: undefined },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run/);
  assert.match(r.stdout, /\/index\.html/);
  assert.match(r.stdout, /\/src\.ts/);
  assert.match(r.stdout, /would deploy to https:\/\/[a-z2-7]{52}\.statice\.app/);
  assert.match(r.stdout, /would claim preview/);
  assert.doesNotMatch(r.stderr, /ECONNREFUSED|fetch failed|no access key/);
  assert.ok(!existsSync(join(home, ".statice", "deployed")), "nothing logged");
  assert.ok(!existsSync(join(dir, ".statice")), "nothing claimed");
});

test("an unknown flag or a stray argument is refused before anything is sent", async (t) => {
  const stub = await startStub(t);
  const dir = scratch();
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");

  const r = await run(["--frobnicate"], { cwd: dir, api: stub.url });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown flag: --frobnicate/);
  const s = await run(["--verify", "extra"], { cwd: dir, api: stub.url });
  assert.equal(s.status, 1);
  assert.match(s.stderr, /unexpected argument: extra/);
  assert.equal(stub.deploys.length, 0);
});

test("a success body on a failed status is not a deploy", async (t) => {
  const stub = await startCustom(t, (req, body) => {
    if (req.url === "/v1/deploy") {
      return [500, { status: "deployed", root: rootOf(JSON.parse(body).files), url: "https://x.statice.app" }];
    }
    return [404, {}];
  });
  const dir = scratch();
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");

  const r = await runWith([], { cwd: dir, api: stub.url, home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /deploy did not complete/);
  assert.doesNotMatch(r.stdout, /→/);
  assert.ok(!existsSync(join(home, ".statice", "deployed")), "nothing logged");
});

test("a deployed answer naming another root is refused", async (t) => {
  const stub = await startCustom(t, (req) => {
    if (req.url === "/v1/deploy") return [200, { status: "deployed", root: "b".repeat(64), url: "https://x.statice.app" }];
    return [404, {}];
  });
  const dir = scratch();
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");

  const r = await runWith([], { cwd: dir, api: stub.url, home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /named a different root/);
  assert.ok(!existsSync(join(home, ".statice", "deployed")), "nothing logged");
});

test("--verify fails when a repair did not land, and never asks the server to confirm", async (t) => {
  const stub = await startCustom(t, (req, body) => {
    if (req.url.startsWith("/v1/blobs/")) return [502, { error: "upstream", message: "no" }];
    if (req.url === "/v1/deploy") return deployedOk(body);
    return [404, {}];
  });
  const dir = scratch();
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");

  const r = await runWith(["--verify"], { cwd: dir, api: stub.url, home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not verified/);
  // The manifest-exists shortcut would have answered `deployed` without
  // looking at a blob, so the deploy call must not happen at all.
  assert.equal(stub.seen.filter((s) => s.url === "/v1/deploy").length, 0);
  // The pass, and one retry.
  assert.equal(stub.seen.filter((s) => s.url.startsWith("/v1/blobs/")).length, 2);
});

test("retire says how to revive, and it is claim rather than --name", async (t) => {
  const stub = await startCustom(t, (req) => {
    if (req.url === "/v1/slugs/demo-abc" && (req.method === "DELETE" || req.method === "HEAD")) return [204];
    return [404, {}];
  });
  const dir = namedScratch("demo");
  const home = mkdtempSync(join(tmpdir(), "statice-home-"));
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  writeFileSync(join(dir, ".statice"), "demo-abc\n");
  mkdirSync(join(home, ".statice", "slugs"), { recursive: true });
  writeFileSync(join(home, ".statice", "slugs", "demo-abc"), `${"f".repeat(64)}\n${dir}\n`);

  const r = await runWith(["retire"], { cwd: dir, api: stub.url, home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /statice claim demo-abc/);
  assert.doesNotMatch(r.stdout, /--name/);
  assert.ok(!existsSync(join(dir, ".statice")), "the pointer is cleared");
  assert.ok(existsSync(join(home, ".statice", "slugs", "demo-abc")), "the token stays");

  // And the sequence it names puts the pointer back from that token.
  const c = await runWith(["claim", "demo-abc"], { cwd: dir, api: stub.url, home });
  assert.equal(c.status, 0, c.stderr);
  assert.equal(readFileSync(join(dir, ".statice"), "utf8"), "demo-abc\n");
});

test("the key never rides plain http to a host on the network", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "index.html"), "<h1>x</h1>");
  const r = await run([], { cwd: dir, api: "http://example.invalid" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must be https/);
  assert.doesNotMatch(r.stderr, /ENOTFOUND|fetch failed/);
});

test("--version is the package's version", async () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const r = await run(["--version"], { cwd: scratch() });
  assert.equal(r.stdout.trim(), `statice ${version}`);
});

test("subcommands refuse extra arguments", async () => {
  const r = await run(["claim", "demo-abc", "extra"], { cwd: scratch() });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unexpected argument: extra/);
});
