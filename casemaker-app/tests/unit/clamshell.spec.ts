// Issue #117 — clamshell seal mode.
//
// The geometry that makes a Pelican-style case (a full-footprint hollow box
// lid sitting ON the rim, instead of a recessed plate dropping INTO a pocket)
// already existed behind `lidRecess: false` + `lidCavityHeight > 0`. What was
// missing was a NAME for that closure style, and a guarantee that asking for
// it can never silently produce a thin plate.
//
// `seal.mode: 'clamshell'` is that name. These specs pin the contract:
//   • the lid is always a box, even when no cavity height is set;
//   • the two halves stack without overlapping and the gasket lands in the
//     plane between them;
//   • projects without `seal.mode` compile exactly as they did before —
//     the change is inert for every legacy project;
//   • 'clamshell' wins over `lidRecess`, which it contradicts;
//   • Whity's reference geometry (case 207.5 × 208.5 × 45.8 + lid
//     207.5 × 208.5 × 25.8) is reproducible from a configured project.

import { describe, it, expect } from 'vitest';

import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { computeShellDims } from '@/engine/compiler/caseShell';
import { computeLidDims, computeRecessDims } from '@/engine/compiler/lid';
import { computeSealLoopPath } from '@/engine/compiler/seal';
import {
  CLAMSHELL_MIN_CAVITY,
  isClamshell,
  lidCavityHeight,
  lidIsRecessed,
} from '@/engine/compiler/lidMode';
import { bboxOfOp } from '@/engine/compiler/connectivity';
import { cube, intersection, translate, type BuildOp } from '@/engine/compiler/buildPlan';
import { createDefaultProject } from '@/store/projectStore';
import { parseProject, serializeProject } from '@/store/persistence';
import type { BoardProfile, CaseParameters } from '@/types';
import type { Project } from '@/types/project';
import { exec } from './helpers/manifoldExec';

const NO_HATS: never[] = [];
const NO_RESOLVE = () => undefined;

function makeBoard(x: number, y: number, z = 1.6): BoardProfile {
  return {
    id: `t-${x}x${y}`,
    name: 'T',
    manufacturer: 'T',
    pcb: { size: { x, y, z } },
    mountingHoles: [{ id: 'h1', x: 5, y: 5, diameter: 2.5 }],
    components: [],
    defaultStandoffHeight: 3,
    recommendedZClearance: 10,
    source: 'https://example.com',
    builtin: false,
  };
}

/** A project whose board and case params are fully specified by the test. */
function makeProject(
  caseOverrides: Partial<CaseParameters>,
  board = makeBoard(80, 60),
): Project {
  const base = createDefaultProject();
  return {
    ...base,
    board,
    case: {
      ...base.case,
      wallThickness: 4,
      floorThickness: 4,
      lidThickness: 4,
      cornerRadius: 4,
      internalClearance: 0.5,
      zClearance: 20,
      lidRecess: false,
      lidCavityHeight: 0,
      bosses: { ...base.case.bosses, enabled: false },
      ventilation: { ...base.case.ventilation, enabled: false },
      ...caseOverrides,
    },
  };
}

function clamshellCase(overrides: Partial<CaseParameters> = {}): Partial<CaseParameters> {
  return {
    seal: {
      enabled: true,
      mode: 'clamshell',
      profile: 'flat',
      width: 2.5,
      depth: 2,
      compressionFactor: 0.25,
      gasketMaterial: 'tpu',
    },
    ...overrides,
  };
}

function dimsOf(project: Project) {
  return computeShellDims(project.board, project.case, NO_HATS, NO_RESOLVE);
}

function lidDimsOf(project: Project) {
  return computeLidDims(project.board, project.case, NO_HATS, NO_RESOLVE);
}

function lidNode(project: Project) {
  const plan = compileProject(project);
  const node = plan.nodes.find((n) => n.id === 'lid');
  expect(node, 'compiled plan has a lid node').toBeDefined();
  return node!.op;
}

/** Volume of `op` ∩ a 1mm cube centred on `p` — 1 ⇒ material there, 0 ⇒ void. */
function probeMaterial(op: BuildOp, p: [number, number, number]): number {
  const box = translate(p, cube([1, 1, 1], true));
  const hit = exec(intersection([op, box]));
  const v = hit.volume();
  hit.delete();
  return v;
}

