import { describe, it, expect } from 'vitest';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { findTemplate } from '@/library/templates';
import { getBuiltinHat } from '@/library/hats';
import type { BuildOp } from '@/engine/compiler/buildPlan';

function countOps(op: BuildOp, kind: BuildOp['kind']): number {
  let n = op.kind === kind ? 1 : 0;
  if ('child' in op && op.child) n += countOps(op.child, kind);
  if ('children' in op) for (const c of op.children) n += countOps(c, kind);
  return n;
}

describe('Extra cavity height (#36)', () => {
  it('extraCavityZ = N grows outerZ by exactly N', () => {
    const tpl = findTemplate('giga-dmx-controller')!;
    const project = tpl.build();
    const baseline = computeShellDims(
      project.board,
      project.case,
      project.hats,
      (id) => getBuiltinHat(id),
    );
    const stretched = computeShellDims(
      project.board,
      { ...project.case, extraCavityZ: 20 },
      project.hats,
      (id) => getBuiltinHat(id),
    );
    expect(stretched.outerZ - baseline.outerZ).toBeCloseTo(20);
    expect(stretched.cavityZ - baseline.cavityZ).toBeCloseTo(20);
  });

  it('zero / undefined extraCavityZ leaves outerZ unchanged', () => {
    const tpl = findTemplate('pi-server-tray')!;
    const project = tpl.build();
    const a = computeShellDims(
      project.board,
      project.case,
      project.hats,
      (id) => getBuiltinHat(id),
    );
    const b = computeShellDims(
      project.board,
      { ...project.case, extraCavityZ: 0 },
      project.hats,
      (id) => getBuiltinHat(id),
    );
    expect(b.outerZ).toBeCloseTo(a.outerZ);
  });

  it('negative extraCavityZ is clamped to zero (no shrink-below-min)', () => {
    const tpl = findTemplate('pi-server-tray')!;
    const project = tpl.build();
    const baseline = computeShellDims(
      project.board,
      project.case,
      project.hats,
      (id) => getBuiltinHat(id),
    );
    const negative = computeShellDims(
      project.board,
      { ...project.case, extraCavityZ: -5 },
      project.hats,
      (id) => getBuiltinHat(id),
    );
    expect(negative.outerZ).toBeCloseTo(baseline.outerZ);
  });

  it('cutout op count is unchanged when extraCavityZ is set', () => {
    const tpl = findTemplate('giga-dmx-controller')!;
    const project = tpl.build();
    const baseline = compileProject(project);
    const taller = compileProject({
      ...project,
      case: { ...project.case, extraCavityZ: 25 },
    });
    const baseShell = baseline.nodes.find((n) => n.id === 'shell')!;
    const tallShell = taller.nodes.find((n) => n.id === 'shell')!;
    expect(countOps(tallShell.op, 'cylinder')).toBe(countOps(baseShell.op, 'cylinder'));
  });
});
