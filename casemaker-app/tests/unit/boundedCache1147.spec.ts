// #1147 — the stamp cache's ceiling is the fix: a plan stamps 5.51 MiB fields per unique chain-step
// IR and folds them many times, so the cache must REUSE without ever holding more than its cap.
// These cases count ENTRIES (the retained-memory proof is the set B trace, not a unit test).
import { describe, expect, it } from 'vitest';

import { BoundedCache } from '@/engine/cnc/cam/model/boundedCache';

describe('#1147 the bounded stamp cache', () => {
  it('never holds more than its cap, evicting the OLDEST first', () => {
    const cache = new BoundedCache<object, string>(32);
    const keys = Array.from({ length: 40 }, () => ({}));
    for (const [i, key] of keys.entries()) {
      cache.set(key, `field-${i}`);
      expect(cache.size).toBeLessThanOrEqual(32);
    }
    expect(cache.size).toBe(32);
    // The first eight insertions are gone; the newest is present.
    for (const key of keys.slice(0, 8)) expect(cache.get(key)).toBeUndefined();
    for (const key of keys.slice(8)) expect(cache.get(key)).toBeDefined();
  });

  it('a HIT does not refresh an entry (FIFO, not LRU)', () => {
    const cache = new BoundedCache<object, number>(2);
    const [a, b, c] = [{}, {}, {}];
    cache.set(a!, 1);
    cache.set(b!, 2);
    expect(cache.get(a!)).toBe(1);
    cache.set(c!, 3);
    // Reading `a` did not save it: it was the oldest insertion.
    expect(cache.get(a!)).toBeUndefined();
    expect(cache.get(b!)).toBe(2);
    expect(cache.get(c!)).toBe(3);
  });

  it('re-setting an existing key replaces the value without growing', () => {
    const cache = new BoundedCache<object, number>(1);
    const key = {};
    cache.set(key, 1);
    cache.set(key, 2);
    expect(cache.size).toBe(1);
    expect(cache.get(key)).toBe(2);
    expect(cache.limit).toBe(1);
  });

  it('refuses a capacity that is not a positive integer', () => {
    expect(() => new BoundedCache(0)).toThrow(/positive integer/);
    expect(() => new BoundedCache(1.5)).toThrow(/positive integer/);
  });
});
