/**
 * dataVersion — a tiny, dependency-free invalidation + in-memory cache layer.
 *
 * Motivation: every list screen re-reads its FULL dataset on every focus via
 * `useFocusEffect`, so navigating back to a list always shows a spinner and
 * re-runs the (potentially heavy) SQLite/aggregation queries even when nothing
 * changed. That is the single biggest perceived-slowness issue on low-end
 * Android.
 *
 * The scheme:
 *  - A monotonically increasing `version` number, bumped whenever ANY mutation
 *    happens (wired into the two api.ts write choke points, plus a handful of
 *    non-router write sites and book switches).
 *  - Screens remember the version at which they last loaded. On focus they
 *    check `getDataVersion()`; if it hasn't changed since their last load they
 *    skip the reload entirely (instant back-navigation). Pull-to-refresh always
 *    forces a reload.
 *  - An optional in-memory cache keyed by (screenKey + activeBook) lets a screen
 *    render its last-known data instantly on focus while a background refresh
 *    runs only when the version advanced.
 *
 * This is intentionally NOT a state-management framework: no subscriptions, no
 * React context, no re-render fan-out. Screens read the value imperatively
 * inside their existing focus effect.
 */

let version = 0;

/** Current global data version. Advances on every mutation. */
export function getDataVersion(): number {
  return version;
}

/**
 * Bump the global data version. Call after any write that could change what a
 * list/dashboard screen displays. Cheap and safe to over-call.
 */
export function bumpDataVersion(): number {
  version += 1;
  return version;
}

// ---- In-memory per-screen cache -------------------------------------------
// Keyed by an arbitrary string (typically `${screenKey}:${activeBookId}`).
// Stores the last-loaded payload alongside the version at which it was loaded.

type CacheEntry<T = unknown> = { version: number; data: T };

const cache = new Map<string, CacheEntry>();

/** Read a cached payload for a key, or undefined if nothing is cached yet. */
export function getCached<T>(key: string): { version: number; data: T } | undefined {
  return cache.get(key) as CacheEntry<T> | undefined;
}

/** Store a payload for a key, tagging it with the current data version. */
export function setCached<T>(key: string, data: T): void {
  cache.set(key, { version, data });
}

/**
 * True when the cache entry for `key` is still valid (present and captured at
 * the current data version) — i.e. the screen can skip reloading.
 */
export function isCacheFresh(key: string): boolean {
  const entry = cache.get(key);
  return entry != null && entry.version === version;
}

/** Drop the entire in-memory cache (e.g. on book reset or sign-out). */
export function clearDataCache(): void {
  cache.clear();
}
