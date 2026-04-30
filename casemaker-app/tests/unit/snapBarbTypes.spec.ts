// Issue #69 — every barb type produces a non-empty, distinct snap-catch
// geometry. The snap-fit-test fixture is the canonical small case used to
// exercise these without engaging the rest of the compiler surface.

import { describe, it, expect } from 'vitest';
import { buildSnapCatch } from '@/engine/compiler/snapCatches';
import { findTemplate } from '@/library/templates';
import { BARB_TYPES } from '@/types/snap';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function countByKind(op: BuildOp, kind: BuildOp['kind']): number {
  let n = op.kind === kind ? 1 : 0;
  if ('child' in op && op.child) n += countByKind(op.child, kind);
  if ('children' in op) for (const c of op.children) n += countByKind(c, kind);
  return n;
}

/** A snap-catch lid build is always a cube arm unioned with some kind of
 *  barb primitive (cube, cylinder, or mesh). Sum across all primitive kinds. */
function countSolidPrimitives(op: BuildOp): number {
  return (
    countByKind(op, 'cube') +
    countByKind(op, 'cylinder') +
    countByKind(op, 'mesh')
  );
}

function meshTriangles(op: BuildOp): number {
  let n = 0;
  if (op.kind === 'mesh') n += op.indices.length / 3;
  if ('child' in op && op.child) n += meshTriangles(op.child);
  if ('children' in op) for (const c of op.children) n += meshTriangles(c);
  return n;
}

function meshPositionsDigest(op: BuildOp): string {
  const out: number[] = [];
  function walk(o: BuildOp): void {
    if (o.kind === 'mesh') {
      for (let i = 0; i < o.positions.length; i++) out.push(Math.round(o.positions[i]! * 1000));
    }
    if ('child' in o && o.child) walk(o.child);
    if ('children' in o) for (const c of o.children) walk(c);
  }
  walk(op);
  return out.join(',');
}

