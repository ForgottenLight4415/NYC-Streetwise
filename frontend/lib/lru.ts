// Server-side only. A minimal TTL + capacity cache for route handlers.
//
// Not `lru-cache` from npm: this needs `get`, `set` and eviction, the whole
// thing is thirty lines, and a Map already keeps insertion order — so the
// oldest key is just the first one the iterator yields.
//
// SCOPE. This lives in the module graph of a serverless function, so it is
// shared by every request that lands on the same warm instance and lost when
// that instance is recycled. On Vercel's Fluid Compute that is a genuinely
// high hit rate; on classic per-request isolates it degrades to "no cache",
// never to "wrong cache". Nothing here is correctness-critical — both callers
// re-fetch on a miss — so a cold instance costs latency, not behaviour.
//
// Safe to hold request-derived values because the entries are keyed by, and
// contain only, the address being resolved: there is no per-user state in here
// (cf. server-no-shared-module-state).

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<V> {
  private map = new Map<string, Entry<V>>();

  constructor(
    private max: number,
    private ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert so recency ordering is maintained: delete + set moves this key
    // to the end, which is what makes the eviction below least-recently-used
    // rather than merely oldest-written.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    // Delete first so an overwrite also counts as a use.
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
