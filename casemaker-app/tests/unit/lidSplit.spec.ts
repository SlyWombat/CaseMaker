// Issue #265 — the LID's split joint: where its laps go, from the lid's own
// mode.
//
// The lid has no floor to hang a lug under. Its underside faces the board
// (and, recessed, its sides sit in the shell's pocket), so the free side is a
// property of the LID:
//   • a cavity lid at least LUG_DROP deep keeps its laps INSIDE the cavity,
//     hanging from the ceiling, invisible from outside;
//   • a plate lid (or a cavity too shallow) carries them as pads proud of its
//     TOP face — the one side open air reaches along the whole seam.
// The geometry runs through the production evaluator, so a piece that would
// print as two loose parts fails here rather than on the plate.

import { describe, it, expect } from 'vitest';
import { bodies, makeBoard, probeMaterial } from './helpers/printModel';

import { LUG_DROP, LUG_EMBED, LUG_LAP } from '@/engine/compiler/shellSplit';
import {
  buildLidSplit,
  canSplitLid,
  lidJointSide,
  planLidJoint,
  type LidSplitRequest,
} from '@/engine/compiler/lidSplit';
import { cube, difference, translate, type Aabb, type BuildOp } from '@/engine/compiler/buildPlan';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import type { CaseParameters, Project } from '@/types';
import type { PrinterVolume } from '@/types/printer';
import { exec } from './helpers/manifoldExec';

const BED: PrinterVolume = { x: 160, y: 160, z: 200 };

/** A flat plate lid: `w × d × t`, no cavity. */
function plateLid(w: number, d: number, t = 4): BuildOp {
  return cube([w, d, t]);
}

/** A cavity lid: walls `wall`, a `t`-thick ceiling, a `cavity`-tall interior. */
function cavityLid(w: number, d: number, cavity = 12, t = 4, wall = 3): BuildOp {
  const outer = cube([w, d, t + cavity]);
  const inner = translate([wall, wall, -0.1], cube([w - 2 * wall, d - 2 * wall, cavity + 0.1]));
  return difference([outer, inner]);
}

function boundsOf(op: BuildOp): Aabb {
  const m = exec(op);
  const b = m.boundingBox();
  m.delete();
  return { min: [...b.min], max: [...b.max] } as Aabb;
}

function request(side: 'cavity' | 'top', lidOp: BuildOp, cavityHeightMm: number): LidSplitRequest {
  return {
    lidOp,
    bounds: boundsOf(lidOp),
    printer: BED,
    side,
    cavityHeightMm,
  };
}

describe('#265 — the lid’s side, from the lid’s own mode', () => {
  const base = createDefaultProject().case;
  it('a cavity at least LUG_DROP deep takes its laps inside the cavity', () => {
    expect(lidJointSide({ ...base, lidCavityHeight: LUG_DROP } as CaseParameters)).toBe('cavity');
    expect(lidJointSide({ ...base, lidCavityHeight: LUG_DROP + 6 } as CaseParameters)).toBe('cavity');
  });

  it('a shallow cavity, and every plate lid, takes them on the top face', () => {
    expect(lidJointSide({ ...base, lidCavityHeight: LUG_DROP - 1 } as CaseParameters)).toBe('top');
    expect(lidJointSide({ ...base, lidCavityHeight: 0 } as CaseParameters)).toBe('top');
    expect(lidJointSide({ ...base, lidCavityHeight: undefined } as CaseParameters)).toBe('top');
  });

  it('refuses a sealed lid, as the shell is refused', () => {
    expect(canSplitLid(true)).toBe(false);
    expect(canSplitLid(false)).toBe(true);
  });
});

describe('#265 — the cavity lid’s laps hang inside its own cavity', () => {
  const lid = cavityLid(300, 100);
  const req = request('cavity', lid, 12);
  const plan = planLidJoint(req)!;

  it('cuts the lid and splits it into pieces that fit the bed', () => {
    expect(plan).not.toBeNull();
    const split = buildLidSplit(req, plan)!;
    expect(split.nodes).toHaveLength(2);
    expect(split.nodes.map((n) => n.id)).toEqual(['lid-split-a1', 'lid-split-b1']);
    for (const n of split.nodes) {
      const b = boundsOf(n.op);
      expect(b.max[0]! - b.min[0]!).toBeLessThanOrEqual(BED.x + 1e-6);
    }
  });

  it('each piece is ONE printed body, not a lid plus a loose lug', () => {
    const split = buildLidSplit(req, plan)!;
    for (const n of split.nodes) expect(bodies(n.op)).toBe(1);
  });

  it('the lap hangs from the ceiling, inside the cavity, and never above the lid', () => {
    const split = buildLidSplit(req, plan)!;
    const first = split.nodes[0]!;
    const b = boundsOf(first.op);
    const seam = plan.seams[0]!.at;
    const lug = plan.lugs.find((l) => l.piece === 0)!;
    // 4 mm off the screw's axis, so the probe is in lap material, not the hole.
    const at: [number, number, number] = [
      lug.axis === 0 ? seam - LUG_LAP / 2 : lug.at + 4,
      lug.axis === 0 ? lug.at + 4 : seam - LUG_LAP / 2,
      12 + LUG_EMBED - LUG_DROP / 2,
    ];
    // Material at the lap, inside the cavity...
    expect(probeMaterial(first.op, at)).toBeGreaterThan(0.5);
    // ...void at the same XY down by the open underside...
    expect(probeMaterial(first.op, [at[0], at[1], 1])).toBeLessThan(0.01);
    // ...and nothing above the lid's own top face.
    expect(probeMaterial(first.op, [at[0], at[1], b.max[2] + 1])).toBeLessThan(0.01);
  });

  it('both halves carry a hole at every screw site', () => {
    const split = buildLidSplit(req, plan)!;
    // Cavity band: zLo = ceiling − LUG_DROP + embed, zHi = ceiling + embed.
    const zAxis = 12 + LUG_EMBED - LUG_DROP / 2;
    const seamAt = plan.seams[0]!.at;
    for (const lug of plan.lugs) {
      const node = split.nodes[lug.piece]!;
      const mid = lug.mouth + lug.reach / 2;
      const at: [number, number, number] =
        lug.axis === 0 ? [mid, lug.at, zAxis] : [lug.at, mid, zAxis];
      expect(probeMaterial(node.op, at), `hole at ${lug.screwKey} piece ${lug.piece}`).toBeLessThan(0.05);
    }
    expect(seamAt).toBeGreaterThan(0);
  });
});

