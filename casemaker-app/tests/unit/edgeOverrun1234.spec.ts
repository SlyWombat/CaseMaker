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
import { layOutsideOnPostedGrid } from '../../src/engine/cnc/cam/model/ops/finish';
import { footprintIndex } from '../../src/engine/cnc/cam/model/footprintIndex';
import { dropCutterHeight, profileOf } from '../../src/engine/cnc/cam/model/dropcutter';
import type { ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import { postZ1 } from '../../src/engine/cnc/post/z1';
import { Z1 } from '../../src/engine/cnc/machine';
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

function plan(open: ((side: StockSide, lowestTipZ: number, radiusMm: number) => boolean) | undefined, ball: Tool = BALL) {
  const geometry = edgeGeometry();
  return planCurvedForTree(edgeTree(), {
    geometry,
    offset,
    boolean,
    ball,
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
    // The overrun reaches past the edge; the LAST grid point ON the grown footprint's edge is not
    // emitted (the fix's rule 4), so the row ends at the last grid point strictly inside it.
    const minY = Math.min(...feeds.map((m) => m.y));
    expect(minY).toBeLessThan(-0.8);
    expect(minY).toBeGreaterThanOrEqual(-1 - 1e-9);
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

// ---------------------------------------------------------------------------------------------
// The fix (analyst's ruling): an overrun point's height is the drop-cutter height at the POSTED
// (rounded) XY, rounded UP onto the posted grid — #1214's posted-value principle applied to XY.

const BALL3175: Tool = { ...flatEndMill(3.175, { number: 1, id: 'ball-3-175', name: 'ball-3-175' }), shape: 'ball', typeText: 'Ball Nose' };
const STEP = 0.001;
const onGrid = (v: number): boolean => Math.abs(v / STEP - Math.round(v / STEP)) <= 1e-9;

describe('#1234 the fix — overrun points lie on the posted grid at the posted XY', () => {
  it('every overrun point is on the grid and at/above the CL at its own posted XY', () => {
    const geometry = edgeGeometry();
    const result = plan((side) => side === 'front', BALL3175);
    const finishOp = result.ops.find((o) => o.kind === 'finish');
    expect(finishOp, `ops: ${result.ops.map((o) => o.kind).join(', ')}; notes: ${result.notes.join('; ')}`).toBeDefined();
    const profile = profileOf(BALL3175)!;
    const feeds = finishOp!.outcome.ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    const outside = feeds.filter((m) => m.x < 0 || m.x > 50 || m.y < 0 || m.y > 40);
    expect(outside.length).toBeGreaterThan(10);
    for (const m of outside) {
      expect(onGrid(m.x), `x ${m.x} is not on the posted grid`).toBe(true);
      expect(onGrid(m.y), `y ${m.y} is not on the posted grid`).toBe(true);
      const cl = dropCutterHeight(profile, geometry.triangles, m.x, m.y);
      expect(cl, `no CL at (${m.x}, ${m.y})`).not.toBeNull();
      expect(m.z, `z ${m.z} below the CL ${cl} at (${m.x}, ${m.y})`).toBeGreaterThanOrEqual(cl! - 1e-6);
      expect(m.z, `z ${m.z} more than one posted step above the CL ${cl} at (${m.x}, ${m.y})`).toBeLessThan(cl! + STEP + 1e-6);
    }
  });

  it('the posted text, parsed back: no posted point below the CL at its posted XY', () => {
    const geometry = edgeGeometry();
    const result = plan((side) => side === 'front', BALL3175);
    const finishOp = result.ops.find((o) => o.kind === 'finish')!;
    const posted = postZ1(
      finishOp.outcome.ir,
      { jobName: 'edge', stock: { length: 50, width: 40, thickness: 25 }, materialName: 'test', zDatum: 'probed-top-face', origin: 'topFrontLeft', camVersion: 'test', toolKey: 'inv:ball-3-175' },
      Z1,
    );
    expect(posted.ok, posted.ok ? '' : posted.errors.join('; ')).toBe(true);
    const text = (posted as { text: string }).text;
    const profile = profileOf(BALL3175)!;
    let x = 0;
    let y = 0;
    let z = 0;
    let mode: 'rapid' | 'feed' | null = null;
    let checked = 0;
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (s === '' || s.startsWith(';') || s.startsWith('(')) continue;
      let g: string | null = null;
      let nx = x;
      let ny = y;
      let nz = z;
      for (const w of s.split(/\s+/)) {
        if (w.startsWith('G')) g = w.slice(1).split('.')[0]!;
        else if (w.startsWith('X')) nx = Number(w.slice(1));
        else if (w.startsWith('Y')) ny = Number(w.slice(1));
        else if (w.startsWith('Z')) nz = Number(w.slice(1));
      }
      if (g === '0') mode = 'rapid';
      else if (g === '1') mode = 'feed';
      if (mode === 'feed' && (nx < 0 || nx > 50 || ny < 0 || ny > 40)) {
        const cl = dropCutterHeight(profile, geometry.triangles, nx, ny);
        if (cl !== null) {
          expect(nz, `posted point (${nx}, ${ny}, ${nz}) below its CL ${cl}`).toBeGreaterThanOrEqual(cl - 1e-6);
          checked++;
        }
      }
      x = nx;
      y = ny;
      z = nz;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('the layout touches only the points outside the rectangle', () => {
    // A fake CL: (2, -0.3) at -1.5004 (rounds up to -1.5); (2, -0.4) at exactly -1.5 (stays).
    const surface = {
      dropCutter: (x: number, y: number): number | null => {
        if (x === 2 && y === -0.3) return -1.5004;
        if (x === 2 && y === -0.4) return -1.5;
        return null;
      },
    } as unknown as ClSurface;
    const inside = { x: 2.0001, y: 0.5, z: -1.234567 };
    // The grown footprint's edge runs along y = -1: a rounded point landing ON it is not emitted.
    const boundary = footprintIndex([[[1, -1], [10, -1], [10, 2], [1, 2]]]);
    const laid = layOutsideOnPostedGrid(
      [
        inside,
        { x: 2.0001, y: -0.3, z: -9 },
        { x: 2.0001, y: -0.3004, z: -9 }, // rounds onto the same grid point: one move
        { x: 2.0001, y: -0.4, z: -9 }, // an exact grid height stays put
        { x: 2.0001, y: -0.5, z: -9 }, // no CL at the rounded position: not emitted
        { x: 2.0001, y: -1.0004, z: -9 }, // rounds ONTO the footprint's edge: not emitted
      ],
      { stockRectMm: { length: 50, width: 40 }, clSurface: surface, axisPrecision: 3 },
      boundary,
    );
    expect(laid).toHaveLength(3);
    expect(laid[0]).toEqual(inside); // inside the stock: untouched, byte for byte
    expect(laid[1]).toEqual({ x: 2, y: -0.3, z: -1.5 });
    expect(laid[2]).toEqual({ x: 2, y: -0.4, z: -1.5 });
  });
});

describe('#1234 the fix — the overrun chords hold the CL on the posted lattice', () => {
  it('no chord between two overrun feed points dips below the CL by more than the allowance', () => {
    const geometry = edgeGeometry();
    const result = plan((side) => side === 'front', BALL3175);
    const finishOp = result.ops.find((o) => o.kind === 'finish');
    expect(finishOp, `ops: ${result.ops.map((o) => o.kind).join(', ')}`).toBeDefined();
    const profile = profileOf(BALL3175)!;
    const outside = (m: { x: number; y: number }): boolean => m.x < 0 || m.x > 50 || m.y < 0 || m.y > 40;
    const feeds = finishOp!.outcome.ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    const STEP = 0.001;
    const ALLOWANCE = 0.005 + STEP; // the analyst's sampling allowance: tolerance + the posted step
    let checked = 0;
    for (let i = 1; i < feeds.length; i++) {
      const a = feeds[i - 1]!;
      const b = feeds[i]!;
      if (!outside(a) || !outside(b)) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const alongX = Math.abs(dx) >= Math.abs(dy);
      const span = alongX ? dx : dy;
      const steps = Math.ceil(Math.abs(span) / STEP);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const x = Math.round((a.x + dx * t) / STEP) * STEP;
        const y = Math.round((a.y + dy * t) / STEP) * STEP;
        const cl = dropCutterHeight(profile, geometry.triangles, x, y);
        if (cl === null) continue;
        const chord = a.z + (b.z - a.z) * t;
        expect(chord, `the chord (${a.x}, ${a.y}, ${a.z}) → (${b.x}, ${b.y}, ${b.z}) dips below the CL at (${x}, ${y})`).toBeGreaterThanOrEqual(cl - ALLOWANCE - 1e-6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});
