/**
 * The rotary column engine (#239, `/Rotary.md` §4). Pure and isolated: no wasm, no timeline for
 * the footprint and volume cases, so the whole file runs in a few hundred ms.
 *
 * The volume assertions are against the ANALYTIC form of a wrapped cut, not against the engine's
 * own output (#239's acceptance): a full-turn pass at radius `z` over a cylinder of radius `R`
 * removes the annulus `[z, R]` wherever the tool reaches, i.e. `π (R² − z²) · 2 r_t`.
 */
import { describe, expect, it } from 'vitest';
import { ROTARY, FLAT, columnSweep, closestAngularOffset, cutterReach, meshRotary, meshFlat, surfaceAboveTip, threadCutter, type ColumnCutter, type ColumnGrid, type CutMove } from '@/workers/geometry/columnEngine';
import { stubSetup, type Setup } from '@/engine/cnc/setup';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { rectProfile } from '@/engine/compiler/profile';
import type { Timeline } from '@/engine/cnc/emulator/timeline';

const RT = 1.5875; // ⌀3.175 flat, the vendor tool
/** The cutter every pre-#405 case sweeps: a flat end mill, so `tanHalf === null` (a level floor). */
const CUT: ColumnCutter = { radius: RT, tanHalf: null };

function cyl(R: number, L: number): Setup {
  return stubSetup({ kind: 'cylinder', diameter: R * 2, length: L }, { kind: 'rotary-chuck', jawDiameter: 25, stickout: L });
}

function prism(w: number, d: number, t: number): Setup {
  return stubSetup({ kind: 'prism', outline: rectProfile(w, d), thickness: t }, { kind: 'tape-down', contact: rectProfile(w, d) });
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
  const grid = ROTARY.buildGrid(cyl(10, 30), CUT, [move({ z: 5 })], { dx: 0.1, dThetaDeg: 0.25 });

  it('cuts the column under the tool to exactly Z_t', () => {
    ROTARY.applyMove(grid, move({ z: 5 }), CUT);
    const i = Math.round((0 - grid.u0) / grid.du);
    expect(grid.h[0 * grid.nu + i]).toBeCloseTo(5, 2); // θ = 0
  });

  it('cuts within φ_max by Z_t/cos φ and leaves beyond it untouched', () => {
    ROTARY.applyMove(grid, move({ z: 5 }), CUT);
    const i = Math.round((0 - grid.u0) / grid.du);
    const jAt = (deg: number): number => Math.round(deg / grid.dv);
    const phiMax = (Math.atan2(RT, 5) / Math.PI) * 180; // 17.6°
    expect(grid.h[jAt(10) * grid.nu + i]).toBeCloseTo(5 / Math.cos((10 * Math.PI) / 180), 2);
    expect(grid.h[jAt(phiMax + 3) * grid.nu + i]).toBeCloseTo(10, 3); // untouched
  });

  it('never touches the far side for Z_t > 0', () => {
    ROTARY.applyMove(grid, move({ z: 5 }), CUT);
    const i = Math.round((0 - grid.u0) / grid.du);
    expect(grid.h[Math.round(180 / grid.dv) * grid.nu + i]).toBe(10);
  });

  it('removes nothing from a move that is above the stock', () => {
    const g = ROTARY.buildGrid(cyl(10, 30), CUT, [move({ z: 30 })], { dx: 0.1, dThetaDeg: 0.25 });
    ROTARY.applyMove(g, move({ z: 30 }), CUT);
    expect(ROTARY.volume(g).removed).toBe(0);
  });
});

describe('axis rule (R8, amended 2026-10-05: clamp shallow, refuse deep)', () => {
  const g = (): ReturnType<typeof ROTARY.buildGrid> => ROTARY.buildGrid(cyl(10, 30), CUT, [move({ z: -0.5 })], { dx: 0.1, dThetaDeg: 0.25 });

  // --- One test per side of the line. The threshold is the TOOL RADIUS: RT = 1.5875 mm.

  it('REFUSES a genuine crossing: a tip at or past one tool radius below the axis', () => {
    for (const z of [-RT, -RT - 0.001, -5]) {
      expect(ROTARY.applyMove(g(), move({ z }), CUT).crossed).toEqual({ z });
    }
    // The rough file's first dip is −0.63 mm — INSIDE the tool radius, so it clamps, not refuses.
    expect(ROTARY.applyMove(g(), move({ z: -0.63 }), CUT).crossed).toBeNull();
  });

  it('CLAMPS a shallow dip inside the tool radius and continues (no refusal)', () => {
    for (const z of [-0.05, -0.5, -0.700, -1.5]) {
      const r = ROTARY.applyMove(g(), move({ z }), CUT);
      expect(r.crossed).toBeNull();
      expect(r.clamped).toEqual({ z });
    }
  });

  it('neither refuses nor clamps a tip at or above the axis', () => {
    expect(ROTARY.applyMove(g(), move({ z: 0.01 }), CUT).crossed).toBeNull();
    expect(ROTARY.applyMove(g(), move({ z: 0.01 }), CUT).clamped).toBeNull();
    expect(ROTARY.applyMove(g(), move({ z: 0 }), CUT).crossed).toBeNull();
    expect(ROTARY.applyMove(g(), move({ z: 0 }), CUT).clamped).toBeNull(); // touching is not a dip
  });

  it('clamps a shallow dip to the axis (the near column is removed entirely)', () => {
    const grid = g();
    ROTARY.applyMove(grid, move({ z: -0.5 }), CUT);
    const i = Math.round((0 - grid.u0) / grid.du);
    expect(grid.h[0 * grid.nu + i]).toBe(0);
  });
});

