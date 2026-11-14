/**
 * #1282 — THE HOLDER GATE IS ASKED OF EVERY CUTTER, BY BOTH ENGINES.
 *
 * `holderGate` (`workers/geometry/sweep.ts`) answers `holder-unproven` (a warning) when a cutter
 * states neither a shoulder nor a flute length, and `holder-collision` (an error) when the deepest
 * cut is past the stated length. The exact sweeper asks it for every cutter. The column engine used
 * to ask it only for a thread mill, so any other cutter it simulated passed with an unprovable
 * holder clearance and said nothing — while the exact sweeper warned for the same record. Which
 * engine simulates a job is not the operator's choice, so both must say the same thing.
 *
 * The same program, the same cutter record, once through each engine.
 */
import { describe, expect, it } from 'vitest';

import { buildTimeline, parseGcode, stubSetup } from '@/engine/cnc';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { columnSweep } from '@/workers/geometry/columnEngine';
import { sweepTimeline } from '@/workers/geometry/sweep';
import { tl } from './helpers/manifoldExec';

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const HOLD = { kind: 'tape-down' as const, contact: SLAB.outline };
const setup = () => stubSetup(SLAB, HOLD);
/** One 0.6 mm-deep stroke: below the stock top, so the holder gate has a depth to judge. */
const PROGRAM = 'S1000 M3\nG0 X20 Y30 Z1\nG1 Z-0.6 F100\nG1 X40\n';
const RES = { dx: 0.2, dThetaDeg: 0.2 };

const codes = (diagnostics: readonly { code: string }[]): string[] => diagnostics.map((d) => d.code);

function viaExact(tool: Tool): { code: string; severity: string }[] {
  const s = setup();
  const out = sweepTimeline(tl, buildTimeline(parseGcode(PROGRAM), s), tool, s);
  if (!out.ok) throw new Error('the exact sweeper refused the program');
  return out.value.diagnostics;
}

function viaColumn(tool: Tool): { code: string; severity: string }[] {
  const s = setup();
  const out = columnSweep(buildTimeline(parseGcode(PROGRAM), s), tool, s, { resolution: RES });
  if (!out.ok) throw new Error('the column engine refused the program');
  return out.diagnostics;
}

describe('#1282 — holder-unproven is raised by both engines for the same record', () => {
  const unproven = flatEndMill(1, { shoulderLength: null, fluteLength: null });

  it('the exact sweeper warns (the reference behaviour)', () => {
    const d = viaExact(unproven).find((x) => x.code === 'holder-unproven');
    expect(d?.severity).toBe('warning');
  });

  it('the column engine warns for the same cutter record, with the same code and severity', () => {
    const d = viaColumn(unproven).find((x) => x.code === 'holder-unproven');
    expect(d, `column diagnostics: ${JSON.stringify(codes(viaColumn(unproven)))}`).toBeDefined();
    expect(d?.severity).toBe('warning');
  });

  it('a cutter that states its flute length is silent in both engines', () => {
    const stated = flatEndMill(1, { shoulderLength: null, fluteLength: 3 });
    expect(codes(viaExact(stated))).not.toContain('holder-unproven');
    expect(codes(viaColumn(stated))).not.toContain('holder-unproven');
  });

  it('a cut deeper than the stated length is holder-collision (an error) in both engines', () => {
    const short = flatEndMill(1, { shoulderLength: 0.4, fluteLength: null });
    const exact = viaExact(short).find((x) => x.code === 'holder-collision');
    const column = viaColumn(short).find((x) => x.code === 'holder-collision');
    expect(exact?.severity).toBe('error');
    expect(column?.severity).toBe('error');
  });
});
