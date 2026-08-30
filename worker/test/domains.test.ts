import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, apiPost, deployFiles, site } from "./helpers";
import { sha256Hex } from "../src/manifest";

const enc = new TextEncoder();

// The resolver is mocked in vitest.config.ts via miniflare's outboundService,
// keyed entirely on the queried name: the suffix chooses the answer and the
// FIRST DNS LABEL is the label the proof names. So a host built as
// `<label>.owned.example` proves itself, with no shared state to coordinate.
const PROVES = "owned.example"; // TXT names this host's own label
const ABSENT = "missing.example"; // NOERROR, no answer
const NXDOMAIN = "nx.example";
const SERVFAIL = "servfail.example"; // unknown, and unknown authorizes nothing
const OTHER = "other.example"; // TXT names somebody else's label
const SPLIT = "split.owned.example"; // multi-string TXT, under an owned zone
const STRANGER = "stranger.example"; // proves, but is NOT an owned zone

interface Claimed { label: string; token: string; root: string }

async function claimed(slug: string): Promise<Claimed> {
  const { root } = await deployFiles({ "/index.html": `<h1>${slug}</h1>` });
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const auth = await sha256Hex(enc.encode(token));
  const res = await apiPost("/v1/slugs", { slug, root, auth });
  const { label } = (await res.json()) as { label: string };
  return { label, token, root };
}

const hostFor = (c: Claimed, zone: string) => `${c.label}.${zone}`;

const bind = (host: string, c: Claimed) =>
  apiPost("/v1/domains", { host, label: c.label }, { "X-Statice-Token": c.token });

describe("bind", () => {
  it("202s an own-zone bind once the TXT names the label, and the domain serves", async () => {
    const c = await claimed("ownzone");
    const host = hostFor(c, PROVES);

    const res = await bind(host, c);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { mode: string; manual: string; note: string };
    expect(body.mode).toBe("own-zone");
    expect(body.manual).toMatch(new RegExp(`attach ${host}`));
    // The word the CLI must not drop is *leave*.
    expect(body.note).toMatch(/leave/i);

    // domains/<host> -> <label>\n, and the value carries a trailing newline.
    expect(await (await env.BUCKET.get(`domains/${host}`))!.text()).toBe(`${c.label}\n`);

    const page = await site(`https://${host}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("<h1>ownzone</h1>");
    // A bound domain follows every deploy, so it takes no-cache.
    expect(page.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("follows the label through a later deploy — bound to a label, never a root", async () => {
    const c = await claimed("follows");
    const host = hostFor(c, PROVES);
    expect((await bind(host, c)).status).toBe(202);

    const v2 = await deployFiles({ "/index.html": "<h1>moved on</h1>" });
    await apiPost(`/v1/slugs/${c.label}`, { root: v2.root }, { "X-Statice-Token": c.token });
    expect(await (await site(`https://${host}/`)).text()).toBe("<h1>moved on</h1>");
  });

  it("422s with the exact record to add when the proof is missing", async () => {
    const c = await claimed("noproof");
    const host = hostFor(c, ABSENT);
    const res = await bind(host, c);
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string; record: { name: string; type: string; value: string }; note: string;
    };
    expect(body.error).toBe("conflict");
    expect(body.record).toEqual({ name: `_statice.${host}`, type: "TXT", value: c.label });
    expect(body.note).toMatch(/leave/i);
    expect(await env.BUCKET.get(`domains/${host}`)).toBeNull();
  });

  it("422s when the TXT names another label", async () => {
    const c = await claimed("otherlabel");
    const res = await bind(hostFor(c, OTHER), c);
    expect(res.status).toBe(422);
    expect((await res.json()) as unknown).toMatchObject({ found: ["someone-elses-abc"] });
  });

  it("503s on SERVFAIL — unknown authorizes nothing", async () => {
    const c = await claimed("servfail");
    const res = await bind(hostFor(c, SERVFAIL), c);
    expect(res.status).toBe(503);
    expect((await res.json()) as unknown).toMatchObject({ error: "unavailable" });
  });

  it("treats NXDOMAIN as a successful absence, not as unknown", async () => {
    const c = await claimed("nxdomain");
    expect((await bind(hostFor(c, NXDOMAIN), c)).status).toBe(422);
  });

  it("joins multi-string TXT answers", async () => {
    const c = await claimed("joined");
    expect((await bind(hostFor(c, SPLIT), c)).status).toBe(202);
  });

  it("refuses multi-tenant with no SaaS credentials, and writes nothing", async () => {
    const c = await claimed("saasless");
    const host = hostFor(c, STRANGER);
    const res = await bind(host, c);
    expect(res.status).toBe(422);
    expect((await res.json()) as unknown).toMatchObject({ error: "conflict" });
    expect(await env.BUCKET.get(`domains/${host}`)).toBeNull();
  });

  it("401s a token that does not match the label, before spending a lookup", async () => {
    const c = await claimed("wrongtoken");
    const res = await apiPost(
      "/v1/domains",
      { host: hostFor(c, PROVES), label: c.label },
      { "X-Statice-Token": "f".repeat(64) },
    );
    expect(res.status).toBe(401);
  });

  it("refuses its own zones, IPv4 literals and wildcards", async () => {
    const c = await claimed("refused");
    for (const host of ["statice.run", "statice.app", "x.statice.app", "10.0.0.1", "*.example.com"]) {
      const res = await apiPost("/v1/domains", { host, label: c.label }, { "X-Statice-Token": c.token });
      expect(res.status, host).toBe(400);
    }
  });
});

