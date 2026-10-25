/**
 * A keyed cache for probe results that stays bounded for a long-lived host. Implements the
 * per-process version and capability caches of PRD §9.2 (C-PERF-02) and the
 * never-cache-a-rejection rule of C-LIFE-11.
 */

export type ProbeCache<T> = {
  /** The cached or in-flight result for `key`, else the result of a new `run()`. */
  readonly get: (key: string, run: () => Promise<T>) => Promise<T>;
  readonly clear: () => void;
};

/**
 * Concurrent callers for one key share its single in-flight run, which is never evicted. Only
 * the `limit` most recently used SUCCESSES are kept once settled; the least recently used goes
 * first. A rejection is never kept, so a failure cannot poison later callers. A run that
 * settles after `clear()` is dropped rather than cached.
 */
export function createProbeCache<T>(limit: number): ProbeCache<T> {
  const running = new Map<string, Promise<T>>();
  // Map order is recency order: a hit is re-inserted at the end, eviction takes the front.
  const settled = new Map<string, { readonly value: T }>();
  const get = (key: string, run: () => Promise<T>): Promise<T> => {
    const hit = settled.get(key);
    if (hit) {
      settled.delete(key);
      settled.set(key, hit);
      return Promise.resolve(hit.value);
    }
    const existing = running.get(key);
    if (existing) return existing;
    const pending = run();
    running.set(key, pending);
    const current = () => running.get(key) === pending;
    pending.then(
      (value) => {
        if (!current()) return;
        running.delete(key);
        settled.set(key, { value });
        for (const oldest of settled.keys()) {
          if (settled.size <= limit) break;
          settled.delete(oldest);
        }
      },
      () => {
        if (current()) running.delete(key);
      },
    );
    return pending;
  };
  return {
    get,
    clear: () => {
      running.clear();
      settled.clear();
    },
  };
}
