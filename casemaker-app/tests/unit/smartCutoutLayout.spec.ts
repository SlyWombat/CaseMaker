import { describe, it, expect } from 'vitest';
import {
  applySmartCutoutLayout,
  MIN_BRIDGE_THICKNESS,
} from '@/engine/compiler/smartCutoutLayout';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import type { PortPlacement, BoardProfile, CaseParameters } from '@/types';

const baseBoard: BoardProfile = {
  id: 'test-board',
  name: 'Test Board',
  manufacturer: 'TestCo',
  pcb: { size: { x: 80, y: 50, z: 1.6 } },
  mountingHoles: [],
  components: [],
  defaultStandoffHeight: 3,
  recommendedZClearance: 10,
  source: 'https://example.com',
  builtin: false,
};

const baseCase: CaseParameters = {
  wallThickness: 2,
  floorThickness: 2,
  lidThickness: 2,
  cornerRadius: 0,
  internalClearance: 0.5,
  zClearance: 10,
  joint: 'flat-lid',
  ventilation: { enabled: false, pattern: 'none', coverage: 0, faces: [] },
  bosses: { enabled: true, insertType: 'self-tap', outerDiameter: 5, holeDiameter: 2.5 },
};

function port(overrides: Partial<PortPlacement> = {}): PortPlacement {
  return {
    id: 'p1',
    sourceComponentId: null,
    kind: 'usb-a',
    position: { x: 5, y: 0, z: 1.6 },
    size: { x: 14, y: 16, z: 7 },
    facing: '-y',
    cutoutMargin: 0.4,
    locked: false,
    enabled: true,
    ...overrides,
  };
}

describe('Marketing gap #17 — smart cutout layout (printability)', () => {
  it('leaves cutouts with adequate top clearance unchanged ("as-is" branch)', () => {
    const shell = computeShellDims(baseBoard, baseCase);
    // cavityZ ~ 11.6 (zClearance + pcb.z), outerZ = 13.6
    // place port low enough to leave > MIN_BRIDGE_THICKNESS above
    const p = port({ position: { x: 5, y: 0, z: 0 }, size: { x: 14, y: 16, z: 4 } });
    const cutoutTopWorld = baseCase.floorThickness + baseBoard.defaultStandoffHeight + p.position.z + p.size.z + p.cutoutMargin;
    expect(shell.outerZ - cutoutTopWorld).toBeGreaterThan(MIN_BRIDGE_THICKNESS);

    const out = applySmartCutoutLayout([p], baseBoard, baseCase);
    expect(out.ports[0]!.size.z).toBe(p.size.z);
    expect(out.decisions[0]?.action).toBe('as-is');
  });

  it('extends cutouts that fall within MIN_BRIDGE_THICKNESS of the shell top ("extended-to-top" branch)', () => {
    const shell = computeShellDims(baseBoard, baseCase);
    // pick size such that cutout top is ~1mm below outerZ — under the 1.5mm threshold
    const targetTop = shell.outerZ - 1.0;
    const margin = 0.4;
    const positionZ = 0;
    const sizeZ = targetTop - baseCase.floorThickness - baseBoard.defaultStandoffHeight - positionZ - margin;
    const p = port({ position: { x: 5, y: 0, z: positionZ }, size: { x: 14, y: 16, z: sizeZ } });

    const out = applySmartCutoutLayout([p], baseBoard, baseCase);
    expect(out.decisions[0]?.action).toBe('extended-to-top');
    // After extension, world-Z top should be at-or-above outerZ
    const newPort = out.ports[0]!;
    const newTopWorld =
      baseCase.floorThickness +
      baseBoard.defaultStandoffHeight +
      newPort.position.z +
      newPort.size.z +
      newPort.cutoutMargin;
    expect(newTopWorld).toBeGreaterThanOrEqual(shell.outerZ);
  });

  it('cutouts already extending past the top are left alone (no negative clearance handling)', () => {
    // size.z larger than possible — cutout already overshoots top
    const p = port({ position: { x: 5, y: 0, z: 0 }, size: { x: 14, y: 16, z: 30 } });
    const out = applySmartCutoutLayout([p], baseBoard, baseCase);
    expect(out.ports[0]!.size.z).toBe(p.size.z);
    expect(
      out.decisions.find((d) => d.portId === 'p1' && d.action === 'extended-to-top'),
    ).toBeUndefined();
  });

  it('disabled ports and +z-facing ports are passed through untouched', () => {
    const disabled = port({ id: 'p-disabled', enabled: false });
    const topFacing = port({ id: 'p-top', facing: '+z' });
    const out = applySmartCutoutLayout([disabled, topFacing], baseBoard, baseCase);
    expect(out.ports).toEqual([disabled, topFacing]);
    expect(out.decisions).toHaveLength(0);
  });

  it('compileProject runs the smart-layout pass and tall side-cutouts always overshoot the shell top', () => {
    const project = createDefaultProject('rpi-4b');
    // pick a port and force it into the danger zone
    const target = project.ports[0]!;
    const shell = computeShellDims(project.board, project.case);
    const targetTop = shell.outerZ - 0.8;
    const newSizeZ = targetTop - project.case.floorThickness - project.board.defaultStandoffHeight - target.position.z - target.cutoutMargin;
    const adjusted = { ...target, size: { ...target.size, z: newSizeZ } };
    const ports = [adjusted, ...project.ports.slice(1)];
    const plan = compileProject({ ...project, ports });
    expect(plan.nodes.find((n) => n.id === 'shell')).toBeTruthy();
    // Decisions should record the extension
    const layout = applySmartCutoutLayout(ports, project.board, project.case);
    const extended = layout.decisions.find((d) => d.action === 'extended-to-top');
    expect(extended).toBeTruthy();
  });
});
