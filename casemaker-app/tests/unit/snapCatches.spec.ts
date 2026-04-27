import { describe, it, expect } from 'vitest';
import {
  defaultSnapCatchesForCase,
  buildSnapCatchOps,
} from '@/engine/compiler/snapCatches';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import type { BoardProfile, CaseParameters } from '@/types';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function countOps(op: BuildOp, kind: BuildOp['kind']): number {
  let n = op.kind === kind ? 1 : 0;
  if ('child' in op && op.child) n += countOps(op.child, kind);
  if ('children' in op) for (const c of op.children) n += countOps(c, kind);
  return n;
}

function makeBoard(x: number, y: number): BoardProfile {
  return {
    id: `t-${x}x${y}`,
    name: 'T',
    manufacturer: 'T',
    pcb: { size: { x, y, z: 1.6 } },
    mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 10,
    source: 'https://example.com',
    builtin: false,
  };
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

describe('Issue #29 — snap-catch placement and geometry', () => {
  it('small case (<80mm longest) → 2 catches at the short ends', () => {
    const board = makeBoard(60, 50); // outer ~65 × 55
    const catches = defaultSnapCatchesForCase(board, baseCase);
    expect(catches.length).toBe(2);
    // longer dim is X → catches on -x and +x walls
    const walls = new Set(catches.map((c) => c.wall));
    expect(walls.has('-x')).toBe(true);
    expect(walls.has('+x')).toBe(true);
  });

  it('medium case (80-150mm longest) → 4 catches, one per wall', () => {
    const board = makeBoard(100, 70); // outer ~105 × 75
    const catches = defaultSnapCatchesForCase(board, baseCase);
    expect(catches.length).toBe(4);
    const walls = new Set(catches.map((c) => c.wall));
    expect(walls.has('-x')).toBe(true);
    expect(walls.has('+x')).toBe(true);
    expect(walls.has('-y')).toBe(true);
    expect(walls.has('+y')).toBe(true);
  });

  it('large case (>150mm longest) → 6 catches', () => {
    const board = makeBoard(180, 120);
    const catches = defaultSnapCatchesForCase(board, baseCase);
    expect(catches.length).toBe(6);
  });

  it('disabled catches produce no shell or lid ops', () => {
    const board = makeBoard(100, 70);
    const catches = defaultSnapCatchesForCase(board, baseCase).map((c) => ({
      ...c,
      enabled: false,
    }));
    const ops = buildSnapCatchOps(catches, board, baseCase);
    expect(ops.shellSubtract).toHaveLength(0);
    expect(ops.lidAdd).toHaveLength(0);
  });

  it('non-snap-fit joint produces no ops even when catches are configured', () => {
    const board = makeBoard(100, 70);
    const catches = defaultSnapCatchesForCase(board, baseCase);
    const flatLidParams: CaseParameters = { ...baseCase, joint: 'flat-lid' };
    const ops = buildSnapCatchOps(catches, board, flatLidParams);
    expect(ops.shellSubtract).toHaveLength(0);
    expect(ops.lidAdd).toHaveLength(0);
  });

  it('compileProject for snap-fit emits shell pockets and lid arms', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'snap-fit';
    project.case.snapCatches = defaultSnapCatchesForCase(project.board, project.case);
    const plan = compileProject(project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    const lid = plan.nodes.find((n) => n.id === 'lid')!;
    // Shell has cube cutouts for pockets; lid has cube unions for arms.
    const shellCubes = countOps(shell.op, 'cube');
    const lidCubes = countOps(lid.op, 'cube');
    expect(shellCubes).toBeGreaterThanOrEqual(2);
    expect(lidCubes).toBeGreaterThanOrEqual(2);
  });
});
