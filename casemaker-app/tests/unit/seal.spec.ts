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
  buildGasketBody,
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

  it('buildGasketBody returns a separate ring buildOp (#108 — printed in TPU)', () => {
    const project = createDefaultProject('rpi-4b');
    const params: CaseParameters = { ...project.case, wallThickness: 5, seal: SEAL };
    const op = buildGasketBody(project.board, params, project.hats ?? [], () => undefined);
    expect(op).not.toBeNull();
  });

  it('compileProject emits a `gasket` top-level node when seal is enabled (#108)', () => {
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
    const gasket = plan.nodes.find((n) => n.id === 'gasket');
    expect(gasket).toBeDefined();
    // Issue #168 — the gasket is what the export path splits into its own file,
    // and it says so itself now. This replaces the old "the exporter special-
    // cases the id `gasket`" coupling: the export side is keyed off this flag
    // (see `meshNodesForExport`), so the two have to agree or the gasket lands
    // in the main STL and prints in the wrong filament.
    expect(gasket!.material).toEqual({ separateFile: true });
    // Unsealed projects still don't have a gasket node.
    const unsealed = compileProject({ ...project, case: { ...project.case, wallThickness: 5 } });
    expect(unsealed.nodes.find((n) => n.id === 'gasket')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Issue #113 — per-printer gasket clearance tolerance.
  // The pre-#113 implicit clearance was 0.2 mm. The new optional field
  // `seal.gasketClearance` lets the user dial it per-printer; when unset
  // the geometry MUST be byte-identical to the pre-#113 build.
  // -------------------------------------------------------------------------
  it('gasketClearance defaults preserve pre-#113 geometry exactly (#113)', () => {
    const project = createDefaultProject('rpi-4b');
    const baseParams: CaseParameters = { ...project.case, wallThickness: 5, seal: SEAL };
    const explicitParams: CaseParameters = {
      ...project.case,
      wallThickness: 5,
      seal: { ...SEAL, gasketClearance: 0.2 },
    };
    const opDefault = buildSealTongue(project.board, baseParams, project.hats ?? [], () => undefined);
    const opExplicit = buildSealTongue(project.board, explicitParams, project.hats ?? [], () => undefined);
    expect(JSON.stringify(opDefault)).toBe(JSON.stringify(opExplicit));
  });

  it('gasketClearance shifts tongue inset proportionally (#113)', () => {
    const project = createDefaultProject('rpi-4b');
    const tightParams: CaseParameters = {
      ...project.case,
      wallThickness: 5,
      seal: { ...SEAL, gasketClearance: 0.2 },
    };
    const looseParams: CaseParameters = {
      ...project.case,
      wallThickness: 5,
      seal: { ...SEAL, gasketClearance: 0.4 },
    };
    const tight = buildSealTongue(project.board, tightParams, project.hats ?? [], () => undefined);
    const loose = buildSealTongue(project.board, looseParams, project.hats ?? [], () => undefined);
    if (!tight || !loose) throw new Error('expected non-null tongue ops');
    // Top-level op is translate([cornerX + tongueClearance, cornerY + tongueClearance, ...], ...).
    // Bumping tolerance from 0.2 → 0.4 should add 0.2 mm to both X and Y offsets.
    if (tight.kind !== 'translate' || loose.kind !== 'translate') {
      throw new Error('expected top-level translate');
    }
    expect(loose.offset[0] - tight.offset[0]).toBeCloseTo(0.2, 6);
    expect(loose.offset[1] - tight.offset[1]).toBeCloseTo(0.2, 6);
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
