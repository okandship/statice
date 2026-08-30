// Every client field is checked against a stated shape before use, on every
// endpoint -- all string tests, all before the first R2 operation.

export const MAX_BLOB_BYTES = 64 * 1024 * 1024; // 2^26
export const MAX_DEPLOY_BYTES = 512 * 1024 * 1024; // 2^29
export const MAX_DEPLOY_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_FILES = 1000;

const HEX64 = /^[0-9a-f]{64}$/;
const LABEL = /^[a-z0-9-]{1,63}$/;
const DIGITS = /^[0-9]+$/;

// Lowercase-only by construction: the host is folded BEFORE this runs, so
// App.Example.com fails outright if the fold comes second.
const HOST =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const IPV4 = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/;

/** 253 minus the nine bytes `_statice.` adds to the name actually queried. */
export const MAX_HOST_BYTES = 244;

export const isHash = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);
export const isLabel = (v: unknown): v is string => typeof v === "string" && LABEL.test(v);
export const isToken = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);
export const isDigits = (v: string): boolean => DIGITS.test(v);

/** Zero is legal and `0` is falsy -- match the digits before converting. */
export function parseContentLength(h: string | null): number | null {
  if (h === null) return null;
  if (!DIGITS.test(h)) return null;
  const n = Number(h);
  return Number.isSafeInteger(n) ? n : null;
}

export function isSize(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_BLOB_BYTES;
}

/** Reserved hosts: statice.app / statice.run and anything under either. */
export function isReservedHost(host: string): boolean {
  for (const zone of ["statice.app", "statice.run"]) {
    if (host === zone || host.endsWith("." + zone)) return true;
  }
  return false;
}

/** Lowercase the host, THEN validate it. Returns the host or null. */
export function validateHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const host = raw.toLowerCase();
  if (new TextEncoder().encode(host).length > MAX_HOST_BYTES) return null;
  if (!HOST.test(host)) return null;
  if (IPV4.test(host)) return null;
  if (host.includes("*")) return null; // belt and braces; HOST already excludes it
  if (isReservedHost(host)) return null;
  return host;
}

/**
 * `Bearer` + one space + key. Scheme case-insensitive; the remainder is hashed,
 * never trimmed. Returns the raw key, or null.
 */
export function bearerKey(header: string | null): string | null {
  if (header === null) return null;
  if (header.length < 7) return null;
  if (header.slice(0, 6).toLowerCase() !== "bearer") return null;
  if (header.charCodeAt(6) !== 32) return null;
  const key = header.slice(7);
  return key.length === 0 ? null : key;
}

/** host === zone || host.endsWith("." + zone) -- underneath means with the dot. */
export function isUnderOwnedZone(host: string, ownedZones: string): boolean {
  for (const raw of ownedZones.split(",")) {
    const zone = raw.trim().toLowerCase();
    if (zone === "") continue;
    if (host === zone || host.endsWith("." + zone)) return true;
  }
  return false;
}