describe('volume against the analytic wrapped cut (§4.5, acceptance)', () => {
  it('matches π(R²−z²)·2r_t for a full-turn pass at constant Z', () => {
    const R = 10;
    const z = 5;
    const grid = ROTARY.buildGrid(cyl(R, 30), CUT, [move({ z })], { dx: 0.1, dThetaDeg: 0.25 });
    ROTARY.applyMove(grid, move({ u0: 0, u1: 0, v0: 0, v1: 360, z }), CUT);
    const analytic = Math.PI * (R * R - z * z) * 2 * RT;
    // Discretisation: one cell at the axial edges of the band and the angular floor. ~1 %.
    expect(ROTARY.volume(grid).removed).toBeGreaterThan(analytic * 0.97);
    expect(ROTARY.volume(grid).removed).toBeLessThan(analytic * 1.01);
  });

  it('scales with the depth as (R²−z²)', () => {
    const R = 10;
    const vAt = (z: number): number => {
      const grid = ROTARY.buildGrid(cyl(R, 30), CUT, [move({ z })], { dx: 0.05, dThetaDeg: 0.25 });
      ROTARY.applyMove(grid, move({ u0: 0, u1: 0, v0: 0, v1: 360, z }), CUT);
      return ROTARY.volume(grid).removed;
    };
    expect(vAt(8) / vAt(5)).toBeCloseTo((100 - 64) / (100 - 25), 1);
  });
});

