/**
 * #948 / the maintainer's review §8.6 — THE GOAL CHECK'S RULE IS FROZEN FOR MILESTONE 2.
 *
 * C9 of docs/reviews/2026-11-05-engine-rebuild-review.md: the gate rule changed five times on
 * `main` in 30 hours with no `SIMULATOR_VERSION` bump (strict footprint edge, wall/shadow on every
 * goal job, border ∪ wall seed, the exact stamp, the raw read beside the judged one). Each change
 * re-scored every card, and a changing ruler cannot judge a changing engine. The rule now freezes
 * for the rest of M2.
 *
 * This spec is the freeze. It pins, at `SIMULATOR_VERSION`:
 *   - the exported constants (cut-into floor, leftover bands, pass-coverage fallback);
 *   - the two unexported thresholds, BEHAVIOURALLY: the design-edge step is strict (`> 0.2`, so a
 *     0.2 mm step is NOT an edge), the edge-break leg is inclusive (`depth ≤ leg`), the raw floor
 *     is strict (`> 0.01`), the adjudicated floor is strict (`> 0.1`) and the leftover bands are
 *     strict (`> band`);
 *   - the EXCLUSION SET and its precedence on one canonical fixture where every class has exactly
 *     one or two cells — edge break (a V bit within reach of a design edge, including the part's
 *     silhouette), wall, border, wall shadow — with the edge-break allowance the only member that
 *     depends on the job stating one;
 *   - the RAW reading beside the JUDGED one (raw 8 cut cells, deepest 0.8 mm; adjudicated 1 cell,
 *     deepest 0.4 mm) so "raw printed beside judged" cannot quietly become "raw replaced judged";
 *   - the exact stamp's precedence (#945): `leftoverTop` is the verdict and `sweptTop` is the
 *     column diagnostic beside it;
 *   - the pass line: coverage at the first leftover band versus `passCoverage`, including the
 *     boundary case (19/20 = 0.95 passes; 18/20 = 0.90 does not).
 *
 * v5 (#970, the maintainer's 2026-11-05 ruling): THE WALL SHADOW IS NO LONGER A BLANKET EXCLUSION.
 * On the tray E found the V driven 3.49 mm into solid land beside a wall (a posted feed at
 * (19.800, 12.050, -4.692)); all 116,868 shadow cells were excused and the gate read 0.00 %. A
 * shadow cell is now excused only when the V cut it within its leg, or the deepest stamp's CL
 * stayed at least the shadow radius from the wall (a disc-stamp artefact). Everything else is
 * adjudicated. The canonical fixture's C cell (0.3 mm, 2 mm behind the wall, no CL stated) is
 * therefore ADJUDICATED at v5, and the E-class case below is the red-first pin of the rule.
 *
 * IF THIS SPEC FAILS, THE GOAL CHECK'S RULE CHANGED. That is allowed, but it is a decision:
 * bump `SIMULATOR_VERSION` in the same commit, update the fingerprint below, and re-score the
 * cards that carry this rule's numbers (tray 70 top, organizer top, and the figure cards) — never
 * mix two rule versions on one card.
 */
import { describe, expect, it } from 'vitest';

import {
  GOAL_CUT_INTO_FLOOR_MM,
  GOAL_LEFTOVER_BANDS_MM,
  GOAL_PASS_COVERAGE_FALLBACK,
  STRADDLING_SLACK_MM,
  checkGoalCutInto,
} from '@/engine/cnc/engrave/designCheck';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { goalEdgeBreakOptions } from '@/engine/cnc/engrave/edgeBreak';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { Timeline } from '@/engine/cnc/emulator/timeline';
import type { EngraveJob } from '@/types/engraveJob';
import { exactSweptFieldTooled, stampProfile } from '@/workers/sim/sweptPoint';
import { SIMULATOR_VERSION } from '@/workers/geometry/simVersion';

const FREEZE =
  'the goal check’s rule moved — bump SIMULATOR_VERSION in the same commit, update this fingerprint and re-score the cards (§8.6)';

