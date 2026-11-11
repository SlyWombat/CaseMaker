/**
 * #1234 (planner v3 A7, stage 2) — THE FINISHING EDGE OVERRUN. RED-FIRST.
 *
 * A ball touches a downhill surface on its downhill side; to cut the surface at the stock's own
 * edge its centre has to go past the edge. The finishing footprint grows by the cutter's radius
 * on the sides whose region boundary lies on the stock's edge — and only there.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '../../src/engine/cnc/cam/engraveJob';
import { planCurvedForTree } from '../../src/engine/cnc/cam/model/plan';
import { overrunFootprint, sidesReached, type StockSide } from '../../src/engine/cnc/cam/model/ops/edgeOverrun';
import { dropCutterHeight, profileOf } from '../../src/engine/cnc/cam/model/dropcutter';
import type { FeatureTree } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const offset = makeClipperOffset(tl);
const boolean = { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) };

/** Signed shoelace area, summed over the rings (Clipper's own orientation convention). */
function area(poly: Polygons): number {
  let total = 0;
  for (const ring of poly) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
    }
    total += a / 2;
  }
  return Math.abs(total);
}

function bounds(poly: Polygons): { min: [number, number]; max: [number, number] } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of poly) for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

/** The tray's own region shape: x 2.6…103.4, y 0…136 — reaches the front and back sides only. */
const RECT: Polygons = [[[2.6, 0], [103.4, 0], [103.4, 136], [2.6, 136]]];
const STOCK = { length: 106, width: 136 };
const RECT_AREA = 100.8 * 136; // 13,708.8

describe('#1234 sidesReached', () => {
  it('the tray rectangle reaches exactly the front and the back', () => {
    expect(sidesReached(RECT, STOCK, 0.01)).toEqual(['front', 'back']);
  });

  it('a hair inside the edge still counts at the fit tolerance', () => {
    const near: Polygons = [[[2.6, 0.004], [103.4, 0.004], [103.4, 135.996], [2.6, 135.996]]];
    expect(sidesReached(near, STOCK, 0.01)).toEqual(['front', 'back']);
  });

  it('a region short of the edges reaches none', () => {
    const short: Polygons = [[[2.6, 0.5], [103.4, 0.5], [103.4, 135.5], [2.6, 135.5]]];
    expect(sidesReached(short, STOCK, 0.01)).toEqual([]);
  });
});

describe('#1234 overrunFootprint', () => {
  it('grows past both open edges by the radius and nothing more', () => {
    const grown = overrunFootprint(RECT, STOCK, 1, ['front', 'back'], offset, boolean);
    const b = bounds(grown);
    expect(b.min[1]).toBeCloseTo(-1, 3);
    expect(b.max[1]).toBeCloseTo(137, 3);
    // The round joins end the strips a radius out in x as well: 2.6 − 1 … 103.4 + 1.
    expect(b.min[0]).toBeCloseTo(1.6, 3);
    expect(b.max[0]).toBeCloseTo(104.4, 3);
    const added = area(grown) - RECT_AREA;
    expect(added).toBeGreaterThan(204.6);
    expect(added).toBeLessThan(205.8);
  });

  it('inside the stock nothing changes', () => {
    const grown = overrunFootprint(RECT, STOCK, 1, ['front', 'back'], offset, boolean);
    for (const ring of grown) {
      for (const [x, y] of ring) {
        if (y > 0.001 && y < 135.999) {
          expect(x).toBeGreaterThanOrEqual(2.6 - 1e-6);
          expect(x).toBeLessThanOrEqual(103.4 + 1e-6);
        }
      }
    }
  });

  it('a closed side gets nothing', () => {
    const grown = overrunFootprint(RECT, STOCK, 1, ['back'], offset, boolean);
    const b = bounds(grown);
    expect(b.min[1]).toBeCloseTo(0, 3);
    expect(b.max[1]).toBeCloseTo(137, 3);
    const added = area(grown) - RECT_AREA;
    expect(added).toBeGreaterThan(102.3);
    expect(added).toBeLessThan(102.9);
  });

  it('a footprint that reaches no edge is returned unchanged', () => {
    const inner: Polygons = [[[10, 10], [20, 10], [20, 20], [10, 20]]];
    expect(overrunFootprint(inner, STOCK, 1, [], offset, boolean)).toBe(inner);
    // Mis-stated by a caller: nothing of the grown square lies past the front, so nothing is added.
    const grown = overrunFootprint(inner, STOCK, 1, ['front'], offset, boolean);
    expect(area(grown)).toBeCloseTo(100, 6);
  });

  it('zero radius returns the same array', () => {
    expect(overrunFootprint(RECT, STOCK, 0, ['front'], offset, boolean)).toBe(RECT);
  });
});

