// #970 — THE POCKET'S PER-LEVEL CEILING MASK, RED-FIRST (the review session's fix 2).
//
// The mask's five samples per cell sit at the cell's point ± half a pitch, but
// `maskLoopsFromPredicate` opens the square [i·pitch, (i+1)·pitch]. The square's FAR HALF is
// therefore opened by samples that never looked at it: a sloped flank narrower than the pitch,
// standing inside that half, is invisible to the mask, and `pocketLoops` insets by exactly R from
// the square edge — so the flat's disc reaches straight into the design's rise. The elephant's
// eleven adjudicated cells are this class (review session, 2026-11-05): the design's contour at
// the level sits 0.10–0.21 mm inside the open square's unsampled half.
//
// This fixture pins the cell's bound: a flank inside an open square's far half must close that
// cell, so no feed's DISC sweeps design standing above the level. Red at the point-sampled mask
// (the cell opens, the ring stands R from the square edge, the disc cuts the flank); green with
// the bound read off `triangleBins`' per-cell `maxZ`.
//
// The mesh is hand-built for exact control (a 0.5 mm heightfield floor for a fine bin cell, and
// closed boxes/wedges for the plate, canopy and flank): a real 124k-triangle figure is the
// acceptance's job, a 0.375 mm raster's far half is this one's.
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '../../src/engine/cnc/cam/engraveJob';
import { pocket } from '../../src/engine/cnc/cam/model/ops/pocket';
import type { PocketNode } from '../../src/engine/cnc/cam/model/features';
import type { RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { DropCutterMesh } from '../../src/engine/cnc/cam/model/dropcutter';
import { flatEndMill } from '../../src/engine/cnc/tool';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const FEEDS = { feedMmPerMin: 900, plungeFeedMmPerMin: 250 };
const flat6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const R = 3;

// The level the flank is cut at, and the design's own heights.
const LEVEL = -3;
const FLOOR = -3.8;
const PLATE_TOP = -3.5; // the gate opener, below the level
const CANOPY_TOP = -2.5; // the closed cells beyond the flank, above the level
const FLANK_TOP = -2.5; // the rise inside the open square's far half

// Mask pitch = min(stepOver, R)/4 = 0.375 at stepOver 1.5. Cell 49's square is [18.375, 18.75];
// its point is 18.375 and its corners 18.1875 / 18.5625 — all three over the plate, none on the
// flank (18.60..18.72).
const FLANK_X1 = 18.72;

/** One heightfield triangle's worth of floor, then hand-built closed boxes and a wedge. */
function mesh(): DropCutterMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const vert = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  // The floor: a 0.5 mm heightfield grid over [0, 20] x [0, 10] at FLOOR — fine triangles, so the
  // bins are 1 mm (twice the median extent), the bound local to a cell or two.
  const STEP = 0.5;
  for (let y = 0; y < 10 - 1e-9; y += STEP) {
    for (let x = 0; x < 20 - 1e-9; x += STEP) {
      const a = vert(x, y, FLOOR);
      const b = vert(x + STEP, y, FLOOR);
      const c = vert(x + STEP, y + STEP, FLOOR);
      const d = vert(x, y + STEP, FLOOR);
      indices.push(a, b, c, a, c, d);
    }
  }
  /** A closed box, outward-wound: its bottom face is the DOWNWARD-facing gate the mask reads. */
  const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    const v0 = vert(x0, y0, z0), v1 = vert(x1, y0, z0), v2 = vert(x1, y1, z0), v3 = vert(x0, y1, z0);
    const v4 = vert(x0, y0, z1), v5 = vert(x1, y0, z1), v6 = vert(x1, y1, z1), v7 = vert(x0, y1, z1);
    indices.push(
      v0, v2, v1, v0, v3, v2, // bottom, normal -Z
      v4, v5, v6, v4, v6, v7, // top, normal +Z
      v0, v1, v5, v0, v5, v4, // front (-Y)
      v2, v3, v7, v2, v7, v6, // back (+Y)
      v0, v4, v7, v0, v7, v3, // left (-X)
      v1, v2, v6, v1, v6, v5, // right (+X)
    );
  };
  box(18.1, 0, -3.6, 18.6, 10, PLATE_TOP); // gate opener under cell 49's samples (top below the level)
  box(19.0, 0, -2.7, 20.0, 10, CANOPY_TOP); // closed cells beyond the flank
  // The flank: a wedge rising from the floor at x = 18.55 to FLANK_TOP at x = 18.72, y 3..7 — a
  // sloped rise sitting entirely inside cell 49's far half and on none of its samples.
  const w0 = vert(18.55, 3, FLOOR), w1 = vert(18.55, 7, FLOOR), w2 = vert(FLANK_X1, 3, FLOOR), w3 = vert(FLANK_X1, 7, FLOOR);
  const w4 = vert(FLANK_X1, 3, FLANK_TOP), w5 = vert(FLANK_X1, 7, FLANK_TOP);
  indices.push(w0, w1, w5, w0, w5, w4, w2, w4, w5, w2, w5, w3);
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), triangleCount: indices.length / 3 };
}

