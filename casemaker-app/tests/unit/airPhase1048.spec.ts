/**
 * #1048 — THE RAPID-MOVE CHECK REPORTS WHILE IT WORKS (the column engine).
 *
 * The client's silence clock re-arms only on messages; before this, a long air phase was silent
 * from the first checkpoint to the load's end, so on a slow machine the worker was terminated as
 * stalled with nothing actually wrong. The phase now announces itself ('air') and ticks every
 * AIR_PROGRESS_EVERY tested moves, so the window always sees it working.
 */
import { describe, expect, it } from 'vitest';

import { AIR_PROGRESS_EVERY, COLUMN_AIR_CHECK_CAP } from '@/workers/geometry/sweep';
import { columnSweep } from '@/workers/geometry/columnEngine';
import { buildTimeline, parseGcode, stubSetup, MACHINES } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const setup = () => stubSetup(SLAB, { kind: 'tape-down', contact: SLAB.outline });
const tool = flatEndMill(1);

/** One stroke, then 300 rapids below the stock top: more than one tick inside the air phase. */
const RAPIDS = Array.from({ length: 300 }, (_, i) => `G0 X${2 + (i % 40)} Y${2 + Math.floor(i / 40)} Z-0.5`).join('\n');
const SRC = 'S1000 M3\nG0 X10 Y10 Z-1\nG1 X20 F100\nG0 Z-0.5\n' + RAPIDS + '\nG0 Z2\nM5\n';

describe('#1048 — the column engine’s rapid-move check is its own phase', () => {
  it('announces itself and ticks every AIR_PROGRESS_EVERY tested moves, capped by MAX_AIR_CHECKS', () => {
    const s = setup();
    const timeline = buildTimeline(parseGcode(SRC), s, MACHINES.Z1);
    const phases: string[] = [];
    const ticks: [number, number][] = [];
    const out = columnSweep(timeline, tool, s, {
      onPhase: (p) => phases.push(p),
      onProgress: (d, t) => ticks.push([d, t]),
    });
    expect(out.ok).toBe(true);
    expect(phases).toEqual(['air']);
    const airTicks = ticks.filter(([, total]) => total > 100);
    expect(airTicks.length, 'the phase ticks while it works').toBeGreaterThanOrEqual(1);
    expect(airTicks[0]![0] % AIR_PROGRESS_EVERY).toBe(0);
    expect(Math.max(...airTicks.map(([, total]) => total))).toBeLessThanOrEqual(COLUMN_AIR_CHECK_CAP);
    expect(out.diagnostics.some((d) => d.code === 'air-moves-unchecked'), '300 moves fit the cap').toBe(false);
  });

  it('#858/#1048 — a job with more moves than the EXACT cap still checks every one here', () => {
    // The e2e's figure job has 5,039 air moves below the stock top. The column engine's own cap is
    // high for #858's reason (its check is a cell walk, not a boolean), so none is left unchecked:
    // the count cap that bounds the exact sweeper must not produce a false ERROR here.
    const many = Array.from({ length: 5000 }, (_, i) => `G0 X${2 + (i % 60)} Y${2 + Math.floor((i / 60) % 40)} Z-0.5`).join('\n');
    const src = 'S1000 M3\nG0 X10 Y10 Z-1\nG1 X20 F100\nG0 Z-0.5\n' + many + '\nG0 Z2\nM5\n';
    const s = setup();
    const timeline = buildTimeline(parseGcode(src), s, MACHINES.Z1);
    const out = columnSweep(timeline, tool, s, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diagnostics.some((d) => d.code === 'air-moves-unchecked'), 'no move is left unchecked').toBe(false);
    expect(out.stats.airMovesChecked).toBeGreaterThan(4000);
  });
});
