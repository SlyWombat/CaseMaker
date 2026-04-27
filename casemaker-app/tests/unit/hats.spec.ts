import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeHatBaseZ,
  buildHatCutoutsForProject,
  autoPortsForHat,
  computeStackedHatHeight,
} from '@/engine/compiler/hats';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { useProjectStore, createDefaultProject } from '@/store/projectStore';
import { getBuiltinHat, listBuiltinHatIds, hatsCompatibleWith } from '@/library/hats';
import { builtinHatProfileSchema } from '@/library/hatSchema';

describe('HAT system (Phase 8a)', () => {
  beforeEach(() => {
    useProjectStore.getState().setProject(createDefaultProject('arduino-giga-r1-wifi'));
  });

  it('library exposes the CQRobot DMX shield as a built-in hat', () => {
    expect(listBuiltinHatIds()).toContain('cqrobot-dmx-shield-max485');
    const hat = getBuiltinHat('cqrobot-dmx-shield-max485')!;
    expect(hat.builtin).toBe(true);
    expect(hat.source).toBeTypeOf('string');
    expect(hat.headerHeight).toBeGreaterThan(0);
  });

  it('strict schema rejects a built-in hat without a source URL', () => {
    const hat = getBuiltinHat('cqrobot-dmx-shield-max485')!;
    const broken = { ...hat, source: undefined };
    expect(() => builtinHatProfileSchema.parse(broken)).toThrow();
  });

  it('hatsCompatibleWith filters by compatibleBoards', () => {
    expect(hatsCompatibleWith('arduino-giga-r1-wifi').map((h) => h.id)).toContain(
      'cqrobot-dmx-shield-max485',
    );
    expect(hatsCompatibleWith('rpi-4b').map((h) => h.id)).not.toContain(
      'cqrobot-dmx-shield-max485',
    );
  });

  it('autoPortsForHat creates one port per side-facing component', () => {
    const hat = getBuiltinHat('cqrobot-dmx-shield-max485')!;
    const ports = autoPortsForHat(hat, 'placement-1');
    const sideFacing = hat.components.filter((c) => c.facing && c.facing !== '+z').length;
    expect(ports.length).toBe(sideFacing);
    expect(ports.every((p) => p.enabled)).toBe(true);
  });

  it('addHat / removeHat / reorderHat manipulate the project hats array', () => {
    const store = useProjectStore.getState();
    store.addHat('cqrobot-dmx-shield-max485');
    expect(useProjectStore.getState().project.hats.length).toBe(1);
    const placement = useProjectStore.getState().project.hats[0]!;
    expect(placement.stackIndex).toBe(0);
    expect(placement.enabled).toBe(true);
    expect(placement.ports.length).toBeGreaterThan(0);

    store.addHat('cqrobot-dmx-shield-max485');
    expect(useProjectStore.getState().project.hats.length).toBe(2);
    const second = useProjectStore.getState().project.hats[1]!;
    expect(second.stackIndex).toBe(1);

    store.reorderHat(second.id, 0);
    const ordered = [...useProjectStore.getState().project.hats].sort(
      (a, b) => a.stackIndex - b.stackIndex,
    );
    expect(ordered[0]!.id).toBe(second.id);

    store.removeHat(placement.id);
    expect(useProjectStore.getState().project.hats.length).toBe(1);
    expect(useProjectStore.getState().project.hats[0]!.stackIndex).toBe(0);
  });

  it('zClearance auto-grows when a HAT is stacked, lifting the case top', () => {
    const before = createDefaultProject('arduino-giga-r1-wifi');
    const baseDims = computeShellDims(before.board, before.case, [], () => undefined);

    useProjectStore.getState().addHat('cqrobot-dmx-shield-max485');
    const withHat = useProjectStore.getState().project;
    const afterDims = computeShellDims(
      withHat.board,
      withHat.case,
      withHat.hats,
      (id) => getBuiltinHat(id),
    );
    expect(afterDims.outerZ).toBeGreaterThan(baseDims.outerZ);

    const stack = computeStackedHatHeight(withHat.hats, (id) => getBuiltinHat(id));
    expect(stack).toBeGreaterThan(0);
  });

  it('disabled HAT does not contribute to stack height', () => {
    useProjectStore.getState().addHat('cqrobot-dmx-shield-max485');
    const placement = useProjectStore.getState().project.hats[0]!;
    useProjectStore.getState().patchHat(placement.id, { enabled: false });
    const project = useProjectStore.getState().project;
    expect(computeStackedHatHeight(project.hats, (id) => getBuiltinHat(id))).toBe(0);
  });

  it('computeHatBaseZ places the HAT PCB at floor + pcb.z + headerHeight', () => {
    useProjectStore.getState().addHat('cqrobot-dmx-shield-max485');
    const project = useProjectStore.getState().project;
    const placement = project.hats[0]!;
    const baseZ = computeHatBaseZ(
      project.board,
      project.case,
      project.hats,
      (id) => getBuiltinHat(id),
    );
    const expected =
      project.case.floorThickness +
      project.board.pcb.size.z +
      getBuiltinHat('cqrobot-dmx-shield-max485')!.headerHeight;
    expect(baseZ.get(placement.id)).toBeCloseTo(expected, 4);
  });

  it('compileProject includes HAT cutout ops in the difference set', () => {
    useProjectStore.getState().addHat('cqrobot-dmx-shield-max485');
    const project = useProjectStore.getState().project;
    const cutouts = buildHatCutoutsForProject(
      project.board,
      project.case,
      project.hats,
      (id) => getBuiltinHat(id),
    );
    expect(cutouts.length).toBeGreaterThan(0);
    const plan = compileProject(project);
    const shell = plan.nodes.find((n) => n.id === 'shell')!.op;
    // Outer wrapper is a difference (cutouts present).
    expect(shell.kind).toBe('difference');
  });
});