describe('#265 — a plate lid’s laps stand proud of its top face', () => {
  const lid = plateLid(300, 100, 4);
  const req = request('top', lid, 0);
  const plan = planLidJoint(req)!;

  it('builds a lap above the top face and none below it', () => {
    const split = buildLidSplit(req, plan)!;
    const first = split.nodes[0]!;
    const lug = plan.lugs.find((l) => l.piece === 0)!;
    const at: [number, number, number] = [
      lug.axis === 0 ? plan.seams[0]!.at - LUG_LAP / 2 : lug.at + 4,
      lug.axis === 0 ? lug.at + 4 : plan.seams[0]!.at - LUG_LAP / 2,
      4 + LUG_DROP / 2,
    ];
    expect(probeMaterial(first.op, at)).toBeGreaterThan(0.5);
    // Nothing hangs below the plate.
    expect(probeMaterial(first.op, [at[0], at[1], -1])).toBeLessThan(0.01);
    // The piece's top is the pad: lid top + LUG_DROP − the embed.
    const b = boundsOf(first.op);
    expect(b.max[2]).toBeCloseTo(4 - LUG_EMBED + LUG_DROP, 3);
  });

  it('a plate lid that already fits is offered nothing', () => {
    const small = plateLid(100, 80, 4);
    expect(planLidJoint(request('top', small, 0))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The compiler's half: the offer and the pieces on a real project.
// ---------------------------------------------------------------------------

/** The #148 big-case fixture: a 209 × 149 shell (and lid) on a 130 × 130 bed. */
function bigProject(overrides: Partial<CaseParameters> = {}): Project {
  const base = createDefaultProject();
  return {
    ...base,
    board: makeBoard(200, 140),
    printer: { x: 130, y: 130, z: 200 },
    ports: [],
    antennas: [],
    externalAssets: [],
    mountingFeatures: [],
    hats: [],
    fanMounts: [],
    textLabels: [],
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
      ...overrides,
    },
  };
}

describe('#265 — the lid offer, through compileProject', () => {
  it('offers the lid split when the lid alone is over the bed', () => {
    const plan = compileProject(bigProject());
    expect(plan.lidSplitOffer).toMatchObject({ state: 'available', pieces: 4 });
    // Nothing is BUILT by the offer alone.
    expect(plan.nodes.some((n) => n.id.startsWith('lid-split-'))).toBe(false);
  });

  it('builds the pieces when the project asks, as alternatives to the lid', () => {
    const plan = compileProject(bigProject({ splitForPrint: true }));
    const ids = plan.nodes.map((n) => n.id);
    expect(ids).toContain('lid');
    const pieces = plan.nodes.filter((n) => n.id.startsWith('lid-split-'));
    expect(pieces.length).toBeGreaterThan(1);
    for (const n of pieces) expect(n.variant?.replaces).toEqual(['lid']);
    // The body's split is unaffected by the lid's.
    expect(ids).toContain('shell-split-a1');
  });

  it('refuses a SEALED lid even when asked', () => {
    const plan = compileProject(
      bigProject({
        splitForPrint: true,
        seal: {
          enabled: true,
          mode: 'clamshell',
          profile: 'flat',
          width: 2.5,
          depth: 2,
          compressionFactor: 0.25,
          gasketMaterial: 'tpu',
        },
      }),
    );
    expect(plan.lidSplitOffer).toMatchObject({ state: 'sealed' });
    expect(plan.nodes.some((n) => n.id.startsWith('lid-split-'))).toBe(false);
  });

  it('says nothing when the lid fits the bed', () => {
    const fits = compileProject({
      ...bigProject(),
      board: makeBoard(100, 90),
      printer: { x: 220, y: 220, z: 200 },
    });
    expect(fits.lidSplitOffer).toBeUndefined();
  });
});
