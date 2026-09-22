// Tiny in-memory TTL cache. The Revenue Recap feature's slowness comes from network
// round-trips to the external Zarve API (paginated invoice fetches + per-vehicle status
// history, throttled to avoid overwhelming it) -- nothing about how the page renders
// changes that. This cache is what actually makes repeat views fast: the first load of
// a given (category, month) is still bound by that external round-trip, but reopening
// the same combination within the TTL is instant.

interface Entry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, Entry<unknown>>();

// Requests for the same key that are already in flight -- e.g. two dashboard tabs
// opened at once, or React Strict Mode's dev-only double-invoked effect -- share the
// same underlying fetch instead of each independently hammering the Zarve API. Without
// this, a slow ~10-15s cold key hit twice in the same window means double the load
// (and, for the per-vehicle fan-out calls, double the risk of the connect-timeouts
// that showed up under concurrency) for no benefit -- both callers wanted the same data.
const inFlight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.value as T;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = fn()
    .then((value) => {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

export function invalidateCache(prefix?: string) {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
