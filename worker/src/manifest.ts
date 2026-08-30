// The manifest: sorted UTF-8 text, one line per file, newline-terminated.
//
//   <sha256-hex> <path>\n
//
// root = SHA-256 of exactly those bytes. The fixed-width prefix lets readers
// slice at byte 65. Sorted by path, strictly ascending, comparing UTF-8 BYTES
// (not UTF-16 code units -- they disagree above the BMP).
//
// FROZEN once the first real link is shared.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const MAX_PATH_BYTES = 1024;

/**
 * Reject, never repair -- the governing rule for every client field.
 * Returns true only for a path already in canonical form.
 */
export function isCanonicalPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (path.charCodeAt(0) !== 47 /* / */) return false;
  if (path.charCodeAt(path.length - 1) === 47) return false; // trailing /
  if (enc.encode(path).length > MAX_PATH_BYTES) return false;

  // \n \r NUL \
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c === 10 || c === 13 || c === 0 || c === 92) return false;
  }

  // unpaired surrogates
  if (!isWellFormed(path)) return false;

  // non-NFC
  if (path.normalize("NFC") !== path) return false;

  // . / .. / empty segments (empty also catches //)
  const segments = path.split("/");
  // segments[0] is "" from the leading slash
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i];
    if (s === "" || s === "." || s === "..") return false;
  }
  return true;
}

function isWellFormed(s: string): boolean {
  const f = (String.prototype as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  if (typeof f === "function") return f.call(s);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** UTF-8 byte-order comparison. Returns <0, 0, >0. */
export function compareUtf8(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

export interface Entry {
  hash: string;
  path: string;
}

/**
 * Serialize once, canonically. Rejects duplicate paths (strictly ascending).
 * Returns null if two entries share a path.
 */
export function serializeManifest(entries: Entry[]): Uint8Array | null {
  const withBytes = entries.map((e) => ({ e, b: enc.encode(e.path) }));
  withBytes.sort((x, y) => compareUtf8(x.b, y.b));
  for (let i = 1; i < withBytes.length; i++) {
    if (compareUtf8(withBytes[i - 1].b, withBytes[i].b) === 0) return null;
  }
  let text = "";
  for (const { e } of withBytes) text += e.hash + " " + e.path + "\n";
  return enc.encode(text);
}

export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const src: ArrayBuffer =
    bytes instanceof Uint8Array
      ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      : bytes;
  const digest = await crypto.subtle.digest("SHA-256", src);
  const view = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < view.length; i++) s += view[i].toString(16).padStart(2, "0");
  return s;
}

/**
 * Read a stored manifest into a Map. Slices each line at 64 and 65 -- the
 * fixed-width prefix is what makes this cheap.
 */
export function parseManifest(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let i = 0;
  while (i < text.length) {
    let nl = text.indexOf("\n", i);
    if (nl < 0) nl = text.length;
    const line = text.slice(i, nl);
    i = nl + 1;
    if (line.length < 66) continue;
    map.set(line.slice(65), line.slice(0, 64));
  }
  return map;
}

/** Every hash a stored manifest names. Used by the base subtraction. */
export function manifestHashes(text: string): Set<string> {
  const set = new Set<string>();
  let i = 0;
  while (i < text.length) {
    let nl = text.indexOf("\n", i);
    if (nl < 0) nl = text.length;
    const line = text.slice(i, nl);
    i = nl + 1;
    if (line.length < 66) continue;
    set.add(line.slice(0, 64));
  }
  return set;
}

export function decodeUtf8(buf: ArrayBuffer): string {
  return dec.decode(buf);
}
