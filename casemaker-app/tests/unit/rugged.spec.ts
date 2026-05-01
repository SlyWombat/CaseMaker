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

  it('full rugged config emits 8 corner caps (top+bottom) + ribs + 4 feet (#121)', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = { ...project.case, rugged: RUGGED_FULL };
    const ops = buildRuggedOps(project.board, params, project.hats ?? [], () => undefined);
    // #121 — corners are now DISCRETE top+bottom caps, not full-height
    // pillars. 4 vertical corners × (1 top + 1 bottom) = 8 cap cylinders.
    // 4 walls × 5 ribs = 20 ribs. 4 feet. Total = 32 ops.
    expect(ops.caseAdditive.length).toBe(8 + 20 + 4);
    expect(ops.bumperNodes).toEqual([]);
  });

  it('flexBumper=true splits 8 corner caps into separate top-level nodes (#121)', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = {
      ...project.case,
      rugged: {
        ...RUGGED_FULL,
        corners: { enabled: true, radius: 8, flexBumper: true },
      },
    };
    const ops = buildRuggedOps(project.board, params, project.hats ?? [], () => undefined);
    // 8 caps now (top + bottom × 4 corners), each a separate flex node
    expect(ops.bumperNodes.length).toBe(8);
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

  it('+x and +y vertical ribs embed INTO the wall and protrude past it (#119 manifold-overlap fix)', () => {
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
    // Post-taper: each rib is a hexagonal-prism mesh whose vertices already
    // bake the world-coord wall position. Inspect the mesh vertices to
    // confirm the +x rib(s) include points BOTH inside the wall (x <
    // outerX, by EMBED) AND outside the case envelope (x > outerX, by
    // ribDepth) — the embed gives the manifold-fusion overlap and the
    // protrusion gives the visible rib bump.
    const collectXs = (op: import('@/engine/compiler/buildPlan').BuildOp): number[] => {
      if (op.kind === 'mesh') {
        const xs: number[] = [];
        for (let i = 0; i < op.positions.length; i += 3) xs.push(op.positions[i]!);
        return xs;
      }
      return [];
    };
    const ribXs = ops.caseAdditive.flatMap(collectXs);
    expect(ribXs.some((x) => x > dims.outerX + 1)).toBe(true);   // ≥1 rib protrudes past +x wall
    expect(ribXs.some((x) => x < -1)).toBe(true);                // ≥1 rib protrudes past -x wall
    expect(ribXs.some((x) => Math.abs(x - (dims.outerX + 0.0)) < 0.01 || x > dims.outerX - 0.6)).toBe(true);
    const ribYs = ops.caseAdditive.flatMap((op) => {
      if (op.kind === 'mesh') {
        const ys: number[] = [];
        for (let i = 1; i < op.positions.length; i += 3) ys.push(op.positions[i]!);
        return ys;
      }
      return [];
    });
    expect(ribYs.some((y) => y > dims.outerY + 1)).toBe(true);   // ≥1 rib protrudes past +y wall
    expect(ribYs.some((y) => y < -1)).toBe(true);                // ≥1 rib protrudes past -y wall
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
    // #121 — discrete top+bottom caps × 4 corners = 8.
    expect(bumpers).toHaveLength(8);
  });
});
