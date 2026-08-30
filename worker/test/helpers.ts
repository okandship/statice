import { SELF } from "cloudflare:test";
import { serializeManifest, sha256Hex } from "../src/manifest";

export const KEY = "test-key";
export const API = "https://api.statice.run";
export const auth = { Authorization: `Bearer ${KEY}` };

const encoder = new TextEncoder();
export const bytes = (s: string) => encoder.encode(s);

export async function api(
  path: string,
  init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {},
) {
  return SELF.fetch(`${API}${path}`, { ...init, headers: { ...auth, ...(init.headers ?? {}) } });
}

export async function apiPost(path: string, body: unknown, extra: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  return api(path, {
    method: "POST",
    body: text,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(bytes(text).length),
      ...extra,
    },
  });
}

export const site = (url: string, init: RequestInit = {}) => SELF.fetch(url, init);

export async function upload(b: Uint8Array): Promise<string> {
  const hash = await sha256Hex(b);
  const res = await api(`/v1/blobs/${hash}`, {
    method: "PUT",
    body: b,
    headers: { "Content-Length": String(b.length) },
  });
  if (res.status !== 201) throw new Error(`blob PUT ${res.status}: ${await res.text()}`);
  return hash;
}

export async function rootOf(files: Record<string, string>): Promise<string> {
  const entries = await Promise.all(
    Object.entries(files).map(async ([path, content]) => ({ path, hash: await sha256Hex(bytes(content)) })),
  );
  return sha256Hex(serializeManifest(entries)!);
}

export async function manifestFor(files: Record<string, string>) {
  const out: Record<string, [string, number]> = {};
  for (const [path, content] of Object.entries(files)) {
    const b = bytes(content);
    out[path] = [await sha256Hex(b), b.length];
  }
  return out;
}

export interface DeployBody {
  status?: string;
  root: string;
  url: string;
  missing?: string[];
  error?: string;
  message?: string;
}

/** Run the client loop to completion: deploy, upload what's missing, deploy again. */
export async function deployFiles(files: Record<string, string>, base?: string): Promise<DeployBody> {
  const manifest = await manifestFor(files);
  const body = { files: manifest, ...(base ? { base } : {}) };
  let res = await apiPost("/v1/deploy", body);
  let out = (await res.json()) as DeployBody;
  if (out.status === "incomplete") {
    for (const content of Object.values(files)) {
      const b = bytes(content);
      if (out.missing!.includes(await sha256Hex(b))) await upload(b);
    }
    res = await apiPost("/v1/deploy", body);
    out = (await res.json()) as DeployBody;
  }
  return out;
}

export const labelOf = (url: string) => new URL(url).hostname.replace(".statice.app", "");