/** A grid whose z is `base` everywhere except the listed overrides. */
function field(
  nx: number,
  ny: number,
  opts: { z?: (i: number, j: number) => number; covered?: (i: number, j: number) => boolean; pitch?: number } = {},
): GoalHeightfield {
  const pitch = opts.pitch ?? 1;
  const covered = new Uint8Array(nx * ny);
  const z = new Float32Array(nx * ny);
  let coveredCount = 0;
  let minZ = Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const c = opts.covered === undefined ? true : opts.covered(i, j);
      if (!c) continue;
      covered[k] = 1;
      coveredCount++;
      const value = opts.z === undefined ? 0 : opts.z(i, j);
      z[k] = value;
      minZ = Math.min(minZ, value);
    }
  }
  if (coveredCount === 0) throw new Error('fixture covers nothing');
  return {
    nx,
    ny,
    x0: 0,
    y0: 0,
    pitch,
    topZ: 0,
    minZ,
    z,
    covered,
    coveredCount,
    resolutionNote: 'goalRuleFreeze948 fixture',
  };
}

/** A top reader that answers `goal + raise(x, y) - cut(x, y)` at each cell centre. */
function reader(
  goal: GoalHeightfield,
  cut: Map<number, number>,
  raise: Map<number, number> = new Map(),
): (x: number, y: number) => number | null {
  return (x, y) => {
    const i = Math.round((x - goal.x0) / goal.pitch);
    const j = Math.round((y - goal.y0) / goal.pitch);
    if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny) return null;
    const k = j * goal.nx + i;
    if (goal.covered[k] !== 1) return null;
    return (goal.z[k] as number) + (raise.get(k) ?? 0) - (cut.get(k) ?? 0);
  };
}

const at = (goal: GoalHeightfield, i: number, j: number): number => j * goal.nx + i;

/**
 * THE CANONICAL FINGERPRINT FIELD — 24 × 24 at 1 mm (covered 572: a 2 × 2 hole at 10..11, 10..11).
 *
 *   - a 1 mm design step at i = 18 (wall cells i = 17 and 18);
 *   - the hole's silhouette (8 covered neighbours of the uncovered hole);
 *   - the grid border (92 covered cells on the outermost row/column);
 *   - cuts at cells chosen so every exclusion class holds exactly one or two cells.
 */
const N = 24;
const CANON = field(N, N, {
  z: (i) => (i >= 18 ? -1 : 0),
  covered: (i, j) => !(i >= 10 && i <= 11 && j >= 10 && j <= 11),
});

const CUTS = new Map<number, number>([
  [at(CANON, 17, 5), 0.8], // A — a wall cell, deeper than the 0.5 mm leg: WALL
  [at(CANON, 0, 5), 0.6], // B — a border cell, deeper than the leg: BORDER (counted as wall)
  [at(CANON, 15, 5), 0.3], // C — 2 mm behind the wall, outside the 1.5 mm band: WALL SHADOW
  [at(CANON, 9, 10), 0.3], // D — a silhouette cell, within the leg: EDGE BREAK
  [at(CANON, 16, 5), 0.4], // E — in the wall's band, no wall cell, within the leg: EDGE BREAK
  [at(CANON, 5, 5), 0.4], // F — clear of every seed: ADJUDICATED
  [at(CANON, 6, 5), 0.09], // G — above the raw floor, below the adjudicated floor: RAW ONLY
  [at(CANON, 7, 5), 0.01], // H — exactly the raw floor: not a cut at all
  [at(CANON, 8, 5), 0.1], // I — exactly the adjudicated floor: raw only
]);
const RAISES = new Map<number, number>([
  [at(CANON, 4, 4), 0.1], // exactly the first band: within it
  [at(CANON, 4, 5), 0.11],
  [at(CANON, 4, 6), 0.3], // exactly the second band: band 1 only
  [at(CANON, 4, 7), 0.35],
  [at(CANON, 4, 8), 1.05],
]);
const CANON_TOP = reader(CANON, CUTS, RAISES);
const COVERED = 572;

