/**
 * #1054 — the rank memo's own store: one entry per key, every user named, and `evictOwner` drops
 * an op only when its last user is gone (a shared rough survives the loss of either candidate).
 * Unit-level, beside the behavioural pin in `rankMemo1054.spec.ts`.
 */

import { describe, expect, it } from 'vitest';

import { createStageMemo, type OpOutcome } from '@/engine/cnc/cam/model/plan';

describe('#1054 the stage memo store', () => {
  it('keeps one entry per key and evicts an op only when its last user is gone', () => {
    const memo = createStageMemo();
    const op = (): OpOutcome => ({ ir: { operations: [] } }) as unknown as OpOutcome;
    const a = op();
    const b = op();
    const c = op();
    memo.set('finish|ball-2|r1', { outcome: a, owners: new Set(['ball-2']) });
    memo.set('finish|ball-4|r1', { outcome: b, owners: new Set(['ball-4']) });
    memo.set('rough|flat-6|r1', { outcome: c, owners: new Set(['ball-2']) });
    expect(memo.get('finish|ball-2|r1', 'ball-2')!.outcome).toBe(a);
    // The rough is shared: the second candidate reads the same op and becomes one of its users.
    expect(memo.get('rough|flat-6|r1', 'ball-4')!.outcome).toBe(c);
    memo.evictOwner('ball-4');
    expect(memo.get('finish|ball-4|r1', 'ball-4')).toBeUndefined();
    expect(memo.get('finish|ball-2|r1', 'ball-2')!.outcome).toBe(a);
    // The winner still uses the rough, so it must survive the loser's eviction.
    expect(memo.get('rough|flat-6|r1', 'ball-2')!.outcome).toBe(c);
    // An op only one loser used dies with it.
    memo.set('pencil|ball-4|r2', { outcome: b, owners: new Set(['ball-4']) });
    memo.evictOwner('ball-4');
    expect(memo.get('pencil|ball-4|r2', 'ball-4')).toBeUndefined();
    // And the winner's own eviction finally takes the shared rough with it.
    memo.evictOwner('ball-2');
    expect(memo.get('rough|flat-6|r1', 'ball-2')).toBeUndefined();
    expect(memo.get('finish|ball-2|r1', 'ball-2')).toBeUndefined();
  });
});
