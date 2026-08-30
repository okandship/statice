import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, apiPost, bytes, deployFiles, labelOf, site } from "./helpers";
import { sha256Hex } from "../src/manifest";

const TOMBSTONE = "0".repeat(64);
const enc = new TextEncoder();

async function newToken() {
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return { token, auth: await sha256Hex(enc.encode(token)) };
}

async function claim(slug: string, root: string) {
  const { token, auth } = await newToken();
  const res = await apiPost("/v1/slugs", { slug, root, auth });
  return { res, token, auth };
}

describe("claim", () => {
  it("201s with an assigned suffix nobody chose, and never says a name is taken", async () => {
    const { root } = await deployFiles({ "/index.html": "<h1>claimed</h1>" });
    const a = await claim("cool 3d generator", root);
    expect(a.res.status).toBe(201);
    const first = (await a.res.json()) as { label: string; url: string };
    expect(first.label).toMatch(/^cool-3d-generator-[a-z2-7]{3}$/);
    expect(first.url).toBe(`https://${first.label}.statice.app`);

    // The suffix is unconditional, so the same slug claimed twice is two labels.
    const b = await claim("cool 3d generator", root);
    expect(b.res.status).toBe(201);
    const second = (await b.res.json()) as { label: string };
    expect(second.label).not.toBe(first.label);
    expect(second.label).toMatch(/^cool-3d-generator-[a-z2-7]{3}$/);
  });

  it("stores a 130-byte fixed-width record holding a hash, never a secret", async () => {
    const { root } = await deployFiles({ "/index.html": "<h1>record</h1>" });
    const { res, token, auth } = await claim("record-shape", root);
    const { label } = (await res.json()) as { label: string };
    const obj = await env.BUCKET.get(`slugs/${label}`);
    const text = await obj!.text();
    expect(enc.encode(text).length).toBe(130);
    expect(text.slice(0, 64)).toBe(root);
    expect(text.slice(64, 65)).toBe(" ");
    expect(text.slice(65, 129)).toBe(auth);
    expect(text.slice(129)).toBe("\n");
    expect(text).not.toContain(token);
  });

  it("422s a root that does not exist", async () => {
    const { res } = await claim("no-such-root", "a".repeat(64));
    expect(res.status).toBe(422);
    expect((await res.json()) as unknown).toMatchObject({ error: "conflict" });
  });

  it("400s a slug that sanitizes to nothing, and a bad auth", async () => {
    const { root } = await deployFiles({ "/index.html": "<h1>bad</h1>" });
    expect((await claim("!!!", root)).res.status).toBe(400);
    const res = await apiPost("/v1/slugs", { slug: "ok", root, auth: "short" });
    expect(res.status).toBe(400);
  });

  it("caps the label at 63 characters at the widest rung", async () => {
    const { root } = await deployFiles({ "/index.html": "<h1>long</h1>" });
    const { res } = await claim("a".repeat(80), root);
    const { label } = (await res.json()) as { label: string };
    expect(label.length).toBeLessThanOrEqual(63);
  });
});

