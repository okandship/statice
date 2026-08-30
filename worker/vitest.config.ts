import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

/**
 * A stateless DoH resolver, keyed entirely on the queried name.
 *
 * `fetchMock` was removed from `cloudflare:test`, and intercepting the global
 * would not reach the Worker anyway: `SELF.fetch` runs it as a separate
 * instance. `outboundService` is where its egress actually goes, so mocking
 * there is both version-stable and closer to the real path.
 *
 * The suffix of the queried host chooses the answer, and the FIRST DNS LABEL is
 * the statice label the proof names — so a test binds `<label>.owned.example`
 * and the proof matches by construction, with no shared state to coordinate.
 */
function doh(request: Request): Response {
  const url = new URL(request.url);
  if (url.hostname !== "cloudflare-dns.com") {
    // Everything else is net-disconnected, as disableNetConnect() used to do.
    return new Response("blocked", { status: 403 });
  }
  const name = url.searchParams.get("name") ?? "";
  const host = name.replace(/^_statice\./, "");
  const label = host.split(".")[0];
  const txt = (data: string) => ({ Status: 0, Answer: [{ type: 16, data }] });

  // SERVFAIL is *unknown*, and unknown authorizes nothing.
  if (host.endsWith(".servfail.example")) return Response.json({ Status: 2 });
  // Only a successful response proves absence: NOERROR-empty and NXDOMAIN.
  if (host.endsWith(".missing.example")) return Response.json({ Status: 0 });
  if (host.endsWith(".nx.example")) return Response.json({ Status: 3 });
  // A record naming somebody else's label.
  if (host.endsWith(".other.example")) return Response.json(txt('"someone-elses-abc"'));
  // Answers unquoted and joined.
  if (host.endsWith(".split.owned.example")) {
    const half = Math.ceil(label.length / 2);
    return Response.json(txt(`"${label.slice(0, half)}" "${label.slice(half)}"`));
  }
  return Response.json(txt(`"${label}"`));
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-08-15",
        compatibilityFlags: ["nodejs_compat"],
        r2Buckets: ["BUCKET"],
        bindings: {
          // sha256("test-key")
          KEY_HASHES: "62af8704764faf8ea82fc61ce9c4c3908b6cb97d463a634e9e587d7c885db0ef",
          // A third zone so the tests can exercise the own-zone path; the
          // reserved two are refused by the host validator by design.
          OWNED_ZONES: "statice.app,statice.run,owned.example",
        },
        outboundService: doh,
      },
    }),
  ],
});
