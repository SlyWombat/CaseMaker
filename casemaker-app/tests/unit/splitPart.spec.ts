// Issue #148 — splitting a part that is too big for the bed, and bolting it
// back together.
//
// Two things are being pinned here, and they are different things:
//
//   • `splitPart.ts` is archetype-blind and answers ONE question — where to cut
//     a solid so every piece fits the bed — plus the hole geometry for the
//     joint. Its specs are about the DECISION: the axis (or axes) that
//     overshoot, the seam landing mid-part unless a keep-out moves it, a
//     quadrant only when a half will not do, and refusing outright when the
//     part is taller than the bed (a seam is vertical; Z is not ours to cut).
//   • `shellSplit.ts` is the case archetype's half: the laps the screws go
//     through. Its specs are about the JOINT actually being there in the
//     solid — one body per piece, holes the shared table's sizes, both halves
//     coaxial, and no lap reaching across a seam into its neighbour. Those run
//     through the production evaluator (`helpers/manifoldExec`), so a piece
//     that would print as two loose parts fails here rather than on the plate.

import { describe, it, expect } from 'vitest';

import {
  SPLIT_SEAM_PITCH,
  MIN_PIECE_SPAN,
  jointHoleDiameters,
  planSeams,
  seamScrewCount,
  seamScrewSites,
  splitBySeams,
  type SplitSeam,
} from '@/engine/compiler/splitPart';
import {
  DEFAULT_SPLIT_SCREW,
  LUG_DROP,
  LUG_LAP,
  buildShellSplit,
  canSplitShell,
  pieceId,
  planShellJoint,
} from '@/engine/compiler/shellSplit';
import { clearanceDiameter, pilotDiameter } from '@/engine/compiler/fasteners';
import {
  cube,
  cylinder,
  difference,
  intersection,
  rotate,
  translate,
  type Aabb,
  type BuildOp,
} from '@/engine/compiler/buildPlan';
import { compileProject } from '@/engine/compiler/ProjectCompiler';
import { createDefaultProject } from '@/store/projectStore';
import { parseProject, serializeProject } from '@/store/persistence';
import type { BoardProfile, CaseParameters, Project } from '@/types';
import type { PrinterVolume } from '@/types/printer';
import { exec } from './helpers/manifoldExec';

/** A box with an open top: the simplest thing a shell split has to handle. */
function boxShell(w: number, d: number, h: number, wall = 3): BuildOp {
  const outer = cube([w, d, h]);
  const inner = translate([wall, wall, wall], cube([w - 2 * wall, d - 2 * wall, h]));
  return difference([outer, inner]);
}

const BOX_BOUNDS: Aabb = { min: [0, 0, 0], max: [120, 80, 30] };

/** Volume of `op` ∩ a 1 mm cube centred on `p` — 1 ⇒ material there, 0 ⇒ void.
 *  (Same probe clamshell.spec uses; a point inside a 3.2 mm hole clears it.) */
function probeMaterial(op: BuildOp, p: [number, number, number]): number {
  const box = translate(p, cube([1, 1, 1], true));
  const hit = exec(intersection([op, box]));
  const v = hit.volume();
  hit.delete();
  return v;
}

/** Positive-volume bodies in a solid. `decompose()` counts sealed voids as
 *  components too (negative volume), and they are not printed parts. */
function bodies(op: BuildOp): number {
  const m = exec(op);
  const n = m.decompose().filter((c) => c.volume() > 0).length;
  m.delete();
  return n;
}

function bboxOf(op: BuildOp): { min: number[]; max: number[] } {
  const m = exec(op);
  const b = m.boundingBox();
  m.delete();
  return { min: [...b.min], max: [...b.max] };
}

/** A probe cylinder of `dia` running `len` along +x from `from`. */
function shankAlongX(dia: number, from: [number, number, number], len: number): BuildOp {
  return translate(from, rotate([0, 90, 0], cylinder(len, dia / 2)));
}

// ---------------------------------------------------------------------------
// Where to cut
// ---------------------------------------------------------------------------

