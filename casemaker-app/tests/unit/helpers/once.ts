/**
 * #1180 B1 — run a deterministic, expensive setup ONCE per spec file.
 *
 * Generator specs re-plan and re-generate the same job inside every `it`. The work is
 * deterministic and the results are read-only under the assertions, so a cache keyed by a
 * semantic name (never by object identity — two `it`s build equal-but-distinct inputs) changes
 * WHEN the work happens, never what is asserted. The cache lives in the spec file's own module
 * graph (vitest isolates files), so nothing leaks between files.
 *
 * A rejected promise is evicted so a later call retries rather than inheriting a transient
 * failure; a spec that WANTS a second, independent run (determinism pins) calls the production
 * function directly instead of `once`.
 */

const cache = new Map<string, Promise<unknown>>();

export function once<T>(key: string, run: () => Promise<T> | T): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached as Promise<T>;
  const started = Promise.resolve().then(run);
  cache.set(key, started);
  started.catch(() => {
    if (cache.get(key) === started) cache.delete(key);
  });
  return started;
}

/** Test-only: forget every cached setup (a spec resetting module state between cases). */
export function resetOnce(): void {
  cache.clear();
}
