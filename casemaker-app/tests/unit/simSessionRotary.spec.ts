/**
 * The session routes a ROTARY job to the column engine (#239, `/Rotary.md` §4.1). Listed
 * separately from `simSession.spec.ts` so this slot's change is isolated: the exact 2.5D path
 * is untouched, and a rotary load must produce the column engine's meshes and its refusal.
 */
import { describe, it, expect } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { createSimSession, type SimLoadOk } from '@/workers/sim/session';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { flatEndMill } from '@/engine/cnc/tool';

const setup = (): Setup => stubSetup({ kind: 'cylinder', diameter: 20, length: 30 }, { kind: 'rotary-chuck', jawDiameter: 25, stickout: 30 });
const tool = flatEndMill(3.175);

const WRAPPED = ['S1000 M3', 'G0 X0 Y0 Z30 A0', 'G1 Z5 F100', 'G1 A360 F500', 'G0 Z30'].join('\n');
const CROSSING = ['S1000 M3', 'G0 X0 Y0 Z5 A0', 'G1 X2 F100', 'G1 Z-2 F100', 'G1 A360 F500'].join('\n');
/** A shallow dip inside the tool radius: clamped and continued, not refused (#239, R8). */
const CLAMPED = ['S1000 M3', 'G0 X0 Y0 Z30 A0', 'G1 Z5 F100', 'G1 A360 F500', 'G1 Z-0.5 F50', 'G1 A720 F500', 'G0 Z30'].join('\n');

describe('session routing — rotary', () => {
  it('loads a rotary job through the column engine, not the exact sweeper', () => {
    const s = createSimSession(tl);
    const r = s.load(WRAPPED, setup(), tool, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ok = r as SimLoadOk;
    expect(ok.summary.rotary).toBe(true);
    expect(ok.stats.engine).toBe('column');
    expect(ok.stats.resolution).toBeDefined();
    expect(ok.count).toBeGreaterThan(0);
    expect(ok.meshes.stock.triangleCount).toBeGreaterThan(0);
    expect(ok.meshes.result.triangleCount).toBeGreaterThan(0);
    // The grid IS the material: no removal ghost, no gouge solids yet.
    expect(ok.meshes.removal).toBeNull();
    expect(ok.meshes.gouges).toEqual([]);
    // Nothing dipped past the axis, so no clamp is carried.
    expect(ok.axisClamped).toBeNull();
    // The clock works whether or not the material does.
    expect(ok.checkpoints.length).toBeGreaterThan(0);
  });

  it('carries a clamped shallow dip to the caller, outside diagnostics', () => {
    const s = createSimSession(tl);
    const r = s.load(CLAMPED, setup(), tool, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ok = r as SimLoadOk;
    expect(ok.axisClamped).not.toBeNull();
    expect(ok.axisClamped?.count).toBeGreaterThanOrEqual(1);
    expect(ok.axisClamped?.deepestZ).toBeLessThan(0);
    s.dispose();
  });

  it('frames the uncut stock and the last checkpoint without a wasm handle', () => {
    const s = createSimSession(tl);
    const r = s.load(WRAPPED, setup(), tool, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const uncut = s.frameAt(-1, 1);
    const cut = s.frameAt(r.count - 1, 2);
    expect(uncut?.stock.triangleCount).toBeGreaterThan(0);
    expect(cut?.stock.triangleCount).toBeGreaterThan(0);
    expect(s.frameAt(-1, 3)?.removalSoFar).toBeNull();
    s.dispose();
  });

  it('refuses to check a prediction against a rotary sweep, naming the axis (#408 review 3)', () => {
    // #408 taught the oracle to judge a FLAT column live off its grid, which is what lets a V-bit
    // trace be checked at all. A ROTARY column cannot be judged the same way, and the reason is
    // geometrical rather than a missing feature: its second grid axis is the stock ANGLE, so its
    // cells are a picture of (X, θ) — comparing one with a region in the work frame's (X, Y) would
    // be comparing two different planes. The refusal must therefore say so rather than claim the
    // sampled engine is unpinnable, which was the old message's overreach.
    const s = createSimSession(tl);
    const r = s.load(WRAPPED, setup(), tool, null);
    expect(r.ok).toBe(true);
    expect(() => s.oracle([])).toThrow(/ROTARY column sweep/);
    expect(() => s.oracle([])).toThrow(/\(X, θ\)/);
    s.dispose();
  });

  it('refuses a rotary job that crosses the axis, keeping the path', () => {
    const s = createSimSession(tl);
    const r = s.load(CROSSING, setup(), tool, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.pathOnly).toBe(true);
    expect(r.diagnostics.some((d) => d.code === 'axis-crossing')).toBe(true);
    expect(r.summary?.rotary).toBe(true);
    // The path is still drawable and the clock still runs; there is just no material.
    expect(s.stateAt(0)).not.toBeNull();
    expect(s.toolPath(0, 10).length).toBeGreaterThanOrEqual(0);
    expect(s.frameAt(0, 4)).toBeNull();
    s.dispose();
  });
});

// #241 — R-4: an INDEXED job holds A through every run, so each run is an ordinary 2.5D cut on a
// round stock turned by that run's angle. It goes to the EXACT sweeper (not the column engine),
// and its playback is per FACE.
const INDEXED = [
  'S1000 M3',
  'G0 X-5 Y0 Z15 A0',
  'G1 Z9 F200',
  'G1 X35 F800',
  'G0 Z15',
  'G0 A180',
  'G1 Z9 F200',
  'G1 X-5 F800',
  'G0 Z15',
].join('\n');

describe('session routing — INDEXED rotary (#241)', () => {
  it('routes an indexed rotary job to the exact sweeper and plays it back per face', () => {
    const s = createSimSession(tl);
    const wide = flatEndMill(10, { shoulderLength: 20, fluteLength: 15 });
    const r = s.load(INDEXED, setup(), wide, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ok = r as SimLoadOk;
    expect(ok.summary.rotary).toBe(true);
    expect(ok.summary.rotaryClass).toBe('indexed');
    // The EXACT engine, not the column grid: it carries a removal ghost and per-run solids.
    expect(ok.stats.engine).toBe('exact');
    expect(ok.meshes.removal).not.toBeNull();
    expect(ok.checkpoints.map((c) => c.a)).toEqual([0, 180]);

    // Per-face playback: after the 0° face the cut is at the top of the stock; after the 180°
    // face the removal reaches the bottom. One solid per face is exactly what that means.
    const afterFirst = s.frameAt(0, 1);
    const afterSecond = s.frameAt(1, 2);
    // (The removal solids carry the sweep's 0.01 mm overshoot above the stock top.)
    expect(afterFirst?.removalSoFar?.bbox.max[2]).toBeGreaterThan(10);
    expect(afterFirst?.removalSoFar?.bbox.min[2]).toBeGreaterThan(-1);
    expect(afterSecond?.removalSoFar?.bbox.min[2]).toBeLessThan(-10);
    expect(afterSecond?.removalSoFar?.bbox.max[2]).toBeGreaterThan(10);
    s.dispose();
  });
});