describe('planSeams — where to cut', () => {
  const bed = (x: number, y: number, z = 250): PrinterVolume => ({ x, y, z });

  it('does nothing when the part already fits', () => {
    expect(planSeams({ min: [0, 0, 0], max: [100, 80, 20] }, bed(220, 220))).toBeNull();
  });

  it('refuses a part taller than the bed rather than pretending Z can be cut', () => {
    // 300 tall on a 250 mm bed: no vertical seam helps, so the answer is null.
    expect(planSeams({ min: [0, 0, 0], max: [100, 80, 300] }, bed(220, 220, 250))).toBeNull();
  });

  it('cuts the axis that overshoots the more, and puts the seam mid-part', () => {
    const seams = planSeams({ min: [0, 0, 0], max: [300, 100, 20] }, bed(220, 220));
    expect(seams).toEqual([{ axis: 0, at: 150 }]);
    // The long axis the other way round cuts the other axis.
    expect(planSeams({ min: [0, 0, 0], max: [100, 300, 20] }, bed(220, 220))).toEqual([
      { axis: 1, at: 150 },
    ]);
  });

  it('goes to a quadrant only when a half will not do', () => {
    const seams = planSeams({ min: [0, 0, 0], max: [400, 400, 20] }, bed(220, 220));
    expect(seams).toEqual([
      { axis: 0, at: 200 },
      { axis: 1, at: 200 },
    ]);
  });

  it('moves the seam off a keep-out, keeping both pieces long enough to hold', () => {
    // A port straddling the midpoint. The seam backs off by the margin (2 mm)
    // to 138 — the nearer legal side.
    const port: Aabb = { min: [140, 20, 0], max: [160, 80, 30] };
    const seams = planSeams({ min: [0, 0, 0], max: [300, 100, 20] }, bed(220, 220), {
      keepOut: [port],
    });
    expect(seams).toEqual([{ axis: 0, at: 140 - 2 }]);
    const [s] = seams!;
    expect(s!.at).toBeGreaterThanOrEqual(MIN_PIECE_SPAN);
    expect(300 - s!.at).toBeGreaterThanOrEqual(MIN_PIECE_SPAN);
  });

  it('ignores a keep-out that cannot reach the seam', () => {
    // Same port, but on the far side of the part in the OTHER axis: a seam on
    // X at y = 90 never comes near material that only exists at y = 0..10.
    const away: Aabb = { min: [140, 0, 0], max: [160, 10, 30] };
    const seams = planSeams({ min: [0, 80, 0], max: [300, 180, 20] }, bed(220, 220), {
      keepOut: [away],
    });
    expect(seams).toEqual([{ axis: 0, at: 150 }]);
  });

  it('returns null when no seam placement is legal', () => {
    const wallToWall: Aabb = { min: [0, 0, 0], max: [300, 100, 30] };
    expect(
      planSeams({ min: [0, 0, 0], max: [300, 100, 20] }, bed(220, 220), { keepOut: [wallToWall] }),
    ).toBeNull();
  });
});

describe('splitBySeams — the cut itself', () => {
  const bounds: Aabb = { min: [0, 0, 0], max: [120, 80, 30] };

  it('gives one piece per grid cell, meeting at the seam', () => {
    const seams: SplitSeam[] = [{ axis: 0, at: 60 }];
    const pieces = splitBySeams(boxShell(120, 80, 30), bounds, seams);
    expect(pieces.map((p) => p.cell)).toEqual([
      [0, 0],
      [1, 0],
    ]);
    // The two pieces share the seam plane exactly — no overlap, no gap.
    expect(pieces[0]!.ranges.x[1]).toBe(60);
    expect(pieces[1]!.ranges.x[0]).toBe(60);
    // Z is untouched: a split never reaches past the part in the bed-normal.
    expect(pieces[0]!.ranges.y).toEqual([-1, 81]);
  });

  it('gives four pieces for a quadrant', () => {
    const seams: SplitSeam[] = [
      { axis: 0, at: 60 },
      { axis: 1, at: 40 },
    ];
    const pieces = splitBySeams(boxShell(120, 80, 30), bounds, seams);
    expect(pieces.map((p) => p.cell)).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
  });
});

