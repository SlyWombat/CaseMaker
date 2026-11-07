/**
 * #959 review item (4b) — THE ROUGH SPLITS SHALLOW FROM STEEP. RED-FIRST.
 *
 * Today the rough is Z-levels only: on ground shallower than one step-down the first level is
 * already below the CL + band target, the mask is empty, and the op emits nothing — the tray's
 * fourteen remainder regions say exactly `rough "…" emitted no moves`. The manager's ruling: on
 * shallow ground the FLAT skims at `CL + band` (a band step-over pass); on steep ground the rough
 * Z-steps to the CL as it does today.
 *
 * Fixture: a gentle ramp (depth 0.4 mm across the region, under a 1.5 mm step-down but above the
 * 0.3 mm band). Red here: no rough op at all. Green after: a skim whose feeds run at the CL + band
 * surface — none deeper than it (that would cut the band the ball is promised), none above the
 * material it may remove.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { planCurvedForTree } from '../../src/engine/cnc/cam/model/plan';
import type { FeatureTree } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const X0 = 2;
const X1 = 42;
const Y0 = -12;
const Y1 = 12;
const BAND = 0.3;

const flat: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };

/** A ramp from `zHigh` at x = X0 to `zLow` at x = X1, mesh extended past the footprint. */
function ramp(zHigh: number, zLow: number): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  const MX0 = -10, MX1 = 50, MY0 = -20, MY1 = 20;
  const zAt = (x: number): number => zHigh + ((x - X0) / (X1 - X0)) * (zLow - zHigh);
  const footprint: Polygons = [[[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]];
  const geometry = {
    triangles: {
      positions: Float32Array.from([
        MX0, MY0, zAt(MX0), MX1, MY0, zAt(MX1), MX1, MY1, zAt(MX1),
        MX0, MY0, zAt(MX0), MX1, MY1, zAt(MX1), MX0, MY1, zAt(MX0),
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: {
        min: [MX0, MY0, Math.min(zAt(MX0), zAt(MX1))] as [number, number, number],
        max: [MX1, MY1, Math.max(zAt(MX0), zAt(MX1))] as [number, number, number],
      },
    },
  };
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: Math.min(zHigh, zLow) },
    levels: [Math.min(zHigh, zLow)],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline: footprint, area: (X1 - X0) * (Y1 - Y0), zTo: Math.min(zHigh, zLow), frees: true, shoulders: [] },
    pockets: [],
    rims: [],
    remainder: [{
      id: 'ramp', footprint, area: (X1 - X0) * (Y1 - Y0), zTop: 0, zBottom: Math.min(zHigh, zLow),
      triangles: new Uint32Array(), slopeDeg: [0, 12], slopeMedianDeg: 11, in: 'top',
    }],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 960, remainderArea: 960, tolerances: {} as never, slivers: [], notes: [] },
  };
  return { tree, geometry };
}

function plan(zHigh: number, zLow: number) {
  const { tree, geometry } = ramp(zHigh, zLow);
  return planCurvedForTree(tree, {
    geometry,
    offset: makeClipperOffset(tl),
    flat,
    ball,
    stepDownMm: 1.5,
    bandMm: BAND,
    feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
    rapid: RAPID,
    spindleRpm: 12000,
    air: true,
    safeZMm: 5,
    hopZMm: 1,
    edgeBreak: { legMm: 0 },
    toolNumberFor: (t) => t.number ?? 1,
  });
}

