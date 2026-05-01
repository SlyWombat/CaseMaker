// Issue #111 — rugged exterior options (corner bumpers, ribbing, feet).

import { describe, it, expect } from 'vitest';
import { buildRuggedOps } from '@/engine/compiler/rugged';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import type { CaseParameters, RuggedParams } from '@/types';

const RUGGED_FULL: RuggedParams = {
  enabled: true,
  corners: { enabled: true, radius: 8, flexBumper: false },
  ribbing: { enabled: true, direction: 'vertical', ribCount: 5, ribDepth: 1.5, clearBand: 5 },
  feet: { enabled: true, pads: 4, padDiameter: 10, padHeight: 2 },
};

describe('Rugged exterior (#111)', () => {
  it('returns empty ops when rugged.enabled is false', () => {
    const project = createDefaultProject('rpi-4b');
    const ops = buildRuggedOps(project.board, project.case, project.hats ?? [], () => undefined);
    expect(ops.caseAdditive).toEqual([]);
    expect(ops.bumperNodes).toEqual([]);
  });

  it('full rugged config emits 4 corners + ribs + 4 feet into caseAdditive', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = { ...project.case, rugged: RUGGED_FULL };
    const ops = buildRuggedOps(project.board, params, project.hats ?? [], () => undefined);
    // 4 corners (1 cylinder each) + 4 walls × 5 ribs = 20 ribs + 4 feet
    // = 4 + 20 + 4 = 28 ops, all fused with the case body.
    expect(ops.caseAdditive.length).toBe(4 + 20 + 4);
    expect(ops.bumperNodes).toEqual([]);
  });

  it('flexBumper=true splits corners into separate top-level nodes', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = {
      ...project.case,
      rugged: {
        ...RUGGED_FULL,
        corners: { enabled: true, radius: 8, flexBumper: true },
      },
    };
    const ops = buildRuggedOps(project.board, params, project.hats ?? [], () => undefined);
    expect(ops.bumperNodes.length).toBe(4);
    // caseAdditive = ribs + feet, no corners
    expect(ops.caseAdditive.length).toBe(20 + 4);
  });

  it('clearBand leaves smooth bands at top + bottom of vertical ribs', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = {
      ...project.case,
      rugged: {
        ...RUGGED_FULL,
        corners: { enabled: false, radius: 8, flexBumper: false },
        feet: { enabled: false, pads: 4, padDiameter: 10, padHeight: 2 },
        ribbing: { enabled: true, direction: 'vertical', ribCount: 3, ribDepth: 1.5, clearBand: 5 },
      },
    };
    const ops = buildRuggedOps(project.board, params, project.hats ?? [], () => undefined);
    // 4 walls × 3 ribs = 12 ribs
    expect(ops.caseAdditive.length).toBe(12);
  });

  it('compileProject builds successfully with full rugged config', () => {
    const project = createDefaultProject('rpi-4b');
    const ruggedProject = {
      ...project,
      case: { ...project.case, rugged: RUGGED_FULL },
    };
    const plan = compileProject(ruggedProject);
    expect(plan.nodes.find((n) => n.id === 'shell')).toBeDefined();
  });

  it('feet overlap the floor volumetrically — cylinder spans z = [-padHeight, +1] (#119)', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = {
      ...project.case,
      rugged: {
        ...RUGGED_FULL,
        corners: { enabled: false, radius: 8, flexBumper: false },
        ribbing: { enabled: false, direction: 'vertical', ribCount: 0, ribDepth: 0, clearBand: 0 },
        feet: { enabled: true, pads: 4, padDiameter: 10, padHeight: 2 },
      },
    };
    const ops = buildRuggedOps(project.board, params, project.hats ?? [], () => undefined);
    expect(ops.caseAdditive).toHaveLength(4);
    // Each foot is translate([x, y, -padHeight], cylinder(padHeight + 1, r)).
    // Cylinder's z extent is [tz, tz + height] = [-padHeight, +1].
    for (const op of ops.caseAdditive) {
      expect(op.kind).toBe('translate');
      if (op.kind !== 'translate') continue;
      expect(op.offset[2]).toBe(-2); // -padHeight = -2
      expect(op.child.kind).toBe('cylinder');
      if (op.child.kind === 'cylinder') {
        expect(op.child.height).toBe(3); // padHeight + 1 = 3 (overlaps floor by 1)
      }
    }
  });

  it('+x and +y vertical ribs embed INTO the wall by 0.5 mm (#119 manifold-overlap fix)', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = {
      ...project.case,
      rugged: {
        ...RUGGED_FULL,
        corners: { enabled: false, radius: 8, flexBumper: false },
        feet: { enabled: false, pads: 4, padDiameter: 10, padHeight: 2 },
        ribbing: { enabled: true, direction: 'vertical', ribCount: 2, ribDepth: 1.5, clearBand: 5 },
      },
    };
    const dims = {
      outerX: project.board.pcb.size.x + 2 * (project.case.wallThickness + project.case.internalClearance),
      outerY: project.board.pcb.size.y + 2 * (project.case.wallThickness + project.case.internalClearance),
    };
    const ops = buildRuggedOps(project.board, params, project.hats ?? [], () => undefined);
    // 4 walls × 2 ribs = 8.
    expect(ops.caseAdditive).toHaveLength(8);
    // Look for the +x rib(s): translate x = outerX - 0.5 (= EMBED). Cube
    // x-extent is ribDepth + EMBED = 2.0. The rib covers x = [outerX-0.5, outerX+1.5].
    const plusX = ops.caseAdditive.filter((op) => {
      if (op.kind !== 'translate') return false;
      return Math.abs(op.offset[0] - (dims.outerX - 0.5)) < 0.01;
    });
    expect(plusX.length).toBeGreaterThan(0);
    // Look for +y rib(s): translate y = outerY - 0.5.
    const plusY = ops.caseAdditive.filter((op) => {
      if (op.kind !== 'translate') return false;
      return Math.abs(op.offset[1] - (dims.outerY - 0.5)) < 0.01;
    });
    expect(plusY.length).toBeGreaterThan(0);
  });

  it('flex-bumper config emits bumper-* nodes in the BuildPlan', () => {
    const project = createDefaultProject('rpi-4b');
    const ruggedProject = {
      ...project,
      case: {
        ...project.case,
        rugged: {
          ...RUGGED_FULL,
          corners: { enabled: true, radius: 8, flexBumper: true },
        },
      },
    };
    const plan = compileProject(ruggedProject);
    const bumpers = plan.nodes.filter((n) => n.id.startsWith('bumper-'));
    expect(bumpers).toHaveLength(4);
  });
});