/** The rule's own fingerprint: constants, thresholds and the canonical report's rule numbers. */
const FROZEN = {
  // #1064 (v7) — the edge-break band seeds only from the edges the job names; the canonical
  // numbers below are the explicit `edges: 'all'` reading, and the default silhouette case is
  // pinned beside them.
  // v8 (#1092) — excuses are proofs bounded by the goal's own relief: B (the border cell, 0.6 mm)
  // is counted instead of excused, so the adjudicated maximum is 0.6 mm at the border, not 0.4 at
  // F. The over-relief counters pin the class that was counted instead.
  version: 8,
  constants: {
    cutIntoFloorMm: 0.01,
    leftoverBandsMm: [0.1, 0.3, 1],
    passCoverageFallback: 0.95,
    // #996 (v6) — the straddling-cell excuse's slack, mm: the swept floor may sit this far below
    // the design's low side over the cell and still count as at it.
    straddlingSlackMm: 0.005,
  },
  // The unexported thresholds as the rule states them today: a design edge is a step STRICTLY
  // deeper than 0.2 mm; the adjudicated floor is STRICTLY deeper than 0.1 mm; the edge-break leg
  // is INCLUSIVE. Stated here for the reader; the behavioural cases BELOW are what enforce them.
  thresholds: { designEdgeStepMm: 0.2, adjudicatedFloorMm: 0.1, edgeBreakLegInclusive: true },
  // #996 (v6) — the straddling excuse's two conditions, as the rule states them: the step over
  // the cell is AT LEAST the read intrusion, and the swept floor is at the low side (within the
  // slack above). The canonical fixture's adjudicated cells sit on flat ground, so none qualifies.
  straddlingRule: { stepAtLeastIntrusion: true, floorAtLowSide: true },
  canonical: {
    goalCells: COVERED,
    raw: { cells: 8, fraction: 8 / COVERED, maxMm: 0.8, at: { x: 17, y: 5 } },
    edgeBreak: { cells: 2, fraction: 2 / COVERED },
    wall: { cells: 1, fraction: 1 / COVERED },
    // v5 — C (0.3 mm, 2 mm behind the wall) states no CL here, so it is adjudicated with F.
    shadow: { cells: 0, fraction: 0 },
    straddling: { cells: 0, maxStepMm: 0 },
    adjudicated: { cells: 3, fraction: 3 / COVERED, maxMm: 0.6, at: { x: 0, y: 5 } },
    overRelief: { wall: 0, border: 1, shadow: 0 },
    leftover: { fractions: [4 / COVERED, 2 / COVERED, 1 / COVERED], maxMm: 1.05 },
    coverageFraction: 559 / COVERED,
    ok: false,
  },
} as const;

