/**
 * The rotary column engine (#239, `/Rotary.md` §4). Pure and isolated: no wasm, no timeline for
 * the footprint and volume cases, so the whole file runs in a few hundred ms.
 *
 * The volume assertions are against the ANALYTIC form of a wrapped cut, not against the engine's
 * own output (#239's acceptance): a full-turn pass at radius `z` over a cylinder of radius `R`
 * removes the annulus `[z, R]` wherever the tool reaches, i.e. `π (R² − z²) · 2 r_t`.
 */
import { describe, expect, it } from 'vitest';
import { ROTARY, columnSweep, closestAngularOffset, meshRotary, AXIS_CROSSING_TOLERANCE_MM, type CutMove } from '@/workers/geometry/columnEngine';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { flatEndMill } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';
import type { Timeline } from '@/engine/cnc/emulator/timeline';

const RT = 1.5875; // ⌀3.175 flat, the vendor tool

function cyl(R: number, L: number): Setup {
  return stubSetup({ kind: 'cylinder', diameter: R * 2, length: L }, { kind: 'rotary-chuck', jawDiameter: 25, stickout: L });
}

function move(partial: Partial<CutMove>): CutMove {
  return { step: 0, line: 1, u0: 0, u1: 0, v0: 0, v1: 0, z: 5, ...partial };
}

describe('closestAngularOffset', () => {
  it('returns the closest φ=θ−A over the A sweep', () => {
    expect(closestAngularOffset(10, 0, 5)).toBe(5); // φ ∈ [5,10]: 5 is nearer
    expect(closestAngularOffset(200, 0, 180)).toBe(20); // φ ∈ [20,200]: 20 is nearer than −160
  });
  it('returns 0 when the sweep turns the column past dead centre', () => {
    expect(closestAngularOffset(0, 0, 360)).toBe(0);
    expect(closestAngularOffset(10, 0, 90)).toBe(0); // φ ∈ [−80,10] contains 0 (A = 10)
  });
});

describe('rotary footprint (§4.2)', () => {
  const grid = ROTARY.buildGrid(cyl(10, 30), RT, [move({ z: 5 })], { dx: 0.1, dThetaDeg: 0.25 });

  it('cuts the column under the tool to exactly Z_t', () => {
    ROTARY.applyMove(grid, move({ z: 5 }), RT, 0);
    const i = Math.round((0 - grid.u0) / grid.du);
    expect(grid.h[0 * grid.nu + i]).toBeCloseTo(5, 2); // θ = 0
  });

  it('cuts within φ_max by Z_t/cos φ and leaves beyond it untouched', () => {
    ROTARY.applyMove(grid, move({ z: 5 }), RT, 0);
    const i = Math.round((0 - grid.u0) / grid.du);
    const jAt = (deg: number): number => Math.round(deg / grid.dv);
    const phiMax = (Math.atan2(RT, 5) / Math.PI) * 180; // 17.6°
    expect(grid.h[jAt(10) * grid.nu + i]).toBeCloseTo(5 / Math.cos((10 * Math.PI) / 180), 2);
    expect(grid.h[jAt(phiMax + 3) * grid.nu + i]).toBeCloseTo(10, 3); // untouched
  });

  it('never touches the far side for Z_t > 0', () => {
    ROTARY.applyMove(grid, move({ z: 5 }), RT, 0);
    const i = Math.round((0 - grid.u0) / grid.du);
    expect(grid.h[Math.round(180 / grid.dv) * grid.nu + i]).toBe(10);
  });

  it('removes nothing from a move that is above the stock', () => {
    const g = ROTARY.buildGrid(cyl(10, 30), RT, [move({ z: 30 })], { dx: 0.1, dThetaDeg: 0.25 });
    ROTARY.applyMove(g, move({ z: 30 }), RT, 0);
    expect(ROTARY.volume(g).removed).toBe(0);
  });
});

describe('axis crossing (R8)', () => {
  const g = (): ReturnType<typeof ROTARY.buildGrid> => ROTARY.buildGrid(cyl(10, 30), RT, [move({ z: -0.5 })], { dx: 0.1, dThetaDeg: 0.25 });

  it('refuses a tip at Z ≤ 0 by default', () => {
    expect(AXIS_CROSSING_TOLERANCE_MM).toBe(0);
    expect(ROTARY.applyMove(g(), move({ z: -0.5 }), RT, 0).crossed).not.toBeNull();
    expect(ROTARY.applyMove(g(), move({ z: 0 }), RT, 0).crossed).not.toBeNull(); // reaches Z ≤ 0
    expect(ROTARY.applyMove(g(), move({ z: 0.01 }), RT, 0).crossed).toBeNull();
  });

  it('clamps to the axis when a tolerance admits a shallow dip', () => {
    const grid = g();
    const r = ROTARY.applyMove(grid, move({ z: -0.5 }), RT, 1.0);
    expect(r.crossed).toBeNull();
    const i = Math.round((0 - grid.u0) / grid.du);
    expect(grid.h[0 * grid.nu + i]).toBe(0); // the near column is removed entirely
  });
});

