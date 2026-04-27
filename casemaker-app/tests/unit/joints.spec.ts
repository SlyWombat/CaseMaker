import { describe, it, expect } from 'vitest';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';

describe('joint type compilation', () => {
  it('flat-lid produces shell + lid plan with one node each', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'flat-lid';
    const plan = compileProject(project);
    expect(plan.nodes.map((n) => n.id)).toEqual(['shell', 'lid']);
  });

  it('snap-fit lid op tree contains a union (top + lip ring) — possibly wrapped if posts present', () => {
    const project = createDefaultProject('rpi-4b');
    project.case.joint = 'snap-fit';
    const plan = compileProject(project);
    const lid = plan.nodes.find((n) => n.id === 'lid')!;
    if (lid.op.kind !== 'translate') throw new Error('expected lid root op to be translate');
    // Child is union (top + lip ring + posts) — no holes when joint != screw-down.
    expect(lid.op.child.kind).toBe('union');
  });

  it('lidRecess produces a different shell op tree than non-recessed (issue #30)', () => {
    const project = createDefaultProject('rpi-4b');
    const flat = compileProject(project);
    const recessed = compileProject({
      ...project,
      case: { ...project.case, lidRecess: true },
    });
    const flatShell = JSON.stringify(flat.nodes.find((n) => n.id === 'shell')!.op);
    const recessedShell = JSON.stringify(recessed.nodes.find((n) => n.id === 'shell')!.op);
    expect(flatShell).not.toBe(recessedShell);
  });

  it('ventilation enabled adds cutout ops to the shell', () => {
    const off = compileProject(createDefaultProject('rpi-4b'));
    const onProject = createDefaultProject('rpi-4b');
    onProject.case.ventilation = { enabled: true, pattern: 'slots', coverage: 0.6 };
    const on = compileProject(onProject);
    const offShell = off.nodes.find((n) => n.id === 'shell')!.op;
    const onShell = on.nodes.find((n) => n.id === 'shell')!.op;
    // off has no port cutouts (default ports are enabled, so it does), so count differences.
    const countDifferenceChildren = (op: typeof offShell): number =>
      op.kind === 'difference' ? op.children.length : 1;
    expect(countDifferenceChildren(onShell)).toBeGreaterThan(countDifferenceChildren(offShell));
  });
});