/** The design's own top at (x, y) — the fixture's stated surface, for the disc check. */
function designTop(x: number, y: number): number {
  let z = FLOOR;
  if (x >= 18.1 && x <= 18.6) z = Math.max(z, PLATE_TOP);
  if (x >= 19.0 && x <= 20.0) z = Math.max(z, CANOPY_TOP);
  if (x >= 18.55 && x <= FLANK_X1 && y >= 3 && y <= 7) {
    const t = (x - 18.55) / (FLANK_X1 - 18.55);
    z = Math.max(z, FLOOR + t * (FLANK_TOP - FLOOR));
  }
  return z;
}

/**
 * The worst design height ANY point of the cutter's disc sweeps above the feed's own z — the
 * honest cut-into question for a flat (its bottom is the disc, not the centre line).
 */
function worstDiscCut(moves: { kind: string; x: number; y: number; z: number }[]): { over: number; x: number; y: number; z: number; top: number } {
  let worst = { over: -Infinity, x: 0, y: 0, z: 0, top: 0 };
  let prev: { x: number; y: number } | null = null;
  for (const m of moves) {
    const lateral = prev !== null && (Math.abs(m.x - prev.x) > 1e-9 || Math.abs(m.y - prev.y) > 1e-9);
    if (m.kind === 'feed' && lateral && prev !== null) {
      const len = Math.hypot(m.x - prev.x, m.y - prev.y);
      const steps = Math.max(1, Math.ceil(len / 0.1));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const cx = prev.x + (m.x - prev.x) * t;
        const cy = prev.y + (m.y - prev.y) * t;
        for (let ox = -R; ox <= R + 1e-9; ox += 0.1) {
          for (let oy = -R; oy <= R + 1e-9; oy += 0.5) {
            if (ox * ox + oy * oy > R * R + 1e-9) continue;
            const top = designTop(cx + ox, cy + oy);
            if (top - m.z > worst.over) worst = { over: top - m.z, x: cx + ox, y: cy + oy, z: m.z, top };
          }
        }
      }
    }
    prev = { x: m.x, y: m.y };
  }
  return worst;
}

describe('#970 the pocket mask cell — a flank inside the open square far half', () => {
  it('closes the cell whose square holds the rise, so no feed disc sweeps the design above the level', () => {
    const regionOutline: Polygons = [[[0, 0], [20, 0], [20, 10], [0, 10]]];
    const node: PocketNode = {
      id: 'p1', floorZ: FLOOR, mouthZ: 0, open: false,
      region: regionOutline, floors: [], islands: [], children: [], remainder: [], narrowest: 10, through: false,
    };
    const region: RegionRef = { id: 'p1', kind: 'pocket', bounds: { min: [0, 0], max: [20, 10] }, topZ: 0, bottomZ: FLOOR, obstacles: [], regionClearanceZ: 5 };
    const out = pocket({
      cutter: flat6,
      node,
      region,
      stepOverMm: 1.5,
      stepDownMm: 1,
      feeds: FEEDS,
      offset: makeClipperOffset(tl),
      boolean: { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) },
      safeZMm: 8,
      hopZMm: 3,
      toolNumber: 1,
      spindleRpm: 12000,
      air: true,
      rapid: RAPID,
      aboveMaterial: { mesh: mesh() },
    });
    const moves = out.ir.operations.flatMap((op) => op.moves);
    expect(moves.length).toBeGreaterThan(0);

    // The mask at the flank's level must not open the flank's own cell: the cleared region may
    // not reach the flank's footprint.
    const atLevel = out.cleared?.find((c) => Math.abs(c.z - LEVEL) < 1e-9);
    expect(atLevel, `no cleared region at level ${LEVEL}`).toBeDefined();
    const covers = atLevel!.boundary.some((ring) => {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i]!;
        const [xj, yj] = ring[j]!;
        if (yi >= 5 === yj >= 5) continue;
        const x = xi + ((5 - yi) * (xj - xi)) / (yj - yi);
        if (x > 18.5) return true;
      }
      return false;
    });
    expect(covers, 'the mask at the flank’s level still opens past x = 18.5').toBe(false);

    const worst = worstDiscCut(moves);
    expect(
      worst.over,
      `a feed's disc at (${worst.x.toFixed(2)}, ${worst.y.toFixed(2)}) rides at z ${worst.z} over design at ${worst.top} — ${worst.over.toFixed(3)} mm of cut-into`,
    ).toBeLessThanOrEqual(1e-6);
  });
});
