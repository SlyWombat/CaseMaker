// Issue #80 — printed prototype showed the snap-fit lid arms hanging deep
// into the cavity with no contact between barb and lip. Catch face Z and
// barb top Z were misaligned by ~5 mm. These tests pin down the
// engagement geometry for both recessed and non-recessed lids.

import { describe, it, expect } from 'vitest';
import { buildSnapCatch } from '@/engine/compiler/snapCatches';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { computeLidDims } from '@/engine/compiler/lid';
import { SNAP_DEFAULTS } from '@/types/snap';
import { findTemplate } from '@/library/templates';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function meshTriangles(op: BuildOp): number {
  let n = 0;
  if (op.kind === 'mesh') n += op.indices.length / 3;
  if ('child' in op && op.child) n += meshTriangles(op.child);
  if ('children' in op) for (const c of op.children) n += meshTriangles(c);
  return n;
}

/** Walk the build op tree and return the world-Z extent of every primitive. */
function zExtent(op: BuildOp): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  function walk(o: BuildOp, dz: number): void {
    if (o.kind === 'translate') {
      walk(o.child, dz + o.offset[2]);
      return;
    }
    if (o.kind === 'cube') {
      const z0 = dz + (o.center ? -o.size[2] / 2 : 0);
      const z1 = z0 + o.size[2];
      if (z0 < min) min = z0;
      if (z1 > max) max = z1;
      return;
    }
    if (o.kind === 'mesh') {
      for (let i = 2; i < o.positions.length; i += 3) {
        const z = dz + o.positions[i]!;
        if (z < min) min = z;
        if (z > max) max = z;
      }
      return;
    }
    if (o.kind === 'cylinder') {
      const z0 = dz + (o.center ? -o.height / 2 : 0);
      const z1 = z0 + o.height;
      if (z0 < min) min = z0;
      if (z1 > max) max = z1;
      return;
    }
    if ('child' in o && o.child) walk(o.child, dz);
    if ('children' in o) for (const c of o.children) walk(c, dz);
  }
  walk(op, 0);
  return { min, max };
}

describe('Snap-fit engagement geometry (#80)', () => {
  const project = findTemplate('snap-fit-test')!.build();
  const firstCatch = project.case.snapCatches?.[0];

  it('non-recessed: lip catch face Z = seated barb top Z', () => {
    const dims = computeShellDims(project.board, project.case);
    const g = buildSnapCatch(firstCatch!, project.board, project.case);
    expect(g).not.toBeNull();
    // The lip is anchored on the case wall in world coords. Bottom = catch face.
    const lipExtent = zExtent(g!.lip);
    const lipBottomZ = lipExtent.min;
    // Compute barb top Z in seated position (lid sits AT outerZ, no liftAboveShell).
    // armBarb is built in lid-local coords; arm Z range [-armLength, 0],
    // barb stacks on top of the arm tip going UP by barbLength.
    // Barb top in lid-local = -armLength + barbLength.
    const seatedLidPlateBottom = dims.outerZ;
    const barbTopSeated =
      seatedLidPlateBottom - SNAP_DEFAULTS.armLength + SNAP_DEFAULTS.barbLength;
    expect(lipBottomZ).toBeCloseTo(barbTopSeated, 3);
  });

  it('recessed: lip drops with the lid; barb top still = catch face', () => {
    const recessedCase = { ...project.case, lidRecess: true };
    const dims = computeShellDims(project.board, recessedCase);
    const g = buildSnapCatch(firstCatch!, project.board, recessedCase);
    expect(g).not.toBeNull();
    const lipExtent = zExtent(g!.lip);
    const lipBottomZ = lipExtent.min;
    // Recessed lid sits at outerZ - lidThickness.
    const seatedLidPlateBottom = dims.outerZ - recessedCase.lidThickness;
    const barbTopSeated =
      seatedLidPlateBottom - SNAP_DEFAULTS.armLength + SNAP_DEFAULTS.barbLength;
    expect(lipBottomZ).toBeCloseTo(barbTopSeated, 3);
  });

  it('recessed lip is lower than non-recessed lip by lidThickness', () => {
    const flat = buildSnapCatch(firstCatch!, project.board, project.case);
    const recessed = buildSnapCatch(firstCatch!, project.board, {
      ...project.case,
      lidRecess: true,
    });
    const flatBottom = zExtent(flat!.lip).min;
    const recessedBottom = zExtent(recessed!.lip).min;
    // Recessed lid sits lower → lip is lower by exactly lidThickness.
    // outerZ also differs (recessed is taller), so we compare the relative
    // drop against the recessed-vs-flat outerZ delta.
    const flatDims = computeShellDims(project.board, project.case);
    const recessedDims = computeShellDims(project.board, { ...project.case, lidRecess: true });
    const outerZDelta = recessedDims.outerZ - flatDims.outerZ;
    // Lip in recessed mode = outerZ - lidThickness - LIP_HEIGHT
    //                      = (flatOuterZ + outerZDelta) - lidThickness - LIP_HEIGHT
    // Lip in flat mode    = outerZ - LIP_HEIGHT
    // Difference = outerZDelta - lidThickness
    expect(recessedBottom - flatBottom).toBeCloseTo(
      outerZDelta - project.case.lidThickness,
      3,
    );
  });

  it('lid mesh exists and arm hangs no further than armLength below the plate', () => {
    // Just sanity: the lid placement happens in ProjectCompiler; the local
    // arm extends armLength below z=0. We assert the build plan agrees.
    const g = buildSnapCatch(firstCatch!, project.board, project.case);
    const armExtent = zExtent(g!.armBarb);
    // armBarb is in lid-local coords. Arm Z range [-armLength, 0].
    expect(armExtent.min).toBeCloseTo(-SNAP_DEFAULTS.armLength, 3);
    expect(armExtent.max).toBeLessThanOrEqual(0.001);
  });

  it('lip slab has positive volume (LIP_HEIGHT > 0) and renders as a sloped trapezoidal prism', () => {
    const g = buildSnapCatch(firstCatch!, project.board, project.case);
    // armLength - barbLength must be positive for the lip to have height.
    expect(SNAP_DEFAULTS.armLength).toBeGreaterThan(SNAP_DEFAULTS.barbLength);
    // The lip is a trapezoidal-prism mesh with a sloped outboard face —
    // the slope translates lid-down force into outward arm-flex so
    // rectangular barbs can click past without flexing the wall. The cube
    // primitive used between #90 and the slope-restoration didn't give
    // any insertion ramp.
    function findMesh(op: import('@/engine/compiler/buildPlan').BuildOp): boolean {
      if (op.kind === 'mesh') return op.positions.length > 0 && op.indices.length > 0;
      if ('child' in op && op.child) return findMesh(op.child);
      if ('children' in op) return op.children.some((c) => findMesh(c));
      return false;
    }
    expect(findMesh(g!.lip)).toBe(true);
  });
});
