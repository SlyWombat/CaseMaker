// #1003 — THE DOME RED-FIRST: a pocket's floor pass must not cut a column whose design stands
// ABOVE the level, even when the design there is a plain upward-facing dome with no downward face
// anywhere in the column.
//
// The fitting case's gouge (the figure's head, 10.06 mm below the goal at (40, 20), #1003's
// comments): `ceilingAboveMm`'s two-phase gate opened a column "all the way, full stop" when it
// found no downward-facing triangle — the dome's central columns are exactly that (dome top →
// solid → floor), so the pocket's floor pass treated the dome as open ground and took it away.
//
// This fixture is the minimal shape of that failure: a flat floor with a paraboloid dome standing
// on it, inside one pocket whose floor is the floor plane. At every level below the dome's own
// local height the dome's columns must be closed, so no feed's DISC sweeps design standing above
// the feed's Z. RED at the two-phase gate (`c23bb11e9`): every column reads open, and the floor
// pass sweeps straight through the dome (the disc's worst cut-into is ~2.6 mm on the h = 3 fixture
// below). GREEN with the exact plane bound (the cell's highest surface over the cell's own square).
//
// Hand-built mesh for exact control (a 0.5 mm heightfield floor for a fine bin cell, the dome a
// polar paraboloid with finite slope at its rim, so no near-vertical facets).
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

const FLOOR = -4;
const MOUTH = 0;
const DOME_CX = 10;
const DOME_CY = 5;
const DOME_R = 4;
const DOME_H = 3; // apex at FLOOR + DOME_H = -1

/** The dome's own surface height at (x, y) — a paraboloid of revolution standing on the floor. */
function domeZ(x: number, y: number): number {
  const d = Math.hypot(x - DOME_CX, y - DOME_CY);
  if (d >= DOME_R) return FLOOR;
  return FLOOR + DOME_H * (1 - (d / DOME_R) * (d / DOME_R));
}

function mesh(): DropCutterMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const vert = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  // The floor: a 0.5 mm heightfield grid over [0, 20] x [0, 10] — fine triangles, so the bins are
  // 1 mm (twice the median extent) and a mask cell sees only the facets really over it.
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
  // The dome: apex + 8 rings, 32 segments — all upward-facing, no downward face anywhere.
  const RINGS = 8;
  const SEGS = 32;
  const apex = vert(DOME_CX, DOME_CY, FLOOR + DOME_H);
  const ring: number[][] = [];
  for (let k = 1; k <= RINGS; k++) {
    const r = (DOME_R * k) / RINGS;
    const z = FLOOR + DOME_H * (1 - (r / DOME_R) * (r / DOME_R));
    const row: number[] = [];
    for (let s = 0; s < SEGS; s++) {
      const a = (2 * Math.PI * s) / SEGS;
      row.push(vert(DOME_CX + r * Math.cos(a), DOME_CY + r * Math.sin(a), z));
    }
    ring.push(row);
  }
  for (let s = 0; s < SEGS; s++) {
    const s1 = (s + 1) % SEGS;
    indices.push(apex, ring[0]![s]!, ring[0]![s1]!);
  }
  for (let k = 0; k < RINGS - 1; k++) {
    const inner = ring[k]!;
    const outer = ring[k + 1]!;
    for (let s = 0; s < SEGS; s++) {
      const s1 = (s + 1) % SEGS;
      // Upward-wound (CCW seen from +Z): the dome's OUTSIDE faces up, like a real part's dome.
      indices.push(inner[s]!, outer[s]!, outer[s1]!);
      indices.push(inner[s]!, outer[s1]!, inner[s1]!);
    }
  }
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), triangleCount: indices.length / 3 };
}

/** The design's own top at (x, y). */
function designTop(x: number, y: number): number {
  return Math.max(FLOOR, domeZ(x, y));
}

/**
 * #1251 — #1227's one-posted-step inset is reversed: the wall pass is exact again, so the
 * invariant is checked on the FULL-radius disc at the 1e-6 tolerance, as before #1227.
 */
const CHECK_R = R;

/** The worst design height ANY point of the cutter's disc sweeps above the feed's own z. */
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
        for (let ox = -CHECK_R; ox <= CHECK_R + 1e-9; ox += 0.1) {
          for (let oy = -CHECK_R; oy <= CHECK_R + 1e-9; oy += 0.5) {
            if (ox * ox + oy * oy > CHECK_R * CHECK_R + 1e-9) continue;
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

describe('#1003 the dome — a pocket floor pass must not take a column the dome stands over', () => {
  it('no feed disc sweeps design standing above its own Z anywhere over the dome', () => {
    const regionOutline: Polygons = [[[0, 0], [20, 0], [20, 10], [0, 10]]];
    const node: PocketNode = {
      id: 'p1', floorZ: FLOOR, mouthZ: MOUTH, open: false,
      region: regionOutline, floors: [], islands: [], children: [], remainder: [], narrowest: 10, through: false,
    };
    const region: RegionRef = { id: 'p1', kind: 'pocket', bounds: { min: [0, 0], max: [20, 10] }, topZ: MOUTH, bottomZ: FLOOR, obstacles: [], regionClearanceZ: 5 };
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

    // The dome's own summit must never be swept below its surface: at the old two-phase gate this
    // column read "open, full stop" and the floor pass cut straight through it.
    const worst = worstDiscCut(moves);
    expect(
      worst.over,
      `a feed's disc at (${worst.x.toFixed(2)}, ${worst.y.toFixed(2)}) rides at z ${worst.z} over design at ${worst.top.toFixed(3)} — ${worst.over.toFixed(3)} mm of cut-into`,
    ).toBeLessThanOrEqual(1e-6);
  });
});
