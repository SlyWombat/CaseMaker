/**
 * #872 — THE COVERAGE MEASURE, on shapes whose answer is countable by hand: a cube (one sixth of
 * its surface faces up), a stack with an overhang (the shadow band), and a turn of the whole mesh
 * (the same surface, a different side up). Pure data — no Manifold, no session — because that is
 * what lets the worker tier (#873) drive it with the real sweep and the ranking pass drive it
 * before any CAM runs.
 */
import { describe, expect, it } from 'vitest';

import {
  coveragePercent,
  goalCoverage,
  goalTopAt,
  rotateCoverageMesh,
  type CoverageMesh,
} from '@/engine/cnc/engrave/goalCoverage';
import type { GoalHeightfield } from '@/engine/cnc/cam/surface3d';

/** A flat heightfield: every cell at `z`, all covered. */
function fieldAt(z: number, nx = 11, ny = 11, x0 = 0, y0 = 0, pitch = 1): GoalHeightfield {
  return {
    nx,
    ny,
    x0,
    y0,
    pitch,
    topZ: z,
    minZ: z,
    z: new Float32Array(nx * ny).fill(z),
    covered: new Uint8Array(nx * ny).fill(1),
    coveredCount: nx * ny,
    resolutionNote: 'test',
  };
}

/** A quad as two triangles, wound outward from the given side. */
function quad(
  out: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): void {
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

/** A closed box, `10 × 10 × 5`, bottom at z 0, wound outward: 2 × 100 top/bottom + 4 × 50 sides. */
function cube(): CoverageMesh {
  const p: number[] = [];
  const [x0, x1, y0, y1, z0, z1] = [0, 10, 0, 10, 0, 5];
  // top (+Z)
  quad(p, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  // bottom (−Z)
  quad(p, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
  // front (−Y)
  quad(p, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  // back (+Y)
  quad(p, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  // left (−X)
  quad(p, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  // right (+X)
  quad(p, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  const positions = new Float32Array(p);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

/**
 * A roof over a floor: a 10 × 10 floor at z 0 with a flat 10 × 10 roof at z 2 standing over it on
 * one wall at x 0. The floor's area under the roof is the shadow band.
 */
function overhang(): CoverageMesh {
  const p: number[] = [];
  // floor at z 0, facing up
  quad(p, [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]);
  // roof at z 2, facing up, and its underside at z 2 facing down
  quad(p, [0, 0, 2], [10, 0, 2], [10, 10, 2], [0, 10, 2]);
  quad(p, [0, 10, 2], [10, 10, 2], [10, 0, 2], [0, 0, 2]);
  // the wall holding the roof up, at x 0
  quad(p, [0, 10, 0], [0, 0, 0], [0, 0, 2], [0, 10, 2]);
  const positions = new Float32Array(p);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

describe('#872 the goal coverage measure', () => {
  it('a cube: the top and the four cliffs are reached, the bottom faces away', () => {
    const goal = fieldAt(5);
    const c = goalCoverage(cube(), goal, () => 5);
    expect(c.totalAreaMm2).toBeCloseTo(400, 6);
    // The vertical sides are the raster's own cliffs (reached); only the BOTTOM points down.
    expect(c.reachedAreaMm2).toBeCloseTo(300, 6);
    expect(c.facingAwayAreaMm2).toBeCloseTo(100, 6);
    expect(c.fraction).toBeCloseTo(0.75, 6);
  });

  it('a cube the result left high is MISSED, not reached — the tolerance question', () => {
    const goal = fieldAt(5);
    const c = goalCoverage(cube(), goal, () => 6);
    expect(c.reachedAreaMm2).toBe(0);
    expect(c.missedAreaMm2).toBeCloseTo(300, 6);
  });

  it('the geometry-only pass scores the visible faces as reached (an upper bound)', () => {
    const c = goalCoverage(cube(), fieldAt(5), null);
    expect(c.reachedAreaMm2).toBeCloseTo(300, 6);
  });

  it('an overhang shadows the floor under it', () => {
    const goal = fieldAt(2);
    const c = goalCoverage(overhang(), goal, () => 2);
    // Floor 100, roof 100 top + 100 underside, wall 20 = 320 total.
    expect(c.totalAreaMm2).toBeCloseTo(320, 6);
    // The floor under the roof is shadowed (the roof's cell top is 2 above it).
    expect(c.shadowedAreaMm2).toBeCloseTo(100, 6);
    // The underside faces away; the roof top AND the vertical wall are reached (the wall is the
    // raster's own cliff).
    expect(c.facingAwayAreaMm2).toBeCloseTo(100, 6);
    expect(c.reachedAreaMm2).toBeCloseTo(120, 6);
  });

  it('turning the mesh over is the same surface with a different side up', () => {
    const goal = fieldAt(5);
    const top = goalCoverage(cube(), goal, () => 5);
    // 180° about X: y → −y, z → −z.
    const turned = rotateCoverageMesh(cube(), [1, 0, 0, 0, -1, 0, 0, 0, -1]);
    // The turned cube's top face is now at z −5; the goal it is measured against is the turned one.
    const c = goalCoverage(turned, fieldAt(-5, 11, 11, 0, -10, 1), () => -5);
    expect(c.fraction).toBeCloseTo(top.fraction, 6);
    expect(c.facingAwayAreaMm2).toBeCloseTo(top.facingAwayAreaMm2, 6);
  });

  it('reads the goal top by cell, and answers null outside it', () => {
    const goal = fieldAt(3);
    expect(goalTopAt(goal, 0, 0)).toBe(3);
    expect(goalTopAt(goal, -5, 5)).toBeNull();
  });

  it('names a share in the operator’s words', () => {
    expect(coveragePercent(0.976)).toBe('98 %');
    expect(coveragePercent(0.005)).toBe('0.5 %');
    expect(coveragePercent(0.5)).toBe('50 %');
  });
});