describe('Issue #117 — clamshell seal mode', () => {
  it('the lid is a full-footprint box even with no cavity height set', () => {
    // `lidCavityHeight: 0` would mean "flat plate" in recess mode; asking for
    // clamshell has to override that, or the user gets the thin plate the
    // issue exists to prevent.
    const project = makeProject(clamshellCase({ lidCavityHeight: 0 }));
    const dims = dimsOf(project);
    const lid = lidDimsOf(project);

    expect(lid.x).toBeCloseTo(dims.outerX, 6);
    expect(lid.y).toBeCloseTo(dims.outerY, 6);
    expect(lid.z).toBeCloseTo(project.case.lidThickness + CLAMSHELL_MIN_CAVITY, 6);

    // And it is a *box*, not a slab: hollow in the middle, solid at the
    // ceiling. Probe the compiled lid mesh rather than the dims struct —
    // dims only say what was asked for. (`bb.min[2]` is no use as the lid's
    // base: the clamping posts hang below it into the case cavity.)
    const lidOp = lidNode(project);
    const bb = bboxOfOp(lidOp)!;
    const cx = (bb.min[0] + bb.max[0]) / 2;
    const cy = (bb.min[1] + bb.max[1]) / 2;
    const cavityHeight = lidCavityHeight(project.case);

    expect(probeMaterial(lidOp, [cx, cy, lid.zPosition + cavityHeight / 2])).toBeLessThan(0.01);
    expect(
      probeMaterial(lidOp, [cx, cy, lid.zPosition + cavityHeight + project.case.lidThickness / 2]),
    ).toBeGreaterThan(0.9);
  });

  it('assembled height is outerZ + lid depth, and the halves do not overlap', () => {
    const project = makeProject(clamshellCase({ lidCavityHeight: 20 }));
    const dims = dimsOf(project);
    const lid = lidDimsOf(project);

    // Clamshell lid sits ON the rim — its underside is exactly the rim plane.
    expect(lid.zPosition).toBeCloseTo(dims.outerZ, 6);
    expect(lid.zPosition + lid.z).toBeCloseTo(dims.outerZ + lid.z, 6);
    expect(lid.zPosition).toBeGreaterThanOrEqual(dims.outerZ - 1e-9);

    // Clamshell takes no recess, so the case envelope does not grow to
    // swallow a protruding lid.
    const recessed = makeProject(clamshellCase({ lidRecess: true, lidCavityHeight: 20 }));
    const recessedDims = dimsOf(recessed);
    expect(recessedDims.outerZ).toBeCloseTo(dims.outerZ, 6);
  });

  it('the gasket sits in the plane between the two halves', () => {
    const project = makeProject(clamshellCase({ lidCavityHeight: 20 }));
    const dims = dimsOf(project);
    const loop = computeSealLoopPath(project.board, project.case, NO_HATS, NO_RESOLVE)!;
    const seal = project.case.seal!;

    // Channel is cut DOWN from the rim plane; centreline is below it.
    expect(loop.centerlineZ).toBeLessThan(dims.outerZ);
    expect(loop.centerlineZ).toBeGreaterThan(dims.outerZ - seal.depth);

    // The lid tongue descends from the lid underside (== rim plane) to meet
    // it, so the gasket ring is straddled by material on both sides.
    expect(lidDimsOf(project).zPosition).toBeCloseTo(dims.outerZ, 6);
  });

  it('recess mode is unchanged — absent mode and explicit mode both recess', () => {
    for (const mode of [undefined, 'recess'] as const) {
      const project = makeProject({
        lidRecess: true,
        lidCavityHeight: 30,
        seal: mode
          ? {
              enabled: true,
              mode,
              profile: 'flat',
              width: 2.5,
              depth: 2,
              compressionFactor: 0.25,
              gasketMaterial: 'tpu',
            }
          : undefined,
      });
      const recess = computeRecessDims(project.board, project.case, NO_HATS, NO_RESOLVE);
      expect(recess, `mode=${String(mode)} still recesses`).not.toBeNull();
      // Recessed lid is a plate, and the case grew a pocket to hold it.
      expect(lidDimsOf(project).z).toBeCloseTo(project.case.lidThickness, 6);
      expect(lidIsRecessed(project.case)).toBe(true);
      expect(isClamshell(project.case)).toBe(false);
    }
  });

  it("'clamshell' overrides `lidRecess`", () => {
    const project = makeProject(clamshellCase({ lidRecess: true, lidCavityHeight: 20 }));

    expect(isClamshell(project.case)).toBe(true);
    expect(lidIsRecessed(project.case)).toBe(false);
    expect(computeRecessDims(project.board, project.case, NO_HATS, NO_RESOLVE)).toBeNull();

    // The case does NOT grow the recess margin, and the lid is a box on the rim.
    const dims = dimsOf(project);
    expect(lidDimsOf(project).zPosition).toBeCloseTo(dims.outerZ, 6);
    expect(lidDimsOf(project).x).toBeCloseTo(dims.outerX, 6);
  });

  it("reproduces Whity's reference geometry (207.5 × 208.5 × 45.8 + a 25.8 lid)", () => {
    // outerX = pcb.x + 2·clearance + 2·wall ⇒ pcb.x = 207.5 − 1 − 8 = 198.5
    const project = makeProject(
      clamshellCase({ lidThickness: 4, lidCavityHeight: 21.8, zClearance: 37.2 }),
      makeBoard(198.5, 199.5),
    );
    const dims = dimsOf(project);
    const lid = lidDimsOf(project);

    expect(dims.outerX).toBeCloseTo(207.5, 6);
    expect(dims.outerY).toBeCloseTo(208.5, 6);
    expect(dims.outerZ).toBeCloseTo(45.8, 6);

    expect(lid.x).toBeCloseTo(207.5, 6);
    expect(lid.y).toBeCloseTo(208.5, 6);
    expect(lid.z).toBeCloseTo(25.8, 6);

    // Closed case stands 45.8 + 25.8 = 71.6 mm.
    expect(lid.zPosition + lid.z).toBeCloseTo(71.6, 6);
  });

  it('hinges and latches survive the box lid', () => {
    const hinge = {
      id: 'hinge-1',
      style: 'external-pin' as const,
      face: '+y' as const,
      numKnuckles: 5,
      knuckleOuterDiameter: 8,
      pinDiameter: 3,
      knuckleClearance: 0.4,
      positioning: 'centered' as const,
      hingeLength: 60,
      pinMode: 'separate' as const,
      enabled: true,
    };
    const latches = ['-x', '+x'].map((wall, i) => ({
      id: `latch-${i}`,
      wall: wall as '-x' | '+x',
      uPosition: 60,
      enabled: true,
      throw: 1.5,
      width: 14,
      height: 30,
    }));

    const project = makeProject(clamshellCase({ hinge, latches, lidCavityHeight: 20 }));
    const plan = compileProject(project);

    // Every emitted part is one extrudable solid. A hollow-box lid moves the
    // surfaces a hinge knuckle or latch arm attaches to, so a part that only
    // touches — rather than overlaps — its host shows up here as a stray body
    // (the #125 failure mode).
    for (const node of plan.nodes) {
      const mesh = exec(node.op);
      expect(mesh.decompose().length, `${node.id} is one solid`).toBe(1);
      mesh.delete();
    }

    // The lid really did grow a cavity, and the hinge/latch parts are present.
    expect(lidCavityHeight(project.case)).toBe(20);
    expect(plan.nodes.some((n) => n.id === 'lid')).toBe(true);
    expect(plan.nodes.some((n) => n.id.startsWith('latch-arm-'))).toBe(true);
  });

  it('schema — legacy projects load unchanged, clamshell round-trips at v13', () => {
    // A v12 project (no `seal.mode`) must parse and compile as a recessed
    // project, and be stamped forward to the current version.
    const legacy = makeProject({ lidRecess: true });
    const legacyJson = JSON.parse(serializeProject(legacy)) as Record<string, unknown>;
    legacyJson.schemaVersion = 12;
    delete (legacyJson.case as { seal?: unknown }).seal;

    const migrated = parseProject(JSON.stringify(legacyJson));
    expect(migrated.schemaVersion).toBe(13);
    expect(migrated.case.seal?.mode).toBeUndefined();
    expect(lidIsRecessed(migrated.case)).toBe(true);
    expect(isClamshell(migrated.case)).toBe(false);

    // A clamshell project keeps its mode through a save/load cycle.
    const roundTripped = parseProject(serializeProject(makeProject(clamshellCase())));
    expect(roundTripped.schemaVersion).toBe(13);
    expect(roundTripped.case.seal?.mode).toBe('clamshell');
    expect(lidCavityHeight(roundTripped.case)).toBe(CLAMSHELL_MIN_CAVITY);
  });
});
