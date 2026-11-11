/**
 * #1220 — THE CYLINDRICAL CHART, RED-FIRST.
 *
 * Planner v3, step B1. #1215's chart is the part seen from straight above; a rod in the 4th axis
 * is seen with the tool pointing at its axis, the rod turning underneath. At (x, θ) the height is
 * how far along u = (0, sin θ, cos θ) the highest surface point lies — signed, so a thin
 * off-centre part can read below zero. The tests pin the frame's own worked examples and the
 * turned-about-X equivalence, then check the guaranteed lower tip value against the exact
 * drop-cutter on every cell.
 *
 * The expected numbers and tolerances are the issue's prototype's; a disagreement is reported,
 * not edited.
 */
import { describe, expect, it } from 'vitest';

import {
  cylGridOver,
  cylSurface,
  cylTipExact,
  cylTipLower,
  turnedAboutX,
  turningProfile,
} from '@/engine/cnc/cam/fields/cylindricalField';
import type { CutterProfile, DropCutterMesh } from '@/engine/cnc/cam/model/dropcutter';

/** The side wall of a cylinder of radius r along X from xa to xb, n flat facets. */
function cylinderMesh(r: number, xa: number, xb: number, n: number): DropCutterMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const v = (x: number, k: number): void => {
    const t = (2 * Math.PI * k) / n;
    positions.push(x, r * Math.sin(t), r * Math.cos(t));
    indices.push(indices.length);
  };
  for (let k = 0; k < n; k++) {
    v(xa, k);
    v(xb, k);
    v(xb, k + 1);
    v(xa, k);
    v(xb, k + 1);
    v(xa, k + 1);
  }
  return { positions, indices, triangleCount: indices.length / 3 };
}

/** The six faces of a box, two triangles each. */
function boxMesh(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): DropCutterMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
    for (const p of [a, b, c, a, c, d]) {
      positions.push(p[0]!, p[1]!, p[2]!);
      indices.push(indices.length);
    }
  };
  quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +Z
  quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]); // -Z
  quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]); // +Y
  quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -Y
  quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]); // -X
  quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]); // +X
  return { positions, indices, triangleCount: indices.length / 3 };
}

const BALL15: CutterProfile = { radiusMm: 1.5, flatRadiusMm: 0, kind: 'arc', curveRadiusMm: 1.5 };
const FLAT2: CutterProfile = { radiusMm: 2, flatRadiusMm: 2, kind: 'flat' };
const V90: CutterProfile = { radiusMm: 3, flatRadiusMm: 0.1, kind: 'cone', tanHalfAngle: 1 };

/** Join two meshes, offsets already resolved (the second's indices moved past the first's vertices). */
function joined(a: DropCutterMesh, b: DropCutterMesh): DropCutterMesh {
  const offset = a.positions.length / 3;
  return {
    positions: [...a.positions, ...b.positions],
    indices: [...a.indices, ...b.indices.map((i) => i + offset)],
    triangleCount: a.triangleCount + b.triangleCount,
  };
}

