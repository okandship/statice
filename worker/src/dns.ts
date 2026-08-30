// Resolution is DoH against a fixed resolver, answers unquoted and joined, any
// one record matching counting.
//
// One discipline the whole layer leans on: ONLY A SUCCESSFUL RESPONSE PROVES
// ABSENCE. NXDOMAIN or an empty answer is absent, while SERVFAIL or a timeout
// is *unknown*, and unknown authorizes nothing.

export type ProofResult =
  | { state: "match" }
  | { state: "other"; found: string[] }
  | { state: "absent" }
  | { state: "unknown"; reason: string };

const DEFAULT_DOH = "https://cloudflare-dns.com/dns-query";
const TIMEOUT_MS = 5000;

export function proofName(host: string): string {
  return `_statice.${host}`;
}

/** Unquote a DoH TXT `data` field: `"a" "b"` -> `ab`. */
export function unquoteTxt(data: string): string {
  const parts = data.match(/"(?:[^"\\]|\\.)*"/g);
  if (parts === null) return data.trim();
  return parts
    .map((p) => p.slice(1, -1).replace(/\\(\d{3}|.)/g, (_, c: string) =>
      /^\d{3}$/.test(c) ? String.fromCharCode(parseInt(c, 10)) : c,
    ))
    .join("");
}

export async function checkProof(host: string, label: string, endpoint?: string): Promise<ProofResult> {
  const name = proofName(host);
  const url = `${endpoint ?? DEFAULT_DOH}?name=${encodeURIComponent(name)}&type=TXT`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    return { state: "unknown", reason: `resolver unreachable: ${String(e)}` };
  }
  if (!res.ok) return { state: "unknown", reason: `resolver returned ${res.status}` };

  let body: { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { state: "unknown", reason: "resolver returned unparseable json" };
  }

  const status = body.Status;
  if (status === undefined) return { state: "unknown", reason: "resolver omitted Status" };
  // 0 NOERROR, 3 NXDOMAIN -- both are successful answers and prove absence.
  if (status !== 0 && status !== 3) {
    return { state: "unknown", reason: `resolver status ${status}` };
  }

  const found: string[] = [];
  for (const answer of body.Answer ?? []) {
    if (answer.type !== 16) continue; // TXT
    if (typeof answer.data !== "string") continue;
    const value = unquoteTxt(answer.data);
    found.push(value);
    if (value === label) return { state: "match" };
  }
  if (found.length === 0) return { state: "absent" };
  return { state: "other", found };
}
