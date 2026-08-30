// The one cache. Module scope, root-hex -> Map<path, hash>.
//
// The key is content-addressed, so the value can never change: evict by LRU on
// a bound, NEVER by age. This is the only cache in the system that structurally
// cannot serve something stale. Every OTHER cache anyone proposes here is a
// cache of a mutable name.
//
// The bound is a charge of 4x the manifest's byte length -- what is retained is
// two JS strings per entry, which raw length undercounts three to five times --
// and the budget is 8 MB.

import { parseManifest } from "./manifest";

const BUDGET = 8 * 1024 * 1024;
const CHARGE_MULTIPLIER = 4;

interface Slot {
  map: Map<string, string>;
  charge: number;
}

// Map preserves insertion order, which is the LRU list.
const cache = new Map<string, Slot>();
let total = 0;

export function cacheGet(root: string): Map<string, string> | undefined {
  const slot = cache.get(root);
  if (slot === undefined) return undefined;
  cache.delete(root);
  cache.set(root, slot); // touch
  return slot.map;
}

export function cachePut(root: string, text: string, byteLength: number): Map<string, string> {
  const map = parseManifest(text);
  const charge = byteLength * CHARGE_MULTIPLIER;
  const existing = cache.get(root);
  if (existing !== undefined) {
    total -= existing.charge;
    cache.delete(root);
  }
  // A single manifest larger than the whole budget is served but not retained.
  if (charge <= BUDGET) {
    cache.set(root, { map, charge });
    total += charge;
    for (const key of cache.keys()) {
      if (total <= BUDGET) break;
      const victim = cache.get(key)!;
      cache.delete(key);
      total -= victim.charge;
    }
  }
  return map;
}

/** Tests only. */
export function cacheReset(): void {
  cache.clear();
  total = 0;
}

/** Tests only. */
export function cacheStats(): { entries: number; bytes: number } {
  return { entries: cache.size, bytes: total };
}