describe('volume against the analytic wrapped cut (§4.5, acceptance)', () => {
  it('matches π(R²−z²)·2r_t for a full-turn pass at constant Z', () => {
    const R = 10;
    const z = 5;
    const grid = ROTARY.buildGrid(cyl(R, 30), RT, [move({ z })], { dx: 0.1, dThetaDeg: 0.25 });
    ROTARY.applyMove(grid, move({ u0: 0, u1: 0, v0: 0, v1: 360, z }), RT, 0);
    const analytic = Math.PI * (R * R - z * z) * 2 * RT;
    // Discretisation: one cell at the axial edges of the band and the angular floor. ~1 %.
    expect(ROTARY.volume(grid).removed).toBeGreaterThan(analytic * 0.97);
    expect(ROTARY.volume(grid).removed).toBeLessThan(analytic * 1.01);
  });

  it('scales with the depth as (R²−z²)', () => {
    const R = 10;
    const vAt = (z: number): number => {
      const grid = ROTARY.buildGrid(cyl(R, 30), RT, [move({ z })], { dx: 0.05, dThetaDeg: 0.25 });
      ROTARY.applyMove(grid, move({ u0: 0, u1: 0, v0: 0, v1: 360, z }), RT, 0);
      return ROTARY.volume(grid).removed;
    };
    expect(vAt(8) / vAt(5)).toBeCloseTo((100 - 64) / (100 - 25), 1);
  });
});

describe('display mesh (§4.4)', () => {
  it('meshes the uncut grid as a closed cylinder of radius R', () => {
    const grid = ROTARY.buildGrid(cyl(10, 30), RT, [], { dx: 0.1, dThetaDeg: 0.25 });
    const m = meshRotary(grid, { dx: 0.5, dThetaDeg: 1 });
    expect(m.triangleCount).toBeGreaterThan(0);
    expect(m.vertexCount).toBe(m.positions.length / 3);
    // A point on the surface at θ = 0 is (x, 0, R) — the stock radius is the max Z.
    expect(m.bbox.max[2]).toBeCloseTo(10, 3);
    expect(m.bbox.min[2]).toBeCloseTo(-10, 3);
    expect(m.bbox.max[0] - m.bbox.min[0]).toBeGreaterThan(30); // spans the axial extent
  });
});

/** A minimal Timeline good enough for `columnSweep` (it reads checkpoints, events, stateAt, airMoves). */
function fakeTimeline(moves: CutMove[]): Timeline {
  const cp = {
    segment: 0,
    zKey: Math.round((moves[0]?.z ?? 0) * 1000),
    z: moves[0]?.z ?? 0,
    run: 0,
    zs: moves.flatMap((m) => [m.z, m.z]),
    steps: moves.map((m) => m.step),
    xy: moves.flatMap((m) => [m.u0, 0, m.u1, 0]),
    nonConstantZ: false,
  };
  const events: unknown[] = [];
  for (const m of moves) events[m.step] = { kind: 'move', mode: 'cut', line: m.line };
  return {
    events: events as unknown as Timeline['events'],
    airMoves: [],
    segments: [],
    pauses: [],
    checkpoints: [cp],
    diagnostics: [],
    stateAt: (i: number) => ({ a: moves[Math.min(i, moves.length - 1)]?.v1 ?? 0 }) as ReturnType<Timeline['stateAt']>,
    summary: { steps: moves.length, segments: 1, pauses: 0, checkpoints: 1, cuttingMoves: moves.length, unsweptMoves: 0, airMoves: 0, laser: false, rotary: true, diagnosticCounts: {} },
  };
}

describe('columnSweep (whole-program)', () => {
  it('sweeps a wrapped move and reports the sampled resolution', () => {
    const tl = fakeTimeline([move({ u0: 0, u1: 0, v0: 0, v1: 360, z: 5 })]);
    const out = columnSweep(tl, flatEndMill(3.175), cyl(10, 30), { resolution: { dx: 0.2, dThetaDeg: 0.5 } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stats.engine).toBe('column');
    expect(out.stats.resolution).toEqual({ dx: expect.any(Number), dThetaDeg: 0.5 });
    expect(out.stats.columnOps).toBeGreaterThan(0);
    expect(out.count).toBe(1);
    expect(out.meshAt(-1).triangleCount).toBeGreaterThan(0);
    expect(out.meshAt(0).triangleCount).toBeGreaterThan(0);
  });

  it('refuses axis-crossing by name, at the crossing step', () => {
    const tl = fakeTimeline([move({ step: 7, line: 42, z: -0.63 })]);
    const out = columnSweep(tl, flatEndMill(3.175), cyl(10, 30));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const d = out.diagnostics.find((x) => x.code === 'axis-crossing');
    expect(d).toBeDefined();
    expect(d?.message).toContain('line 42');
    expect(d?.message).toContain('step 7');
    expect(out.stats?.checkpointsSwept).toBe(0);
  });

  it('refuses a non-cylinder stock', () => {
    const tl = fakeTimeline([move({ z: 5 })]);
    const prism = stubSetup({ kind: 'prism', outline: rectProfile(10, 10), thickness: 5 }, { kind: 'tape-down', contact: rectProfile(10, 10) });
    const out = columnSweep(tl, flatEndMill(3.175), prism);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.diagnostics[0]?.code).toBe('rotary-stock');
  });
});