describe('#1220 the cylindrical chart', () => {
  it('the grid', () => {
    expect(cylGridOver(0, 30, 0.5, 5)).toEqual({ nx: 61, nTheta: 72, x0: 0, dx: 0.5, dThetaDeg: 5 });
    const coarse = cylGridOver(0, 10, 1, 100);
    expect(coarse.nTheta).toBe(4);
    expect(coarse.dThetaDeg).toBe(90);
    expect(() => cylGridOver(0, 1, 0, 5)).toThrow();
  });

  it('turning about X', () => {
    const mesh: DropCutterMesh = {
      positions: [0, 0, 1, 1, 0, 1, 0, 1, 1],
      indices: [0, 1, 2],
      triangleCount: 1,
    };
    const turned = turnedAboutX(mesh, 90);
    const expected = [0, -1, 0, 1, -1, 0, 0, -1, 1];
    for (let i = 0; i < expected.length; i++) expect(turned.positions[i]!).toBeCloseTo(expected[i]!, 12);
    const zero = turnedAboutX(mesh, 0);
    for (let i = 0; i < mesh.positions.length; i++) expect(zero.positions[i]!).toBeCloseTo(mesh.positions[i]!, 12);
  });

  it('a cylinder reads its radius at every angle', () => {
    const mesh = cylinderMesh(10, 0, 30, 64);
    const grid = cylGridOver(2, 28, 1, 5);
    const s = cylSurface(mesh, grid);
    const min = 10 * Math.cos(Math.PI / 64) - 1e-6;
    for (let k = 0; k < s.height.length; k++) {
      expect(Number.isFinite(s.height[k]!)).toBe(true);
      expect(s.height[k]!).toBeGreaterThanOrEqual(min);
      expect(s.height[k]!).toBeLessThanOrEqual(10 + 1e-6);
    }
  });

  it('an off-centre bar reads a height below zero', () => {
    const mesh = boxMesh(0, 20, 2, 8, -2, 2);
    const grid = cylGridOver(5, 15, 5, 90);
    const s = cylSurface(mesh, grid);
    const at = (i: number, j: number): number => s.height[j * grid.nx + i]!;
    expect(at(1, 1)).toBeCloseTo(8, 9);
    expect(at(1, 3)).toBeCloseTo(-2, 9);
    expect(at(1, 0)).toBe(-Infinity);
    expect(at(1, 2)).toBe(-Infinity);
  });

  it('the lower value never exceeds the exact tip height', () => {
    const meshes: readonly DropCutterMesh[] = [cylinderMesh(10, 0, 30, 64), boxMesh(0, 20, 2, 8, -2, 2)];
    const cylinder = meshes[0]!;
    for (const mesh of meshes) {
      const grid = cylGridOver(2, 18, 0.5, 5);
      const surface = cylSurface(mesh, grid);
      for (const profile of [BALL15, FLAT2, V90]) {
        const lower = cylTipLower(surface, profile);
        let checked = 0;
        for (let j = 0; j < grid.nTheta; j++) {
          for (let i = 0; i < grid.nx; i++) {
            const value = lower[j * grid.nx + i]!;
            if (!Number.isFinite(value)) continue;
            checked += 1;
            const exact = cylTipExact(mesh, profile, grid.x0 + i * grid.dx, j * grid.dThetaDeg);
            expect(exact, `cell ${i},${j}: the lower value is finite where the exact value is not`).not.toBeNull();
            expect(value).toBeLessThanOrEqual(exact! + 1e-6);
          }
        }
        if (mesh === cylinder) expect(checked, `${profile.kind}: cells checked`).toBeGreaterThan(500);
      }
    }
  }, 600_000);

  it('on the cylinder the lower value is close', () => {
    const mesh = cylinderMesh(10, 0, 30, 64);
    const grid = cylGridOver(2, 18, 0.5, 5);
    const surface = cylSurface(mesh, grid);
    const lower = cylTipLower(surface, BALL15);
    for (let j = 0; j < grid.nTheta; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const value = lower[j * grid.nx + i]!;
        if (!Number.isFinite(value)) continue;
        const exact = cylTipExact(mesh, BALL15, grid.x0 + i * grid.dx, j * grid.dThetaDeg);
        expect(exact, `cell ${i},${j}: the lower value is finite where the exact value is not`).not.toBeNull();
        expect(exact! - value).toBeLessThan(0.05);
      }
    }
  }, 600_000);

  it('the turning profile of a stepped shaft', () => {
    const mesh = joined(cylinderMesh(10, 0, 15, 64), cylinderMesh(5, 15, 30, 64));
    const grid = cylGridOver(1, 29, 1, 5);
    const p = turningProfile(cylSurface(mesh, grid));
    for (let i = 0; i < grid.nx; i++) {
      const x = grid.x0 + i * grid.dx;
      if (x <= 14) {
        expect(p[i]!).toBeGreaterThan(9.98);
        expect(p[i]!).toBeLessThan(10.0001);
      }
      if (x >= 16) {
        expect(p[i]!).toBeGreaterThan(4.99);
        expect(p[i]!).toBeLessThan(5.0001);
      }
    }
  });
});
