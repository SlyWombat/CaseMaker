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
    it(`${barbType}: produces a non-empty lip + arm/barb pair`, () => {
      const c = { ...firstCatch!, barbType };
      const g = buildSnapCatch(c, project.board, project.case);
      expect(g).not.toBeNull();
      // Lid arm/barb is always: arm cube + a barb primitive (cube/cylinder/mesh).
      expect(countSolidPrimitives(g!.armBarb)).toBeGreaterThanOrEqual(2);
      // Lip is always at least one mesh primitive (or cube for non-wedge variants).
      expect(countSolidPrimitives(g!.lip)).toBeGreaterThanOrEqual(1);
    });
  }

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

  it('symmetric-ramp lip uses a different mesh than the hook lip', () => {
    const hook = buildSnapCatch({ ...firstCatch!, barbType: 'hook' }, project.board, project.case);
    const sym = buildSnapCatch(
      { ...firstCatch!, barbType: 'symmetric-ramp' },
      project.board,
      project.case,
    );
    // Both lips are mesh primitives. They happen to share the same triangle
    // count (8) but different vertex positions because the symmetric prism
    // puts the tip at h/2 instead of z=0. Compare the position digest.
    expect(meshTriangles(hook!.lip)).toBeGreaterThan(0);
    expect(meshTriangles(sym!.lip)).toBeGreaterThan(0);
    expect(meshPositionsDigest(hook!.lip)).not.toEqual(meshPositionsDigest(sym!.lip));
  });
});
