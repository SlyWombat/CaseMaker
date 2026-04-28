import { describe, it, expect } from 'vitest';
import { validatePlacements } from '@/engine/compiler/placementValidator';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { findTemplate, TEMPLATES } from '@/library/templates';
import { createDefaultProject } from '@/store/projectStore';
import { listBuiltinBoardIds } from '@/library';

describe('Placement validator (#37)', () => {
  it('every built-in board (default project) reports zero errors', () => {
    for (const boardId of listBuiltinBoardIds()) {
      const project = createDefaultProject(boardId);
      const report = validatePlacements(project);
      const errors = report.issues.filter((i) => i.severity === 'error');
      expect(errors, `errors on ${boardId}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
    }
  });

  it('every built-in template reports zero errors', () => {
    for (const tpl of TEMPLATES) {
      const project = tpl.build();
      const report = validatePlacements(project);
      const errors = report.issues.filter((i) => i.severity === 'error');
      expect(errors, `errors in template ${tpl.id}: ${errors.map((e) => e.message).join('; ')}`).toEqual([]);
    }
  });

  it('compileProject attaches the placement report to the BuildPlan', () => {
    const project = findTemplate('giga-dmx-controller')!.build();
    const plan = compileProject(project);
    expect(plan.placementReport).toBeDefined();
    expect(plan.placementReport!.errorCount).toBe(0);
  });

  it('detects two ports overlapping on the same face', () => {
    const project = createDefaultProject('arduino-uno-r3');
    // Synthesize an obvious overlap by injecting two ports at the same position.
    project.ports.push({
      id: 'fake-overlap-1',
      sourceComponentId: null,
      kind: 'usb-c',
      position: { x: 0, y: 5, z: 1.6 },
      size: { x: 8, y: 8, z: 8 },
      facing: '-x',
      cutoutMargin: 0.5,
      locked: false,
      enabled: true,
    });
    project.ports.push({
      id: 'fake-overlap-2',
      sourceComponentId: null,
      kind: 'usb-c',
      position: { x: 0, y: 5, z: 1.6 },
      size: { x: 8, y: 8, z: 8 },
      facing: '-x',
      cutoutMargin: 0.5,
      locked: false,
      enabled: true,
    });
    const report = validatePlacements(project);
    const overlap = report.issues.find(
      (i) => i.kind === 'overlap' &&
        i.involves.includes('fake-overlap-1') &&
        i.involves.includes('fake-overlap-2'),
    );
    expect(overlap).toBeDefined();
    expect(overlap!.face).toBe('-x');
  });

  it('flags a mounting hole placed off the PCB', () => {
    const project = createDefaultProject('arduino-uno-r3');
    project.board.mountingHoles.push({
      id: 'h-bogus',
      x: 999,
      y: 999,
      diameter: 3,
    });
    const report = validatePlacements(project);
    const off = report.issues.find(
      (i) => i.kind === 'off-pcb' && i.involves.includes('h-bogus'),
    );
    expect(off).toBeDefined();
    expect(off!.severity).toBe('error');
  });
});