describe('display mesh (§4.4)', () => {
  it('meshes the uncut grid as a closed cylinder of radius R', () => {
    const grid = ROTARY.buildGrid(cyl(10, 30), CUT, [], { dx: 0.1, dThetaDeg: 0.25 });
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
function fakeTimeline(moves: CutMove[], rotary = true, y = 0): Timeline {
  const cp = {
    segment: 0,
    tool: 1,
    zKey: Math.round((moves[0]?.z ?? 0) * 1000),
    // #240 — a flat fixture: no A word, so the checkpoint carries null.
    a: null,
    z: moves[0]?.z ?? 0,
    run: 0,
    zs: moves.flatMap((m) => [m.z, m.z]),
    steps: moves.map((m) => m.step),
    xy: moves.flatMap((m) => [m.u0, y, m.u1, y]),
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
    summary: { steps: moves.length, segments: 1, pauses: 0, checkpoints: 1, cuttingMoves: moves.length, unsweptMoves: 0, airMoves: 0, laser: false, rotary, rotaryClass: rotary ? 'wrapped' : 'none', diagnosticCounts: {} },
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
    const tl = fakeTimeline([move({ step: 7, line: 42, z: -2 })]); // deeper than the tool radius
    const out = columnSweep(tl, flatEndMill(3.175), cyl(10, 30));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    const d = out.diagnostics.find((x) => x.code === 'axis-crossing');
    expect(d).toBeDefined();
    expect(d?.message).toContain('line 42');
    expect(d?.message).toContain('step 7');
    expect(out.stats?.checkpointsSwept).toBe(0);
  });

  it('carries a clamped shallow dip OUTSIDE diagnostics, as axisClamped', () => {
    const tl = fakeTimeline([move({ step: 3, line: 11, u0: 0, u1: 0, v0: 0, v1: 360, z: -0.5 })]);
    const out = columnSweep(tl, flatEndMill(3.175), cyl(10, 30));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.axisClamped).toEqual({ count: 1, deepestZ: -0.5 });
    // …and still reported once as a warning, so the diagnostic list is not silently missing it.
    const warn = out.diagnostics.filter((x) => x.code === 'axis-clamped');
    expect(warn).toHaveLength(1);
    expect(warn[0]?.severity).toBe('warning');
  });

  it('reports axisClamped null when nothing dipped past the axis', () => {
    const tl = fakeTimeline([move({ u0: 0, u1: 0, v0: 0, v1: 360, z: 5 })]);
    const out = columnSweep(tl, flatEndMill(3.175), cyl(10, 30), { resolution: { dx: 0.2, dThetaDeg: 0.5 } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.axisClamped).toBeNull();
    expect(out.diagnostics.some((d) => d.code === 'axis-clamped')).toBe(false);
  });

  it('refuses a non-cylinder stock for a rotary job', () => {
    const tl = fakeTimeline([move({ z: 5 })]);
    const out = columnSweep(tl, flatEndMill(3.175), prism(10, 10, 5));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.diagnostics[0]?.code).toBe('rotary-stock');
  });
});

/**
 * The FLAT parameterisation (#222): columns over (x, y) holding the remaining top Z — the dexel
 * engine. Work frame is the ordinary 3-axis frame: top face `initial = 0`, bottom `base = −t`.
 */
describe('flat parameterisation (#222)', () => {
  it('plunges a flat floor over the tool disc and leaves outside it untouched', () => {
    const grid = FLAT.buildGrid(prism(40, 40, 5), CUT, [move({ u0: 10, u1: 10, v0: 10, v1: 10, z: -1 })], { dx: 0.1, dThetaDeg: 0.1 });
    const r = FLAT.applyMove(grid, move({ u0: 10, u1: 10, v0: 10, v1: 10, z: -1 }), CUT);
    expect(r.crossed).toBeNull();
    expect(r.clamped).toBeNull(); // the flat engine never clamps to the axis
    expect(r.written).toBeGreaterThan(0);
    const at = (x: number, y: number): number => {
      const i = Math.round((x - grid.u0) / grid.du);
      const j = Math.round((y - grid.v0) / grid.dv);
      return grid.h[j * grid.nu + i] as number;
    };
    expect(at(10, 10)).toBeCloseTo(-1, 3); // under the tool
    expect(at(10 + RT + 1, 10)).toBeCloseTo(0, 3); // beyond the disc
  });

  it('removes π·r_t²·depth for a plunge, against the analytic form', () => {
    const depth = 1;
    const grid = FLAT.buildGrid(prism(40, 40, 5), CUT, [move({ z: -depth })], { dx: 0.05, dThetaDeg: 0.05 });
    FLAT.applyMove(grid, move({ u0: 20, u1: 20, v0: 20, v1: 20, z: -depth }), CUT);
    const analytic = Math.PI * RT * RT * depth;
    const removed = FLAT.volume(grid).removed;
    expect(removed).toBeGreaterThan(analytic * 0.95);
    expect(removed).toBeLessThan(analytic * 1.05);
  });

  it('sweeps a segment as a capsule (a slot), not a point', () => {
    const grid = FLAT.buildGrid(prism(40, 40, 5), CUT, [move({ u0: 5, u1: 30, v0: 20, v1: 20, z: -2 })], { dx: 0.1, dThetaDeg: 0.1 });
    FLAT.applyMove(grid, move({ u0: 5, u1: 30, v0: 20, v1: 20, z: -2 }), CUT);
    const at = (x: number, y: number): number => {
      const i = Math.round((x - grid.u0) / grid.du);
      const j = Math.round((y - grid.v0) / grid.dv);
      return grid.h[j * grid.nu + i] as number;
    };
    expect(at(16, 20)).toBeCloseTo(-2, 3); // mid-segment
    expect(at(6, 20)).toBeCloseTo(-2, 3); // still within the capsule at the start end
    expect(at(16, 20 + RT + 1)).toBeCloseTo(0, 3); // a radius off the segment
  });

  it('clamps a cut to the blank bottom (nothing below the stock)', () => {
    const grid = FLAT.buildGrid(prism(40, 40, 5), CUT, [move({ z: -99 })], { dx: 0.1, dThetaDeg: 0.1 });
    FLAT.applyMove(grid, move({ u0: 20, u1: 20, v0: 20, v1: 20, z: -99 }), CUT);
    const i = Math.round((20 - grid.u0) / grid.du);
    const j = Math.round((20 - grid.v0) / grid.dv);
    expect(grid.h[j * grid.nu + i]).toBe(-5); // base, not −99
  });

  it('a grid floor lets a through cut reach the breakthrough into the board', () => {
    const built = FLAT.buildGrid(prism(40, 40, 5), CUT, [move({ z: -99 })], { dx: 0.1, dThetaDeg: 0.1 });
    // `columnSweep` sets this from `breakthroughMm`; here it is set directly.
    const grid = { ...built, floor: built.base - 0.3 };
    FLAT.applyMove(grid, move({ u0: 20, u1: 20, v0: 20, v1: 20, z: -99 }), CUT);
    const i = Math.round((20 - grid.u0) / grid.du);
    const j = Math.round((20 - grid.v0) / grid.dv);
    expect(grid.h[j * grid.nu + i]).toBeCloseTo(-5.3, 6); // base − breakthrough, not −99
  });

  it('splits volume at the blank bottom: part loss and sacrificial loss', () => {
    const built = FLAT.buildGrid(prism(40, 40, 5), CUT, [move({ z: -99 })], { dx: 0.05, dThetaDeg: 0.05 });
    const grid = { ...built, floor: built.base - 0.3 };
    FLAT.applyMove(grid, move({ u0: 20, u1: 20, v0: 20, v1: 20, z: -99 }), CUT);
    const vol = FLAT.volume(grid);
    const disc = Math.PI * RT * RT;
    expect(vol.removed).toBeGreaterThan(disc * 5 * 0.95);
    expect(vol.removed).toBeLessThan(disc * 5 * 1.05);
    expect(vol.sacrificialRemoved ?? 0).toBeGreaterThan(disc * 0.3 * 0.9);
    expect(vol.sacrificialRemoved ?? 0).toBeLessThan(disc * 0.3 * 1.1);
  });

  it('meshes the uncut blank as a closed box spanning the stock extent', () => {
    const grid = FLAT.buildGrid(prism(40, 40, 5), CUT, [], { dx: 0.1, dThetaDeg: 0.1 });
    const m = meshFlat(grid, { dx: 1, dThetaDeg: 1 });
    expect(m.triangleCount).toBeGreaterThan(0);
    expect(m.vertexCount).toBe(m.positions.length / 3);
    expect(m.bbox.max[2]).toBeCloseTo(0, 3); // top at work Z 0
    expect(m.bbox.min[2]).toBeCloseTo(-5, 3); // bottom at −thickness
  });

  it('refuses a non-prism stock for a flat job', () => {
    const tl = fakeTimeline([move({ u0: 20, u1: 20, z: -1 })], false);
    const out = columnSweep(tl, flatEndMill(3.175), cyl(10, 30));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.diagnostics[0]?.code).toBe('flat-stock');
  });

  it('sweeps a flat job through columnSweep and is never clamped', () => {
    const tl = fakeTimeline([move({ u0: 5, u1: 30, v0: 20, v1: 20, z: -1 })], false, 20);
    const out = columnSweep(tl, flatEndMill(3.175), prism(40, 40, 5), { resolution: { dx: 0.2, dThetaDeg: 0.2 } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stats.engine).toBe('column');
    expect(out.axisClamped).toBeNull();
    expect(out.count).toBe(1);
    expect(out.meshAt(-1).triangleCount).toBeGreaterThan(0);
    expect(out.meshAt(0).triangleCount).toBeGreaterThan(0);
  });

  it('takes breakthroughMm and reports the below-blank removal separately (#218)', () => {
    // The program cuts 0.3 mm past the 5 mm blank's underside.
    const tl = fakeTimeline([move({ u0: 20, u1: 20, v0: 20, v1: 20, z: -5.3 })], false, 20);
    const through = columnSweep(tl, flatEndMill(3.175), prism(40, 40, 5), {
      resolution: { dx: 0.2, dThetaDeg: 0.2 },
      breakthroughMm: 0.3,
    });
    expect(through.ok).toBe(true);
    if (!through.ok) return;
    expect(through.stats.removedFromSacrificial).toBeGreaterThan(0);
    // The display mesh follows the kerf through the underside instead of stopping at base.
    expect(through.meshAt(0).bbox.min[2]).toBeLessThan(-5);

    // The same program without the option is clamped at the base and removes nothing from a board.
    const clamped = columnSweep(tl, flatEndMill(3.175), prism(40, 40, 5), {
      resolution: { dx: 0.2, dThetaDeg: 0.2 },
    });
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) return;
    expect(clamped.stats.removedFromSacrificial).toBe(0);
    expect(clamped.meshAt(0).bbox.min[2]).toBeCloseTo(-5, 6);
  });
});

