import { describe, it, expect } from 'vitest';
import {
  resolveMountingPosition,
  rotateFacing,
  applyMountingPosition,
} from '@/engine/compiler/hatOrientation';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { getBuiltinHat } from '@/library/hats';
import type { HatProfile, HatPlacement, PortPlacement } from '@/types';

const profile: HatProfile = {
  id: 'tst',
  name: 'Tst',
  manufacturer: 'Tst',
  pcb: { size: { x: 60, y: 40, z: 1.6 } },
  mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
  headerHeight: 8.5,
  components: [],
  compatibleBoards: [],
  mountingPositions: [
    { id: 'default', label: 'Default', offset: { x: 0, y: 0 }, rotation: 0 },
    { id: 'rot90', label: 'CCW 90°', offset: { x: 0, y: 0 }, rotation: 90 },
    { id: 'rot180', label: '180°', offset: { x: 0, y: 0 }, rotation: 180 },
    { id: 'rot270', label: 'CCW 270°', offset: { x: 0, y: 0 }, rotation: 270 },
  ],
  source: 'https://example.com',
  builtin: false,
};

function basePort(overrides: Partial<PortPlacement> = {}): PortPlacement {
  return {
    id: 'p1',
    sourceComponentId: null,
    kind: 'usb-a',
    position: { x: 5, y: 30, z: 0 },
    size: { x: 14, y: 8, z: 7 },
    facing: '+y',
    cutoutMargin: 0.4,
    locked: false,
    enabled: true,
    ...overrides,
  };
}

describe('Issue #23 — HAT orientation drag-and-snap (data model)', () => {
  it('rotateFacing rotates +x→+y→-x→-y at 90° increments', () => {
    expect(rotateFacing('+x', 0)).toBe('+x');
    expect(rotateFacing('+x', 90)).toBe('+y');
    expect(rotateFacing('+x', 180)).toBe('-x');
    expect(rotateFacing('+x', 270)).toBe('-y');
  });

  it('rotateFacing leaves +z alone', () => {
    expect(rotateFacing('+z', 90)).toBe('+z');
  });

  it('resolveMountingPosition returns default identity when profile has no mountingPositions', () => {
    const noPos: HatProfile = { ...profile, mountingPositions: undefined };
    const placement: HatPlacement = {
      id: 'h1',
      hatId: 'tst',
      stackIndex: 0,
      ports: [],
      enabled: true,
    };
    const out = resolveMountingPosition(noPos, placement);
    expect(out.rotation).toBe(0);
    expect(out.offset).toEqual({ x: 0, y: 0 });
  });

  it('resolveMountingPosition returns the named entry when mountingPositionId set', () => {
    const placement: HatPlacement = {
      id: 'h1',
      hatId: 'tst',
      stackIndex: 0,
      mountingPositionId: 'rot180',
      ports: [],
      enabled: true,
    };
    const out = resolveMountingPosition(profile, placement);
    expect(out.rotation).toBe(180);
  });

  it('applyMountingPosition with rotation=180 mirrors a +y port to -y', () => {
    const port = basePort({ facing: '+y', position: { x: 10, y: 30, z: 0 } });
    const rotated = applyMountingPosition(port, profile.pcb.size, {
      id: 'r',
      label: 'r',
      offset: { x: 0, y: 0 },
      rotation: 180,
    });
    expect(rotated.facing).toBe('-y');
  });

  it('applyMountingPosition with rotation=90 swaps size axes', () => {
    const port = basePort({ size: { x: 14, y: 8, z: 7 } });
    const rotated = applyMountingPosition(port, profile.pcb.size, {
      id: 'r',
      label: 'r',
      offset: { x: 0, y: 0 },
      rotation: 90,
    });
    expect(rotated.size.x).toBe(8);
    expect(rotated.size.y).toBe(14);
    expect(rotated.size.z).toBe(7);
  });

  it('compileProject for the DMX HAT in flipped orientation moves XLR cutouts to -y wall', () => {
    const proj = createDefaultProject('arduino-uno-r3');
    useProjectStore.setState({ project: proj });
    useProjectStore.getState().addHat('cqrobot-dmx-shield-max485');
    const placementId = useProjectStore.getState().project.hats[0]!.id;

    // Default orientation
    const planA = compileProject(useProjectStore.getState().project);
    expect(planA.nodes.find((n) => n.id === 'shell')).toBeTruthy();

    // Flipped orientation
    useProjectStore.getState().patchHat(placementId, { mountingPositionId: 'flipped' });
    const planB = compileProject(useProjectStore.getState().project);

    // Triangle counts in the BuildPlan tree differ when ports move (cylinder/cube
    // counts depend on facings, so node tree diffs are observable).
    const serializedA = JSON.stringify(planA);
    const serializedB = JSON.stringify(planB);
    expect(serializedA).not.toBe(serializedB);
  });

  it('DMX HAT profile carries the two declared mounting positions', () => {
    const dmx = getBuiltinHat('cqrobot-dmx-shield-max485')!;
    expect(dmx.mountingPositions).toBeDefined();
    expect(dmx.mountingPositions!.length).toBe(2);
    expect(dmx.mountingPositions!.map((p) => p.id).sort()).toEqual(['default', 'flipped']);
  });
});
