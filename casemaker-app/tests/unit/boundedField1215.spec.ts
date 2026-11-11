/**
 * #1215 (planner v3, slice 2) — THE BOUNDS CONTRACT, against the exact drop-cutter.
 *
 * Every test checks the one invariant the selector will rely on: the exact tip height at every
 * cell centre lies inside [lo, hi]. A cell outside the bounds is a defect in `surfaceBounds` or
 * `tipBounds` — never in these expectations.
 */
import { describe, expect, it } from 'vitest';

import {
  dropCutterHeight,
  type CutterProfile,
  type DropCutterMesh,
} from '@/engine/cnc/cam/model/dropcutter';
import {
  ambiguousShare,
  gridOver,
  surfaceBounds,
  tipBounds,
  type TipBounds,
} from '@/engine/cnc/cam/fields/boundedField';

/** A deterministic random number in [0, 1). */
let seed = 20261111;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

/** A bumpy surface: (n+1) × (n+1) corners `step` mm apart starting at (0, 0), heights from `heightOf`, two triangles per square. */
function gridMesh(n: number, step: number, heightOf: (x: number, y: number) => number): DropCutterMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const push = (x: number, y: number): void => {
    positions.push(x, y, heightOf(x, y));
    indices.push(indices.length);
  };
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = i * step;
      const y = j * step;
      push(x, y);
      push(x + step, y);
      push(x + step, y + step);
      push(x, y);
      push(x + step, y + step);
      push(x, y + step);
    }
  return { positions, indices, triangleCount: indices.length / 3 };
}

const BALL3: CutterProfile = { radiusMm: 3, flatRadiusMm: 0, kind: 'arc', curveRadiusMm: 3 };
const BALL15: CutterProfile = { radiusMm: 1.5, flatRadiusMm: 0, kind: 'arc', curveRadiusMm: 1.5 };
const FLAT2: CutterProfile = { radiusMm: 2, flatRadiusMm: 2, kind: 'flat' };
const V90: CutterProfile = { radiusMm: 3, flatRadiusMm: 0.1, kind: 'cone', tanHalfAngle: 1 };

/** The check every test below uses: the exact value is inside the bounds at every cell centre. */
function expectContains(mesh: DropCutterMesh, profile: CutterProfile, bounds: TipBounds): number {
  const { nx, ny, x0, y0, pitch } = bounds.grid;
  let checked = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const exact = dropCutterHeight(profile, mesh, x0 + i * pitch, y0 + j * pitch);
      const idx = j * nx + i;
      if (exact === null) {
        expect(bounds.lo[idx], `cell ${i},${j}: lo must be -Infinity where nothing is in reach`).toBe(-Infinity);
        continue;
      }
      expect(bounds.lo[idx], `cell ${i},${j}: lo above the exact value`).toBeLessThanOrEqual(exact + 1e-6);
      expect(bounds.hi[idx], `cell ${i},${j}: hi below the exact value`).toBeGreaterThanOrEqual(exact - 1e-6);
      checked++;
    }
  return checked;
}

