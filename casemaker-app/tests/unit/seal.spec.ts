// Issue #107 — waterproof gasket geometry. Verifies the closed-loop
// channel + lid tongue render at the right Z, with the right cross-section,
// and that compileProject succeeds with seal enabled.

import { describe, it, expect } from 'vitest';
import {
  MIN_SEAL_RING_WIDTH,
  MIN_SEAL_WEB,
  computeSealRing,
  computeSealLoopPath,
  computeChannelAndTongue,
  buildSealChannel,
  buildSealTongue,
  buildGasketBody,
  maxSealRingWidth,
  sealFitNote,
  sealTongueWidth,
} from '@/engine/compiler/seal';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { intersection, cube, translate, type BuildOp } from '@/engine/compiler/buildPlan';
import { createDefaultProject } from '@/store/projectStore';
import type { CaseParameters } from '@/types';
import { exec } from './helpers/manifoldExec';

/** Positive-volume bodies in a solid. `decompose()` counts sealed voids as
 *  components too (negative volume), and they are not printed parts. */
function bodies(op: BuildOp): number {
  const m = exec(op);
  const n = m.decompose().filter((c) => c.volume() > 0).length;
  m.delete();
  return n;
}

/** Volume of `op` ∩ a `size` cube centred on `p` — full volume ⇒ material
 *  there, 0 ⇒ void. The cube has to fit inside the feature being probed: the
 *  channel is 0.8 mm tall, so a 1 mm cube straddles its floor. */
function probeMaterial(op: BuildOp, p: [number, number, number], size = 1): number {
  const hit = exec(intersection([op, translate(p, cube([size, size, size], true))]));
  const v = hit.volume();
  hit.delete();
  return v;
}

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

  it('computeSealRing returns null when the wall is thinner than its two webs', () => {
    // Issue #264 — the test is no longer "the gasket is wider than the wall"
    // (that is clamped now); it is "there is no room for any channel at all".
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

// ---------------------------------------------------------------------------
// Issue #264 — the channel may not consume the wall it is cut into.
//
// A channel as wide as the wall leaves a zero-width surface where the case
// outer face was. Nothing about that is visible in a cross-section: the ring is
// where it always was, just wider. What it does is show up in the SOLID — on a
// recessed-lid case the cut runs through the only material joining the rim band
// to the body, and the shell decomposes into two bodies. The first test below
// is the issue's own repro, run through the production evaluator.
// ---------------------------------------------------------------------------
describe('the channel cannot consume the wall (#264)', () => {
  const SEALED = (over: Partial<CaseParameters> = {}): CaseParameters => {
    const base = createDefaultProject('rpi-4b');
    return {
      ...base.case,
      wallThickness: 4,
      lidThickness: 4,
      lidRecess: true,
      seal: { ...SEAL },
      ...over,
    };
  };
  const resolve = (): undefined => undefined;

  it('a gasket as wide as the wall leaves ONE printed shell, not two', () => {
    // The repro: wall 4, gasket 4. Before the clamp this was a body plus a
    // floating rim band 0.8 mm above it — the rim was held on only through the
    // channel cut, which of course removed it.
    const project = createDefaultProject('rpi-4b');
    const plan = compileProject({ ...project, case: SEALED() });
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    expect(bodies(shell.op)).toBe(1);
  });

  it('clamps the ring to what the wall can hold and keeps a web on each side', () => {
    const project = createDefaultProject('rpi-4b');
    const ring = computeSealRing(project.board, SEALED(), project.hats ?? [], resolve)!;
    // wall 4 − 2 × 0.4 mm of web = 3.2 mm of channel, centred: 0.4 either side.
    expect(ring.ringWidth).toBeCloseTo(3.2, 6);
    expect(ring.outerCornerX).toBeCloseTo(MIN_SEAL_WEB, 6);
    expect(maxSealRingWidth(4)).toBeCloseTo(3.2, 6);
  });

  it('cuts a channel on the stock 2 mm wall instead of silently cutting nothing', () => {
    // The default project is wall 2 with `defaultSeal()`'s 4 mm gasket, which
    // used to be a null ring — ticking "Waterproof gasket" built no channel at
    // all, with nothing on screen saying so.
    const project = createDefaultProject('rpi-4b');
    const params = SEALED({ wallThickness: 2, lidThickness: 3, seal: { ...SEAL } });
    const ring = computeSealRing(project.board, params, project.hats ?? [], resolve)!;
    expect(ring.ringWidth).toBeCloseTo(1.2, 6);
    expect(buildSealChannel(project.board, params, project.hats ?? [], resolve)).not.toBeNull();
    expect(buildSealTongue(project.board, params, project.hats ?? [], resolve)).not.toBeNull();
  });

  it('builds the gasket body into the channel it was cut for', () => {
    // The gasket is a separate part (#108), so "the clamp fixed the case" is
    // only half the claim: the ring the user prints has to land in the channel
    // that is left for it. Probe the middle of the wall at the rim on the -x
    // side: void in the shell, material in the gasket.
    const project = createDefaultProject('rpi-4b');
    const params = SEALED();
    const dims = computeShellDims(project.board, params, project.hats ?? [], resolve);
    const rimTopZ = dims.outerZ - params.lidThickness;
    const { channelDepth } = computeChannelAndTongue(params.seal!);
    const plan = compileProject({ ...project, case: params });
    const shell = plan.nodes.find((n) => n.id === 'shell')!;
    const gasket = buildGasketBody(project.board, params, project.hats ?? [], resolve)!;
    const midY = dims.outerY / 2;
    const inChannel: [number, number, number] = [2, midY, rimTopZ - channelDepth / 2 + 0.1];
    expect(probeMaterial(shell.op, inChannel, 0.4)).toBe(0);
    expect(probeMaterial(gasket, inChannel, 0.4)).toBeGreaterThan(0);
  });

  it('reports what the wall could not hold, and what it would take', () => {
    // The panel reads this; the geometry reads the same clamp, so the sentence
    // and the solid cannot disagree.
    expect(sealFitNote(SEALED({ wallThickness: 5 }))).toBeNull();
    expect(sealFitNote(SEALED({ wallThickness: 2, seal: { ...SEAL } }))).toEqual({
      requested: 4,
      delivered: 1.2,
      web: MIN_SEAL_WEB,
      wallForRequest: 4.8,
      tongueTooNarrow: false,
    });
    // Thinner than the two webs: there is no channel to cut at all.
    expect(sealFitNote(SEALED({ wallThickness: 1, seal: { ...SEAL } }))).toEqual({
      requested: 4,
      delivered: 0,
      web: 1,
      wallForRequest: 4.8,
      tongueTooNarrow: false,
    });
    // And the third silent failure: a clearance wide enough to eat the tongue.
    const wide = SEALED({ wallThickness: 5, seal: { ...SEAL, gasketClearance: 2 } });
    expect(sealTongueWidth(4, 2)).toBeNull();
    expect(sealFitNote(wide)).toEqual({
      requested: 4,
      delivered: 4,
      web: 0.5,
      wallForRequest: 5,
      tongueTooNarrow: true,
    });
    expect(buildSealTongue(createDefaultProject('rpi-4b').board, wide, [], resolve)).toBeNull();
    // The threshold itself, so it is a stated number rather than a magic one.
    expect(sealTongueWidth(MIN_SEAL_RING_WIDTH, 0)).toBeNull();
    expect(sealTongueWidth(MIN_SEAL_RING_WIDTH + 0.01, 0)).toBeCloseTo(0.51, 6);
  });
});
