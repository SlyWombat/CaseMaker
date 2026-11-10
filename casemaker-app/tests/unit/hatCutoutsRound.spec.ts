import { describe, it, expect, beforeEach } from 'vitest';
import { countOps } from './helpers/printModel';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { computeHatBaseZ, autoPortsForHat } from '@/engine/compiler/hats';
import { computeStackedHatHeight, HOST_HAT_CLEARANCE } from '@/engine/compiler/caseShell';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { getBuiltinHat } from '@/library/hats';
import { getBuiltinBoard } from '@/library';
import type { BuildOp } from '@/engine/compiler/buildPlan';

describe('Issue #18 — DMX shield round XLR cutouts + HAT lift over host components', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(createDefaultProject('arduino-uno-r3'));
  });

  it('DMX shield XLR connectors produce round cutouts via autoPortsForHat', () => {
    const dmx = getBuiltinHat('cqrobot-dmx-shield-max485')!;
    const ports = autoPortsForHat(dmx, 'h-1');
    const xlrFemale = ports.find((p) => p.sourceComponentId === 'dmx-xlr-female');
    const xlrMale = ports.find((p) => p.sourceComponentId === 'dmx-xlr-male');
    expect(xlrFemale?.cutoutShape).toBe('round');
    expect(xlrMale?.cutoutShape).toBe('round');
  });

  it('compileProject for Uno + DMX shield emits two round XLR cutouts', () => {
    useProjectStore.getState().addHat('cqrobot-dmx-shield-max485');
    const plan = compileProject(useProjectStore.getState().project);
    const shellNode = plan.nodes.find((n) => n.id === 'shell')!;
    const cyls = countOps(shellNode.op, 'cylinder');
    expect(cyls).toBeGreaterThanOrEqual(2);
  });

  it('HAT lift clears host tallest +z when host is taller than headerHeight', () => {
    const board = getBuiltinBoard('arduino-uno-r3')!;
    const hostTallest = board.components.reduce(
      (m, c) => (c.facing === '+z' ? Math.max(m, c.position.z + c.size.z) : m),
      0,
    );
    const dmx = getBuiltinHat('cqrobot-dmx-shield-max485')!;

    if (hostTallest <= dmx.headerHeight) {
      // Synthetic test: same idea but the Uno may not have a tall +z right now —
      // assert that increasing host tallest above headerHeight raises the lift.
      const synthetic = {
        ...board,
        components: [
          ...board.components,
          {
            id: 'tall-comp',
            kind: 'custom' as const,
            position: { x: 10, y: 10, z: 1.6 },
            size: { x: 5, y: 5, z: 20 },
            facing: '+z' as const,
          },
        ],
      };
      const lift = computeStackedHatHeight(
        [{ id: 'h-1', hatId: dmx.id, stackIndex: 0, ports: [], enabled: true }],
        () => dmx,
        synthetic,
      );
      expect(lift).toBeGreaterThanOrEqual(20 + HOST_HAT_CLEARANCE);
    } else {
      const lift = computeStackedHatHeight(
        [{ id: 'h-1', hatId: dmx.id, stackIndex: 0, ports: [], enabled: true }],
        () => dmx,
        board,
      );
      expect(lift).toBeGreaterThanOrEqual(hostTallest + HOST_HAT_CLEARANCE);
    }
  });

  it('only the first enabled HAT has its lift bumped — subsequent HATs keep their headerHeight', () => {
    const board = getBuiltinBoard('arduino-uno-r3')!;
    const synthetic = {
      ...board,
      components: [
        ...board.components,
        {
          id: 'tall-comp',
          kind: 'custom' as const,
          position: { x: 10, y: 10, z: 1.6 },
          size: { x: 5, y: 5, z: 20 },
          facing: '+z' as const,
        },
      ],
    };
    const dmx = getBuiltinHat('cqrobot-dmx-shield-max485')!;
    const baseZ = computeHatBaseZ(
      board.id === synthetic.id ? synthetic : synthetic,
      {
        wallThickness: 2,
        floorThickness: 2,
        lidThickness: 2,
        cornerRadius: 0,
        internalClearance: 0.5,
        zClearance: 10,
        joint: 'flat-lid',
        ventilation: { enabled: false, pattern: 'none', coverage: 0, surfaces: [] },
        bosses: { enabled: true, insertType: 'self-tap', outerDiameter: 5, holeDiameter: 2.5 },
      },
      [
        { id: 'h-1', hatId: dmx.id, stackIndex: 0, ports: [], enabled: true },
        { id: 'h-2', hatId: dmx.id, stackIndex: 1, ports: [], enabled: true },
      ],
      () => dmx,
    );
    const z1 = baseZ.get('h-1')!;
    const z2 = baseZ.get('h-2')!;
    const stacked = z2 - z1;
    // Issue #32: stack delta now includes the previous HAT's full Z extent
    // (PCB + tallest component, including side-facing connectors). For the DMX
    // shield, the XLR connector body adds 24mm on top of the 1.6mm PCB.
    const tallestPlus = dmx.components.reduce(
      (m, c) => Math.max(m, c.position.z + c.size.z),
      0,
    );
    expect(stacked).toBeCloseTo(dmx.pcb.size.z + tallestPlus + dmx.headerHeight, 5);
  });
});