describe("unbind", () => {
  it("takes the label's token", async () => {
    const c = await claimed("unbindable");
    const host = hostFor(c, PROVES);
    await bind(host, c);

    const res = await api(`/v1/domains/${host}`, {
      method: "DELETE", headers: { "X-Statice-Token": c.token },
    });
    expect(res.status).toBe(204);
    expect(await env.BUCKET.get(`domains/${host}`)).toBeNull();
    expect((await site(`https://${host}/`)).status).toBe(404);
  });

  it("takes nothing at all once the proof is gone", async () => {
    // The owner removed the TXT: the sentence is retracted, so the binding it
    // authorized becomes deletable by anyone. Written directly, the way an
    // operator writes a domain record.
    const c = await claimed("departed");
    const host = hostFor(c, ABSENT);
    await env.BUCKET.put(`domains/${host}`, `${c.label}\n`);

    const res = await api(`/v1/domains/${host}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await env.BUCKET.get(`domains/${host}`)).toBeNull();
  });

  it("401s an unauthenticated unbind while the proof still stands", async () => {
    const c = await claimed("standing");
    const host = hostFor(c, PROVES);
    await bind(host, c);
    const res = await api(`/v1/domains/${host}`, { method: "DELETE" });
    expect(res.status).toBe(401);
    expect(await env.BUCKET.get(`domains/${host}`)).not.toBeNull();
  });

  it("503s an unauthenticated unbind the resolver cannot answer for", async () => {
    const c = await claimed("cantsay");
    const host = hostFor(c, SERVFAIL);
    await env.BUCKET.put(`domains/${host}`, `${c.label}\n`);
    const res = await api(`/v1/domains/${host}`, { method: "DELETE" });
    expect(res.status).toBe(503);
    expect(await env.BUCKET.get(`domains/${host}`)).not.toBeNull();
  });

  it("204s a host with no record — no tombstone", async () => {
    const res = await api("/v1/domains/never.owned.example", { method: "DELETE" });
    expect(res.status).toBe(204);
  });
});

describe("domain serving", () => {
  it("takes everything before the first newline in the record", async () => {
    const c = await claimed("newline");
    await env.BUCKET.put("domains/manual.example.org", `${c.label}\n`);
    const res = await site("https://manual.example.org/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>newline</h1>");
  });

  it("serves a bound host given with a trailing dot", async () => {
    const c = await claimed("trailingdot");
    await env.BUCKET.put("domains/dotted.example.org", `${c.label}\n`);
    expect((await site("https://dotted.example.org./")).status).toBe(200);
  });

  it("404s an unbound host with a short max-age", async () => {
    const res = await site("https://nothing.example.org/");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
  });

  it("lowercases the host for the lookup", async () => {
    const c = await claimed("folded");
    await env.BUCKET.put("domains/folded.example.org", `${c.label}\n`);
    expect((await site("https://FOLDED.example.org/")).status).toBe(200);
  });
});
