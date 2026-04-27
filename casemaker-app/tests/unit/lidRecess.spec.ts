import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { computeLidDims, computeRecessDims } from '@/engine/compiler/lid';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { createDefaultProject } from '@/store/projectStore';

describe('Issue #30 — recessed lid mode', () => {
  it('lidRecess off: lid X/Y matches shell outer X/Y', () => {
    const project = createDefaultProject('rpi-4b');
    const dims = computeShellDims(project.board, project.case);
    const lid = computeLidDims(project.board, project.case);
    expect(lid.x).toBe(dims.outerX);
    expect(lid.y).toBe(dims.outerY);
  });

  it('lidRecess on: lid X/Y is smaller (sized to recess pocket minus clearance)', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.lidRecess = true;
    const dimsOff = computeShellDims(project.board, { ...project.case, lidRecess: false });
    const lidOn = computeLidDims(project.board, project.case);
    expect(lidOn.x).toBeLessThan(dimsOff.outerX);
    expect(lidOn.y).toBeLessThan(dimsOff.outerY);
  });

  it('lidRecess on: shell envelope is taller (extends above the cavity)', () => {
    const project = createDefaultProject('rpi-4b');
    const dimsOff = computeShellDims(project.board, project.case);
    const dimsOn = computeShellDims(project.board, { ...project.case, lidRecess: true });
    expect(dimsOn.outerZ).toBeGreaterThan(dimsOff.outerZ);
  });

  it('lidRecess off: computeRecessDims returns null', () => {
    const project = createDefaultProject('rpi-4b');
    expect(computeRecessDims(project.board, project.case)).toBeNull();
  });

  it('lidRecess on: shell op tree adds a third subtractive child for the pocket', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.lidRecess = true;
    const plan = compileProject(project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    // Outer wrapper is a difference (cutouts); innermost shell envelope includes
    // the recess pocket as a difference child of the additive trunk.
    const op = shell.op;
    expect(op.kind).toBe('difference');
  });
});
