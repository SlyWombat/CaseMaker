import { describe, it, expect } from 'vitest';
import { buildLid } from '@/engine/compiler/lid';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function countByKind(op: BuildOp, kind: BuildOp['kind']): number {
  let n = op.kind === kind ? 1 : 0;
  if ('child' in op && op.child) n += countByKind(op.child, kind);
  if ('children' in op) for (const c of op.children) n += countByKind(c, kind);
  return n;
}

describe('recessed lid + full-lid friction perimeter (valid combination)', () => {
  it('a recessed flat-lid project produces a plate with no friction-lip ring', () => {
    const p = createDefaultProject('rpi-4b');
    p.case.joint = 'flat-lid';
    p.case.lidRecess = true;
    const lid = buildLid(p.board, p.case);
    // No lip → no `difference` op contributed by the lip ring; the only
    // difference (if any) comes from boss holes. With bosses disabled there
    // shouldn't be any.
    p.case.bosses.enabled = false;
    const cleanLid = buildLid(p.board, p.case);
    expect(countByKind(cleanLid, 'difference')).toBe(0);
    void lid;
  });

  it('a recessed snap-fit + full-lid project produces BOTH the recessed plate AND the friction-lip ring', () => {
    const p = createDefaultProject('rpi-4b');
    p.case.joint = 'snap-fit';
    p.case.snapType = 'full-lid';
    p.case.lidRecess = true;
    p.case.bosses.enabled = false; // strip bosses so the only `difference` left is the lip's hollow.
    const lid = buildLid(p.board, p.case);
    // The lip ring is a `difference([lipOuter, lipInner])`. With bosses off,
    // exactly one difference op should be present.
    expect(countByKind(lid, 'difference')).toBe(1);
    // The lid is now a union of the plate + lip + (possibly) posts.
    expect(countByKind(lid, 'union')).toBeGreaterThanOrEqual(1);
  });

  it("toggling snapType from 'barb' to 'full-lid' on a recessed lid changes the lid mesh", () => {
    const p = createDefaultProject('rpi-4b');
    p.case.joint = 'snap-fit';
    p.case.snapType = 'barb';
    p.case.lidRecess = true;
    p.case.bosses.enabled = false;
    const barbLid = buildLid(p.board, p.case);
    p.case.snapType = 'full-lid';
    const fullLid = buildLid(p.board, p.case);
    // Full-lid path adds the lip-ring difference; barb path doesn't.
    expect(countByKind(fullLid, 'difference')).toBeGreaterThan(countByKind(barbLid, 'difference'));
  });

  it('compileProject with recessed + full-lid succeeds and the lid node is non-empty', () => {
    const p = createDefaultProject('rpi-4b');
    p.case.joint = 'snap-fit';
    p.case.snapType = 'full-lid';
    p.case.lidRecess = true;
    const plan = compileProject(p);
    const lidNode = plan.nodes.find((n) => n.id === 'lid');
    expect(lidNode).toBeDefined();
    expect(lidNode!.op).toBeDefined();
  });
});
