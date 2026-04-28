// Issue #42 — every built-in board must produce a non-empty snap-fit shell
// AND a non-empty lid. The earlier code shifted the lid lip by
// `internalClearance` so it pierced the wall, and degenerate-cavity boards
// could collapse the lip subtraction to zero triangles, leaving the user with
// an invisible lid.
import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { defaultSnapCatchesForCase } from '@/engine/compiler/snapCatches';
import { buildSnapFitLid } from '@/engine/compiler/lid';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { createDefaultProject } from '@/store/projectStore';
import { listBuiltinBoardIds } from '@/library';
import type { BuildOp } from '@/engine/compiler/buildPlan';
import type { CaseParameters, BoardProfile } from '@/types';

function countOps(op: BuildOp, kind: BuildOp['kind']): number {
  let n = op.kind === kind ? 1 : 0;
  if ('child' in op && op.child) n += countOps(op.child, kind);
  if ('children' in op) for (const c of op.children) n += countOps(c, kind);
  return n;
}

function flattenCubes(op: BuildOp): Array<{ size: [number, number, number] }> {
  const out: Array<{ size: [number, number, number] }> = [];
  function walk(o: BuildOp): void {
    if (o.kind === 'cube') out.push({ size: o.size });
    if ('child' in o && o.child) walk(o.child);
    if ('children' in o) for (const c of o.children) walk(c);
  }
  walk(op);
  return out;
}

const baseCase: CaseParameters = {
  wallThickness: 2,
  floorThickness: 2,
  lidThickness: 2,
  cornerRadius: 0,
  internalClearance: 0.5,
  zClearance: 10,
  joint: 'snap-fit',
  ventilation: { enabled: false, pattern: 'none', coverage: 0 },
  bosses: { enabled: true, insertType: 'none', outerDiameter: 5, holeDiameter: 2.5 },
};

describe('Snap-fit render integrity (#42)', () => {
  for (const boardId of listBuiltinBoardIds()) {
    it(`${boardId}: snap-fit shell and lid both compile to non-trivial geometry`, () => {
      const project = createDefaultProject(boardId);
      project.case.joint = 'snap-fit';
      project.case.snapCatches = defaultSnapCatchesForCase(project.board, project.case);
      const plan = compileProject(project);
      const shell = plan.nodes.find((n) => n.id === 'shell')!;
      const lid = plan.nodes.find((n) => n.id === 'lid')!;
      // Shell must have at least the outer cube + cavity subtraction; the
      // snap lips on the inside walls are mesh wedges (issue #75), not
      // cubes — so just check the count of mesh ops covers the catches.
      expect(countOps(shell.op, 'cube')).toBeGreaterThanOrEqual(2);
      expect(countOps(shell.op, 'mesh')).toBeGreaterThanOrEqual(1);
      // Lid: flat plate cube + (arm + barb cubes per catch). The default
      // catch layout is at least 4 catches (one per wall), so ≥ 1 plate
      // + 4 × 2 = 9 cubes. The lower bound of 3 keeps the assertion
      // tolerant of future schema changes.
      expect(countOps(lid.op, 'cube')).toBeGreaterThanOrEqual(3);
    });
  }

  it('snap-fit lid is a plain plate sized to the outer shell (issue #73 — no continuous lip ring)', () => {
    // Issue #73 — the continuous lid lip was dropped in favour of discrete
    // cantilever arms attached at each snap-catch position. The lid itself
    // is now a flat plate; retention comes from the inside-wall lips on
    // the case shell engaging the lid arms.
    const board: BoardProfile = {
      id: 'fixture-pi4',
      name: 'F',
      manufacturer: 'F',
      pcb: { size: { x: 85, y: 56, z: 1.6 } },
      mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
      components: [],
      defaultStandoffHeight: 5,
      recommendedZClearance: 14,
      builtin: false,
    };
    const dims = computeShellDims(board, baseCase, [], () => undefined);
    const lidOp = buildSnapFitLid(board, baseCase);
    const cubes = flattenCubes(lidOp);
    // Top plate: outerX × outerY × lidThickness.
    const topPlate = cubes.find(
      (c) =>
        Math.abs(c.size[0] - dims.outerX) < 1e-6 &&
        Math.abs(c.size[1] - dims.outerY) < 1e-6 &&
        Math.abs(c.size[2] - baseCase.lidThickness) < 1e-6,
    );
    expect(topPlate, 'snap-fit lid should contain the outer top plate cube').toBeDefined();
  });

  it('tiny custom board falls back to a plain plate (no degenerate lip)', () => {
    const board: BoardProfile = {
      id: 'fixture-tiny',
      name: 'T',
      manufacturer: 'T',
      pcb: { size: { x: 4, y: 4, z: 1 } },
      mountingHoles: [{ id: 'h1', x: 2, y: 2, diameter: 1.5 }],
      components: [],
      defaultStandoffHeight: 2,
      recommendedZClearance: 6,
      builtin: false,
    };
    // Should not throw, should still produce some geometry.
    expect(() => buildSnapFitLid(board, baseCase)).not.toThrow();
    const op = buildSnapFitLid(board, baseCase);
    expect(countOps(op, 'cube')).toBeGreaterThanOrEqual(1);
  });
});
