import { describe, expect, it } from "vitest";
import { decodeBase32, encodeBase32, labelToRoot, rootToLabel } from "../src/base32";
import { compareUtf8, isCanonicalPath, serializeManifest, sha256Hex } from "../src/manifest";
import { isAdmitted, lookupType } from "../src/type-table";
import { bearerKey, validateHost, isUnderOwnedZone, parseContentLength } from "../src/validate";
import { normalizeHost } from "../src/index";
import { parseRange, resolvePath } from "../src/serve";
import { sanitizeSlug } from "../src/api";
import { unquoteTxt } from "../src/dns";

const enc = new TextEncoder();

describe("base32", () => {
  it("encodes 32 bytes to 52 lowercase chars", () => {
    const label = rootToLabel("00".repeat(32));
    expect(label).toHaveLength(52);
    expect(label).toMatch(/^[a-z2-7]{52}$/);
  });

  it("round-trips", () => {
    const hex = "9f".repeat(32);
    expect(labelToRoot(rootToLabel(hex))).toBe(hex);
  });

  it("404s a non-canonical label (trailing bits set)", () => {
    const canonical = rootToLabel("ff".repeat(32));
    // The last char carries 4 bits of padding; nudging it must not decode.
    const bytes = decodeBase32(canonical)!;
    const alt = encodeBase32(bytes);
    expect(alt).toBe(canonical);
    // Find a character that decodes to the same bytes but is not canonical.
    const last = canonical[51];
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const idx = alphabet.indexOf(last);
    let found = false;
    for (let i = 0; i < 32; i++) {
      if (i === idx) continue;
      const candidate = canonical.slice(0, 51) + alphabet[i];
      const decoded = decodeBase32(candidate);
      if (decoded && encodeBase32(decoded) !== candidate) {
        expect(labelToRoot(candidate)).toBeNull();
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("rejects out-of-alphabet and wrong length", () => {
    expect(labelToRoot("A".repeat(52))).toBeNull();
    expect(labelToRoot("a".repeat(51))).toBeNull();
    expect(labelToRoot("a1".repeat(26))).toBeNull(); // 1 is not in the alphabet
  });
});

describe("path canonicalization — reject, never repair", () => {
  const bad = [
    "index.html", "/", "/a/", "//a", "/a//b", "/./a", "/../a", "/a/./b", "/a/../b",
    "/a\\b", "/a\nb", "/a\rb", "/a\0b", "",
  ];
  for (const p of bad) {
    it(`rejects ${JSON.stringify(p)}`, () => expect(isCanonicalPath(p)).toBe(false));
  }
  it("rejects non-NFC", () => {
    expect(isCanonicalPath("/café.txt")).toBe(false); // decomposed
    expect(isCanonicalPath("/café.txt")).toBe(true); // composed
  });
  it("rejects unpaired surrogates", () => {
    expect(isCanonicalPath("/a\ud800b.txt")).toBe(false);
  });
  it("rejects over 1024 bytes", () => {
    expect(isCanonicalPath("/" + "a".repeat(1024) + ".html")).toBe(false);
    expect(isCanonicalPath("/" + "a".repeat(1018) + ".html")).toBe(true);
  });
  it("accepts ordinary paths", () => {
    expect(isCanonicalPath("/index.html")).toBe(true);
    expect(isCanonicalPath("/a/b/c.js")).toBe(true);
  });
});

describe("manifest", () => {
  it("sorts by UTF-8 bytes, not UTF-16 code units", () => {
    // U+FFFD (3 bytes, EF BF BD) vs U+10000 (4 bytes, F0 90 80 80).
    // UTF-16 puts the surrogate pair FIRST; UTF-8 puts it LAST.
    const a = enc.encode("/�.txt");
    const b = enc.encode("/\u{10000}.txt");
    expect(compareUtf8(a, b)).toBeLessThan(0);
    expect("/�.txt" < "/\u{10000}.txt").toBe(false); // UTF-16 disagrees
  });

  it("serializes fixed-width, newline-terminated, sorted", () => {
    const out = serializeManifest([
      { hash: "b".repeat(64), path: "/b.txt" },
      { hash: "a".repeat(64), path: "/a.txt" },
    ])!;
    const text = new TextDecoder().decode(out);
    expect(text).toBe(`${"a".repeat(64)} /a.txt\n${"b".repeat(64)} /b.txt\n`);
    expect(text.slice(64, 65)).toBe(" ");
  });

  it("rejects duplicate paths", () => {
    expect(serializeManifest([
      { hash: "a".repeat(64), path: "/x" },
      { hash: "b".repeat(64), path: "/x" },
    ])).toBeNull();
  });
});

describe("type table", () => {
  it("admits the wasm audience whole", () => {
    for (const p of ["/a.wasm", "/a.pck", "/a.data", "/a.js", "/a.html"]) {
      expect(isAdmitted(p)).toBe(true);
    }
  });
  it("excludes the interesting half", () => {
    for (const p of ["/a.ts", "/a.tsx", "/a.jsx", "/a.yml", "/a.toml", "/a.sql",
                     "/a.sh", "/a.py", "/a.pem", "/a.key", "/a.tfstate", "/Makefile", "/.env"]) {
      expect(isAdmitted(p)).toBe(false);
    }
  });
  it("admits the geometry a 3D scene loads by name", () => {
    expect(lookupType("/glyphs/a_1.obj")!.type).toBe("model/obj; charset=utf-8");
  });
  it("flags .map and only .map", () => {
    expect(lookupType("/a.js.map")!.flag).toBeTruthy();
    expect(lookupType("/a.js")!.flag).toBeUndefined();
  });
  it("lowercases the extension for the lookup, never the path", () => {
    expect(lookupType("/A.HTML")!.type).toBe("text/html; charset=utf-8");
  });
  it("carries charset in the value, not as a branch", () => {
    expect(lookupType("/a.css")!.type).toBe("text/css; charset=utf-8");
    expect(lookupType("/a.png")!.type).toBe("image/png");
  });
  it("admits extensionless files only under a top-level /.well-known/", () => {
    expect(isAdmitted("/.well-known/cross-origin-isolated")).toBe(true);
    expect(isAdmitted("/cross-origin-isolated")).toBe(false);
    expect(isAdmitted("/a/.well-known/cross-origin-isolated")).toBe(false);
    expect(isAdmitted("/.well-known/deep/cross-origin-isolated")).toBe(false);
  });
});

describe("Authorization", () => {
  it("is case-insensitive in the scheme and never trims the remainder", () => {
    expect(bearerKey("Bearer abc")).toBe("abc");
    expect(bearerKey("bearer abc")).toBe("abc");
    expect(bearerKey("BEARER abc")).toBe("abc");
    expect(bearerKey("Bearer  abc")).toBe(" abc"); // one space, then the key verbatim
    expect(bearerKey("Bearer abc ")).toBe("abc ");
  });
  it("rejects other shapes", () => {
    expect(bearerKey(null)).toBeNull();
    expect(bearerKey("abc")).toBeNull();
    expect(bearerKey("Basic abc")).toBeNull();
    expect(bearerKey("Bearer")).toBeNull();
    expect(bearerKey("Bearer\tabc")).toBeNull();
  });
});

describe("Content-Length — zero is legal and 0 is falsy", () => {
  it("accepts 0", () => expect(parseContentLength("0")).toBe(0));
  it("rejects absent and non-digits", () => {
    expect(parseContentLength(null)).toBeNull();
    expect(parseContentLength("")).toBeNull();
    expect(parseContentLength("+1")).toBeNull();
    expect(parseContentLength("1.5")).toBeNull();
    expect(parseContentLength(" 1")).toBeNull();
  });
});

describe("host validation", () => {
  it("folds then validates", () => {
    expect(validateHost("App.Example.com")).toBe("app.example.com");
  });
  it("rejects IPv4 literals, wildcards and our own zones", () => {
    expect(validateHost("192.168.0.1")).toBeNull();
    expect(validateHost("*.example.com")).toBeNull();
    expect(validateHost("statice.app")).toBeNull();
    expect(validateHost("statice.run")).toBeNull();
    expect(validateHost("x.statice.app")).toBeNull();
    expect(validateHost("x.statice.run")).toBeNull();
  });
  it("caps at 244 bytes", () => {
    const long = "a".repeat(60) + "." + "b".repeat(60) + "." + "c".repeat(60) + "." + "d".repeat(60) + ".com";
    expect(long.length).toBeGreaterThan(244);
    expect(validateHost(long)).toBeNull();
  });
  it("requires at least one dot", () => expect(validateHost("localhost")).toBeNull());
  it("underneath means with the dot", () => {
    expect(isUnderOwnedZone("statice.app", "statice.app")).toBe(true);
    expect(isUnderOwnedZone("a.statice.app", "statice.app")).toBe(true);
    expect(isUnderOwnedZone("notstatice.app", "statice.app")).toBe(false);
  });
});

describe("host normalization", () => {
  it("strips :port and one trailing dot", () => {
    expect(normalizeHost("statice.run:8787")).toBe("statice.run");
    expect(normalizeHost("statice.run.")).toBe("statice.run");
    expect(normalizeHost("statice.run..")).toBe("statice.run.");
  });
});

describe("path resolution", () => {
  it("percent-decodes per segment, after splitting on /", () => {
    expect(resolvePath("/a%20b/c.txt")).toBe("/a b/c.txt");
    // %2F must not mint a second URL for the same bytes.
    expect(resolvePath("/a%2Fb")).toBeNull();
  });
  it("404s a malformed sequence, never 500s", () => {
    expect(resolvePath("/%")).toBeNull();
    expect(resolvePath("/%zz")).toBeNull();
    expect(resolvePath("/%e0%a4%a")).toBeNull();
  });
  it("NFC-normalizes", () => {
    expect(resolvePath("/cafe%CC%81.txt")).toBe("/café.txt");
  });
});

describe("Range parsing", () => {
  it("takes exactly one range", () => {
    expect(parseRange("bytes=0-1")).toEqual({ kind: "range", start: 0, end: 1 });
    expect(parseRange("bytes=5-")).toEqual({ kind: "range", start: 5 });
    expect(parseRange("bytes=-500")).toEqual({ kind: "suffix", suffix: 500 });
  });
  it("gives every other shape the full 200", () => {
    for (const h of ["bytes=0-1,3-4", "items=0-1", "bytes=", "bytes=-", "bytes=a-b", "bytes=5-1", "nonsense"]) {
      expect(parseRange(h).kind).toBe("unsupported");
    }
  });
  it("has no header at all as its own state", () => {
    expect(parseRange(null).kind).toBe("none");
  });
});

describe("slug sanitization", () => {
  it("lowercases, spaces to -, drops the rest, collapses runs", () => {
    expect(sanitizeSlug("Cool 3D Generator!")).toBe("cool-3d-generator");
    expect(sanitizeSlug("a___b")).toBe("ab");
    expect(sanitizeSlug("a   b")).toBe("a-b");
    expect(sanitizeSlug("a---b")).toBe("a-b");
  });
  it("trims leading/trailing - LAST, after the 55 cap", () => {
    expect(sanitizeSlug("-abc-")).toBe("abc");
    const long = "a".repeat(54) + "-" + "b".repeat(10);
    expect(sanitizeSlug(long)).toBe("a".repeat(54)); // cap lands on the -, which is then trimmed
    expect(sanitizeSlug(long).length).toBeLessThanOrEqual(55);
  });
  it("can sanitize to nothing", () => expect(sanitizeSlug("!!!")).toBe(""));
});

describe("DoH TXT unquoting", () => {
  it("unquotes and joins", () => {
    expect(unquoteTxt('"cool-3d-generator-hfj"')).toBe("cool-3d-generator-hfj");
    expect(unquoteTxt('"abc" "def"')).toBe("abcdef");
  });
});

describe("sha256", () => {
  it("hashes the key bytes with no trailing newline", async () => {
    // statice key's digest != echo "$KEY" | shasum -a 256
    expect(await sha256Hex(enc.encode("test-key"))).toBe(
      "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef",
    );
    expect(await sha256Hex(enc.encode("test-key\n"))).not.toBe(
      "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef",
    );
  });
});
