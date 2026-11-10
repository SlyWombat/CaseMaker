import { describe, it, expect, beforeEach } from 'vitest';
import { countOps } from './helpers/printModel';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import type { BuildOp } from '@/engine/compiler/buildPlan';

describe('Issue #33 — enabling ventilation auto-fills coverage and pattern', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(createDefaultProject('rpi-4b'));
  });

  it('toggling ventilation.enabled=true with default coverage=0 bumps coverage and pattern', () => {
    useProjectStore.getState().patchCase({
      ventilation: { enabled: true, pattern: 'none', coverage: 0 },
    });
    const v = useProjectStore.getState().project.case.ventilation;
    expect(v.enabled).toBe(true);
    expect(v.coverage).toBeGreaterThan(0);
    expect(v.pattern).not.toBe('none');
  });

  it('compileProject after enabling ventilation produces ≥ 1 extra subtractive child in the shell', () => {
    const before = compileProject(useProjectStore.getState().project);
    useProjectStore.getState().patchCase({
      ventilation: { enabled: true, pattern: 'none', coverage: 0 },
    });
    const after = compileProject(useProjectStore.getState().project);

    const beforeShell = before.nodes.find((n) => n.id === 'shell')!.op;
    const afterShell = after.nodes.find((n) => n.id === 'shell')!.op;

    // Either cube or cylinder counts increase (slots = cubes, hex = cylinders).
    const beforeCount = countOps(beforeShell, 'cube') + countOps(beforeShell, 'cylinder');
    const afterCount = countOps(afterShell, 'cube') + countOps(afterShell, 'cylinder');
    expect(afterCount).toBeGreaterThan(beforeCount);
  });
});
