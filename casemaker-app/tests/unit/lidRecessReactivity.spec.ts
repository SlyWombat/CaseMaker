// Issue #82 — confirm that toggling lidRecess produces a different
// BuildPlan, so any reactivity bug isn't in the engine itself.

import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { computeLidDims } from '@/engine/compiler/lid';
import { findTemplate } from '@/library/templates';

describe('lidRecess reactivity (#82)', () => {
  const project = findTemplate('snap-fit-test')!.build();

  it('outerZ grows by lidThickness + 1 when lidRecess flips on', () => {
    const flat = computeShellDims(project.board, project.case);
    const recessed = computeShellDims(project.board, {
      ...project.case,
      lidRecess: true,
    });
    expect(recessed.outerZ - flat.outerZ).toBeCloseTo(project.case.lidThickness + 1, 3);
  });

  it('lid dims change when lidRecess flips on', () => {
    const flat = computeLidDims(project.board, project.case);
    const recessed = computeLidDims(project.board, { ...project.case, lidRecess: true });
    // Recessed: lid is sized to the pocket (smaller in X and Y).
    expect(recessed.x).toBeLessThan(flat.x);
    expect(recessed.y).toBeLessThan(flat.y);
    // Recessed: lid sits at (outerZ - lidThickness) relative to the new
    // outerZ. outerZ itself grew by (lidThickness + 1), so the lid in
    // world coords ends up 1 mm higher than it was — but it sits BELOW
    // the new rim by exactly lidThickness.
    const flatDims = computeShellDims(project.board, project.case);
    const recessedDims = computeShellDims(project.board, { ...project.case, lidRecess: true });
    expect(flat.zPosition).toBeCloseTo(flatDims.outerZ, 3);
    expect(recessed.zPosition).toBeCloseTo(recessedDims.outerZ - project.case.lidThickness, 3);
  });

  it('compileProject produces nodes with different shell + lid ops when toggled', () => {
    const flat = compileProject(project);
    const recessed = compileProject({ ...project, case: { ...project.case, lidRecess: true } });
    // Both have shell + lid nodes.
    expect(flat.nodes.map((n) => n.id)).toEqual(['shell', 'lid']);
    expect(recessed.nodes.map((n) => n.id)).toEqual(['shell', 'lid']);
    // The op trees are not the same object reference.
    expect(flat.nodes[0]!.op).not.toBe(recessed.nodes[0]!.op);
    expect(flat.nodes[1]!.op).not.toBe(recessed.nodes[1]!.op);
  });
});