describe('screw layout along a seam', () => {
  it('tracks the seam length, at the pitch the reviewed systems use', () => {
    // The source systems put 7 screws on a ≈250 mm seam; so does this.
    expect(seamScrewCount(250)).toBe(7);
    expect(seamScrewCount(250)).toBe(Math.ceil(250 / SPLIT_SEAM_PITCH));
    expect(seamScrewCount(40)).toBe(2);
    // Two is the floor: one screw lets the pieces rotate about it.
    expect(seamScrewCount(10)).toBe(2);
    expect(seamScrewCount(800)).toBe(20);
  });

  it('spaces the sites evenly, inside the seam, with the ends pulled in', () => {
    const sites = seamScrewSites(0, 250, 7);
    expect(sites).toHaveLength(7);
    expect(sites[0]).toBeCloseTo(20, 6); // half a pitch in from the end
    expect(sites[6]).toBeCloseTo(230, 6);
    const gaps = sites.slice(1).map((s, i) => s - sites[i]!);
    for (const g of gaps) expect(g).toBeCloseTo(gaps[0]!, 6);
    expect(Math.min(...sites)).toBeGreaterThan(0);
    expect(Math.max(...sites)).toBeLessThan(250);
  });

  it('pulls a short seam in by a quarter of its own length, not a whole pitch', () => {
    // 30 mm seam: half a pitch (20) would leave almost nothing, so the inset
    // is length/4 = 7.5.
    expect(seamScrewSites(0, 30, 2)).toEqual([7.5, 22.5]);
  });

  it('takes both hole sizes from the shared fastener table', () => {
    expect(jointHoleDiameters('M3')).toEqual({
      clearance: clearanceDiameter('M3'),
      pilot: pilotDiameter('M3'),
    });
    expect(jointHoleDiameters('M3').clearance).toBeCloseTo(3.2, 6);
  });
});

// ---------------------------------------------------------------------------
// The joint in the case shell
// ---------------------------------------------------------------------------