/**
 * The V-bit's cone on the FLAT parameterisation (#405) — the hook #221 reserved.
 *
 * The one thing that must never happen is a V-bit swept as a flat end mill of its tip diameter:
 * that draws a 0.3 mm slot where the machine cuts a 0.836 mm groove. So the cases below pin the
 * two halves of the cone — the floor RISES away from the centre line, and the groove's top
 * opening is `tip + 2·d·tan(half)` — and one of them is the direct comparison against the flat
 * stand-in, which must come out visibly narrower.
 */
describe('a V-bit cone on the flat engine (#405)', () => {
  // The 30° engraving bit the text job defaults to: 0.3 mm tip, 30° INCLUDED, so 15° from the axis.
  const HALF_DEG = 15;
  const TAN = Math.tan((HALF_DEG * Math.PI) / 180);
  const CONE: ColumnCutter = { radius: 0.15, tanHalf: TAN };
  const FLAT_TIP: ColumnCutter = { radius: 0.15, tanHalf: null };
  /** The bench bit, as a Tool: what `columnSweep` is handed, and what `cuttingForTrace` reads. */
  const vBit = (): Tool => flatEndMill(0.3, { name: '30° engraving bit', typeText: 'Engraving', shape: 'engraving', tipDiameter: 0.3, halfAngle: HALF_DEG, angle: 2 * HALF_DEG });

  /** The grid's floor at (x, y), read at the nearest column. */
  const floorAt = (grid: ReturnType<typeof FLAT.buildGrid>, x: number, y: number): number =>
    grid.h[Math.round((y - grid.v0) / grid.dv) * grid.nu + Math.round((x - grid.u0) / grid.du)] as number;

  it('leaves the cone profile at every column — a floor that RISES away from the centre line', () => {
    const grid = FLAT.buildGrid(prism(6, 6, 5), CONE, [move({ z: -1 })], { dx: 0.02, dThetaDeg: 0.02 });
    FLAT.applyMove(grid, move({ u0: 3, u1: 3, v0: 3, v1: 3, z: -1 }), CONE);
    // Every column within a millimetre of the tip is at the analytic floor: the tip plane inside
    // the tip's flat, then `z + (ρ − r_t)/tan` up the flank, and the top face where the flank has
    // risen past it. A flat stand-in would leave −1 out to 0.15 and 0 beyond — a step, not a slope.
    const j = Math.round((3 - grid.v0) / grid.dv);
    const y = grid.v0 + j * grid.dv;
    let flank = 0;
    for (let i = 0; i < grid.nu; i++) {
      const x = grid.u0 + i * grid.du;
      // The column's own distance from the move's SEGMENT — the 2D distance the engine reads.
      // Reading `|x − 3|` alone (as this did until the #405 review) folds the nearest Y column's
      // half-cell offset into `want` instead: at 15° that is ≈0.5 µm of floor, which the 3-decimal
      // tolerance then hides a real geometry error behind rather than absorbing float32 rounding.
      const rho = Math.hypot(x - 3, y - 3);
      if (rho > 1) continue;
      const want = Math.max(-1, Math.min(0, -1 + Math.max(0, (rho - 0.15) / TAN)));
      expect(grid.h[j * grid.nu + i] as number).toBeCloseTo(want, 3);
      if (want > -1 && want < 0) flank++;
    }
    expect(flank).toBeGreaterThan(10); // a real slope, sampled: not one flat span and a cliff
  });

  /**
   * ABOVE 45° IS WHERE THE INVERSE IS TESTED (#405 review). Below it the cone's flank is steeper
   * than the diagonal and `r + h/tanHalf` over-scans (it only costs time); above it the flank is
   * SHALLOWER, and the same wrong form stops the sweep short of where the bit cuts. So a half-angle
   * over 45° is the case that separates the two readings — and the case a 90° chamfer bit, which
   * this repo lists (`kz-chamfer-90`), is actually cut with.
   *
   * A 120° chamfer at 1 mm deep puts its flank 0.15 + 1·tan 60° = 1.882 mm out. The wrong bound
   * would reach 0.15 + 1/√3 = 0.727, so the groove would be drawn 0.727 mm half-wide where the
   * machine cuts 1.882 — a third of the width, and the gouge bound with it.
   */
  it('reaches the top-face meeting point ABOVE 45°, where r + h/tanHalf falls short', () => {
    const T60 = Math.tan((60 * Math.PI) / 180); // √3: a 120° INCLUDED chamfer
    const CHAMFER: ColumnCutter = { radius: 0.15, tanHalf: T60 };
    const half = 0.15 + T60;
    // The bound itself, pinned: the rise TIMES the tangent, not the rise over it.
    expect(cutterReach(CHAMFER, 1)).toBeCloseTo(half, 9);
    expect(cutterReach(CHAMFER, 1)).toBeGreaterThan(1.5); // never 0.15 + 1/√3 ≈ 0.727

    const grid = FLAT.buildGrid(prism(6, 6, 5), CHAMFER, [move({ z: -1 })], { dx: 0.01, dThetaDeg: 0.01 });
    FLAT.applyMove(grid, move({ u0: 3, u1: 3, v0: 3, v1: 3, z: -1 }), CHAMFER);
    let widest = 0;
    for (let i = 0; i < grid.nu; i++) {
      const x = grid.u0 + i * grid.du;
      if (floorAt(grid, x, 3) < 0) widest = Math.max(widest, Math.abs(x - 3));
    }
    expect(widest).toBeLessThanOrEqual(half); // nothing cut past the opening
    expect(widest).toBeGreaterThan(half - 2 * grid.du); // and the edge is where it should be
    expect(widest).toBeGreaterThan(1.5); // the clipped bound would have stopped at ≈0.727
  });

  it('cuts a groove whose TOP OPENING is tip + 2·d·tan(half) — 0.836 mm at d = 1.0', () => {
    const grid = FLAT.buildGrid(prism(6, 6, 5), CONE, [move({ z: -1 })], { dx: 0.01, dThetaDeg: 0.01 });
    FLAT.applyMove(grid, move({ u0: 3, u1: 3, v0: 3, v1: 3, z: -1 }), CONE);
    // The opening's half-width, read off the grid: the widest column the move cut, and the nearest
    // column it did not. The analytic half-width is 0.15 + tan(15°) = 0.4179 mm; the grid can only
    // report the boundary to a cell, so the assertions bracket it rather than pin it.
    const half = 0.15 + TAN;
    let widestCut = 0;
    let nearestWhole = Infinity;
    for (let i = 0; i < grid.nu; i++) {
      const x = grid.u0 + i * grid.du;
      const rho = Math.abs(x - 3);
      const cut = floorAt(grid, x, 3) < 0;
      if (cut) widestCut = Math.max(widestCut, rho);
      else if (rho <= half + 0.2) nearestWhole = Math.min(nearestWhole, rho);
    }
    expect(widestCut).toBeLessThanOrEqual(half); // nothing cut past the opening
    expect(nearestWhole).toBeGreaterThanOrEqual(half); // nothing left whole inside it
    expect(widestCut).toBeGreaterThan(half - 2 * grid.du); // the boundary is where it should be
    expect(2 * widestCut).toBeCloseTo(0.836, 1); // the bench number, to the grid's own resolution
  });

  it('is NOT the flat stand-in: the same tip as a flat end mill cuts a disc barely a third as wide', () => {
    const cutWidth = (cutter: ColumnCutter): number => {
      const grid = FLAT.buildGrid(prism(6, 6, 5), cutter, [move({ z: -1 })], { dx: 0.01, dThetaDeg: 0.01 });
      FLAT.applyMove(grid, move({ u0: 3, u1: 3, v0: 3, v1: 3, z: -1 }), cutter);
      let widest = 0;
      for (let i = 0; i < grid.nu; i++) {
        const x = grid.u0 + i * grid.du;
        if (floorAt(grid, x, 3) < 0) widest = Math.max(widest, Math.abs(x - 3));
      }
      return 2 * widest;
    };
    const v = cutWidth(CONE);
    const flat = cutWidth(FLAT_TIP);
    expect(flat).toBeCloseTo(0.3, 1); // the tip, and only the tip
    expect(v).toBeGreaterThan(flat * 2.5); // 0.836 against 0.30: never the same cut
  });

  it('routes a V tool through columnSweep on the flat engine', () => {
    const tl = fakeTimeline([move({ u0: 3, u1: 3, v0: 3, v1: 3, z: -1 })], false, 3);
    const out = columnSweep(tl, vBit(), prism(6, 6, 5), { resolution: { dx: 0.05, dThetaDeg: 0.05 } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.stats.engine).toBe('column');
    expect(out.diagnostics.some((d) => d.code === 'tool-refused')).toBe(false);
  });

  it('REFUSES a V tool on a rotary job by name — a cone about a turntable axis is #221', () => {
    const tl = fakeTimeline([move({ u0: 0, u1: 0, v0: 0, v1: 360, z: 5 })]);
    const out = columnSweep(tl, vBit(), cyl(10, 30));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.diagnostics[0]?.code).toBe('tool-refused');
    expect(out.diagnostics[0]?.message).toMatch(/V-bit|cone/i);
  });
});

