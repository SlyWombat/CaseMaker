// Issue #120 — part registry. Every project's BuildPlan has a typed list
// of named parts (case body, lid, gasket, hinge pin, latch arms, bumpers).
// The visibility pulldown + export modal both read this list.

import { describe, it, expect } from 'vitest';
import { enumerateParts, partsByCategory } from '@/engine/exporters/parts';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { findTemplate } from '@/library/templates';
import { createDefaultProject } from '@/store/projectStore';

describe('Part registry (#120)', () => {
  it('protective-case template enumerates the expected named parts', () => {
    const tpl = findTemplate('protective-case')!;
    const project = tpl.build();
    const plan = compileProject(project);
    const parts = enumerateParts(plan);
    const ids = parts.map((p) => p.id);
    expect(ids).toContain('shell');
    expect(ids).toContain('lid');
    expect(ids).toContain('gasket');
    // 2 latches in the template
    expect(ids.filter((id) => id.startsWith('latch-arm-')).length).toBe(2);
  });

  it('Pi 4B default project enumerates only shell + lid', () => {
    const project = createDefaultProject('rpi-4b');
    const plan = compileProject(project);
    const parts = enumerateParts(plan);
    const ids = parts.map((p) => p.id).sort();
    expect(ids).toEqual(['lid', 'shell']);
  });

  it('classifies parts by material correctly', () => {
    const tpl = findTemplate('protective-case')!;
    const project = tpl.build();
    const plan = compileProject(project);
    const parts = enumerateParts(plan);
    const byId = new Map(parts.map((p) => [p.id, p] as const));
    expect(byId.get('shell')?.material).toBe('rigid');
    expect(byId.get('lid')?.material).toBe('rigid');
    expect(byId.get('gasket')?.material).toBe('flex');
  });

  it('partsByCategory groups in fixed order: case → gasket → fastener → accessory', () => {
    const tpl = findTemplate('protective-case')!;
    const project = tpl.build();
    const plan = compileProject(project);
    const parts = enumerateParts(plan);
    const groups = partsByCategory(parts);
    const categories = groups.map((g) => g.category);
    // case must precede gasket must precede fastener (when all three present)
    const casIdx = categories.indexOf('case');
    const gasIdx = categories.indexOf('gasket');
    const fasIdx = categories.indexOf('fastener');
    expect(casIdx).toBeLessThan(gasIdx);
    expect(gasIdx).toBeLessThan(fasIdx);
  });

  it('lid has flipForPrint = true (rim sits on bed when slicing)', () => {
    const tpl = findTemplate('protective-case')!;
    const project = tpl.build();
    const plan = compileProject(project);
    const parts = enumerateParts(plan);
    const lid = parts.find((p) => p.id === 'lid');
    expect(lid?.printOrientation.flipForPrint).toBe(true);
  });

  it('returns empty list for null/undefined plan', () => {
    expect(enumerateParts(null)).toEqual([]);
    expect(enumerateParts(undefined)).toEqual([]);
  });
});
