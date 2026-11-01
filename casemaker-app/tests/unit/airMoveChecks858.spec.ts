// #858 — WHY 11 204 AIR MOVES WENT UNCHECKED. The tool tray's ⌀1 mm program has 15 204 air moves;
// the run sheet said 11 204 of them were "not checked: more than 4000 in the job". The cap was the
// exact sweeper's (`MAX_AIR_CHECKS`, one Manifold boolean per check), and it counted EVERY air
// move — the ones above the stock, settled by one comparison, included. The tray's program is
// dense, so the COLUMN engine swept it, and that engine borrowed the same count cap although its
// check is a walk over a few grid cells: checking all 14 644 moves below the stock top costs about
// 41 ms there, against 16 ms capped.
//
// Fixed: the exact sweeper's cap counts only the moves that need its boolean, and the column
// engine has no count cap (the sweep's own time budget still bounds it). Each case below ends with
// a rapid that plunges into uncut stock AFTER more than 4000 other air moves: before the fix it was
// one of the unchecked, and the gouge went unreported.

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { buildTimeline, parseGcode, stubSetup } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import { MAX_AIR_CHECKS, sweepTimeline } from '@/workers/geometry/sweep';
import { columnSweep } from '@/workers/geometry/columnEngine';

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const setup = () => stubSetup(SLAB, { kind: 'tape-down' as const, contact: SLAB.outline });
const tool = flatEndMill(1);

/** A 20 mm slot at Z −1, then `hops` rapids, then a rapid plunge into stock nothing has cut. */
function program(hops: (i: number) => string, count: number): string {
  const lines = ['S1000 M3', 'G0 X10 Y10 Z5', 'G1 Z-1 F100', 'G1 X30 F300', 'G0 Z5'];
  for (let i = 0; i < count; i++) lines.push(hops(i));
  lines.push('G0 Z5', 'G0 X50 Y40', 'G0 Z-0.5', 'G0 Z5', 'M5');
  return lines.join('\n');
}

const HOPS = MAX_AIR_CHECKS + 500;

describe('#858 every air move near the stock is checked', () => {
  it('exact sweep: moves above the stock do not spend the cap, so the late plunge is caught', () => {
    // 4500 rapids at Z 5 over a 5 mm blank: settled without a boolean.
    const nc = program((i) => `G0 X${i % 2 === 0 ? 20 : 25} Y40`, HOPS);
    const s = setup();
    const out = sweepTimeline(tl, buildTimeline(parseGcode(nc), s), tool, s);
    if (!out.ok) throw new Error(out.diagnostics.map((d) => d.message).join('; '));
    const codes = out.value.diagnostics.map((d) => d.code);
    expect(codes, 'no move near the stock went unchecked').not.toContain('air-moves-unchecked');
    expect(codes, 'the plunge after them is a gouge, and it is found').toContain('rapid-through-stock');
    expect(out.value.stats.airMovesChecked).toBeGreaterThan(MAX_AIR_CHECKS);
    out.value.gouges.forEach((g) => g.solid.delete());
  });

  it('column engine: 4500 rapids below the stock top are all tested, and the late plunge is caught', () => {
    // Back and forth INSIDE the slot at Z −0.5: below the stock top, so each needs the grid test,
    // and none gouges — the slot is already cut to Z −1 under the same disc.
    const nc = program((i) => `G0 X${i % 2 === 0 ? 30 : 10} Z-0.5`, HOPS);
    const s = setup();
    const out = columnSweep(buildTimeline(parseGcode(nc), s), tool, s);
    if (!out.ok) throw new Error(out.diagnostics.map((d) => d.message).join('; '));
    const air = out.diagnostics.filter((d) => d.code === 'air-moves-unchecked');
    expect(air, 'nothing below the stock top was left unchecked').toEqual([]);
    const gouges = out.diagnostics.filter((d) => d.code === 'rapid-through-stock');
    // The plunge, and its retract back out through the same uncut stock: the first is the plunge's
    // own line (5 lines of slot, the hops, then `G0 Z5`, `G0 X50 Y40`, `G0 Z-0.5`).
    expect(gouges, 'one finding for the rapids into uncut stock').toHaveLength(1);
    expect(gouges[0]!.message).toContain(`first at line ${5 + HOPS + 3})`);
  });
});