describe('Snap-fit barb cross-section registry (#69)', () => {
  const project = findTemplate('snap-fit-test')!.build();
  const firstCatch = project.case.snapCatches?.[0];

  it('snap-fit-test fixture exposes at least one snap catch', () => {
    expect(firstCatch).toBeDefined();
  });

  for (const barbType of BARB_TYPES) {
    it(`${barbType}: produces a non-empty arm/barb pair plus either a lip or a wall pocket`, () => {
      const c = { ...firstCatch!, barbType };
      const g = buildSnapCatch(c, project.board, project.case);
      expect(g).not.toBeNull();
      // Lid arm/barb is always: arm cube + a barb primitive (cube/cylinder/mesh).
      expect(countSolidPrimitives(g!.armBarb)).toBeGreaterThanOrEqual(2);
      // Issue #77 — every barb type produces SOME case-side geometry change:
      // either a lip (additive) or a wall pocket (subtractive). Ball-socket is
      // the detent design (pocket only); every other type is lip-based.
      const caseSide = (g!.lip ? countSolidPrimitives(g!.lip) : 0)
        + (g!.wallPocket ? countSolidPrimitives(g!.wallPocket) : 0);
      expect(caseSide).toBeGreaterThanOrEqual(1);
    });
  }

  it('ball-socket emits a wall pocket and no lip; other types emit a lip and no pocket', () => {
    for (const barbType of BARB_TYPES) {
      const g = buildSnapCatch({ ...firstCatch!, barbType }, project.board, project.case);
      if (barbType === 'ball-socket') {
        expect(g!.lip).toBeNull();
        expect(g!.wallPocket).not.toBeNull();
      } else {
        expect(g!.lip).not.toBeNull();
        expect(g!.wallPocket).toBeNull();
      }
    }
  });

  it('ball-socket wall pocket bbox overlaps wall material, not the cavity (advisor-flagged regression)', () => {
    // The pocket is structured as translate(rotate(cylinder)). The cylinder
    // has positive Z extent only (length, radius, segments — body in +Z).
    // The rotate decides which world axis the body extends along; the
    // translate places the cylinder's local origin (z=0 face center) on the
    // inside-wall plane. So the body span in world coords is determined by
    // the rotation direction starting from the translate origin.
    function extractTranslateAndRotate(op: BuildOp): {
      translate: [number, number, number];
      rotate: [number, number, number];
      length: number;
      radius: number;
    } | null {
      if (op.kind !== 'translate') return null;
      const inner = op.child;
      if (inner.kind !== 'rotate') return null;
      const cyl = inner.child;
      if (cyl.kind !== 'cylinder') return null;
      return {
        translate: op.offset as [number, number, number],
        rotate: inner.degrees as [number, number, number],
        length: cyl.height,
        radius: cyl.radiusLow,
      };
    }
    // Build a case that's large enough to host catches on every wall + the
    // four-corner long-side preset. We swap in a test catch on each wall to
    // exercise all four orientations.
    const walls = ['+x', '-x', '+y', '-y'] as const;
    for (const wall of walls) {
      const c = { ...firstCatch!, wall, barbType: 'ball-socket' as const, uPosition: 20 };
      const g = buildSnapCatch(c, project.board, project.case);
      expect(g).not.toBeNull();
      const meta = extractTranslateAndRotate(g!.wallPocket!);
      expect(meta, `pocket op shape for wall ${wall}`).not.toBeNull();
      const [tx, ty] = meta!.translate;
      const [rx, ry] = meta!.rotate;
      const wallThickness = project.case.wallThickness;
      // The cylinder body extends from the translate origin along (rotate ⋅ +Z).
      // For +x/-x walls: rotate around Y. +90 sends +Z → +X (into +x wall).
      //                                     -90 sends +Z → -X (into -x wall).
      // For +y/-y walls: rotate around X. -90 sends +Z → +Y (into +y wall).
      //                                     +90 sends +Z → -Y (into -y wall).
      if (wall === '+x') {
        // Translate is on the inner wall plane (innerX); body extends +X by length.
        // Cylinder body must end inside wall material x ∈ [innerX, outerX].
        // innerX > 0; rotate must be +90 around Y so body extends into wall.
        expect(ry, '+x wall: rotate Y should be +90 so body points into wall').toBe(90);
        // tx should be > some inner threshold; assert it's at least cavity right.
        expect(tx).toBeGreaterThan(wallThickness);
      } else if (wall === '-x') {
        expect(ry, '-x wall: rotate Y should be -90 so body points into wall').toBe(-90);
        // -x wall translate origin sits at innerX = wallThickness, body extends -X.
        expect(tx).toBeCloseTo(wallThickness, 1);
      } else if (wall === '+y') {
        expect(rx, '+y wall: rotate X should be -90 so body points +Y into wall').toBe(-90);
        expect(ty).toBeGreaterThan(wallThickness);
      } else if (wall === '-y') {
        expect(rx, '-y wall: rotate X should be +90 so body points -Y into wall').toBe(90);
        expect(ty).toBeCloseTo(wallThickness, 1);
      }
    }
  });

  it('omitting barbType (legacy projects) defaults to hook geometry', () => {
    const legacy = { ...firstCatch! };
    const explicit = { ...firstCatch!, barbType: 'hook' as const };
    const gLegacy = buildSnapCatch(legacy, project.board, project.case);
    const gExplicit = buildSnapCatch(explicit, project.board, project.case);
    expect(countSolidPrimitives(gLegacy!.lip)).toBe(countSolidPrimitives(gExplicit!.lip));
    expect(countSolidPrimitives(gLegacy!.armBarb)).toBe(countSolidPrimitives(gExplicit!.armBarb));
  });

  it('half-round and ball-socket use cylinder primitives (different from cube hook)', () => {
    const hook = buildSnapCatch({ ...firstCatch!, barbType: 'hook' }, project.board, project.case);
    const halfRound = buildSnapCatch(
      { ...firstCatch!, barbType: 'half-round' },
      project.board,
      project.case,
    );
    const ball = buildSnapCatch(
      { ...firstCatch!, barbType: 'ball-socket' },
      project.board,
      project.case,
    );
    // Hook is cube-only on the lid side; half-round and ball-socket bring in
    // a cylinder primitive — so geometry is observably distinct.
    expect(countByKind(hook!.armBarb, 'cylinder')).toBe(0);
    expect(countByKind(halfRound!.armBarb, 'cylinder')).toBe(1);
    expect(countByKind(ball!.armBarb, 'cylinder')).toBe(1);
  });

  it('hook + symmetric-ramp lips both produce a single trapezoidal-prism mesh (sloped lip)', () => {
    const hook = buildSnapCatch({ ...firstCatch!, barbType: 'hook' }, project.board, project.case);
    const sym = buildSnapCatch(
      { ...firstCatch!, barbType: 'symmetric-ramp' },
      project.board,
      project.case,
    );
    // The lip is a trapezoidal-prism mesh with a sloped outboard face — the
    // slope converts lid-down force into arm-flex force so rectangular
    // barbs can click past without requiring the wall itself to flex.
    // Hook vs symmetric-ramp differ only in the barb shape on the lid side.
    expect(countByKind(hook!.lip, 'mesh')).toBe(1);
    expect(countByKind(sym!.lip, 'mesh')).toBe(1);
    expect(countByKind(hook!.lip, 'cube')).toBe(0);
    expect(countByKind(sym!.lip, 'cube')).toBe(0);
    // 8-vert / 12-tri trapezoidal prism — sanity check the topology.
    expect(meshTriangles(hook!.lip)).toBe(12);
    expect(meshTriangles(sym!.lip)).toBe(12);
  });

  // Suppress unused-import lint when the helpers below stop being used.
  void meshPositionsDigest;
});