// ---------------------------------------------------------------------------------------------
// The finish op's own case: a surface running downhill to y = 0 of its stock.

const BALL: Tool = { ...flatEndMill(2, { number: 1, id: 'ball-2', name: 'ball-2' }), shape: 'ball', typeText: 'Ball Nose' };
const Y_MAX = 24; // the region's back edge — inside the 40 mm stock, so the back is closed
const Z_AT = (y: number): number => -0.5 - (4 / Y_MAX) * y;

function edgeTree(): FeatureTree {
  const footprint: Polygons = [[[2, 0], [42, 0], [42, Y_MAX], [2, Y_MAX]]];
  const z1 = Z_AT(Y_MAX);
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: z1 },
    levels: [z1],
    top: { z: 0, floors: [], area: 0 },
    // The contour is the STOCK's own outline — larger than the region, so the plan's outer-surface
    // growth (which would grow every side by the ball's radius) does not fire: the only growth in
    // this test is the overrun rule under test.
    contour: { outline: [[[0, 0], [50, 0], [50, 40], [0, 40]]], area: 2000, zTo: z1, frees: true, shoulders: [] },
    pockets: [],
    rims: [],
    remainder: [{
      id: 'edge', footprint, area: 40 * Y_MAX, zTop: 0, zBottom: z1,
      triangles: new Uint32Array(), slopeDeg: [9.5, 9.5], slopeMedianDeg: 9.5, in: 'top',
    }],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 960, remainderArea: 960, tolerances: {} as never, slivers: [], notes: [] },
  };
}

/** The surface mesh: it spans the whole stock in x, and ENDS at y = 0 (the stock's own edge). */
function edgeGeometry() {
  const z0 = Z_AT(0);
  const z1 = Z_AT(Y_MAX);
  return {
    triangles: {
      positions: Float32Array.from([0, 0, z0, 50, 0, z0, 50, Y_MAX, z1, 0, 0, z0, 50, Y_MAX, z1, 0, Y_MAX, z1]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: { min: [0, 0, z1] as [number, number, number], max: [50, Y_MAX, z0] as [number, number, number] },
    },
  };
}

function plan(open: ((side: StockSide, lowestTipZ: number, radiusMm: number) => boolean) | undefined) {
  const geometry = edgeGeometry();
  return planCurvedForTree(edgeTree(), {
    geometry,
    offset,
    boolean,
    ball: BALL,
    stepDownMm: 1,
    bandMm: 0.3,
    feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
    rapid: RAPID,
    spindleRpm: 12000,
    air: true,
    safeZMm: 5,
    hopZMm: 1,
    edgeBreak: { legMm: 0 },
    toolNumberFor: (t) => t.number ?? 1,
    stockMm: { length: 50, width: 40 },
    ...(open === undefined ? {} : { stockEdgeOpen: open }),
  });
}

describe('#1234 the finish op runs past the stock edge and states it', () => {
  it('rows reach y = -1 on an open side, and no feed cuts below the unclipped CL', () => {
    const result = plan((side) => side === 'front');
    const finishOp = result.ops.find((o) => o.kind === 'finish');
    expect(finishOp, `ops: ${result.ops.map((o) => o.kind).join(', ')}; notes: ${result.notes.join('; ')}`).toBeDefined();
    const moves = finishOp!.outcome.ir.operations.flatMap((o) => o.moves);
    const feeds = moves.filter((m) => m.kind === 'feed');
    expect(feeds.length).toBeGreaterThan(10);
    const minY = Math.min(...feeds.map((m) => m.y));
    expect(minY).toBeCloseTo(-1, 3);
    const profile = profileOf(BALL)!;
    for (const m of feeds) {
      const cl = dropCutterHeight(profile, edgeGeometry().triangles, m.x, m.y);
      expect(cl, `feed at (${m.x}, ${m.y}) has no CL`).not.toBeNull();
      expect(m.z, `feed at (${m.x}, ${m.y}) runs below its CL`).toBeGreaterThanOrEqual(cl! - 1e-6);
    }
    expect(finishOp!.outcome.edgeOverrun).toEqual({ sides: ['front'], amountMm: 1 });
  });

  it('absent stockEdgeOpen: the rows stop at y = 0 and no fact is stated', () => {
    const result = plan(undefined);
    const finishOp = result.ops.find((o) => o.kind === 'finish');
    expect(finishOp).toBeDefined();
    const moves = finishOp!.outcome.ir.operations.flatMap((o) => o.moves);
    const feeds = moves.filter((m) => m.kind === 'feed');
    expect(Math.min(...feeds.map((m) => m.y))).toBeCloseTo(0, 3);
    expect(finishOp!.outcome.edgeOverrun).toBeUndefined();
  });
});