describe('shellSplit — the joint material', () => {
  const printer: PrinterVolume = { x: 60, y: 60, z: 100 };
  const split = buildShellSplit({
    shellOp: boxShell(120, 80, 30),
    bounds: BOX_BOUNDS,
    printer,
    keepOut: [],
  });

  it('cuts a quadrant for a part whose quarter is the most that fits', () => {
    expect(split).not.toBeNull();
    expect(split!.seams).toEqual([
      { axis: 0, at: 60 },
      { axis: 1, at: 40 },
    ]);
    expect(split!.nodes.map((n) => n.id)).toEqual([
      'shell-split-a1',
      'shell-split-a2',
      'shell-split-b1',
      'shell-split-b2',
    ]);
  });

  it('leaves the uncut shell alone — every piece is an ALTERNATIVE to it', () => {
    for (const n of split!.nodes) {
      expect(n.variant?.replaces).toEqual(['shell']);
      expect(n.variant?.label).toContain('4 pieces');
    }
  });

  it('counts each screw once, and names the screw it is designed around', () => {
    // A quadrant has FOUR seam segments — each axis's seam is cut in two by the
    // other — and every 40 mm segment takes seamScrewCount(40) = 2. So 8, and
    // each of those is counted ONCE even though it has a hole in two pieces:
    // the clearance and the pilot are the two halves of one screw.
    expect(split!.screwCount).toBe(8);
    expect(split!.screwLabel).toBe(`${DEFAULT_SPLIT_SCREW}×${LUG_LAP * 2} socket cap`);
    expect(split!.label).toContain('60×60 mm bed');
  });

  it('puts the lap on the underside, fused into the floor of each piece', () => {
    const a1 = split!.nodes[0]!.op;
    // Below the floor, beside the screw — there is lap material here.
    expect(probeMaterial(a1, [56, 14, -3.2])).toBeCloseTo(1, 3);
    // …and it is EMBEDDED in the floor, not sitting under it as a loose part.
    expect(probeMaterial(a1, [56, 14, 0.5])).toBeCloseTo(1, 3);
    const bb = bboxOf(a1);
    expect(bb.min[2]).toBeCloseTo(-LUG_DROP + 0.8, 3); // the lap's own underside
    // The archetype's one job: the print is ONE body.
    expect(bodies(a1)).toBe(1);
    expect(bodies(split!.nodes[2]!.op)).toBe(1);
  });

  it('never lets a lap reach across the seam into its neighbour', () => {
    const [a1, , b1] = split!.nodes.map((n) => n.op);
    // a1 is the low-x piece: at the seam's far side it has nothing at all.
    expect(probeMaterial(a1!, [62, 10, -3.2])).toBeCloseTo(0, 3);
    expect(probeMaterial(b1!, [58, 10, -3.2])).toBeCloseTo(0, 3);
    // And each piece stops exactly at its own cell: shell faces are untouched.
    expect(bboxOf(a1!).max[0]).toBeCloseTo(60, 3);
    expect(bboxOf(a1!).min[1]).toBeCloseTo(0, 3);
    expect(bboxOf(b1!).max[0]).toBeCloseTo(120, 3);
  });

  it('drills a screw through BOTH pieces on the same axis at the same site', () => {
    const a1 = split!.nodes[0]!.op; // low-x piece, carries the head
    const b1 = split!.nodes[2]!.op; // high-x piece, carries the starter hole
    const site = [10, -3.2] as const; // the seam's first screw site

    // The screw's clearance is 3.2; a slightly smaller shank passes through the
    // low piece without touching it, and bites the high piece's 2.8 pilot.
    const shank = shankAlongX(3.0, [52, site[0], site[1]], LUG_LAP * 2);
    const throughLow = exec(intersection([a1, shank]));
    const inHigh = exec(intersection([b1, shank]));
    expect(throughLow.volume()).toBeCloseTo(0, 3);
    expect(inHigh.volume()).toBeGreaterThan(2);
    throughLow.delete();
    inHigh.delete();

    // The head seat is cut from the lap's outer end face, not somewhere else.
    expect(probeMaterial(a1, [53.5, 10, -3.2])).toBeCloseTo(0, 3); // in the recess
    expect(probeMaterial(a1, [59, 10, -3.2])).toBeCloseTo(0, 3); // in the hole
  });

  it('leaves the cavity and the walls exactly as they were', () => {
    const a1 = split!.nodes[0]!.op;
    expect(probeMaterial(a1, [30, 20, 15])).toBeCloseTo(0, 3); // cavity
    expect(probeMaterial(a1, [1.5, 20, 15])).toBeCloseTo(1, 3); // wall
  });

  it('declines when the part already fits', () => {
    expect(
      buildShellSplit({
        shellOp: boxShell(120, 80, 30),
        bounds: BOX_BOUNDS,
        printer: { x: 220, y: 220, z: 250 },
        keepOut: [],
      }),
    ).toBeNull();
  });

  it('refuses a sealed shell rather than cutting through the gasket channel', () => {
    expect(canSplitShell(true)).toBe(false);
    expect(canSplitShell(false)).toBe(true);
  });

  it('names a piece after its grid cell', () => {
    expect(pieceId([0, 0])).toBe('shell-split-a1');
    expect(pieceId([1, 1])).toBe('shell-split-b2');
  });

  it('plans the joint the builder would make, without any geometry', () => {
    // The offer is built from this plan and the pieces from the builder, so the
    // two have to be the same decision — otherwise the app offers a split whose
    // screws are somewhere else, or offers one that builds nothing.
    const req = {
      shellOp: boxShell(120, 80, 30),
      bounds: BOX_BOUNDS,
      printer,
      keepOut: [],
    };
    const plan = planShellJoint(req);
    expect(plan).not.toBeNull();
    expect(plan!.seams).toEqual(split!.seams);
    expect(plan!.pieces).toHaveLength(split!.pieces.length);
    expect(plan!.screwCount).toBe(split!.screwCount);
    // One lug per screw per piece: both halves of a screw are a lug.
    expect(plan!.lugs).toHaveLength(split!.screwCount * 2);
    // …and a part that already fits is not a joint at all.
    expect(planShellJoint({ ...req, printer: { x: 220, y: 220, z: 250 } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Through the compiler — the path the app actually takes
// ---------------------------------------------------------------------------

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

/** The seal settings a sealed shell uses (#107/#108). */
function sealedSeal(): NonNullable<CaseParameters['seal']> {
  return {
    enabled: true,
    mode: 'clamshell',
    profile: 'flat',
    width: 2.5,
    depth: 2,
    compressionFactor: 0.25,
    gasketMaterial: 'tpu',
  };
}

/**
 * A project with a big board and a bed too small for it.
 *
 * Board 200 × 140 with 4 mm walls gives a 209 × 149 shell; on a 130 × 130 bed
 * that is a quarter and no more, so the answer is a quadrant with room to
 * spare. Everything that would grow or eat into the shell (ports, antennas,
 * assets) is emptied, so the arithmetic stays the test's rather than the
 * rpi-4b profile's.
 */
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

describe('the case archetype (#148, through compileProject)', () => {
  it('offers the pieces, and keeps the uncut shell on the list', () => {
    const plan = compileProject(bigProject({ splitForPrint: true }));
    const ids = plan.nodes.map((n) => n.id);
    expect(ids.filter((id) => id.startsWith('shell-split-'))).toEqual([
      'shell-split-a1',
      'shell-split-a2',
      'shell-split-b1',
      'shell-split-b2',
    ]);
    expect(ids).toContain('shell');
    for (const n of plan.nodes.filter((n) => n.id.startsWith('shell-split-'))) {
      expect(n.variant?.replaces).toEqual(['shell']);
    }
  });

  it('keeps the bed through a save/load cycle — the v14 field is not stripped', () => {
    // The bed moved from the rack archetype up to the project; a schema that
    // did not know the root-level field would strip it on load (the board-JSON
    // trap), leaving a saved project that cannot be fit-checked at all.
    const reloaded = parseProject(serializeProject(bigProject({ splitForPrint: true })));
    expect(reloaded.printer).toEqual({ x: 130, y: 130, z: 200 });
    expect(reloaded.case.splitForPrint).toBe(true);
    // …and the reloaded project still compiles to the same four pieces.
    expect(
      compileProject(reloaded).nodes.filter((n) => n.id.startsWith('shell-split-')),
    ).toHaveLength(4);
  });

  it('builds no split geometry unless the project asks for it', () => {
    const plan = compileProject(bigProject());
    expect(plan.nodes.some((n) => n.id.startsWith('shell-split-'))).toBe(false);
  });

  it('refuses a SEALED shell even when asked', () => {
    const plan = compileProject(bigProject({ splitForPrint: true, seal: sealedSeal() }));
    expect(plan.nodes.some((n) => n.id.startsWith('shell-split-'))).toBe(false);
  });
});

/**
 * The offer the export modal shows, decided by the compiler — every state a
 * user can be told, including the two that mean "there is nothing to offer".
 *
 * It is pinned here because the modal cannot see any of it: the mesh bounds say
 * only "over the bed", while whether a seam EXISTS depends on the case's own
 * board bosses, ports and latches. An offer guessed from the bounds is how a
 * checkbox gets ticked that builds nothing.
 */
describe('the split offer (#148, as the engine reports it)', () => {
  it('offers a split with its piece and screw counts, and builds nothing yet', () => {
    const plan = compileProject(bigProject());
    // Ten, not the synthetic box's eight: a quadrant's four seam segments are
    // 74.5, 74.5, 104.5 and 104.5 mm on this 209 × 149 shell, so two of them
    // take three screws instead of two. That is the seam-length rule doing its
    // job — the count is not a constant.
    expect(plan.splitOffer).toEqual({
      state: 'available',
      pieces: 4,
      screws: 10,
      screwLabel: 'M3×16 socket cap',
    });
    // Offering is arithmetic; the geometry still waits to be asked for.
    expect(plan.nodes.some((n) => n.id.startsWith('shell-split-'))).toBe(false);
  });

  it('says nothing when the shell fits the bed', () => {
    const p: Project = { ...bigProject(), printer: { x: 400, y: 400, z: 400 } };
    expect(compileProject(p).splitOffer).toBeUndefined();
  });

  it('says nothing when the project has no bed to check against', () => {
    const base = createDefaultProject();
    expect(compileProject({ ...base, printer: undefined }).splitOffer).toBeUndefined();
  });

  it('reports a part over the bed HEIGHT as too tall — a seam cannot help it', () => {
    const overWidth: Project = { ...bigProject(), printer: { x: 130, y: 130, z: 12 } };
    expect(compileProject(overWidth).splitOffer?.state).toBe('tooTall');
    // …and it says so even when the FOOTPRINT fits: a body that will not print
    // is worth hearing about either way, and no seam would have helped it.
    const tooTallOnly: Project = { ...bigProject(), printer: { x: 400, y: 400, z: 12 } };
    expect(compileProject(tooTallOnly).splitOffer?.state).toBe('tooTall');
  });

  it('reports a SEALED shell as sealed rather than cutting the gasket channel', () => {
    const p = bigProject({ seal: sealedSeal() });
    expect(compileProject(p).splitOffer?.state).toBe('sealed');
  });

  it('reports blocked when the case’s own features leave no seam to cut', () => {
    // The rpi-4b default: 93 × 64 mm shell, and board bosses across the middle
    // so the 64 mm depth cannot be cut on a 60 mm bed. Over the bed, and still
    // nothing honest to offer.
    const plan = compileProject({
      ...createDefaultProject(),
      printer: { x: 60, y: 60, z: 200 },
    });
    expect(plan.splitOffer?.state).toBe('blocked');
  });
});