describe('#959 review — the rough splits shallow from steep', () => {
  it("a shallow ramp gets a SKIM to the flat's own CL — never deeper", () => {
    // Depth 0.4 over the region: material above CL + band is 0.1-0.4 thick, under one 1.5 step-down.
    const result = plan(-0.6, -1.0);
    const roughOp = result.ops.find((op) => op.kind === 'rough');
    expect(roughOp, `ops: ${result.ops.map((o) => o.kind).join(', ')}; notes: ${result.notes.join('; ')}`).toBeDefined();
    // CUTTING feeds only: the runs' lateral feeds at or below the stock top. Since the skim joins
    // through link() (item 4b's linking fix), the op also carries link VERTICALS at plungeFeed —
    // those climb to the clearance plane and are not cuts; a job's gouge question is about the
    // lateral ones.
    const all = roughOp!.outcome.ir.operations.flatMap((o) => o.moves);
    const feeds: typeof all = [];
    let prevMove: (typeof all)[number] | null = null;
    for (const m of all) {
      const lateral = prevMove !== null && Math.hypot(m.x - prevMove.x, m.y - prevMove.y) > 1e-6;
      if (m.kind === 'feed' && lateral && m.z <= 0) feeds.push(m);
      prevMove = m;
    }
    expect(feeds.length).toBeGreaterThan(10);
    // THE RULING (ii): the skim cuts to the flat's OWN CL — exact contact, never deeper. On a
    // plane descending in +x the flat touches at its uphill edge, so its CL stands slope x radius
    // = 0.01 x 3 = 0.03 above the design there: the skim runs from -0.6 + 0.03 = -0.57 at the
    // high end to -1.0 + 0.03 = -0.97 at the low end. Deeper than the CL is a gouge; shallower
    // would leave the band this pass exists to take.
    const zs = feeds.map((m) => m.z);
    expect(Math.max(...zs)).toBeLessThanOrEqual(-0.57 + 0.05);
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(-0.97 - 0.05);
  }, 120_000);

  it('a steep ramp still Z-steps: several discrete levels, unchanged', () => {
    // Depth 8 over the region: four step-downs at 1.5.
    const result = plan(-0.5, -8.5);
    const roughOp = result.ops.find((op) => op.kind === 'rough');
    expect(roughOp, `ops: ${result.ops.map((o) => o.kind).join(', ')}`).toBeDefined();
    const feeds = roughOp!.outcome.ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    const levels = new Set(feeds.map((m) => m.z.toFixed(3)));
    expect(levels.size).toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("#962 — the skim's runs tour: the travel BETWEEN runs collapses, not just the row turns", () => {
    // The skim's raster rows run along x across the region's 40 mm width. Before #962 every row
    // was traced low-x to high-x, so each join raced the full width back (the organizer measured
    // 645 returns, 104.1 m, ~87 min). The runs now tour — nearest endpoint + 2-opt — so the
    // between-run travel is one grid pitch in the common case. A tour may strand one run (a
    // classic nearest-neighbour tail), so the property is the TOTAL travel, not the widest turn.
    const result = plan(-0.6, -1.0);
    const roughOp = result.ops.find((op) => op.kind === 'rough');
    expect(roughOp, `ops: ${result.ops.map((o) => o.kind).join(', ')}`).toBeDefined();
    const moves = roughOp!.outcome.ir.operations.flatMap((o) => o.moves);
    // A JUMP is a near-level lateral move longer than one grid pitch — the travel BETWEEN runs
    // (a retract's across leg, or one stay-down feed). The rows' own 0.5 mm feed steps are not
    // jumps; the raster's between-run returns were ~46 mm each.
    let jumps = 0;
    let total = 0;
    for (let i = 1; i < moves.length; i++) {
      const a = moves[i - 1]!;
      const b = moves[i]!;
      if (Math.abs(b.z - a.z) > 0.5) continue; // a vertical leg, not a jump
      const lateral = Math.hypot(b.x - a.x, b.y - a.y);
      if (lateral <= 1) continue;
      jumps++;
      total += lateral;
    }
    // The tour may strand ONE run at its tail (nearest-neighbour's classic blind spot, which the
    // 2-opt cannot fix when the last step is the stranded one); the raster stranded every row.
    expect(jumps, 'the between-run travel still crosses the region — the runs do not tour').toBeLessThanOrEqual(2);
    expect(total, 'the between-run travel still crosses the region — the runs do not tour').toBeLessThan(100);
  }, 120_000);
});
