// RFC 4648 base32, lowercase, unpadded. 256 bits -> 52 chars.
// Hex is 64 and a DNS label caps at 63, which is why this exists.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

const REVERSE = (() => {
  const r = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) r[ALPHABET.charCodeAt(i)] = i;
  return r;
})();

export const B32_ALPHABET = ALPHABET;

export function encodeBase32(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** Returns null on any character outside the alphabet. Does not check canonicity. */
export function decodeBase32(label: string): Uint8Array | null {
  const outLen = Math.floor((label.length * 5) / 8);
  const out = new Uint8Array(outLen);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    const v = c < 128 ? REVERSE[c] : -1;
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function rootToLabel(rootHex: string): string {
  return encodeBase32(hexToBytes(rootHex));
}

/**
 * Non-canonical labels 404: decode, re-encode, compare byte-for-byte.
 * Returns the 64-hex root, or null.
 */
export function labelToRoot(label: string): string | null {
  if (label.length !== 52) return null;
  const bytes = decodeBase32(label);
  if (bytes === null || bytes.length !== 32) return null;
  if (encodeBase32(bytes) !== label) return null;
  return bytesToHex(bytes);
}
