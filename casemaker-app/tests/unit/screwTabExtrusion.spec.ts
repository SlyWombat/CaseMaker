import { describe, it, expect } from 'vitest';
import { buildMountingFeatureOps, fourCornerScrewTabs } from '@/engine/compiler/mountingFeatures';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { createDefaultProject } from '@/store/projectStore';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function bboxOf(op: BuildOp): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  function walk(o: BuildOp, ox: number, oy: number, oz: number): void {
    if (o.kind === 'translate') {
      walk(o.child, ox + o.offset[0], oy + o.offset[1], oz + o.offset[2]);
    } else if (o.kind === 'rotate' || o.kind === 'scale') {
      walk(o.child, ox, oy, oz);
    } else if (o.kind === 'cube') {
      const [sx, sy, sz] = o.size;
      const x0 = o.center ? ox - sx / 2 : ox;
      const y0 = o.center ? oy - sy / 2 : oy;
      const z0 = o.center ? oz - sz / 2 : oz;
      for (const [x, y, z] of [
        [x0, y0, z0],
        [x0 + sx, y0 + sy, z0 + sz],
      ]) {
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    } else if (o.kind === 'cylinder') {
      // Z-axis cylinder of radius r and height h, post-rotate handled above.
      const r = o.radiusLow;
      const h = o.height;
      for (const [x, y, z] of [
        [ox - r, oy - r, oz],
        [ox + r, oy + r, oz + h],
      ]) {
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
      }
    }
    if ('children' in o) for (const c of o.children) walk(c, ox, oy, oz);
  }
  walk(op, 0, 0, 0);
  return { min, max };
}

describe('screw-tab tabs extrude OUTSIDE the case envelope (#80 corner-tabs bug)', () => {
  it('fourCornerScrewTabs preset places tabs at the four outer corners (u/v on the boundary, not inset)', () => {
    const tabs = fourCornerScrewTabs(100, 70);
    const positions = tabs.map((t) => [t.position.u, t.position.v]).sort();
    expect(positions).toEqual([
      [0, 0],
      [0, 70],
      [100, 0],
      [100, 70],
    ]);
  });

  it('compiled additive bbox grows BEYOND the bare-shell footprint when 4-corner tabs are added', () => {
    const project = createDefaultProject('rpi-4b');
    const dims = computeShellDims(project.board, project.case);
    const ops = buildMountingFeatureOps(
      fourCornerScrewTabs(dims.outerX, dims.outerY),
      project.board,
      project.case,
    );
    expect(ops.additive.length).toBe(4);
    // Each tab's slab bbox should reach negative coords (outside the case
    // origin-corner) AND coords past outerX/outerY (outside the far corner).
    let anyNegX = false;
    let anyNegY = false;
    let anyPastX = false;
    let anyPastY = false;
    for (const op of ops.additive) {
      const bb = bboxOf(op);
      if (bb.min[0] < 0) anyNegX = true;
      if (bb.min[1] < 0) anyNegY = true;
      if (bb.max[0] > dims.outerX) anyPastX = true;
      if (bb.max[1] > dims.outerY) anyPastY = true;
    }
    expect(anyNegX, 'at least one tab should extend in -X past the case origin').toBe(true);
    expect(anyNegY, 'at least one tab should extend in -Y past the case origin').toBe(true);
    expect(anyPastX, 'at least one tab should extend in +X past outerX').toBe(true);
    expect(anyPastY, 'at least one tab should extend in +Y past outerY').toBe(true);
  });

  it('hole cylinder is rotated [180, 0, 0] for -z face so its body extends INTO the slab, not into the case floor (#80 corner-tabs bug regression)', () => {
    // Pre-#80, the hole was a Z-axis cylinder of length 5 placed at z = -3.5;
    // its body therefore extended from z=-3.5 to z=+1.5, gouging 1.5 mm into
    // the case floor. New code rotates the cylinder by [180,0,0] for -z so
    // the body extends in -Z from the start. Structural assertion below.
    function findRotate(op: BuildOp): [number, number, number] | null {
      if (op.kind === 'rotate') return op.degrees;
      if ('child' in op && op.child) return findRotate(op.child);
      if ('children' in op) for (const c of op.children) {
        const r = findRotate(c);
        if (r) return r;
      }
      return null;
    }
    function findCylinderStartZ(op: BuildOp): number | null {
      if (op.kind === 'translate') {
        const child = op.child;
        if (child && (child.kind === 'rotate' || child.kind === 'cylinder')) {
          return op.offset[2];
        }
      }
      if ('child' in op && op.child) {
        const r = findCylinderStartZ(op.child);
        if (r !== null) return r;
      }
      if ('children' in op) for (const c of op.children) {
        const r = findCylinderStartZ(c);
        if (r !== null) return r;
      }
      return null;
    }
    const project = createDefaultProject('rpi-4b');
    const dims = computeShellDims(project.board, project.case);
    const ops = buildMountingFeatureOps(
      fourCornerScrewTabs(dims.outerX, dims.outerY),
      project.board,
      project.case,
    );
    expect(ops.subtractive.length).toBe(4);
    for (const sub of ops.subtractive) {
      const rot = findRotate(sub);
      expect(rot, 'hole on -z face must carry an explicit rotate').not.toBeNull();
      expect(rot, 'rotate must flip cylinder to extend in -Z').toEqual([180, 0, 0]);
      const startZ = findCylinderStartZ(sub);
      expect(startZ, 'hole start z should be just inside the case (≈0.2 mm)').toBeGreaterThan(0);
      expect(startZ).toBeLessThan(0.5);
    }
  });
});
