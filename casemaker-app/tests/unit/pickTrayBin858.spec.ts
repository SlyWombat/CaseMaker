// #858 — the tight-corner half, split out of pickTray858 so the two full searches (the demo tray
// and the four 0.6 mm-corner bins) run in parallel workers. #1180.

import { describe, expect, it } from 'vitest';

import { planCostSeconds, FIDELITY_TIE } from '@/engine/cnc/engrave/smartPick';
import { CLEAR, FINE, SEED, keys, pickFor, tray } from './helpers/pickTray858';

describe('#858 tight bin corners — the clear-plus-rest pair is the answer', () => {
  it('tight bin corners: the ⌀3.175 clear with a ⌀1 rest wins, at about a quarter of the ⌀1’s time', { timeout: 900_000 }, async () => {
    // Four of the tray's bins with 0.6 mm corners: the ⌀3.175 leaves each corner 0.46 mm² short,
    // past the tie, so the rest pass is what reproduces the design.
    const job = tray();
    const keep = new Set(['bin0', 'bin1', 'bin2', 'bin3']);
    job.shapes = job.shapes
      .filter((s) => keep.has(s.id))
      .map((s) => (s.kind === 'rect' ? { ...s, cornerRadius: 0.6 } : s));
    job.combined = [];
    job.drills = [];
    job.cutouts = [];
    const pick = await pickFor(job);
    expect(pick.runnable, pick.notes.join(' ')).not.toBeNull();
    const byKeys = new Map(pick.considered.map((s) => [keys(s), s] as const));
    const single = byKeys.get(CLEAR)!;
    const fine = byKeys.get(FINE)!;
    expect(single.worstFidelity).toBeLessThan(fine.worstFidelity - FIDELITY_TIE);
    expect(keys(pick.chosen)).toBe(`${CLEAR}+${FINE}`);
    const cost = (s: (typeof pick.considered)[number]) => planCostSeconds(s.evaluation, SEED.value);
    // About 51 min 34 s for the pair (one change at the seed included) against 3 h 8 min for the ⌀1.
    expect(cost(pick.chosen) / cost(fine)).toBeCloseTo(0.274, 2);
  });
});
