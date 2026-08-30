// Multi-tenant custom hostnames, via Cloudflare for SaaS. A product rather than
// code. With no SaaS credentials this path answers "not enabled" and writes
// nothing, so launch needs no SaaS setup and strangers later need no redesign.

import type { Env } from "./serve";

export type SaasResult =
  | { ok: true; id: string }
  | { ok: false; kind: "not-enabled" | "upstream"; message: string };

export function saasEnabled(env: Env): boolean {
  return Boolean(env.SAAS_API_TOKEN && env.CF_ZONE_ID);
}

export async function registerHostname(env: Env, host: string): Promise<SaasResult> {
  if (!saasEnabled(env)) {
    return { ok: false, kind: "not-enabled", message: "multi-tenant custom hostnames are not enabled" };
  }
  const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SAAS_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        hostname: host,
        ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return { ok: false, kind: "upstream", message: `custom hostname api unreachable: ${String(e)}` };
  }
  let body: { success?: boolean; result?: { id?: string }; errors?: Array<{ message?: string }> };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, kind: "upstream", message: "custom hostname api returned unparseable json" };
  }
  // An already-registered hostname is success for our purposes.
  if (body.success === true && body.result?.id) return { ok: true, id: body.result.id };
  const message = (body.errors ?? []).map((e) => e.message ?? "").join("; ") || `status ${res.status}`;
  if (/already exists/i.test(message)) return { ok: true, id: "existing" };
  return { ok: false, kind: "upstream", message };
}

export async function unregisterHostname(env: Env, host: string): Promise<void> {
  if (!saasEnabled(env)) return;
  const base = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames`;
  try {
    const list = await fetch(`${base}?hostname=${encodeURIComponent(host)}`, {
      headers: { Authorization: `Bearer ${env.SAAS_API_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    const body = (await list.json()) as { result?: Array<{ id?: string; hostname?: string }> };
    for (const item of body.result ?? []) {
      if (item.hostname !== host || !item.id) continue;
      await fetch(`${base}/${item.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${env.SAAS_API_TOKEN}` },
        signal: AbortSignal.timeout(10000),
      });
    }
  } catch {
    // Unbind deletes the record first, so both fail toward a state the
    // dangling-hostname reconcile can see.
  }
}