describe('#948 the goal check’s rule is frozen at SIMULATOR_VERSION', () => {

  it('is stamped with the frozen version', () => {
    expect(SIMULATOR_VERSION, FREEZE).toBe(FROZEN.version);
  });

  it('states its constants, thresholds and exclusion set', () => {
    expect(GOAL_CUT_INTO_FLOOR_MM, FREEZE).toBe(FROZEN.constants.cutIntoFloorMm);
    expect([...GOAL_LEFTOVER_BANDS_MM], FREEZE).toEqual(FROZEN.constants.leftoverBandsMm);
    expect(GOAL_PASS_COVERAGE_FALLBACK, FREEZE).toBe(FROZEN.constants.passCoverageFallback);

    const r = checkGoalCutInto(CANON, CANON_TOP, {
      // #1064 — the canonical fixture is the all-edges reading: an interior wall (E) and the
      // hole's silhouette (D) are both edge-break sites only when the job names every edge.
      edgeBreak: { reachMm: 1.5, legMm: 0.5, edges: 'all' },
      wallShadowRadiusMm: 2,
    });
    // The raw reading beside the judged one.
    expect(r.goalCells, FREEZE).toBe(FROZEN.canonical.goalCells);
    expect(r.cutIntoFraction, FREEZE).toBe(FROZEN.canonical.raw.fraction);
    expect(r.maxCutIntoMm, FREEZE).toBeCloseTo(FROZEN.canonical.raw.maxMm, 12);
    expect(r.maxCutIntoAt, FREEZE).toEqual(FROZEN.canonical.raw.at);
    // Every exclusion class, by precedence: edge break, then wall ∪ border, then wall shadow.
    expect(r.edgeBreakFraction, FREEZE).toBe(FROZEN.canonical.edgeBreak.fraction);
    expect(r.wallNotScoredFraction, FREEZE).toBe(FROZEN.canonical.wall.fraction);
    expect(r.shadowNotScoredFraction, FREEZE).toBe(FROZEN.canonical.shadow.fraction);
    // v6 — the straddling excuse: none on the canonical fixture (its adjudicated cells are flat
    // ground, step 0, and a step of 0 can never reach the intrusion), but the fields are part of
    // the rule's fingerprint and must exist, at zero, beside wall/shadow.
    expect(STRADDLING_SLACK_MM, FREEZE).toBe(FROZEN.constants.straddlingSlackMm);
    expect(r.straddlingNotScoredCells, FREEZE).toBe(FROZEN.canonical.straddling.cells);
    expect(r.straddlingMaxStepMm, FREEZE).toBe(FROZEN.canonical.straddling.maxStepMm);
    // The judged reading.
    expect(r.adjudicatedFraction, FREEZE).toBe(FROZEN.canonical.adjudicated.fraction);
    expect(r.adjudicatedMaxMm, FREEZE).toBeCloseTo(FROZEN.canonical.adjudicated.maxMm, 12);
    expect(r.adjudicatedMaxAt, FREEZE).toEqual(FROZEN.canonical.adjudicated.at);
    // The leftover bands and the coverage the pass line reads.
    expect(r.leftoverFractions, FREEZE).toEqual([...FROZEN.canonical.leftover.fractions]);
    expect(r.maxLeftoverMm, FREEZE).toBeCloseTo(FROZEN.canonical.leftover.maxMm, 12);
    expect(r.coverageFraction, FREEZE).toBe(FROZEN.canonical.coverageFraction);
    expect(r.passCoverage, FREEZE).toBe(FROZEN.constants.passCoverageFallback);
    expect(r.ok, FREEZE).toBe(FROZEN.canonical.ok);
    // Volume, so a change to the cell area or the depth fold is caught too.
    expect(r.cutIntoVolumeMm3, FREEZE).toBeCloseTo(2.99, 9);
  });

  // #1064 (v7) — THE DEFAULT BAND NAMES THE PART'S SILHOUETTE ONLY. On the canonical fixture the
  // hole's silhouette is a WALL cell (not the grid border) and E sits at an interior wall, so
  // with the default edge scope the allowance excuses nothing here: both are judged or wall, and
  // only a job that states `edges: 'all'` reads the canonical 2-cell edge break above.
  it('the default edge scope excuses nothing at the interior wall — D is wall, E is judged', () => {
    const r = checkGoalCutInto(CANON, CANON_TOP, {
      edgeBreak: { reachMm: 1.5, legMm: 0.5 },
      wallShadowRadiusMm: 2,
    });
    expect(r.edgeBreakFraction, FREEZE).toBe(0);
    expect(r.wallNotScoredFraction, FREEZE).toBe(1 / COVERED);
    expect(r.adjudicatedFraction, FREEZE).toBe(5 / COVERED);
    expect(r.adjudicatedMaxMm, FREEZE).toBeCloseTo(0.6, 12);
    expect(r.adjudicatedMaxAt, FREEZE).toEqual({ x: 0, y: 5 });
  });

  it('excludes wall cells and the wall shadow in a job that states NO edge break', () => {
    const r = checkGoalCutInto(CANON, CANON_TOP, { wallShadowRadiusMm: 2 });
    expect(r.edgeBreakFraction, FREEZE).toBe(0);
    // D (a silhouette wall cell) joins A and B as a wall; E (0.4 mm, inside the shadow, no CL)
    // and C (0.3 mm, behind the wall) are ADJUDICATED at v5 — the shadow excuses nothing without
    // a CL or the V's leg — and F stays adjudicated.
    expect(r.wallNotScoredFraction, FREEZE).toBe(1 / COVERED);
    expect(r.shadowNotScoredFraction, FREEZE).toBe(0);
    expect(r.adjudicatedFraction, FREEZE).toBe(5 / COVERED);
  });

  it('treats a step of 0.199 mm as NO design edge and 0.201 as one (strict > 0.2)', () => {
    // The heightfield stores top-Z as float32, so the exact decimal 0.2 is not representable
    // (float32(0.2) is 0.200000003 — an edge under the strict rule). The threshold is stated
    // either side with representable neighbours.
    const grid = (step: number) => field(5, 3, { z: (i) => (i >= 2 ? -step : 0) });
    const cut = (goal: GoalHeightfield) => reader(goal, new Map([[at(goal, 1, 1), 0.5]]));
    const under = grid(0.199);
    const rUnder = checkGoalCutInto(under, cut(under));
    expect(rUnder.wallNotScoredFraction, FREEZE).toBe(0);
    expect(rUnder.adjudicatedFraction, FREEZE).toBe(1 / 15);
    const over = grid(0.201);
    const rOver = checkGoalCutInto(over, cut(over));
    // v8 — the wall cell is no longer excused by class: the 0.5 mm read is deeper than the 0.201 mm
    // step it straddles, so it is COUNTED (the straddling proof cannot reach it).
    expect(rOver.wallNotScoredFraction, FREEZE).toBe(0);
    expect(rOver.adjudicatedFraction, FREEZE).toBe(1 / 15);
  });

  it('allows edge break at exactly the V bit’s leg, and not a micron deeper', () => {
    const goal = field(5, 3, { z: (i) => (i >= 2 ? -0.21 : 0) });
    const cut = (depth: number) => reader(goal, new Map([[at(goal, 1, 1), depth]]));
    const allowance = { edgeBreak: { reachMm: 1, legMm: 0.5 } };
    const exact = checkGoalCutInto(goal, cut(0.5), allowance);
    expect(exact.edgeBreakFraction, FREEZE).toBe(1 / 15);
    expect(exact.wallNotScoredFraction, FREEZE).toBe(0);
    const deeper = checkGoalCutInto(goal, cut(0.500001), allowance);
    expect(deeper.edgeBreakFraction, FREEZE).toBe(0);
    // v8 — no longer excused as a wall cell: it is counted.
    expect(deeper.wallNotScoredFraction, FREEZE).toBe(0);
    expect(deeper.adjudicatedFraction, FREEZE).toBe(1 / 15);
  });

  it('reads the pass line at the first leftover band, inclusive at exactly 0.95', () => {
    const grid = field(20, 1);
    const one = reader(grid, new Map(), new Map([[at(grid, 0, 0), 0.11]]));
    const two = reader(grid, new Map(), new Map([[at(grid, 0, 0), 0.11], [at(grid, 1, 0), 0.11]]));
    const pass = checkGoalCutInto(grid, one);
    expect(pass.passCoverage, FREEZE).toBe(0.95);
    expect(pass.ok, FREEZE).toBe(true);
    const fail = checkGoalCutInto(grid, two);
    expect(fail.ok, FREEZE).toBe(false);
    expect(fail.sentence).toContain('coverage');
  });

  it('judges on the exact stamp when both reads are given — the column read stays beside it (#945)', () => {
    const grid = field(5, 5);
    const struck = reader(grid, new Map([[at(grid, 2, 2), 0.4]]));
    const cleanup = reader(grid, new Map());
    const r = checkGoalCutInto(grid, struck, { leftoverTop: cleanup });
    // The page's own point read is the verdict: this stamp cut nothing.
    expect(r.ran, FREEZE).toBe(true);
    expect(r.cutIntoFraction, FREEZE).toBe(0);
    expect(r.adjudicatedFraction, FREEZE).toBe(0);
    expect(r.ok, FREEZE).toBe(true);
    // The conservative column read is carried beside the verdict and SEES the cut.
    expect(r.columnCutInto, FREEZE).toBeDefined();
    expect(r.columnCutInto!.fraction, FREEZE).toBe(1 / 25);
    expect(r.columnCutInto!.maxMm, FREEZE).toBeCloseTo(0.4, 12);
    expect(r.columnCutInto!.at, FREEZE).toEqual({ x: 2, y: 2 });
  });

  it('keeps the V stamp’s stated tip — the 0.1 mm flat, not a sharp cone (#964/fcad250d)', () => {
    const chamfer: Tool = flatEndMill(3.175, {
      number: 4,
      name: '90° chamfer',
      shape: 'chamfer',
      typeText: 'Chamfer',
      angle: 90,
      halfAngle: 45,
      tipDiameter: 0.1,
      diameter: 3.175,
    });
    const profile = stampProfile(chamfer);
    expect(profile.radius, FREEZE).toBeCloseTo(1.5875, 12);
    // At or inside the stated tip radius the stamp is the flat: zero rise. The old forced-0 tip
    // read 0.04 and 0.05 at these radii — the defect that flipped the tray's per-cell who.
    expect(profile.profile(0.04), FREEZE).toBe(0);
    expect(profile.profile(0.05), FREEZE).toBe(0);
    // 45° per side: 0.05 mm beyond the tip radius rises 0.05 mm.
    expect(profile.profile(0.25), FREEZE).toBeCloseTo(0.2, 12);
  });

  it('records the per-cell who map: lowest reach wins, ties to the later stamp', () => {
    // A hand-built timeline (the stamp reads only checkpoints/tool/xy/zs): T2 flat, then T7 ball
    // 0.2 mm deeper at the centre, then T9 flat at T2's depth.
    const grid = { nx: 21, ny: 21, x0: 0, y0: 0, pitch: 1 };
    const flat2: Tool = flatEndMill(6, { number: 2, name: 'flat 6 (T2)' });
    const ball7: Tool = flatEndMill(6, {
      number: 7,
      name: 'ball 6 (T7)',
      shape: 'ball',
      typeText: 'Ball End',
      tipDiameter: 6,
      diameter: 6,
    });
    const flat9: Tool = flatEndMill(6, { number: 9, name: 'flat 6 (T9)' });
    const byNumber = new Map<number, Tool>([[2, flat2], [7, ball7], [9, flat9]]);
    const timeline = {
      checkpoints: [
        { tool: 2, xy: [2, 10, 18, 10], zs: [-0.5, -0.5], steps: [0] },
        { tool: 7, xy: [10, 10, 10, 10], zs: [-0.7, -0.7], steps: [0] },
        { tool: 9, xy: [12, 4, 12, 16], zs: [-0.5, -0.5], steps: [0] },
      ],
    } as unknown as Timeline;
    const stamped = exactSweptFieldTooled(grid, timeline, (state) => byNumber.get(state as number) ?? null);
    expect(stamped, FREEZE).not.toBeNull();
    const field = (i: number, j: number): number => stamped!.field[j * 21 + i]!;
    const who = (i: number, j: number): number => stamped!.who[j * 21 + i]!;
    expect(field(5, 10), FREEZE).toBeCloseTo(-0.5, 6);
    expect(who(5, 10), FREEZE).toBe(2); // the only cutter there
    expect(field(10, 10), FREEZE).toBeCloseTo(-0.7, 6);
    expect(who(10, 10), FREEZE).toBe(7); // the ball's deeper stamp took the centre
    // (8, 11) is under T2's flat band and inside the ball's disc, out of T9's line: the ball's
    // stamp rises by its radius, so the flat keeps the lower reach and the cell.
    expect(field(8, 11), FREEZE).toBeCloseTo(-0.5, 6);
    expect(who(8, 11), FREEZE).toBe(2);
    expect(field(12, 10), FREEZE).toBeCloseTo(-0.5, 6);
    expect(who(12, 10), FREEZE).toBe(9); // a tie with T2's flat: the LATER stamp wins
    expect(who(20, 20), FREEZE).toBe(0); // never stamped
  });

  it('gates the edge-break band on the V being the deepest cutter', () => {
    // #1064 — this case is about IDENTITY, not edge scope: the job names every edge (`all`).
    const V = { edgeBreak: { reachMm: 1.5, legMm: 0.5, toolNumber: 7, edges: 'all' as const } };
    const vDeepest = checkGoalCutInto(CANON, CANON_TOP, { ...V, wallShadowRadiusMm: 2, whoAt: () => 7 });
    expect(vDeepest.edgeBreakFraction, FREEZE).toBe(2 / COVERED);
    // A flat cut both band cells deepest: they are judged instead — D becomes a wall, and E and C
    // are adjudicated (v5: no CL is stated, so the shadow excuses neither), F too.
    const flatDeepest = checkGoalCutInto(CANON, CANON_TOP, { ...V, wallShadowRadiusMm: 2, whoAt: () => 2 });
    expect(flatDeepest.edgeBreakFraction, FREEZE).toBe(0);
    expect(flatDeepest.wallNotScoredFraction, FREEZE).toBe(1 / COVERED);
    expect(flatDeepest.shadowNotScoredFraction, FREEZE).toBe(0);
    expect(flatDeepest.adjudicatedFraction, FREEZE).toBe(5 / COVERED);
    // No identity at all is the conservative side: nothing is excused.
    const unknown = checkGoalCutInto(CANON, CANON_TOP, { ...V, wallShadowRadiusMm: 2 });
    expect(unknown.edgeBreakFraction, FREEZE).toBe(0);
  });

  it('carries the V’s tool number into the card’s allowance — and states none without a V', () => {
    const chamfer: Tool = flatEndMill(3.175, {
      number: 4,
      name: '90° chamfer',
      shape: 'chamfer',
      typeText: 'Chamfer',
      angle: 90,
      halfAngle: 45,
      tipDiameter: 0.1,
      diameter: 3.175,
    });
    const job = (edgeBreak?: { widthMm: number; toolKey?: string }): EngraveJob =>
      ({
        targetObject: { role: 'goal', enabled: true, ...(edgeBreak === undefined ? {} : { edgeBreak }) },
        labels: [],
        shapes: [],
        cutouts: [],
        chamfers: [],
        combined: [],
        traces: [],
        vectors: [],
        keepOuts: [],
        drills: [],
        threads: [],
        primitives: [],
      }) as unknown as EngraveJob;
    const toolFor = (key: string): Tool | null => (key === 'c90' ? chamfer : null);
    // The card's allowance names the V: reach 1.5875, leg 1.5375, tool 4.
    expect(goalEdgeBreakOptions(job({ widthMm: 1, toolKey: 'c90' }), toolFor, ['c90']).edgeBreak, FREEZE).toEqual({
      reachMm: 1.5875,
      legMm: 1.5375,
      edges: 'silhouette',
      toolNumber: 4,
    });
    // No stated break → no allowance, and the absence is the answer (never a silent excusal).
    expect(goalEdgeBreakOptions(job(), toolFor, ['c90']).edgeBreak, FREEZE).toBeUndefined();
    // A stated break with no V cutter in the run → no allowance either.
    expect(goalEdgeBreakOptions(job({ widthMm: 1, toolKey: 'c90' }), () => null, []).edgeBreak, FREEZE).toBeUndefined();
  });

  /**
   * v5 (#970) — THE WALL SHADOW'S DEPTH RULE. E's tray class: the V driven 3.49 mm into land beside
   * a wall, every shadow cell excused, the gate reading 0.00 %. These are the rule's pins.
   *
   * The fixture: a 2 mm step at i = 8..9 (the wall columns) on a 16 × 9 grid at 1 mm. A cut at
   * i = 7 sits 1 mm from the wall — inside the V's 1.5875 mm reach and inside a 4 mm shadow — and
   * a cut at i = 6 is 2 mm out, outside a 1.0 mm reach and still inside the shadow. That is the
   * mouth-rim placement E found: the V is allowed there, so only its DEPTH separates a legal break
   * from a gouge. (Nine rows, so the cut rows are clear of the border seed's 1 mm reach.)
   */
  it('v5 — a V 3.49 mm into land beside a wall is ADJUDICATED, not excused as shadow (E’s tray class)', () => {
    const goal = field(16, 9, { z: (i) => (i >= 9 ? -2 : 0) });
    const top = reader(goal, new Map([[at(goal, 7, 4), 3.49]]));
    const V = { edgeBreak: { reachMm: 1.5875, legMm: 1.5375, toolNumber: 7 }, wallShadowRadiusMm: 4, whoAt: () => 7 };
    const r = checkGoalCutInto(goal, top, V);
    // The V is the deepest cutter and the cell is inside its reach, but 3.49 > the 1.5375 leg, so
    // it is not edge break — and with no CL stated the shadow cannot excuse it either (v4 excused
    // every shadow cell whatever cut it).
    expect(r.edgeBreakFraction, FREEZE).toBe(0);
    expect(r.shadowNotScoredFraction, FREEZE).toBe(0);
    expect(r.adjudicatedFraction, FREEZE).toBe(1 / 144);
    expect(r.adjudicatedMaxMm, FREEZE).toBeCloseTo(3.49, 6);
    expect(r.adjudicatedMaxAt, FREEZE).toEqual({ x: 7, y: 4 });
    expect(r.ok, FREEZE).toBe(false);
  });

  it('v5 — a stamp-artefact shadow cell is excused only while the CL stays R from the wall', () => {
    const goal = field(16, 9, { z: (i) => (i >= 9 ? -2 : 0) });
    const top = reader(goal, new Map([[at(goal, 6, 4), 0.3]]));
    // A flat cutter, outside a 1 mm reach: the edge-break allowance cannot excuse the cell, so the
    // shadow rule alone decides it.
    const flat = { edgeBreak: { reachMm: 1, legMm: 1.5375 }, wallShadowRadiusMm: 4 };
    // The CL at x = 0 is 8 mm from the wall: the disc's rim covered the cell, not a wall drive —
    // excused, as v4 excused it unconditionally.
    const far = checkGoalCutInto(goal, top, { ...flat, clAt: () => ({ x: 0, y: 4 }) });
    expect(far.edgeBreakFraction, FREEZE).toBe(0);
    expect(far.shadowNotScoredFraction, FREEZE).toBe(1 / 144);
    expect(far.adjudicatedFraction, FREEZE).toBe(0);
    // The CL at the wall itself: the cutter was driven along the wall's base — adjudicated.
    const near = checkGoalCutInto(goal, top, { ...flat, clAt: () => ({ x: 8, y: 4 }) });
    expect(near.shadowNotScoredFraction, FREEZE).toBe(0);
    expect(near.adjudicatedFraction, FREEZE).toBe(1 / 144);
    expect(near.adjudicatedMaxMm, FREEZE).toBeCloseTo(0.3, 6);
    // No CL at all is the conservative side: adjudicated, never excused.
    const none = checkGoalCutInto(goal, top, flat);
    expect(none.shadowNotScoredFraction, FREEZE).toBe(0);
    expect(none.adjudicatedFraction, FREEZE).toBe(1 / 144);
  });

  /**
   * v5 (the manager's ruling after the review session's #3 answer, #943): THE EXCUSE IS BOUNDED AT
   * ONE PITCH. A stamp-artefact excuse takes the deepest stamp's CL at least R from the wall, with
   * ONE PITCH of slack for the wall's own location error (± half a cell) and the CL's cell
   * quantisation — never more. This pins the bound at a 0.1 mm pitch: a CL whose cell is exactly
   * R − pitch from the nearest wall cell is excused; one cell closer (R − 2 pitches) is not.
   */
  it('v5 — the CL excuse stops at one pitch inside R, no further', () => {
    const P = 0.1;
    // 160 x 90 at 0.1 mm: a 2 mm step between i = 80 and 81 (wall cells x = 8.0 and 8.1).
    const goal = field(160, 90, { pitch: P, z: (i) => (i >= 81 ? -2 : 0) });
    // A cut 4 mm behind the wall (x = 4.0), well inside R = 4 and outside a 1 mm reach: only the
    // shadow rule can excuse it.
    const top = reader(goal, new Map([[at(goal, 40, 45), 0.3]]));
    const flat = { edgeBreak: { reachMm: 1, legMm: 1.5375 }, wallShadowRadiusMm: 4 };
    // CL at x = 4.1: its cell is 39 cells (3.9 mm = R − one pitch) from the nearest wall cell.
    const atBound = checkGoalCutInto(goal, top, { ...flat, clAt: () => ({ x: 4.1, y: 4.5 }) });
    // v8 — THE RELIEF CEILING DECIDES FIRST. At this cell the disc (R = 4) reaches the wall's
    // HIGH side (the land) but not the floor one pitch beyond it, so the goal's own relief there is
    // 0: the v5 proof alone no longer excuses a 0.3 mm read, and the cell is COUNTED.
    expect(atBound.shadowNotScoredFraction, FREEZE).toBe(0);
    expect(atBound.adjudicatedFraction, FREEZE).toBe(1 / (160 * 90));
    expect(atBound.shadowOverReliefCells, FREEZE).toBe(1);
    // CL at x = 4.2: 38 cells (3.8 mm = R − two pitches) — the rim overlaps the wall line by more
    // than the location error, so the cell is judged.
    const inside = checkGoalCutInto(goal, top, { ...flat, clAt: () => ({ x: 4.2, y: 4.5 }) });
    expect(inside.shadowNotScoredFraction, FREEZE).toBe(0);
    expect(inside.adjudicatedFraction, FREEZE).toBe(1 / (160 * 90));
  });

  it('STATES an unchecked goal, never a silent pass', () => {
    const grid = field(5, 5);
    const r = checkGoalCutInto(grid, null);
    expect(r.ran, FREEZE).toBe(false);
    expect(r.ok).toBe(true); // an unchecked goal is a gap, not a failure
    expect(r.reason).not.toBeNull();
    expect(r.sentence).toContain('not run');
  });
});
