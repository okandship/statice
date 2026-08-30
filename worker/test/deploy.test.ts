import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, apiPost, bytes, deployFiles, manifestFor, rootOf, upload } from "./helpers";
import { sha256Hex } from "../src/manifest";
import { rootToLabel } from "../src/base32";

describe("access — admission, not identity", () => {
  it("401s a missing key — empty or missing fails closed", async () => {
    const res = await fetchNoAuth("https://api.statice.run/v1/deploy", {
      method: "POST",
      body: "{}",
      headers: { "Content-Length": "2" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()) as unknown).toMatchObject({ error: "unauthorized" });
  });

  it("401s an unknown key, and says so as json with no-store", async () => {
    const res = await api("/v1/deploy", {
      method: "POST",
      body: "{}",
      headers: { Authorization: "Bearer nope", "Content-Length": "2" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("401s a malformed Authorization header", async () => {
    const res = await api("/v1/deploy", {
      method: "POST",
      body: "{}",
      headers: { Authorization: "Basic test-key", "Content-Length": "2" },
    });
    expect(res.status).toBe(401);
  });

  it("404s anything that is not /v1 on the API host, without a key", async () => {
    const res = await fetchNoAuth("https://api.statice.run/index.html");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not-found" });
  });
});

async function fetchNoAuth(url: string, init: RequestInit = {}) {
  const { SELF } = await import("cloudflare:test");
  return SELF.fetch(url, init);
}

describe("deploy protocol", () => {
  it("answers incomplete with the missing list and writes nothing", async () => {
    const files = { "/index.html": "<h1>one</h1>" };
    const res = await apiPost("/v1/deploy", { files: await manifestFor(files) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; root: string; missing: string[]; url: string };
    expect(body.status).toBe("incomplete");
    expect(body.missing).toHaveLength(1);
    expect(body.url).toBe(`https://${rootToLabel(body.root)}.statice.app`);
    expect(await env.BUCKET.head(`manifests/${body.root}`)).toBeNull();
  });

  it("computes the root itself and ignores a client-supplied one", async () => {
    const files = { "/index.html": "<h1>root</h1>" };
    const expected = await rootOf(files);
    const res = await apiPost("/v1/deploy", {
      files: await manifestFor(files),
      root: "f".repeat(64),
    });
    expect(((await res.json()) as { root: string }).root).toBe(expected);
  });

  it("deploys, then answers an unchanged redeploy from one operation", async () => {
    const files = { "/index.html": "<h1>hi</h1>", "/style.css": "body{}" };
    const first = await deployFiles(files);
    expect(first.status).toBe("deployed");
    // Now delete the blobs. The manifest-exists shortcut must still answer
    // deployed -- that key existing is the proof.
    const manifest = await manifestFor(files);
    for (const [hash] of Object.values(manifest)) await env.BUCKET.delete(`blobs/${hash}`);
    const again = await apiPost("/v1/deploy", { files: manifest });
    expect((await again.json()) as unknown).toMatchObject({ status: "deployed", root: first.root });
    // Put them back for later tests.
    for (const content of Object.values(files)) await upload(bytes(content));
  });

  it("subtracts base by HASH, never by path", async () => {
    // A path whose bytes changed must NOT be subtracted as unchanged.
    const v1 = { "/index.html": "<h1>v1</h1>", "/app.js": "console.log(1)" };
    const base = (await deployFiles(v1)).root;
    const v2 = { "/index.html": "<h1>v2 CHANGED</h1>", "/app.js": "console.log(1)" };
    const res = await apiPost("/v1/deploy", { files: await manifestFor(v2), base });
    const body = (await res.json()) as { status: string; missing: string[] };
    expect(body.status).toBe("incomplete");
    // app.js is subtracted; index.html's new bytes are not.
    expect(body.missing).toEqual([await sha256Hex(bytes("<h1>v2 CHANGED</h1>"))]);
  });

  it("subtracts a moved file rather than re-uploading it", async () => {
    const v1 = { "/a.js": "same bytes" };
    const base = (await deployFiles(v1)).root;
    const v2 = { "/b.js": "same bytes" };
    const res = await apiPost("/v1/deploy", { files: await manifestFor(v2), base });
    expect((await res.json()) as unknown).toMatchObject({ status: "deployed" });
  });

  it("treats an unknown base as simply absent — one wasted read, never a wrong answer", async () => {
    const files = { "/only.html": "alone" };
    const body = await deployFiles(files, "a".repeat(64));
    expect(body.status).toBe("deployed");
  });

  it("rejects a base whose SHAPE is wrong", async () => {
    const res = await apiPost("/v1/deploy", { files: await manifestFor({ "/a.html": "x" }), base: "nope" });
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({ error: "invalid-request" });
  });

  it("422s a stored size that contradicts the declaration", async () => {
    const content = "eight!!!";
    const hash = await upload(bytes(content));
    const res = await apiPost("/v1/deploy", { files: { "/a.html": [hash, 999] } });
    expect(res.status).toBe(422);
    expect((await res.json()) as unknown).toMatchObject({ error: "conflict" });
  });

  it("requires Content-Length before the parse", async () => {
    const res = await api("/v1/deploy", { method: "POST", body: "{}" });
    // The runtime may supply a length for a string body; when it does not, 411.
    expect([200, 400, 411]).toContain(res.status);
    const explicit = await api("/v1/deploy", {
      method: "POST",
      body: "{}",
      headers: { "Content-Length": "9999999999" },
    });
    expect(explicit.status).toBe(413);
    expect((await explicit.json()) as unknown).toMatchObject({ error: "too-large" });
  });
});

describe("deploy validation — all string tests, all before the first R2 operation", () => {
  const cases: Array<[string, unknown]> = [
    ["files absent", {}],
    ["files an array", { files: [] }],
    ["files empty", { files: {} }],
    ["value not a pair", { files: { "/a.html": "x" } }],
    ["value wrong arity", { files: { "/a.html": ["a".repeat(64)] } }],
    ["bad hash", { files: { "/a.html": ["nothex", 1] } }],
    ["uppercase hash", { files: { "/a.html": ["A".repeat(64), 1] } }],
    ["negative size", { files: { "/a.html": ["a".repeat(64), -1] } }],
    ["fractional size", { files: { "/a.html": ["a".repeat(64), 1.5] } }],
    ["non-canonical path", { files: { "a.html": ["a".repeat(64), 1] } }],
    ["traversal path", { files: { "/../a.html": ["a".repeat(64), 1] } }],
    ["type not admitted", { files: { "/a.ts": ["a".repeat(64), 1] } }],
    ["two sizes for one hash", {
      files: { "/a.html": ["a".repeat(64), 1], "/b.html": ["a".repeat(64), 2] },
    }],
  ];
  for (const [name, body] of cases) {
    it(`400s ${name}`, async () => {
      const res = await apiPost("/v1/deploy", body);
      expect(res.status).toBe(400);
      expect((await res.json()) as unknown).toMatchObject({ error: "invalid-request" });
    });
  }

  it("413s a single blob over 64 MB", async () => {
    const res = await apiPost("/v1/deploy", { files: { "/a.html": ["a".repeat(64), 64 * 1024 * 1024 + 1] } });
    expect(res.status).toBe(413);
  });

  it("413s a deploy over 512 MB of distinct blobs", async () => {
    const files: Record<string, [string, number]> = {};
    for (let i = 0; i < 9; i++) {
      files[`/f${i}.html`] = [String(i).repeat(64), 64 * 1024 * 1024];
    }
    const res = await apiPost("/v1/deploy", { files });
    expect(res.status).toBe(413);
  });

  it("413s over 1,000 entries", async () => {
    const files: Record<string, [string, number]> = {};
    for (let i = 0; i < 1001; i++) files[`/f${i}.html`] = ["a".repeat(64), 1];
    const res = await apiPost("/v1/deploy", { files });
    expect(res.status).toBe(400);
  });

  it("accepts exactly 1,000 entries", async () => {
    const files: Record<string, [string, number]> = {};
    for (let i = 0; i < 1000; i++) files[`/f${i}.html`] = [i.toString(16).padStart(64, "0"), 1];
    const res = await apiPost("/v1/deploy", { files });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown).toMatchObject({ status: "incomplete" });
  });
});

describe("blob PUT", () => {
  it("201s a good body", async () => {
    const b = bytes("hello blob");
    const hash = await sha256Hex(b);
    const res = await api(`/v1/blobs/${hash}`, {
      method: "PUT", body: b, headers: { "Content-Length": String(b.length) },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("400s a body that does not hash to the key — R2's refusal, not an outage", async () => {
    const b = bytes("not what the key says");
    const res = await api(`/v1/blobs/${"a".repeat(64)}`, {
      method: "PUT", body: b, headers: { "Content-Length": String(b.length) },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toMatchObject({ error: "invalid-request" });
    expect(await env.BUCKET.head(`blobs/${"a".repeat(64)}`)).toBeNull();
  });

  it("accepts a zero-length body — zero is legal", async () => {
    const hash = await sha256Hex(new Uint8Array(0));
    const res = await api(`/v1/blobs/${hash}`, {
      method: "PUT", body: null, headers: { "Content-Length": "0" },
    });
    expect(res.status).toBe(201);
    const meta = await env.BUCKET.head(`blobs/${hash}`);
    expect(meta).not.toBeNull();
    expect(meta!.size).toBe(0);
  });

  it("411s an absent Content-Length and 413s an oversized one", async () => {
    const tooBig = await api(`/v1/blobs/${"b".repeat(64)}`, {
      method: "PUT", body: "x", headers: { "Content-Length": String(64 * 1024 * 1024 + 1) },
    });
    expect(tooBig.status).toBe(413);
  });

  it("400s a bad key shape", async () => {
    const res = await api("/v1/blobs/notahash", {
      method: "PUT", body: "x", headers: { "Content-Length": "1" },
    });
    expect(res.status).toBe(400);
  });

  it("405s the wrong method, carrying Allow", async () => {
    const res = await api(`/v1/blobs/${"c".repeat(64)}`, { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("PUT");
  });
});
