// One table, three uses: admission at deploy, Content-Type at serve, a name at
// review. The extension is lowercased for the lookup and the path never is.
// Text types carry `; charset=utf-8` IN THE VALUE, so the charset is data, not
// a branch.
//
// FROZEN. Server-side keys are append-at-will, but changing an admitted
// extension's VALUE is not, and client-side the table is frozen in both
// directions -- the CLI admits files by it, so it decides which files a folder
// has, and the selection policy is an input to the root.
//
// This table is mirrored byte-for-byte in cli/statice.mjs. They must agree.

export interface TypeEntry {
  type: string;
  /** Named at review, on every deploy in which the file is new. */
  flag?: string;
}

const T = (type: string): TypeEntry => ({ type });

export const TYPE_TABLE: Record<string, TypeEntry> = {
  // documents + code
  html: T("text/html; charset=utf-8"),
  htm: T("text/html; charset=utf-8"),
  css: T("text/css; charset=utf-8"),
  js: T("text/javascript; charset=utf-8"),
  mjs: T("text/javascript; charset=utf-8"),
  json: T("application/json; charset=utf-8"),
  wasm: T("application/wasm"),

  // the bundles a Godot or Unity export is nothing without; inert as documents
  // under nosniff
  pck: T("application/octet-stream"),
  data: T("application/octet-stream"),

  // the one flagged entry
  map: { type: "application/json; charset=utf-8", flag: "sourcemaps embed original source" },

  // image set
  png: T("image/png"),
  jpg: T("image/jpeg"),
  jpeg: T("image/jpeg"),
  gif: T("image/gif"),
  webp: T("image/webp"),
  avif: T("image/avif"),
  bmp: T("image/bmp"),
  ico: T("image/x-icon"),
  svg: T("image/svg+xml; charset=utf-8"),

  // font set
  woff: T("font/woff"),
  woff2: T("font/woff2"),
  ttf: T("font/ttf"),
  otf: T("font/otf"),

  // media set
  mp4: T("video/mp4"),
  webm: T("video/webm"),
  mov: T("video/quicktime"),
  ogv: T("video/ogg"),
  mp3: T("audio/mpeg"),
  wav: T("audio/wav"),
  ogg: T("audio/ogg"),
  oga: T("audio/ogg"),
  m4a: T("audio/mp4"),
  flac: T("audio/flac"),
  aac: T("audio/aac"),

  // geometry, fetched by name at runtime the way an image is -- an OBJ loader
  // reads the file the manifest names, so excluding it publishes a scene with
  // nothing in it; text, and inert as a document under nosniff
  obj: T("model/obj; charset=utf-8"),

  // the rest
  pdf: T("application/pdf"),
  txt: T("text/plain; charset=utf-8"),
  xml: T("application/xml; charset=utf-8"),
  webmanifest: T("application/manifest+json; charset=utf-8"),
  vtt: T("text/vtt; charset=utf-8"),
  md: T("text/markdown; charset=utf-8"),
};

/**
 * The one exception to "extensionless is excluded": extensionless files under a
 * top-level /.well-known/, from a name -> type map.
 */
export const WELL_KNOWN_TABLE: Record<string, TypeEntry> = {
  "cross-origin-isolated": T("text/plain; charset=utf-8"),
  "apple-app-site-association": T("application/json; charset=utf-8"),
  "assetlinks": T("application/json; charset=utf-8"),
  "nodeinfo": T("application/json; charset=utf-8"),
  "host-meta": T("application/xrd+xml; charset=utf-8"),
  "webfinger": T("application/jrd+json; charset=utf-8"),
  "dnt-policy": T("text/plain; charset=utf-8"),
  "change-password": T("text/plain; charset=utf-8"),
};

export const ISOLATION_MARKER = "/.well-known/cross-origin-isolated";

/** Lowercase the extension for the lookup; the path itself is never folded. */
function extensionOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // no dot, or a leading dot (dotfile, not an extension)
  return name.slice(dot + 1).toLowerCase();
}

function wellKnownName(path: string): string | null {
  if (!path.startsWith("/.well-known/")) return null;
  const rest = path.slice("/.well-known/".length);
  if (rest.includes("/")) return null; // top-level only
  return rest.toLowerCase();
}

/** The admission and Content-Type decision, in one place. */
export function lookupType(path: string): TypeEntry | null {
  const ext = extensionOf(path);
  if (ext !== null) {
    return Object.prototype.hasOwnProperty.call(TYPE_TABLE, ext) ? TYPE_TABLE[ext] : null;
  }
  const wk = wellKnownName(path);
  if (wk !== null && Object.prototype.hasOwnProperty.call(WELL_KNOWN_TABLE, wk)) {
    return WELL_KNOWN_TABLE[wk];
  }
  return null;
}

export function isAdmitted(path: string): boolean {
  return lookupType(path) !== null;
}
