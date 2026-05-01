// Regression for the snap-fit-test loose-pieces bug (post-#123 followup).
//
// The trapezoidal-prism lip emitted by buildLipWedge had a hard-coded
// triangle index list that only produced outward-pointing normals for two
// of the four wall orientations. The other two walls (+x and -y in the
// pre-fix convention) emitted inverted-orientation triangles that
// manifold left as a separate disconnected component when unioned with
// the shell — visible in the print as a tiny lip cube floating off the
// case. The lip also protruded OUTWARD from the case (away from the
// cavity), so even where it WAS connected the snap was non-functional:
// the lid arm's barb had nothing to hook under.
//
// We assert two invariants that are cheap to check without dragging
// Manifold WASM into the unit-test path:
//   (1) the lip's signed mesh volume is POSITIVE for every wall — i.e.
//       the triangles consistently wind so the divergence-theorem volume
//       integral matches the geometric volume (catches inversions);
//   (2) the lip lives in the CAVITY half-space (cavity-bound side of the
//       inner wall surface), not on the outer side — catches a future
//       direction-flip regression that would still pass (1).
//
// NB: post-followup (subtract-tab redesign), the 'hook' barb type no
// longer emits a lip — it engages via wall subtraction. These winding
// regression tests use 'asymmetric-ramp' instead, which still uses the
// trapezoidal-prism lip mesh and exercises the same buildLipWedge code.

import { describe, it, expect } from 'vitest';
import { buildSnapCatch } from '@/engine/compiler/snapCatches';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { findTemplate } from '@/library/templates';
import type { BuildOp } from '@/engine/compiler/buildPlan';
import type { SnapWall } from '@/types';

/** Sum of (1/6) (a · (b × c)) over every triangle — divergence-theorem
 *  volume. Positive for a closed, outward-wound mesh; negative for
 *  inverted; ~0 for a partially-inverted mesh that cancels with itself. */
function signedVolume(positions: Float32Array, indices: Uint32Array): number {
  let v = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]! * 3;
    const b = indices[i + 1]! * 3;
    const c = indices[i + 2]! * 3;
    const ax = positions[a]!, ay = positions[a + 1]!, az = positions[a + 2]!;
    const bx = positions[b]!, by = positions[b + 1]!, bz = positions[b + 2]!;
    const cx = positions[c]!, cy = positions[c + 1]!, cz = positions[c + 2]!;
    v += (
      ax * (by * cz - bz * cy) +
      bx * (cy * az - cz * ay) +
      cx * (ay * bz - az * by)
    ) / 6;
  }
  return v;
}

/** Find the first 'mesh' primitive inside an op tree (the lip is a single
 *  trapezoidal-prism mesh; no nesting to worry about). */
function findMesh(op: BuildOp): { positions: Float32Array; indices: Uint32Array } | null {
  if (op.kind === 'mesh') return { positions: op.positions, indices: op.indices };
  if ('child' in op && op.child) return findMesh(op.child);
  if ('children' in op) {
    for (const c of op.children) {
      const m = findMesh(c);
      if (m) return m;
    }
  }
  return null;
}

describe('Snap-fit lip wedge winding + direction (regression)', () => {
  const project = findTemplate('snap-fit-test')!.build();
  const dims = computeShellDims(project.board, project.case, project.hats ?? [], () => undefined);
  const wallThickness = project.case.wallThickness;
  // Build one catch per wall at a known u-position, run buildSnapCatch, pull
  // the lip mesh, assert volume > 0 (well-wound) and that the cavity-bound
  // extreme of the mesh sits on the correct side of the inner wall surface.
  const checks: { wall: SnapWall; cavitySideAssert: (positions: Float32Array) => void }[] = [
    {
      wall: '-x',
      cavitySideAssert: (p) => {
        // -x wall: inner surface at x=wall; cavity at x > wall. Some lip
        // vertex must extend past the inner surface into the cavity.
        const xs = collectAxis(p, 0);
        expect(Math.max(...xs)).toBeGreaterThan(wallThickness);
      },
    },
    {
      wall: '+x',
      cavitySideAssert: (p) => {
        const innerX = dims.outerX - wallThickness;
        const xs = collectAxis(p, 0);
        expect(Math.min(...xs)).toBeLessThan(innerX);
      },
    },
    {
      wall: '-y',
      cavitySideAssert: (p) => {
        const ys = collectAxis(p, 1);
        expect(Math.max(...ys)).toBeGreaterThan(wallThickness);
      },
    },
    {
      wall: '+y',
      cavitySideAssert: (p) => {
        const innerY = dims.outerY - wallThickness;
        const ys = collectAxis(p, 1);
        expect(Math.min(...ys)).toBeLessThan(innerY);
      },
    },
  ];

  function collectAxis(p: Float32Array, axisOffset: 0 | 1 | 2): number[] {
    const out: number[] = [];
    for (let i = axisOffset; i < p.length; i += 3) out.push(p[i]!);
    return out;
  }

  for (const { wall, cavitySideAssert } of checks) {
    it(`${wall}: lip mesh has POSITIVE signed volume (no inverted triangles)`, () => {
      const c = {
        id: `t-${wall}`,
        wall,
        uPosition: wall.endsWith('x') ? dims.outerY / 2 : dims.outerX / 2,
        enabled: true,
        barbType: 'asymmetric-ramp' as const,
      };
      const g = buildSnapCatch(c, project.board, project.case);
      expect(g?.lip).not.toBeNull();
      const m = findMesh(g!.lip!);
      expect(m).not.toBeNull();
      const v = signedVolume(m!.positions, m!.indices);
      expect(v).toBeGreaterThan(0);
    });

    it(`${wall}: lip protrudes INTO the cavity (not outward)`, () => {
      const c = {
        id: `t-${wall}`,
        wall,
        uPosition: wall.endsWith('x') ? dims.outerY / 2 : dims.outerX / 2,
        enabled: true,
        barbType: 'asymmetric-ramp' as const,
      };
      const g = buildSnapCatch(c, project.board, project.case);
      const m = findMesh(g!.lip!);
      cavitySideAssert(m!.positions);
    });
  }
});
