import { describe, it, expect } from 'vitest';
import { roundedRectPrism } from '@/engine/compiler/buildPlan';
import { buildOuterShell } from '@/engine/compiler/caseShell';
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

describe('rounded vertical corners (#81)', () => {
  it('roundedRectPrism with radius=0 is byte-identical to a plain cube', () => {
    const op = roundedRectPrism(100, 70, 30, 0);
    expect(op.kind).toBe('cube');
    if (op.kind === 'cube') {
      expect(op.size).toEqual([100, 70, 30]);
      expect(op.center).toBe(false);
    }
  });

  it('roundedRectPrism with radius>0 emits a union of strips + 4 corner cylinders', () => {
    const op = roundedRectPrism(100, 70, 30, 4);
    expect(op.kind).toBe('union');
    if (op.kind === 'union') {
      // 2 strips + 4 corner cylinders = 6 children.
      expect(op.children.length).toBe(6);
    }
    // 4 cylinder primitives total — one at each corner.
    expect(countByKind(op, 'cylinder')).toBe(4);
  });

  it('roundedRectPrism skips zero-extent strips when radius hits the half-extent (avoids empty manifold mesh)', () => {
    // 10×10 box, radius=5 — both strips would be zero-extent, so only the
    // 4 corner cylinders remain.
    const op = roundedRectPrism(10, 10, 5, 5);
    expect(op.kind).toBe('union');
    if (op.kind === 'union') {
      expect(op.children.length).toBe(4);
      expect(countByKind(op, 'cube')).toBe(0);
    }
  });

  it('clamps radius to half the smaller side so the corner cylinders never overlap past center', () => {
    // 20×10 box, radius=15 should clamp to 5 (= 10/2). Find the inner
    // cylinder via the translate wrapper and assert its radius matches.
    const op = roundedRectPrism(20, 10, 5, 15);
    expect(op.kind).toBe('union');
    if (op.kind !== 'union') return;
    function firstCylinderRadius(o: BuildOp): number | null {
      if (o.kind === 'cylinder') return o.radiusLow;
      if ('child' in o && o.child) return firstCylinderRadius(o.child);
      if ('children' in o) for (const c of o.children) {
        const r = firstCylinderRadius(c);
        if (r !== null) return r;
      }
      return null;
    }
    expect(firstCylinderRadius(op)).toBe(5);
    expect(countByKind(op, 'cylinder')).toBe(4);
  });

  it('outer shell with cornerRadius=0 stays a difference of plain cubes (legacy fast path)', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.cornerRadius = 0;
    const shell = buildOuterShell(project.board, project.case, project.hats ?? [], () => undefined);
    expect(shell.kind).toBe('difference');
    // Children are { outer, cavity } — both should be cubes (or translates of cubes).
    if (shell.kind === 'difference') {
      for (const child of shell.children) {
        const isCubeOrTranslateOfCube =
          child.kind === 'cube' ||
          (child.kind === 'translate' && child.child.kind === 'cube');
        expect(isCubeOrTranslateOfCube, `child ${child.kind}`).toBe(true);
      }
    }
  });

  it('outer shell with cornerRadius>0 contains corner cylinders (rounded outer + inner)', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.cornerRadius = 4;
    const shell = buildOuterShell(project.board, project.case, project.hats ?? [], () => undefined);
    // 4 corner cylinders for outer + 4 for inner cavity = 8 total cylinders.
    // (Cavity inner radius = 4 - wallThickness = 4 - 2 = 2 > 0.)
    expect(countByKind(shell, 'cylinder')).toBe(8);
  });

  it('outer shell with cornerRadius < wallThickness still rounds OUTER corners (inner radius clamps to 0 → cube cavity)', () => {
    const project = createDefaultProject('rpi-4b');
    // wallThickness=2, cornerRadius=1 → outer rounded, inner cavity stays square.
    project.case.cornerRadius = 1;
    project.case.wallThickness = 2;
    const shell = buildOuterShell(project.board, project.case, project.hats ?? [], () => undefined);
    // Outer = 4 corner cylinders; inner cavity = plain cube (no cylinders).
    expect(countByKind(shell, 'cylinder')).toBe(4);
  });

  it('lid plate adds 4 corner cylinders when cornerRadius>0 vs cornerRadius=0 (lid posts excluded)', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.cornerRadius = 0;
    const flatCount = countByKind(buildLid(project.board, project.case), 'cylinder');
    project.case.cornerRadius = 4;
    const roundedCount = countByKind(buildLid(project.board, project.case), 'cylinder');
    // The rounded plate adds exactly 4 corner cylinders. Lid posts contribute
    // the same count to both runs since cornerRadius doesn't affect them.
    expect(roundedCount - flatCount).toBe(4);
  });

  it('compileProject with cornerRadius>0 produces a manifold-friendly union/difference tree (no errors)', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.cornerRadius = 4;
    const plan = compileProject(project);
    expect(plan.nodes.find((n) => n.id === 'shell')).toBeDefined();
    expect(plan.nodes.find((n) => n.id === 'lid')).toBeDefined();
  });

  it('recessed lid + cornerRadius=4 still compiles cleanly', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.cornerRadius = 4;
    project.case.lidRecess = true;
    expect(() => compileProject(project)).not.toThrow();
  });
});