/**
 * Thread milling on the flat engine (#445). When the load brings the thread's own dimensions the
 * cutting-diameter cylinder is replaced by the NECK + 60° TOOTH profile (`threadCutter`), swept
 * along the program's helix; the generic envelope warning is replaced by one line per thread, and
 * the cutter is checked against each thread it claims to cut. Without dimensions the old cylinder
 * and its warning are unchanged.
 */
describe('a milled thread on the flat engine (#445)', () => {
  /** A 4 mm thread mill: fits M5's ⌀4.134 pilot and spans its radial depth. */
  const MILL = (over: Partial<Tool> = {}): Tool =>
    flatEndMill(4, { name: '4 mm thread mill', typeText: 'Thread Mill', shape: 'thread', tipDiameter: 4, diameter: 4, fluteLength: 20, ...over });
  const M5 = { x: 20, y: 15, majorMm: 5, minorMm: 4.134, pitchMm: 0.8, threadDepthMm: 5, through: false };
  const flat = (z = -5.8) => fakeTimeline([move({ u0: 20, u1: 20, v0: 15, v1: 15, z })], false, 15);
  const tiny = { dx: 0.2, dThetaDeg: 0.2 };

  it('models the cutter as a neck plus a 60° tooth that rises INWARD', () => {
    // M5 over a 4 mm cutter: tip r = 2, radial depth = 0.433, root r = 1.567.
    const cutter = threadCutter(4, 5, 4.134);
    const root = cutter.toothRootRadius!;
    expect(cutter.radius).toBeCloseTo(2, 9);
    expect(root).toBeCloseTo(2 - (5 - 4.134) / 2, 9);
    expect(cutter.tanHalf).toBeCloseTo(Math.tan(Math.PI / 6), 9);
    // The whole user-facing reach is the tooth tip, not a cone that grows with depth.
    expect(cutterReach(cutter, 0)).toBeCloseTo(2, 9);
    expect(cutterReach(cutter, 20)).toBeCloseTo(2, 9);
    // At the tip the floor is the move's Z; halfway to the root it is higher by the flank rise; at
    // the root/neck it is the tip plane again (the neck's own bottom).
    expect(surfaceAboveTip(cutter, 2)).toBe(0);
    const mid = (2 + root) / 2;
    expect(surfaceAboveTip(cutter, mid)).toBeCloseTo((2 - mid) / Math.tan(Math.PI / 6), 6);
    expect(surfaceAboveTip(cutter, root)).toBe(0);
    expect(surfaceAboveTip(cutter, 2.0001)).toBe(Infinity); // no pad: the tooth ends at its tip
    expect(surfaceAboveTip(cutter, 3)).toBe(Infinity);
    // Half a cell of padding only widens the footprint, never raises the flank.
    expect(threadCutter(4, 5, 4.134, 0.1).outerRadius).toBeCloseTo(2.1, 9);
    expect(surfaceAboveTip(threadCutter(4, 5, 4.134, 0.1), 2.05)).toBe(0);
  });

  it('sweeps the tooth along the helix: the floor carries the pitch and the flank', () => {
    // One revolution of an M5 helix at the final radial pass: the tool axis orbits at
    // (D − d)/2 = 0.5 mm, climbing one pitch (0.8) per turn from the tip depth.
    const N = 360;
    const zTip = -5.8;
    const cx = 20;
    const cy = 15;
    const moves: CutMove[] = [];
    for (let i = 0; i < N; i++) {
      const a0 = (2 * Math.PI * i) / N;
      const a1 = (2 * Math.PI * (i + 1)) / N;
      moves.push(move({
        u0: cx + 0.5 * Math.cos(a0), v0: cy + 0.5 * Math.sin(a0),
        u1: cx + 0.5 * Math.cos(a1), v1: cy + 0.5 * Math.sin(a1),
        z: zTip + (M5.pitchMm * i) / N,
      }));
    }
    const setup = prism(40, 30, 8);
    const res = { dx: 0.1, dThetaDeg: 0.1 };
    const thread = threadCutter(4, M5.majorMm, M5.minorMm);
    /** A one-cell grid centred exactly where the assertion wants to read the floor. */
    const cell = (x: number, y: number): ColumnGrid => ({
      kind: 'flat', nu: 1, nv: 1, u0: x, du: 1, v0: y, dv: 1, initial: 0, base: -8, h: new Float32Array([0]),
    });
    // One chord only, so the reading is the flank's own shape: a column 1.75 mm from the tool
    // axis is on the 60° tooth, 0.433 mm above the tip plane. The cylinder model of #382 left it
    // at the tip depth.
    const flank = cell(cx + 2.25, cy);
    FLAT.applyMove(flank, moves[0]!, thread);
    expect(flank.h[0]).toBeCloseTo(zTip + 0.433, 2);
    // The whole revolution at the tooth's tip radius: only the one chord that passes over each
    // cell reaches it, so the floor IS the move's Z — and half a turn later that Z is half a
    // pitch higher. The floor is a helix, not a level.
    const nearTip = cell(cx + 2.5, cy);
    const farTip = cell(cx - 2.5, cy);
    for (const m of moves) {
      FLAT.applyMove(nearTip, m, thread);
      FLAT.applyMove(farTip, m, thread);
    }
    expect(nearTip.h[0]).toBeCloseTo(zTip, 2);
    expect(farTip.h[0]).toBeCloseTo(zTip + M5.pitchMm / 2, 2);
    expect(farTip.h[0]! - nearTip.h[0]!).toBeCloseTo(0.4, 2);
    // The old cylinder, swept over the same path, is level at the tip depth everywhere inside
    // ⌀d — so the profile leaves material the envelope used to claim removed.
    const grid = FLAT.buildGrid(setup, thread, moves, res);
    for (const m of moves) FLAT.applyMove(grid, m, thread);
    const cylinder: ColumnCutter = { radius: 2, tanHalf: null };
    const flatGrid = FLAT.buildGrid(setup, cylinder, moves, res);
    for (const m of moves) FLAT.applyMove(flatGrid, m, cylinder);
    expect(FLAT.volume(grid).removed).toBeLessThan(FLAT.volume(flatGrid).removed);
  });

  it('replaces the generic envelope warning with one line per thread, and states the band', () => {
    const out = columnSweep(flat(), MILL(), prism(40, 30, 8), { resolution: tiny, threads: [M5] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const envelope = out.diagnostics.filter((d) => d.code === 'thread-envelope');
    expect(envelope).toHaveLength(1);
    expect(envelope[0]!.message).not.toMatch(/simulated as a/);
    // The analytic upper bound: π/4 (D² − D1²) L = 31.06 mm³ for M5 × 5 mm.
    const band = (Math.PI / 4) * (M5.majorMm ** 2 - M5.minorMm ** 2) * M5.threadDepthMm;
    expect(band).toBeCloseTo(31.0627, 3);
    expect(envelope[0]!.message).toContain('31.06 mm³');
    // The new model is said in the message: a neck + 60° tooth swept along the helix, with the
    // crests still absent and the pilot traced in the blank.
    expect(envelope[0]!.message).toMatch(/neck plus a tooth on the item's 60° form/);
    expect(envelope[0]!.message).toMatch(/floor follows the thread's pitch and flank/);
    expect(envelope[0]!.message).toMatch(/crests between the grooves are not left/);
    expect(envelope[0]!.message).toMatch(/neck traces the ⌀4\.134 pilot/);
  });

  it('keeps the old envelope warning when no thread dimensions are passed', () => {
    const out = columnSweep(flat(), MILL(), prism(40, 30, 8), { resolution: tiny });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const envelope = out.diagnostics.filter((d) => d.code === 'thread-envelope');
    expect(envelope).toHaveLength(1);
    expect(envelope[0]!.message).toMatch(/simulated as a ⌀4 mm cylinder/);
  });

  it('refuses a cutter whose diameter does not enter the pilot — an error, naming both numbers', () => {
    // ⌀4.5 into M3's ⌀2.459 pilot: the program cannot cut this thread at all.
    const spec = { ...M5, majorMm: 3, minorMm: 2.459, pitchMm: 0.5 };
    const out = columnSweep(flat(), MILL({ tipDiameter: 4.5, diameter: 4.5 }), prism(40, 30, 8), { resolution: tiny, threads: [spec] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const fit = out.diagnostics.find((d) => d.code === 'thread-cutter-fit')!;
    expect(fit.severity).toBe('error');
    expect(fit.message).toMatch(/4\.5 mm cutting diameter cannot enter the ⌀2\.459 mm pilot/);
  });

  it('refuses a cutter too small to reach the major', () => {
    const out = columnSweep(flat(), MILL({ tipDiameter: 0.3, diameter: 0.3 }), prism(40, 30, 8), { resolution: tiny, threads: [M5] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diagnostics.find((d) => d.code === 'thread-cutter-fit')?.message).toMatch(/radial depth/);
  });

  it('still asks the holder gate — the envelope is honest only as deep as the neck', () => {
    const noNeck = MILL({ fluteLength: null, shoulderLength: null });
    const out = columnSweep(flat(), noNeck, prism(40, 30, 8), { resolution: tiny, threads: [M5] });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.diagnostics.map((d) => d.code)).toContain('holder-unproven');
  });

  it('REFUSES a rotary job with thread dimensions by name — thread-flat-only', () => {
    const out = columnSweep(fakeTimeline([move({ u0: 0, u1: 0, v0: 0, v1: 360, z: 5 })]), MILL(), cyl(10, 30), { threads: [M5] });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.diagnostics[0]?.code).toBe('thread-flat-only');
    expect(out.diagnostics[0]?.message).toMatch(/flat face/);
  });
});
