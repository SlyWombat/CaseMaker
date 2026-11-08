/**
 * #1054 — the rank memo's own store: one entry per key, and `evictOwner` drops a losing
 * candidate's ops (the rank's memory bound). Unit-level, beside the behavioural pin in
 * `rankMemo1054.spec.ts`.
 */

import { describe, expect, it } from 'vitest';

import { createStageMemo, type OpOutcome } from '@/engine/cnc/cam/model/plan';

describe('#1054 the stage memo store', () => {
  it('keeps one entry per key and evicts only the named owner', () => {
    const memo = createStageMemo();
    const op = (): OpOutcome => ({ ir: { operations: [] } }) as unknown as OpOutcome;
    const a = op();
    const b = op();
    const c = op();
    memo.set('finish|ball-2|r1', { outcome: a, owner: 'ball-2' });
    memo.set('finish|ball-4|r1', { outcome: b, owner: 'ball-4' });
    memo.set('rough|flat-6|r1', { outcome: c, owner: 'ball-2' });
    expect(memo.get('finish|ball-2|r1')!.outcome).toBe(a);
    memo.evictOwner('ball-4');
    expect(memo.get('finish|ball-4|r1')).toBeUndefined();
    expect(memo.get('finish|ball-2|r1')!.outcome).toBe(a);
    expect(memo.get('rough|flat-6|r1')!.outcome).toBe(c);
  });
});
