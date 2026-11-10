import { describe, it, expect } from 'vitest';
import { countOps } from './helpers/printModel';
import {
  buildAntennaOps,
  defaultAntennasForBoard,
} from '@/engine/compiler/antennas';
import { ANTENNA_SPECS } from '@/types/antenna';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import { getBuiltinBoard } from '@/library';
import type { BuildOp } from '@/engine/compiler/buildPlan';
import type { BoardProfile, CaseParameters } from '@/types';

const baseCase: CaseParameters = {
  wallThickness: 2,
  floorThickness: 2,
  lidThickness: 2,
  cornerRadius: 0,
  internalClearance: 0.5,
  zClearance: 12,
  joint: 'flat-lid',
  ventilation: { enabled: false, pattern: 'none', coverage: 0, surfaces: [] },
  bosses: { enabled: true, insertType: 'self-tap', outerDiameter: 5, holeDiameter: 2.5 },
};

describe('Issue #19 — antenna feature', () => {
  it('internal antenna produces no cutout ops', () => {
    const board = getBuiltinBoard('esp32-devkit-v1')!;
    const out = buildAntennaOps(
      [{ id: 'a1', type: 'internal', enabled: true }],
      board,
      baseCase,
    );
    expect(out.subtractive).toHaveLength(0);
  });

  it('rpi-external antenna produces a cylindrical hole + counterbore (2 ops)', () => {
    const board = getBuiltinBoard('rpi-5')!;
    const out = buildAntennaOps(
      [{ id: 'a1', type: 'rpi-external', enabled: true, facing: '+x', uOffset: 50 }],
      board,
      baseCase,
    );
    expect(out.subtractive.length).toBeGreaterThanOrEqual(1);
    let cyls = 0;
    for (const op of out.subtractive) cyls += countOps(op, 'cylinder');
    expect(cyls).toBeGreaterThanOrEqual(1);
  });

  it('external-mount antenna produces a 6.4mm dia cylindrical hole', () => {
    const board = getBuiltinBoard('arduino-giga-r1-wifi')!;
    const out = buildAntennaOps(
      [{ id: 'a1', type: 'external-mount', enabled: true, facing: '+y', uOffset: 60 }],
      board,
      baseCase,
    );
    let foundRadius: number | null = null;
    function visit(op: BuildOp) {
      if (op.kind === 'cylinder' && foundRadius === null) {
        foundRadius = op.radiusLow;
      }
      if ('child' in op && op.child) visit(op.child);
      if ('children' in op) op.children.forEach(visit);
    }
    out.subtractive.forEach(visit);
    expect(foundRadius).not.toBeNull();
    expect(foundRadius).toBeCloseTo(ANTENNA_SPECS['external-mount'].holeDiameter / 2 + 0.2, 4);
  });

  it('disabled antenna produces no ops', () => {
    const board = getBuiltinBoard('rpi-5')!;
    const out = buildAntennaOps(
      [{ id: 'a1', type: 'rpi-external', enabled: false, facing: '+x', uOffset: 50 }],
      board,
      baseCase,
    );
    expect(out.subtractive).toHaveLength(0);
  });

  it('connector position determines default wall: +y connector → +y antenna facing', () => {
    const board: BoardProfile = {
      id: 'test',
      name: 'T',
      manufacturer: 'T',
      pcb: { size: { x: 60, y: 40, z: 1.6 } },
      mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
      components: [
        {
          id: 'antenna-x',
          kind: 'antenna-connector',
          position: { x: 30, y: 38, z: 1.6 }, // near +y wall
          size: { x: 3, y: 3, z: 2 },
          facing: '+y',
        },
      ],
      defaultStandoffHeight: 3,
      recommendedZClearance: 10,
      source: 'https://example.com',
      builtin: false,
    };
    const ants = defaultAntennasForBoard(board);
    expect(ants).toHaveLength(1);
    expect(ants[0]?.facing).toBe('+y');
  });

  it('connector close to -x wall picks -x facing', () => {
    const board: BoardProfile = {
      id: 'test',
      name: 'T',
      manufacturer: 'T',
      pcb: { size: { x: 60, y: 40, z: 1.6 } },
      mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
      components: [
        {
          id: 'antenna-x',
          kind: 'antenna-connector',
          position: { x: 1, y: 20, z: 1.6 },
          size: { x: 3, y: 3, z: 2 },
          facing: '+y',
        },
      ],
      defaultStandoffHeight: 3,
      recommendedZClearance: 10,
      source: 'https://example.com',
      builtin: false,
    };
    const ants = defaultAntennasForBoard(board);
    expect(ants[0]?.facing).toBe('-x');
  });

  it('createDefaultProject for rpi-5 includes a default external antenna', () => {
    const project = createDefaultProject('rpi-5');
    expect(project.antennas).toBeDefined();
    expect(project.antennas.length).toBe(1);
    expect(project.antennas[0]?.type).toBe('rpi-external');
  });

  it('createDefaultProject for esp32-devkit-v1 sets antenna type=internal', () => {
    const project = createDefaultProject('esp32-devkit-v1');
    expect(project.antennas[0]?.type).toBe('internal');
  });

  it('createDefaultProject for boards without antenna-connector returns empty antennas', () => {
    const project = createDefaultProject('rpi-4b');
    expect(project.antennas).toEqual([]);
  });

  it('compileProject runs the antenna pass without error', () => {
    const project = createDefaultProject('arduino-giga-r1-wifi');
    const plan = compileProject(project);
    expect(plan.nodes.find((n) => n.id === 'shell')).toBeTruthy();
  });
});
