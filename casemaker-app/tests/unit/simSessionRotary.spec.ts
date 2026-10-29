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

  it('the path carries the machine’s A at every vertex (#716 slice 2)', () => {    const s = createSimSession(tl);
    const r = s.load(WRAPPED, setup(), tool, null);
    expect(r.ok).toBe(true);
    const p = s.simPath();
    expect(p.a).toBeDefined();
    // G0 … A0, the plunge at A0, the turn to A360, the retract at A360.
    expect(Array.from(p.a!)).toEqual([0, 0, 360, 360]);
    s.dispose();
  });

  it('Unroll asks the same checkpoint in the map frame (#716 slice 2)', () => {
    const s = createSimSession(tl);
    const r = s.load(WRAPPED, setup(), tool, null);
    expect(r.ok).toBe(true);
    const rod = s.frameAt(-1, 1);
    expect(rod?.design).toBe('stock');
    expect(rod?.stock.bbox.max[1]).toBeCloseTo(10, 3); // the wrapped rod: its radius
    const map = s.frameAt(-1, 2, 'map');
    expect(map?.design).toBe('map');
    expect(map?.stock.bbox.max[1]).toBeCloseTo(2 * Math.PI * 10, 3); // the map: around 62.832
    expect(map?.stock.bbox.max[2]).toBeCloseTo(0, 6); // uncut: the surface is the map's z = 0
    s.dispose();
  });

  it('carries a clamped shallow dip to the caller, outside diagnostics', () => {    const s = createSimSession(tl);
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

  it('judges a rotary prediction COLUMN by COLUMN, in the map frame (#240, §4.5)', () => {
    // #408 taught the oracle to judge a FLAT column live off its grid. A ROTARY column's second
    // grid axis is the stock ANGLE, so the grid is a picture of (X, θ) — the map's (x, arc at R),
    // which is exactly the frame the prediction is authored in (§3.7). So the same live reading
    // works, provided the comparison is the column one: the R-2 model's flat tip is a wedge, and
    // a full-turn pass at Z_t = 5 leaves a floor of 5 under each pass and the facet term's excess
    // toward the stroke edges, never a flat level worth an area comparison.
    const s = createSimSession(tl);
    const r = s.load(WRAPPED, setup(), tool, null);
    expect(r.ok).toBe(true);
    // The cut is one circumferential band, 2·r_t wide, at the pass: the tool's footprint disc in
    // the map plane. Half a cell of slack each side is the engine's own resolution, not a number.
    const halfWidth = 3.175 / 2;
    const circumference = 2 * Math.PI * 10;
    const report = s.oracle([
      {
        depth: 5,
        polygons: [
          [
            [-halfWidth, 0],
            [halfWidth, 0],
            [halfWidth, circumference],
            [-halfWidth, circumference],
          ] as [number, number][],
        ],
      },
    ]);
    expect(report.ok).toBe(true);
    expect(report.frame).toBe('work');
    expect(report.levels).toHaveLength(1);
    expect(report.levels[0]!.z).toBe(-5);
    // The band carries the CELL term plus the derived facet term of Z_t = 5, r_t = 1.5875:
    // `sqrt(25 + 1.5875²) − 5` = 0.24692 mm, plus this grid's half cell diagonal (~0.05 mm).
    // Nothing here is hand-set; the upper bound only says the cell term is a cell, not a fudge.
    expect(report.band).toBeGreaterThan(0.24692);
    expect(report.band).toBeLessThan(0.24692 + 0.1);
    s.dispose();
  });

  it('reports BOTH an under-cut inside the region and an over-cut outside it', () => {
    // The prediction band is shifted from the pass: 20°..280° predicted, 60°..300° cut (both at
    // X = 0, Z = 5 on ⌀20). Inside the region the missing 20°..60° is material left standing;
    // outside it the cut's own 280°..300° (plus its footprint past the end) is material removed
    // where the map says none should be. A flat area comparison cannot tell these apart.
    const s = createSimSession(tl);
    const SHIFTED = ['S1000 M3', 'G0 X0 Y0 Z30 A60', 'G1 Z5 F100', 'G1 A300 F500', 'G0 Z30'].join('\n');
    const r = s.load(SHIFTED, setup(), tool, null);
    expect(r.ok).toBe(true);
    const arc = (deg: number): number => (deg * Math.PI * 10) / 180;
    const report = s.oracle([
      {
        depth: 5,
        polygons: [
          [
            [-1.5875, arc(20)],
            [1.5875, arc(20)],
            [1.5875, arc(280)],
            [-1.5875, arc(280)],
          ] as [number, number][],
        ],
      },
    ]);
    expect(report.ok).toBe(false);
    const level = report.levels[0]!;
    expect(level.underCut).toBeGreaterThan(report.areaFloor!);
    expect(level.overCut).toBeGreaterThan(report.areaFloor!);
    // The under-cut sits where the prediction runs ahead of the pass (arc of 20°..60°)…
    const under = level.underBbox!;
    const over = level.overBbox!;
    expect(under.min[1]!).toBeLessThan(arc(30));
    expect(under.max[1]!).toBeGreaterThan(arc(45));
    // …and the over-cut where the pass runs past the prediction (280° and beyond).
    expect(over.max[1]!).toBeGreaterThan(arc(285));
    s.dispose();
  });

  it('refuses a rotary job that crosses the axis, keeping the path', () => {
    const s = createSimSession(tl);
    const r = s.load(CROSSING, setup(), tool, null);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.pathOnly).toBe(true);
    const crossing = r.diagnostics.find((d) => d.code === 'axis-crossing');
    expect(crossing).toBeDefined();
    // #716 slice 2 — carried to the session with the move number and the stop clause intact.
    expect(crossing?.message).toMatch(/^Move \d+ cuts through the centre: the cutter tip reaches 2 mm past the axis\. The simulation stops there; the moves after it are drawn, not simulated\.$/);
    expect(crossing?.line).toBe(4); // the G1 Z-2 line of CROSSING
    expect(crossing?.step).toBeDefined();
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

describe('#729 — a wrapped job says what its simulation does not check', () => {
  it('names the chuck and tailstock as unchecked on the column engine', () => {
    const s = createSimSession(tl);
    const r = s.load(WRAPPED, setup(), tool, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const d = r.diagnostics.find((x) => x.code === 'fixture-unchecked');
    expect(d?.severity).toBe('info');
    expect(d?.message).toMatch(/chuck and tailstock are not modelled/);
    s.dispose();
  });
});
