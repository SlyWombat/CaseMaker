// Issue #107 — waterproof gasket geometry. Verifies the closed-loop
// channel + lid tongue render at the right Z, with the right cross-section,
// and that compileProject succeeds with seal enabled.

import { describe, it, expect } from 'vitest';
import {
  computeSealRing,
  computeSealLoopPath,
  computeChannelAndTongue,
  buildSealChannel,
  buildSealTongue,
} from '@/engine/compiler/seal';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { createDefaultProject } from '@/store/projectStore';
import type { CaseParameters } from '@/types';

const SEAL: NonNullable<CaseParameters['seal']> = {
  enabled: true,
  profile: 'flat',
  width: 4,
  depth: 2,
  compressionFactor: 0.25,
  gasketMaterial: 'tpu',
};

describe('Waterproof gasket (#107)', () => {
  it('computeSealRing returns null when seal is disabled', () => {
    const project = createDefaultProject('rpi-4b');
    const ring = computeSealRing(project.board, project.case, project.hats ?? [], () => undefined);
    expect(ring).toBeNull();
  });

  it('computeSealRing returns null when wall is too thin for the gasket width', () => {
    const project = createDefaultProject('rpi-4b');
    const ring = computeSealRing(
      project.board,
      { ...project.case, wallThickness: 1, seal: { ...SEAL, width: 4 } },
      project.hats ?? [],
      () => undefined,
    );
    expect(ring).toBeNull();
  });

  it('computeSealRing places the gasket centered in the wall material', () => {
    const project = createDefaultProject('rpi-4b');
    // outerOffset = wall/2 - ringWidth/2. With wall=5, gasketWidth=4: offset = 0.5
    const params5: CaseParameters = { ...project.case, wallThickness: 5, seal: SEAL };
    const ring5 = computeSealRing(project.board, params5, project.hats ?? [], () => undefined);
    expect(ring5).not.toBeNull();
    expect(ring5!.outerCornerX).toBeCloseTo(0.5, 3);
    expect(ring5!.outerCornerY).toBeCloseTo(0.5, 3);
  });

  it('computeChannelAndTongue: channel + tongue together exceed compressed gasket depth (preload)', () => {
    const { channelDepth, tongueHeight } = computeChannelAndTongue(SEAL);
    const compressedGasket = SEAL.depth * (1 - SEAL.compressionFactor);
    // Preload: tongue + channel sum should be ≥ compressed gasket so the
    // gasket is squeezed (i.e. the geometry engages the compression).
    expect(channelDepth + tongueHeight).toBeGreaterThanOrEqual(compressedGasket);
  });

  it('buildSealChannel returns a buildOp for an enabled seal with adequate wall', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = { ...project.case, wallThickness: 5, seal: SEAL };
    const op = buildSealChannel(project.board, params, project.hats ?? [], () => undefined);
    expect(op).not.toBeNull();
  });

  it('buildSealTongue returns a buildOp for an enabled seal with adequate wall', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = { ...project.case, wallThickness: 5, seal: SEAL };
    const op = buildSealTongue(project.board, params, project.hats ?? [], () => undefined);
    expect(op).not.toBeNull();
  });

  it('compileProject succeeds with seal enabled and emits both shell + lid nodes', () => {
    const project = createDefaultProject('rpi-4b');
    const sealedProject = {
      ...project,
      case: {
        ...project.case,
        wallThickness: 5,
        lidRecess: true,
        seal: SEAL,
      },
    };
    const plan = compileProject(sealedProject);
    expect(plan.nodes.find((n) => n.id === 'shell')).toBeDefined();
    expect(plan.nodes.find((n) => n.id === 'lid')).toBeDefined();
    // BuildPlan with seal should be DIFFERENT from BuildPlan without seal —
    // the channel adds a difference op into the shell, the tongue adds a
    // union op into the lid.
    const unsealed = compileProject({ ...project, case: { ...project.case, wallThickness: 5 } });
    expect(JSON.stringify(plan.nodes)).not.toBe(JSON.stringify(unsealed.nodes));
  });

  it('computeSealLoopPath returns the centerline z below the rim top by channelDepth/2', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = { ...project.case, wallThickness: 5, seal: SEAL, lidRecess: true };
    const dims = computeShellDims(project.board, params, project.hats ?? [], () => undefined);
    const loop = computeSealLoopPath(project.board, params, project.hats ?? [], () => undefined);
    expect(loop).not.toBeNull();
    const { channelDepth } = computeChannelAndTongue(SEAL);
    const rimTopZ = dims.outerZ - params.lidThickness;
    expect(loop!.centerlineZ).toBeCloseTo(rimTopZ - channelDepth / 2, 3);
  });
});
