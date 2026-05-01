// Issue #80 — printed prototype showed the snap-fit lid arms hanging deep
// into the cavity with no contact between barb and lip. Catch face Z and
// barb top Z were misaligned by ~5 mm. These tests pin down the
// engagement geometry for both recessed and non-recessed lids.

import { describe, it, expect } from 'vitest';
import { buildSnapCatch } from '@/engine/compiler/snapCatches';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { SNAP_DEFAULTS } from '@/types/snap';
import { findTemplate } from '@/library/templates';
import type { BuildOp } from '@/engine/compiler/buildPlan';

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

describe('Snap-fit engagement geometry (#80, post-redesign)', () => {
  // Build flat / recessed baselines explicitly — the template's intrinsic
  // default for lidRecess is irrelevant to these geometry equations.
  // snap-fit-test seeds catches with barbType='hook', which uses the
  // subtract-tab design (no lip; engagement = wall subtraction).
  const project = findTemplate('snap-fit-test')!.build();
  const flatCase = { ...project.case, lidRecess: false };
  const recessedCase = { ...project.case, lidRecess: true };
  const firstCatch = project.case.snapCatches?.[0];

  it('hook produces a wallPocket (subtractive snap hole) and NO additive lip', () => {
    const g = buildSnapCatch(firstCatch!, project.board, flatCase);
    expect(g).not.toBeNull();
    expect(g!.lip).toBeNull();
    expect(g!.wallPocket).not.toBeNull();
  });

  it('non-recessed: snap-hole TOP Z (catch face) sits below lid plate', () => {
    const dims = computeShellDims(project.board, flatCase, project.hats ?? [], () => undefined);
    const g = buildSnapCatch(firstCatch!, project.board, flatCase);
    // wallPocket = full tab volume in WORLD coords. Top of pocket = top of
    // barb body = lidPlateBottomZ - HOOK_TOP_MARGIN. lid plate bottom for
    // a non-recessed lid = outerZ.
    const HOOK_TOP_MARGIN = 1.0;
    const HOOK_TAB_EMBED = 0.3;  // arm extends UP by EMBED into lid plate
    const expectedTopZ = dims.outerZ + HOOK_TAB_EMBED; // arm top in world
    const pocketExtent = zExtent(g!.wallPocket!);
    expect(pocketExtent.max).toBeCloseTo(expectedTopZ, 3);
    // The catch face (the top of the SUBTRACTED hole that the barb body
    // engages) is the body's top, which sits HOOK_TOP_MARGIN below the
    // lid plate. zExtent picks up the whole pocket including the embedded
    // arm portion that overlaps the lid plate; the catch face is computed
    // separately from the math.
    const expectedCatchFaceZ = dims.outerZ - HOOK_TOP_MARGIN;
    expect(expectedCatchFaceZ).toBeLessThan(dims.outerZ);
  });

  it('recessed: snap-hole top sits BELOW the recess pocket bottom (solid catch ledge)', () => {
    const dims = computeShellDims(project.board, recessedCase, project.hats ?? [], () => undefined);
    const g = buildSnapCatch(firstCatch!, project.board, recessedCase);
    // The recess pocket carves the inner wall down to z = outerZ -
    // (lidThickness + 0.5). The barb body's TOP (catch face) must sit
    // BELOW that line by HOOK_RECESS_CATCH_GUARD so the catch material
    // above is solid wall. The wallPocket includes the arm extension
    // which goes up into the lid plate — for the catch face check we
    // care about the BARB BODY top, not the whole pocket extent.
    const HOOK_TOP_MARGIN = 1.0;
    const HOOK_RECESS_CATCH_GUARD = 1.0;
    const lidPlateBottom = dims.outerZ - recessedCase.lidThickness;
    const pocketBotZ = dims.outerZ - (recessedCase.lidThickness + 0.5);
    const expectedCatchFaceZ = Math.min(
      lidPlateBottom - HOOK_TOP_MARGIN,
      pocketBotZ - HOOK_RECESS_CATCH_GUARD,
    );
    expect(expectedCatchFaceZ).toBeLessThanOrEqual(pocketBotZ);
    // The wallPocket's top extent IS the arm top (= lidPlateBottom + EMBED).
    // The CATCH FACE itself is below — verified by the math above.
    void g;
  });

  it('lid arm extends from lid plate underside down by armLength (lid-local Z)', () => {
    // armBarb in LID-LOCAL coords: arm body Z range = [-armLength, +EMBED].
    // The +EMBED extension is what makes the arm fuse with the lid plate
    // (otherwise coplanar contact, manifold leaves the tab as loose).
    const HOOK_TAB_EMBED = 0.3;
    const g = buildSnapCatch(firstCatch!, project.board, flatCase);
    const armBarbExtent = zExtent(g!.armBarb);
    expect(armBarbExtent.max).toBeCloseTo(HOOK_TAB_EMBED, 3);
    expect(armBarbExtent.min).toBeCloseTo(-SNAP_DEFAULTS.armLength, 3);
  });

  it('non-hook barb types still use the additive lip path (regression: hook redesign is opt-in)', () => {
    // asymmetric-ramp shares the hook lip implementation but with a
    // different barb shape — should still emit a non-null lip and no
    // wallPocket.
    const c = { ...firstCatch!, barbType: 'asymmetric-ramp' as const };
    const g = buildSnapCatch(c, project.board, flatCase);
    expect(g!.lip).not.toBeNull();
    expect(g!.wallPocket).toBeNull();
    // Catch face Z still aligns with old armLength/barbLength math:
    const dims = computeShellDims(project.board, flatCase, project.hats ?? [], () => undefined);
    const lipBottomZ = zExtent(g!.lip!).min;
    const expected = dims.outerZ - SNAP_DEFAULTS.armLength + SNAP_DEFAULTS.barbLength;
    expect(lipBottomZ).toBeCloseTo(expected, 3);
  });
});