describe("update, delete, check", () => {
  it("updates unconditionally with the token and serves the new root at once", async () => {
    const v1 = await deployFiles({ "/index.html": "<h1>v1</h1>" });
    const { res, token } = await claim("updatable", v1.root);
    const { label } = (await res.json()) as { label: string };

    expect((await site(`https://${label}.statice.app/`)).status).toBe(200);
    expect(await (await site(`https://${label}.statice.app/`)).text()).toBe("<h1>v1</h1>");

    const v2 = await deployFiles({ "/index.html": "<h1>v2</h1>" });
    const upd = await apiPost(`/v1/slugs/${label}`, { root: v2.root }, { "X-Statice-Token": token });
    expect(upd.status).toBe(204);

    // No server-side cache of the record: a deploy is live the instant it is written.
    const after = await site(`https://${label}.statice.app/`);
    expect(await after.text()).toBe("<h1>v2</h1>");
    expect(after.headers.get("Cache-Control")).toBe("no-cache");
    expect(after.headers.get("ETag")).toBe(`"${await sha256Hex(bytes("<h1>v2</h1>"))}"`);
  });

  it("401s a mistyped token where it was typed, not a day later", async () => {
    const { root } = await deployFiles({ "/index.html": "<h1>auth</h1>" });
    const { res } = await claim("guarded", root);
    const { label } = (await res.json()) as { label: string };
    const wrong = "f".repeat(64);
    expect((await apiPost(`/v1/slugs/${label}`, { root }, { "X-Statice-Token": wrong })).status).toBe(401);
    expect((await api(`/v1/slugs/${label}`, { method: "HEAD", headers: { "X-Statice-Token": wrong } })).status).toBe(401);
  });

  it("answers check 204 with the right token", async () => {
    const { root } = await deployFiles({ "/index.html": "<h1>check</h1>" });
    const { res, token } = await claim("checkable", root);
    const { label } = (await res.json()) as { label: string };
    expect((await api(`/v1/slugs/${label}`, { method: "HEAD", headers: { "X-Statice-Token": token } })).status).toBe(204);
    expect((await api(`/v1/slugs/nope-xyz`, { method: "HEAD", headers: { "X-Statice-Token": token } })).status).toBe(404);
  });

  it("tombstones on delete: the label 404s but the record survives", async () => {
    const { root } = await deployFiles({ "/index.html": "<h1>gone</h1>" });
    const { res, token, auth } = await claim("retired", root);
    const { label } = (await res.json()) as { label: string };

    expect((await api(`/v1/slugs/${label}`, { method: "DELETE", headers: { "X-Statice-Token": token } })).status).toBe(204);
    expect((await site(`https://${label}.statice.app/`)).status).toBe(404);

    // The record survives, so nobody else can claim it and the holder can revive it.
    const record = await (await env.BUCKET.get(`slugs/${label}`))!.text();
    expect(record.slice(0, 64)).toBe(TOMBSTONE);
    expect(record.slice(65, 129)).toBe(auth);

    const revived = await apiPost(`/v1/slugs/${label}`, { root }, { "X-Statice-Token": token });
    expect(revived.status).toBe(204);
    expect((await site(`https://${label}.statice.app/`)).status).toBe(200);
  });

  it("404s an unknown label and 400s a bad label shape", async () => {
    expect((await apiPost("/v1/slugs/nope-abc", { root: "a".repeat(64) }, { "X-Statice-Token": "f".repeat(64) })).status).toBe(404);
    expect((await apiPost("/v1/slugs/BAD_LABEL", { root: "a".repeat(64) }, { "X-Statice-Token": "f".repeat(64) })).status).toBe(400);
  });

  it("405s the wrong method, carrying Allow", async () => {
    const res = await api("/v1/slugs/anything-abc", { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST, DELETE, HEAD");
  });
});

describe("slug serving", () => {
  it("proxies rather than redirecting, so the origin never moves", async () => {
    const { root } = await deployFiles({ "/index.html": "<h1>proxy</h1>", "/a.css": "a{}" });
    const { res } = await claim("proxied", root);
    const { label } = (await res.json()) as { label: string };
    const page = await site(`https://${label}.statice.app/`, { redirect: "manual" });
    expect(page.status).toBe(200);
    expect(page.headers.get("Location")).toBeNull();
  });

  it("takes no-cache uniformly, including the trailing-slash 301", async () => {
    const { root } = await deployFiles({ "/docs/index.html": "<h1>d</h1>" });
    const { res } = await claim("nocache", root);
    const label = labelOf(((await res.json()) as { url: string }).url);
    const redirect = await site(`https://${label}.statice.app/docs`, { redirect: "manual" });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("304s on a matching ETag with no blob read", async () => {
    const { root } = await deployFiles({ "/index.html": "<h1>etag</h1>" });
    const { res } = await claim("etagged", root);
    const label = labelOf(((await res.json()) as { url: string }).url);
    const first = await site(`https://${label}.statice.app/`);
    const again = await site(`https://${label}.statice.app/`, {
      headers: { "If-None-Match": first.headers.get("ETag")! },
    });
    expect(again.status).toBe(304);
  });
});

describe("body caps", () => {
  // "no /v1 endpoint buffers an arbitrary body" -- the deploy route reads its
  // cap before its parse, and the small routes get the same at 16 KB.
  it("413s a claim or a bind whose body is over 16 KB, before parsing it", async () => {
    const big = JSON.stringify({ slug: "x".repeat(20_000), root: "a".repeat(64), auth: "b".repeat(64) });
    const headers = { "Content-Type": "application/json", "Content-Length": String(bytes(big).length) };
    const claim = await api("/v1/slugs", { method: "POST", body: big, headers });
    expect(claim.status).toBe(413);
    const bind = await api("/v1/domains", {
      method: "POST", body: big, headers: { ...headers, "X-Statice-Token": "c".repeat(64) },
    });
    expect(bind.status).toBe(413);
  });
});
