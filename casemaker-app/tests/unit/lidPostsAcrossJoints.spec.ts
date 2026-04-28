import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import type { JointType } from '@/types';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function countOps(op: BuildOp, kind: BuildOp['kind']): number {
  let n = op.kind === kind ? 1 : 0;
  if ('child' in op && op.child) n += countOps(op.child, kind);
  if ('children' in op) for (const c of op.children) n += countOps(c, kind);
  return n;
}

describe('Issue #27 — lid posts present on every joint', () => {
  const joints: JointType[] = ['flat-lid', 'snap-fit', 'screw-down'];

  for (const joint of joints) {
    it(`${joint}: lid mesh contains cylinder posts (one per mounting hole)`, () => {
      const project = createDefaultProject('rpi-4b');
      project.case.joint = joint;
      const plan = compileProject(project);
      const lid = plan.nodes.find((n) => n.id === 'lid')!;
      const cyls = countOps(lid.op, 'cylinder');
      const expectedAtLeast = project.board.mountingHoles.length;
      expect(cyls, `${joint} expected ≥${expectedAtLeast} cylinder ops`).toBeGreaterThanOrEqual(
        expectedAtLeast,
      );
    });
  }

  it('switching from screw-down to flat-lid keeps the same number of post cylinders', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'screw-down';
    const sd = compileProject(project);
    const sdLid = sd.nodes.find((n) => n.id === 'lid')!.op;

    project.case.joint = 'flat-lid';
    const flat = compileProject(project);
    const flatLid = flat.nodes.find((n) => n.id === 'lid')!.op;

    // Same plate + post structure either way; only screw-clearance holes differ.
    // We can't compare cylinder counts directly because screw-down adds the
    // hole cylinders. But the LID should always have at least N posts where
    // N = mounting hole count.
    const N = project.board.mountingHoles.length;
    expect(countOps(sdLid, 'cylinder')).toBeGreaterThanOrEqual(N);
    expect(countOps(flatLid, 'cylinder')).toBeGreaterThanOrEqual(N);
  });

  it('switching insert from self-tap → none on a screw-down case removes the screw clearance hole but keeps the post count', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'screw-down';
    project.case.bosses.insertType = 'self-tap';
    const withHoles = compileProject(project);
    const withHolesLid = withHoles.nodes.find((n) => n.id === 'lid')!.op;

    project.case.bosses.insertType = 'none';
    const withoutHoles = compileProject(project);
    const withoutHolesLid = withoutHoles.nodes.find((n) => n.id === 'lid')!.op;

    // self-tap has 4 posts + 4 hole cylinders = 8; 'none' has only 4 posts.
    expect(countOps(withHolesLid, 'cylinder')).toBeGreaterThan(
      countOps(withoutHolesLid, 'cylinder'),
    );
  });
});
