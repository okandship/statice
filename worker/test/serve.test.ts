import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { bytes, deployFiles, site, upload } from "./helpers";
import { sha256Hex } from "../src/manifest";
import { rootToLabel } from "../src/base32";

/** clip.mp4 is binary by Content-Type, so decode bytes rather than .text(). */
const bodyText = async (r: Response) => new TextDecoder().decode(await r.arrayBuffer());

const SITE = {
  "/index.html": "<h1>home</h1>",
  "/style.css": "body{color:red}",
  "/app.js": "console.log('hi')",
  "/docs/index.html": "<h1>docs</h1>",
  "/assets/logo.png": "PNGPNGPNG",
  "/media/clip.mp4": "0123456789abcdefghij",
};

let cachedHost: string | null = null;
async function hashHost(): Promise<string> {
  if (cachedHost === null) {
    const body = await deployFiles(SITE);
    expect(body.status).toBe("deployed");
    cachedHost = `https://${rootToLabel(body.root)}.statice.app`;
  }
  return cachedHost;
}

describe("host dispatch", () => {
  it("301s the statice.app apex, path and query kept, never immutable", async () => {
    const res = await site("https://statice.app/a/b?c=d", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://statice.run/a/b?c=d");
    expect(res.headers.get("Cache-Control")).not.toMatch(/immutable/);
  });

  it("404s a non-canonical or unknown label", async () => {
    expect((await site("https://" + "a".repeat(52) + ".statice.app/")).status).toBe(404);
    expect((await site("https://short.statice.app/")).status).toBe(404);
  });

  it("runs the `-` test BEFORE the length test", async () => {
    // A 48-character slug at width 3 makes a 52-character label. Length-first
    // would read it as a root and 404 a live site.
    const body = await deployFiles({ "/index.html": "<h1>slug-vs-root</h1>" });
    const label = "a".repeat(48) + "-bcd";
    expect(label).toHaveLength(52);
    await env.BUCKET.put(`slugs/${label}`, `${body.root} ${"e".repeat(64)}\n`);
    const res = await site(`https://${label}.statice.app/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>slug-vs-root</h1>");
  });

  it("404s a multi-level subdomain of statice.app", async () => {
    expect((await site("https://a.b.statice.app/")).status).toBe(404);
  });

  it("405s a non-GET/HEAD/OPTIONS, carrying Allow, before any read", async () => {
    const res = await site("https://statice.app/", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("answers OPTIONS 204 from the method alone with a wildcard preflight", async () => {
    const res = await site("https://anything.example.com/", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    // Range is not CORS-safelisted; the wildcard admits it.
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("*");
  });
});

describe("serving", () => {
  it("serves index.html for a trailing slash, with the full header block", async () => {
    const res = await site((await hashHost()) + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>home</h1>");
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("ETag")).toBe(`"${await sha256Hex(bytes("<h1>home</h1>"))}"`);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe("ETag, Content-Range");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(res.headers.get("X-Served-By")).toBe("statice");
  });

  it("names the server on every response the Worker makes, /v1 and 404s included", async () => {
    for (const res of [
      await site((await hashHost()) + "/missing"),
      await site("https://api.statice.run/v1/nope"),
      await site("https://statice.app/", { method: "POST" }),
      await site("https://anything.example.com/", { method: "OPTIONS" }),
    ]) {
      expect(res.headers.get("X-Served-By")).toBe("statice");
    }
  });

  it("carries Content-Length on a streamed response", async () => {
    const res = await site((await hashHost()) + "/style.css");
    expect(res.headers.get("Content-Length")).toBe(String(bytes("body{color:red}").length));
    expect(await res.text()).toBe("body{color:red}");
  });

  it("takes Content-Type from the table, never from R2", async () => {
    expect((await site((await hashHost()) + "/app.js")).headers.get("Content-Type"))
      .toBe("text/javascript; charset=utf-8");
    expect((await site((await hashHost()) + "/assets/logo.png")).headers.get("Content-Type"))
      .toBe("image/png");
  });

  it("301s a directory path to its trailing slash, with the host's cache policy", async () => {
    const res = await site((await hashHost()) + "/docs?x=1", { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/docs/?x=1");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("has no 404.html, no SPA fallback and no extensionless lookup", async () => {
    for (const p of ["/missing", "/index", "/nope.html", "/docs/missing/"]) {
      const res = await site((await hashHost()) + p);
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    }
  });

  it("404s a malformed percent sequence rather than 500ing", async () => {
    const res = await site((await hashHost()) + "/%zz");
    expect(res.status).toBe(404);
  });

  it("answers HEAD with the headers and no body", async () => {
    const res = await site((await hashHost()) + "/style.css", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe("15");
    expect(await res.text()).toBe("");
  });

  it("304s a matching If-None-Match with no blob read", async () => {
    const first = await site((await hashHost()) + "/index.html");
    const etag = first.headers.get("ETag")!;
    const res = await site((await hashHost()) + "/index.html", { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
  });

  it("parses If-None-Match as the list it is", async () => {
    const etag = (await site((await hashHost()) + "/index.html")).headers.get("ETag")!;
    const res = await site((await hashHost()) + "/index.html", {
      headers: { "If-None-Match": `"other", ${etag}` },
    });
    expect(res.status).toBe(304);
  });

  // Nothing in workerd compresses, so the weak form only ever arrives from a
  // real edge. These send it by hand, or the bug is invisible to the suite.
  it("304s the weak ETag Cloudflare hands back from a compressed response", async () => {
    const url = (await hashHost()) + "/style.css";
    const etag = (await site(url)).headers.get("ETag")!;
    const res = await site(url, { headers: { "If-None-Match": `W/${etag}` } });
    expect(res.status).toBe(304);
    // The 304 restates the representation's own tag, which is strong.
    expect(res.headers.get("ETag")).toBe(etag);
  });

  it("finds a weak tag inside a list", async () => {
    const url = (await hashHost()) + "/style.css";
    const etag = (await site(url)).headers.get("ETag")!;
    const res = await site(url, { headers: { "If-None-Match": `"other", W/${etag}` } });
    expect(res.status).toBe(304);
  });

  it("still 200s a weak tag for different bytes", async () => {
    const url = (await hashHost()) + "/style.css";
    const res = await site(url, { headers: { "If-None-Match": 'W/"stale"' } });
    expect(res.status).toBe(200);
  });
});

describe("Range", () => {
  const clip = "0123456789abcdefghij"; // 20 bytes

  it("206s one range with the right denominator", async () => {
    const res = await site((await hashHost()) + "/media/clip.mp4", { headers: { Range: "bytes=0-1" } });
    expect(res.status).toBe(206);
    // A ranged get() still reports the WHOLE object in obj.size: it is
    // Content-Range's denominator and never the 206's Content-Length.
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-1/${clip.length}`);
    expect(res.headers.get("Content-Length")).toBe("2");
    expect(await bodyText(res)).toBe("01");
  });

  it("clamps an over-long end", async () => {
    const res = await site((await hashHost()) + "/media/clip.mp4", { headers: { Range: "bytes=15-999" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 15-19/${clip.length}`);
    expect(await bodyText(res)).toBe("fghij");
  });

  it("honors an open-ended and a suffix range", async () => {
    const open = await site((await hashHost()) + "/media/clip.mp4", { headers: { Range: "bytes=18-" } });
    expect(await bodyText(open)).toBe("ij");
    const suffix = await site((await hashHost()) + "/media/clip.mp4", { headers: { Range: "bytes=-3" } });
    expect(suffix.status).toBe(206);
    expect(await bodyText(suffix)).toBe("hij");
  });

  it("416s what fits nothing, carrying bytes */<size>", async () => {
    for (const r of ["bytes=20-", "bytes=99-100", "bytes=-0"]) {
      const res = await site((await hashHost()) + "/media/clip.mp4", { headers: { Range: r } });
      expect(res.status).toBe(416);
      expect(res.headers.get("Content-Range")).toBe(`bytes */${clip.length}`);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    }
  });

  it("gives every other shape of the header the full 200", async () => {
    for (const r of ["bytes=0-1,5-6", "items=0-1", "bytes=x", "bytes=5-1"]) {
      const res = await site((await hashHost()) + "/media/clip.mp4", { headers: { Range: r } });
      expect(res.status).toBe(200);
      expect(await bodyText(res)).toBe(clip);
    }
  });

  it("keeps HEAD answering 200 whole", async () => {
    const res = await site((await hashHost()) + "/media/clip.mp4", {
      method: "HEAD", headers: { Range: "bytes=0-1" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(clip.length));
  });

  it("honors If-Range on a match and answers 200 on anything else", async () => {
    const url = (await hashHost()) + "/media/clip.mp4";
    const etag = (await site(url)).headers.get("ETag")!;
    const honored = await site(url, { headers: { Range: "bytes=0-1", "If-Range": etag } });
    expect(honored.status).toBe(206);
    // Yesterday's download must not get today's bytes spliced onto it.
    const stale = await site(url, { headers: { Range: "bytes=0-1", "If-Range": '"stale"' } });
    expect(stale.status).toBe(200);
    // The date form is never equal; nothing here emits Last-Modified.
    const dated = await site(url, {
      headers: { Range: "bytes=0-1", "If-Range": "Wed, 21 Oct 2015 07:28:00 GMT" },
    });
    expect(dated.status).toBe(200);
  });

  it("refuses a weak If-Range — a slice needs the strong compare", async () => {
    const url = (await hashHost()) + "/media/clip.mp4";
    const etag = (await site(url)).headers.get("ETag")!;
    const res = await site(url, { headers: { Range: "bytes=0-1", "If-Range": `W/${etag}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Range")).toBeNull();
  });

  it("puts conditionals ahead of ranges — a 304 never carries a slice", async () => {
    const url = (await hashHost()) + "/media/clip.mp4";
    const etag = (await site(url)).headers.get("ETag")!;
    const res = await site(url, { headers: { "If-None-Match": etag, Range: "bytes=0-1" } });
    expect(res.status).toBe(304);
    expect(res.headers.get("Content-Range")).toBeNull();
  });
});

describe("cross-origin isolation", () => {
  it("is off without the marker", async () => {
    const res = await site((await hashHost()) + "/");
    expect(res.headers.get("Cross-Origin-Embedder-Policy")).toBeNull();
    expect(res.headers.get("Cross-Origin-Opener-Policy")).toBeNull();
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });

  it("puts COEP on EVERY response and COOP on text/html only", async () => {
    const body = await deployFiles({
      "/index.html": "<h1>isolated</h1>",
      "/worker.js": "self.onmessage=()=>{}",
      "/.well-known/cross-origin-isolated": "",
    });
    expect(body.status).toBe("deployed");
    const host = `https://${rootToLabel(body.root)}.statice.app`;

    const doc = await site(host + "/");
    expect(doc.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(doc.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");

    // Not just documents: threaded WASM in a worker is `blocked` otherwise
    // while crossOriginIsolated still reads true.
    const asset = await site(host + "/worker.js");
    expect(asset.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(asset.headers.get("Cross-Origin-Opener-Policy")).toBeNull();

    const missing = await site(host + "/nope.js");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
  });

  it("treats the empty marker as present — zero is legal", async () => {
    const emptyHash = await sha256Hex(new Uint8Array(0));
    const meta = await env.BUCKET.head(`blobs/${emptyHash}`);
    expect(meta).not.toBeNull();
    expect(meta!.size).toBe(0);
  });
});

describe("operator deletion", () => {
  it("404s a deleted blob rather than 500ing, and the rest of the site serves", async () => {
    const body = await deployFiles({ "/index.html": "<h1>takedown</h1>", "/keep.html": "<h1>keep</h1>" });
    const host = `https://${rootToLabel(body.root)}.statice.app`;
    await env.BUCKET.delete(`blobs/${await sha256Hex(bytes("<h1>takedown</h1>"))}`);
    expect((await site(host + "/index.html")).status).toBe(404);
    expect((await site(host + "/keep.html")).status).toBe(200);
    await upload(bytes("<h1>takedown</h1>"));
  });
});
