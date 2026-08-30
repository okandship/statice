import type { Env as WorkerEnv } from "../src/serve";

declare global {
  // `cloudflare:test` types `env` as Cloudflare.Env; give it the shape the
  // Worker actually sees.
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
