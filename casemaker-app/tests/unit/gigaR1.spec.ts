// Regression: #6 — built-in Arduino GIGA R1 WiFi profile must load and
// schema-validate alongside the existing 5 boards.
import { describe, it, expect } from 'vitest';
import { getBuiltinBoard, listBuiltinBoardIds } from '@/library';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';

describe('Arduino GIGA R1 WiFi board profile (#6)', () => {
  it('is registered in the built-in board list', () => {
    expect(listBuiltinBoardIds()).toContain('arduino-giga-r1-wifi');
  });

  it('has 4 mounting holes and a non-empty components array', () => {
    const giga = getBuiltinBoard('arduino-giga-r1-wifi')!;
    expect(giga.mountingHoles.length).toBe(4);
    expect(giga.components.length).toBeGreaterThan(3);
  });

  it('declares a datasheet source URL (required for built-ins)', () => {
    const giga = getBuiltinBoard('arduino-giga-r1-wifi')!;
    expect(giga.source).toBeTypeOf('string');
    expect(giga.source!.length).toBeGreaterThan(10);
  });

  it('compiles to a non-empty BuildPlan with shell + lid', () => {
    const project = createDefaultProject('arduino-giga-r1-wifi');
    const plan = compileProject(project);
    expect(plan.nodes.map((n) => n.id)).toEqual(['shell', 'lid']);
  });

  it('PCB outline matches the GIGA R1 spec (~101.6 × 53.3 mm)', () => {
    const giga = getBuiltinBoard('arduino-giga-r1-wifi')!;
    expect(giga.pcb.size.x).toBeCloseTo(101.6, 1);
    expect(giga.pcb.size.y).toBeCloseTo(53.3, 1);
  });
});
