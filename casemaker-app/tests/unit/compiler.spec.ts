import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { computeBossPlacements } from '@/engine/compiler/bosses';
import { createDefaultProject } from '@/store/projectStore';

describe('ProjectCompiler', () => {
  it('produces a plan with shell + lid nodes for the default Pi 4B project', () => {
    const project = createDefaultProject('rpi-4b');
    const plan = compileProject(project);
    const ids = plan.nodes.map((n) => n.id);
    expect(ids).toEqual(['shell', 'lid']);
  });

  it('shell dims grow by 2*delta on X and Y when wallThickness changes by delta', () => {
    const project = createDefaultProject('rpi-4b');
    const before = computeShellDims(project.board, project.case);
    const delta = 1;
    project.case.wallThickness += delta;
    const after = computeShellDims(project.board, project.case);
    expect(after.outerX - before.outerX).toBeCloseTo(2 * delta, 6);
    expect(after.outerY - before.outerY).toBeCloseTo(2 * delta, 6);
  });

  it('outer Z grows by exactly delta when zClearance changes by delta (above the host-tallest floor)', () => {
    // Issue #66 — cavity height uses max(zClearance, hostTallest+z). Pi 4B
    // host-tallest is ~16 mm, so zClearance only dominates above that. Start
    // the test at zClearance=30 (well past host-tallest) and grow by 8.
    const project = createDefaultProject('rpi-4b');
    project.case.zClearance = 30;
    const before = computeShellDims(project.board, project.case, [], () => undefined);
    project.case.zClearance += 8;
    const after = computeShellDims(project.board, project.case, [], () => undefined);
    expect(after.outerZ - before.outerZ).toBeCloseTo(8, 6);
  });

  it('boss placements equal mountingHoles offset by (wall + clearance) on X and Y', () => {
    const project = createDefaultProject('rpi-4b');
    const offset = project.case.wallThickness + project.case.internalClearance;
    const placements = computeBossPlacements(project.board, project.case);
    expect(placements.length).toBe(project.board.mountingHoles.length);
    for (let i = 0; i < placements.length; i++) {
      const hole = project.board.mountingHoles[i]!;
      const boss = placements[i]!;
      expect(boss.x).toBeCloseTo(hole.x + offset, 6);
      expect(boss.y).toBeCloseTo(hole.y + offset, 6);
    }
  });

  it('produces no boss placements when bosses are disabled', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.bosses.enabled = false;
    const placements = computeBossPlacements(project.board, project.case);
    expect(placements).toEqual([]);
  });
});
