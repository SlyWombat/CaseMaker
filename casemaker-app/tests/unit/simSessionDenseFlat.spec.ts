// #531 slice B — route a DENSE flat job to the FLAT dexel (column engine) instead of refusing it.
//
// Before this slice a flat-end-mill program with more than MAX_CHECKPOINTS causal runs was a 3D /
// dense job the exact 2.5D sweep would not take on: `sweepTimeline` refused it `dense-3d-refused`
// and the session was left path-only (#194), with no cut picture at all — even though the FLAT
// dexel (already live for V/drill/thread) could draw it. The change is ROUTING ONLY: a dense flat
// job now goes to `columnSweep`, while a non-dense flat job still takes the exact sweep, and a ball
// / bull nose stays refused (that is #532's to admit). This spec pins all three.
//
// The engine that ran is read off the load result: the column engine regenerates its surface from
// the grid and builds NO removal ghost (`meshes.removal === null`, session.ts frameAt / load),
// whereas the exact sweep that removed material returns a removal mesh. Modelled on simSession.spec.ts.

import { describe, it, expect } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimLoadOk } from '@/workers/sim/session';
import { MAX_CHECKPOINTS } from '@/workers/geometry/sweep';
import { stubSetup, type Setup } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [100, 60] as [number, number] }, thickness: 5 };
const HOLD = { kind: 'tape-down' as const, contact: SLAB.outline };
const setup = (o: Partial<Setup> = {}) => stubSetup(SLAB, HOLD, o);
const flat = flatEndMill(1);

/** A flat-end-mill program with > MAX_CHECKPOINTS causal runs (each plunge is its own run). */
function denseFlatProgram(): string {
  const lines = ['S1000 M3'];
  for (let i = 0; i < MAX_CHECKPOINTS + 1; i++) {
    lines.push(`G0 X${10 + (i % 50)} Y${10 + (i % 7)} Z1`, `G1 Z${i % 2 ? -0.5 : -1} F100`, `G1 X${12 + (i % 50)}`, 'G0 Z1');
  }
  return lines.join('\n');
}

/** Three plain cuts — well under the cap, so the EXACT sweep takes it. */
const SPARSE_FLAT = ['S1000 M3', 'G0 X10 Y10 Z1', 'G1 Z-0.5 F100', 'G1 X40', 'G0 Z1', 'G0 X10 Y30', 'G1 Z-1 F100', 'G1 X40'].join('\n');

let gen = 0;

describe('#531: a dense flat job routes to the FLAT dexel instead of being refused', () => {
  it('a > MAX_CHECKPOINTS flat timeline returns a meshed column load, NOT `dense-3d-refused`', () => {
    const session = createSimSession(tl);
    const r = session.load(denseFlatProgram(), setup(), flat, null);
    expect(r.ok).toBe(true);
    const ok = r as SimLoadOk;
    // No refusal by name, and not path-only: the dense flat job is drawn, not dropped.
    expect(ok.diagnostics.some((d) => d.code === 'dense-3d-refused')).toBe(false);
    // The column (dexel) engine ran: it builds no removal ghost, and it regenerates a stock surface.
    expect(ok.meshes.removal).toBeNull();
    const f = session.frameAt(0, ++gen);
    expect(f).not.toBeNull();
    expect((f!.stock.positions.length)).toBeGreaterThan(0);
    expect(f!.removalSoFar).toBeNull(); // column frames carry no removal
    session.dispose();
  });

  it('a non-dense flat job still takes the EXACT sweep (a removal ghost, not the dexel)', () => {
    const session = createSimSession(tl);
    const r = session.load(SPARSE_FLAT, setup(), flat, null);
    expect(r.ok).toBe(true);
    const ok = r as SimLoadOk;
    // The exact sweep that cut material yields a removal ghost; the dexel never does.
    expect(ok.meshes.removal).not.toBeNull();
    const f = session.frameAt(1, ++gen);
    expect(f).not.toBeNull();
    expect(f!.removalSoFar).not.toBeNull();
    session.dispose();
  });

  it('a dense BULL nose is still refused `tool-refused` — ball/bull is #532, not routed here', () => {
    const session = createSimSession(tl);
    const r = session.load(denseFlatProgram(), setup(), flatEndMill(1, { name: 'Bull', cornerRadius: 0.2 }), null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.pathOnly).toBe(true);
    const codes = r.diagnostics.filter((d) => d.source === 'sweep').map((d) => d.code);
    expect(codes).toContain('tool-refused');
    expect(codes).not.toContain('dense-3d-refused');
    session.dispose();
  });
});
