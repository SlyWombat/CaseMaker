// Issue #66 — for every built-in board, computeShellDims must produce an
// outerZ that fits the host's tallest +z component plus the lid + a 2 mm
// rim margin, regardless of HAT presence.
// Issue #67 — panel-mount connectors with a `facing` of ±x/±y are allowed
// to overhang the PCB outline by up to CONNECTOR_OVERHANG_BUDGET (5 mm).

import { describe, it, expect } from 'vitest';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { validatePlacements } from '@/engine/compiler/placementValidator';
import { createDefaultProject } from '@/store/projectStore';
import { listBuiltinBoardIds, getBuiltinBoard } from '@/library';
import type { BoardProfile, BoardComponent, Facing } from '@/types';

const RIM_MARGIN = 2;

describe('Cavity height fits host components without HATs (#66)', () => {
  for (const boardId of listBuiltinBoardIds()) {
    it(`${boardId}: outerZ ≥ floor + standoff + tallest+z + lidThickness + ${RIM_MARGIN} mm`, () => {
      const project = createDefaultProject(boardId);
      const dims = computeShellDims(project.board, project.case, project.hats, () => undefined);
      const pcbZ = project.board.pcb.size.z;
      const tallestAbovePcb = project.board.components.reduce(
        (m, c) => Math.max(m, c.position.z + c.size.z - pcbZ),
        0,
      );
      const required =
        project.case.floorThickness +
        project.board.defaultStandoffHeight +
        pcbZ +
        tallestAbovePcb +
        project.case.lidThickness +
        RIM_MARGIN;
      expect(dims.outerZ).toBeGreaterThanOrEqual(required);
    });
  }
});

describe('Panel-mount connector overhang exemption (#67)', () => {
  function syntheticBoard(facing: Facing, cy: number): BoardProfile {
    const usb: BoardComponent = {
      id: 'usb-test',
      kind: 'micro-usb',
      position: { x: 10, y: cy - 2.75, z: 1 },
      size: { x: 8, y: 5.5, z: 2.5 },
      facing,
      cutoutMargin: 0.5,
    };
    return {
      id: 'synthetic-test',
      name: 'Synthetic',
      manufacturer: 'test',
      pcb: { size: { x: 30, y: 21, z: 1.6 } },
      mountingHoles: [],
      components: [usb],
      defaultStandoffHeight: 3,
      recommendedZClearance: 10,
    };
  }

  it('allows a +y connector centroid up to 5 mm past the PCB +y edge', () => {
    const board = syntheticBoard('+y', 24); // PCB +y is 21; centroid 24 = 3 mm past
    const project = { ...createDefaultProject('rpi-pico'), board };
    const report = validatePlacements(project);
    const offPcb = report.issues.filter((i) => i.kind === 'off-pcb');
    expect(offPcb).toHaveLength(0);
  });

  it('still flags a connector overhanging in a non-facing direction', () => {
    // +y facing connector, centroid 3 mm past +x — not the facing axis, must warn.
    const board = syntheticBoard('+y', 10);
    board.components[0]!.position.x = 30; // pushes centroid x to 34 (3mm past 30)
    board.components[0]!.size.x = 8;
    const project = { ...createDefaultProject('rpi-pico'), board };
    const report = validatePlacements(project);
    const offPcb = report.issues.filter((i) => i.kind === 'off-pcb');
    expect(offPcb.length).toBeGreaterThan(0);
  });

  it('Pi Pico USB-micro no longer triggers off-PCB warning', () => {
    const project = createDefaultProject('rpi-pico');
    const report = validatePlacements(project);
    const offPcb = report.issues.filter(
      (i) => i.kind === 'off-pcb' && i.involves.includes('usb-micro'),
    );
    expect(offPcb).toHaveLength(0);
  });
});