describe('#1215 — tip bounds', () => {
  it('the plane through three corners', () => {
    const mesh: DropCutterMesh = {
      positions: [0, 0, 1, 4, 0, 3, 0, 4, 5],
      indices: [0, 1, 2],
      triangleCount: 1,
    };
    const grid = gridOver(0, 0, 4, 4, 1, 0);
    const s = surfaceBounds(mesh, grid);
    const at = (i: number, j: number): number => j * grid.nx + i;
    expect(s.lo[at(0, 0)]).toBeCloseTo(1, 9);
    expect(s.lo[at(1, 1)]).toBeCloseTo(2.5, 9);
    expect(s.lo[at(4, 4)]).toBe(-Infinity);
    for (const value of s.hi) if (Number.isFinite(value)) expect(value).toBeLessThanOrEqual(5 + 1e-9);
  });

  it('a level plane: both bounds are the plane', () => {
    const mesh = gridMesh(1, 20, () => 0);
    const grid = gridOver(0, 0, 20, 20, 0.5, 0);
    const b = tipBounds(surfaceBounds(mesh, grid), BALL3);
    for (let j = 0; j < grid.ny; j++)
      for (let i = 0; i < grid.nx; i++) {
        const x = grid.x0 + i * grid.pitch;
        const y = grid.y0 + j * grid.pitch;
        if (x < 4 || x > 16 || y < 4 || y > 16) continue;
        const idx = j * grid.nx + i;
        expect(b.lo[idx]).toBeCloseTo(0, 9);
        expect(b.hi[idx]).toBeCloseTo(0, 9);
      }
  });

  it('a ramp: the exact value is inside, and the bounds are tight', () => {
    const mesh = gridMesh(1, 20, (x) => 0.5 * x);
    const grid = gridOver(0, 0, 20, 20, 0.25, 0);
    const b = tipBounds(surfaceBounds(mesh, grid), BALL3);
    expect(expectContains(mesh, BALL3, b)).toBeGreaterThan(1000);
    for (let j = 0; j < grid.ny; j++)
      for (let i = 0; i < grid.nx; i++) {
        const x = grid.x0 + i * grid.pitch;
        const y = grid.y0 + j * grid.pitch;
        if (x < 4 || x > 16 || y < 4 || y > 16) continue;
        const idx = j * grid.nx + i;
        expect(b.hi[idx]! - b.lo[idx]!).toBeLessThan(0.35);
      }
  });

  it('a step with a vertical wall', () => {
    // Top at z = 0 over x 0..10; floor at z = −5 over x 10..20; the wall at x = 10.
    const positions = [
      // top
      0, 0, 0, 10, 0, 0, 10, 10, 0,
      0, 0, 0, 10, 10, 0, 0, 10, 0,
      // floor
      10, 0, -5, 20, 0, -5, 20, 10, -5,
      10, 0, -5, 20, 10, -5, 10, 10, -5,
      // wall
      10, 0, -5, 10, 10, -5, 10, 10, 0,
      10, 0, -5, 10, 10, 0, 10, 0, 0,
    ];
    const mesh: DropCutterMesh = { positions, indices: positions.map((_, i) => i), triangleCount: 6 };
    const grid = gridOver(0, 0, 20, 10, 0.5, 0);
    const surface = surfaceBounds(mesh, grid);
    for (const profile of [BALL15, FLAT2, V90]) {
      expect(expectContains(mesh, profile, tipBounds(surface, profile))).toBeGreaterThan(200);
    }
  });

  it('a bumpy surface, three cutters', () => {
    const mesh = gridMesh(12, 1, () => -3 * rnd());
    const grid = gridOver(0, 0, 12, 12, 0.5, 0);
    const surface = surfaceBounds(mesh, grid);
    for (const profile of [BALL15, FLAT2, V90]) {
      expect(expectContains(mesh, profile, tipBounds(surface, profile))).toBeGreaterThan(300);
    }
  });

  it('ambiguousShare', () => {
    const grid = { nx: 4, ny: 1, x0: 0, y0: 0, pitch: 1 };
    const bounds = {
      grid,
      lo: Float64Array.from([0, 0, -Infinity, 1]),
      hi: Float64Array.from([0.5, 0.005, 3, 1]),
    };
    expect(ambiguousShare(bounds, 0.01)).toBeCloseTo(1 / 3, 9);
    const none = { grid, lo: Float64Array.from([-Infinity, -Infinity, -Infinity, -Infinity]), hi: Float64Array.from([1, 1, 1, 1]) };
    expect(ambiguousShare(none, 0.01)).toBe(0);
  });

  it('gridOver', () => {
    expect(gridOver(0, 0, 10, 5, 0.5, 1)).toEqual({ nx: 25, ny: 15, x0: -1, y0: -1, pitch: 0.5 });
    expect(() => gridOver(0, 0, 1, 1, 0, 0)).toThrow('cam/fields: pitch must be above 0');
  });
});
