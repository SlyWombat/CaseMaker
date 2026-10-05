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
    // The clock works whether or not the material does.
    expect(ok.checkpoints.length).toBeGreaterThan(0);
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
