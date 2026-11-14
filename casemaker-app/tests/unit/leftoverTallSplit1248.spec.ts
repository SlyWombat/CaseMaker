/**
 * #1248 — THE TALL LEFTOVER SPLIT: wall line / wall foot / open, reported only.
 *
 * The goal check's `leftoverTall` reads the cells standing more than the TALL BAND above the goal
 * (the LAST of the leftover bands the check was called with: the shop's own band since #1207) and
 * says which of three things they are, with #1245's part-A rules exactly as G's classifier
 * applied them:
 *
 *  - wall line: the cell is tall and its GOAL's height differs by at least the tall band minus a
 *    float-equality slack (`LEFTOVER_TALL_WALL_STEP_TOL`) from a 4-neighbour one pitch away — the
 *    step is the tall limit itself, not a number of its own (a 1.0 mm step is not > 1.0 in
 *    float32, so the equality counts);
 *  - wall foot: tall, not wall line, and its CENTRE is within R of a wall-line cell's CENTRE
 *    (di² + dj² ≤ (R/pitch)²), where R is the smallest cutter radius the job used (half the
 *    smallest cutting diameter among the programs);
 *  - open: every other tall cell — material standing proud away from any wall.
 *
 * The wall-line SEEDS are the goal's own step cells, tall or not, exactly as G's classifier
 * seeded its disc; the three counts partition the TALL cells. No rule reads any of this.
 */
import { describe, expect, it } from 'vitest';

import { checkGoalCutInto, type GoalCutIntoReport } from '@/engine/cnc/engrave/designCheck';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

const P = 0.1;
const NX = 41; // x = 0 … 4.0
const NY = 11; // y = 0 … 1.0
const cellOf = (x: number): number => Math.round(x / P);

function goalOf(zAt: (i: number, j: number) => number, nx = NX, ny = NY): GoalHeightfield {
  const z = new Float32Array(nx * ny);
  const covered = new Uint8Array(nx * ny);
  let minZ = Infinity;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = zAt(i, j);
      z[j * nx + i] = v;
      covered[j * nx + i] = 1;
      minZ = Math.min(minZ, v);
    }
  }
  return { nx, ny, x0: 0, y0: 0, pitch: P, topZ: 0, minZ, z, covered, coveredCount: nx * ny, resolutionNote: 'sampled on a 0.1 mm grid' };
}

/** A cut field that is a function of the column alone, sampled at the goal cell's centre. */
const cutByColumn = (zAt: (i: number) => number) => (x: number): number => zAt(cellOf(x));

function check(
  goal: GoalHeightfield,
  cut: (x: number, y: number) => number,
  opts: { radiusMm?: number; tallMm?: number } = {},
): GoalCutIntoReport {
  return checkGoalCutInto(goal, null, {
    leftoverTop: cut,
    // The shop's own three bands (the recommendations here); the LAST is the tall band.
    leftoverBandsMm: [0.1, 0.3, opts.tallMm ?? 1],
    ...(opts.radiusMm === undefined ? {} : { smallestCutterRadiusMm: opts.radiusMm }),
  });
}

/** A step 3 mm down along x = 2.0: columns i < 20 at z = 0, i ≥ 20 at z = −3. */
const STEP = (i: number): number => (i < 20 ? 0 : -3);

describe('#1248 — the tall cells, split', () => {
  it('1: a sample on a wall line is a wall-line cell', () => {
    // The goal steps 3 mm down at x = 2.0; the cut matches it except column i = 20 (x = 2.0),
    // left at the top: 11 tall cells (one per row), all on the goal's wall line. Expected by hand:
    // wall line 11, foot 0, open 0.
    const goal = goalOf((i) => STEP(i));
    const cut = cutByColumn((i) => (i === 20 ? 0 : STEP(i)));
    const r = check(goal, cut, { radiusMm: 0.3 });
    expect(r.leftoverTall).toEqual({ wallLineCells: 11, wallFootCells: 0, openCells: 0, cellAreaMm2: P * P });
  });

  it('2: the band beside the wall is the cutter’s foot', () => {
    // As test 1, and columns i = 21, 22, 23 (x = 2.1, 2.2, 2.3) left 1.5 mm proud (z = −1.5).
    // Expected by hand with R = 0.3 mm and pitch 0.1: wall line 11 (column 20); foot 33 (columns
    // 21, 22, 23 — centres 0.1 / 0.2 / 0.3 from the wall-line cells' centres, and 0.3 ≤ R);
    // open 0. Tall total 44.
    const goal = goalOf((i) => STEP(i));
    const cut = cutByColumn((i) => (i === 20 ? 0 : i >= 21 && i <= 23 ? -1.5 : STEP(i)));
    const r = check(goal, cut, { radiusMm: 0.3 });
    expect(r.leftoverTall).toEqual({ wallLineCells: 11, wallFootCells: 33, openCells: 0, cellAreaMm2: P * P });
    // The sentence gains the clause; the limit it states is the tall band the check was called with.
    expect(r.sentence).toMatch(
      /of the 0\.44 mm² standing over 1 mm, 0\.11 mm² is on wall lines, 0\.33 mm² at the foot of walls and 0(\.00)? mm² in the open/,
    );
  });

  it('3: 0.15 mm radius — the 0.1 neighbour is foot, 0.2 and 0.3 are open', () => {
    // Test 2's fields with R = 0.15. The distance rule is between CENTRES: di² + dj² ≤ (R/pitch)²
    // with R = 0.15 and pitch 0.1 → 2.25; the 4-neighbours (0.1) and the diagonals (0.1414) count,
    // 0.2 does not. Expected by hand: wall line 11 (column 20); foot 11 (column 21, 0.1 away);
    // open 22 (columns 22 and 23, 0.2 and 0.3 away). Tall total 44.
    const goal = goalOf((i) => STEP(i));
    const cut = cutByColumn((i) => (i === 20 ? 0 : i >= 21 && i <= 23 ? -1.5 : STEP(i)));
    const r = check(goal, cut, { radiusMm: 0.15 });
    expect(r.leftoverTall).toEqual({ wallLineCells: 11, wallFootCells: 11, openCells: 22, cellAreaMm2: P * P });
  });

  it('4: a proud patch in the open is open', () => {
    // A flat floor; a 5 × 5 patch of cells left 2 mm proud in its middle. Expected by hand: no wall
    // line exists (the goal is flat), so all 25 tall cells are open.
    const goal = goalOf(() => 0, 21, 21);
    const cut = (x: number, y: number): number => {
      const i = cellOf(x);
      const j = cellOf(y);
      return i >= 8 && i <= 12 && j >= 8 && j <= 12 ? 2 : 0;
    };
    const r = check(goal, cut, { radiusMm: 0.3 });
    expect(r.leftoverTall).toEqual({ wallLineCells: 0, wallFootCells: 0, openCells: 25, cellAreaMm2: P * P });
  });

  it('5: no tall cells — zeros, and the sentence gains no clause', () => {
    const goal = goalOf(() => 0, 21, 21);
    const r = check(goal, () => 0.5, { radiusMm: 0.3 });
    expect(r.leftoverTall).toEqual({ wallLineCells: 0, wallFootCells: 0, openCells: 0, cellAreaMm2: P * P });
    expect(r.sentence).not.toMatch(/standing over/);
  });

  it('6: no cutter known — the foot cells count as open', () => {
    // Test 2's fields with NO smallestCutterRadiusMm: wall line 11; foot 0; open 33.
    const goal = goalOf((i) => STEP(i));
    const cut = cutByColumn((i) => (i === 20 ? 0 : i >= 21 && i <= 23 ? -1.5 : STEP(i)));
    const r = check(goal, cut);
    expect(r.leftoverTall).toEqual({ wallLineCells: 11, wallFootCells: 0, openCells: 33, cellAreaMm2: P * P });
  });
  it('7: the wall-line step IS the tall band — at 2 mm a 1.5 mm step is not a wall line and a 2.0 mm step is', () => {
    // Column i = 20 is left 1 mm ABOVE the stock top on a goal that steps down at x = 2.0, so it
    // stands 2.5 mm (step 1.5) or 3.0 mm (step 2.0) over its goal: tall at a 2 mm band either way.
    const STEP15 = (i: number): number => (i < 20 ? 0 : -1.5);
    const STEP20 = (i: number): number => (i < 20 ? 0 : -2);
    const proud = (zAt: (i: number) => number) => cutByColumn((i) => (i === 20 ? 1 : zAt(i)));
    // At the 2 mm band: the 1.5 mm step is NOT a wall line (open — no cutter known), the 2.0 mm one is.
    expect(check(goalOf(STEP15), proud(STEP15), { tallMm: 2 }).leftoverTall).toEqual({
      wallLineCells: 0,
      wallFootCells: 0,
      openCells: 11,
      cellAreaMm2: P * P,
    });
    expect(check(goalOf(STEP20), proud(STEP20), { tallMm: 2 }).leftoverTall).toEqual({
      wallLineCells: 11,
      wallFootCells: 0,
      openCells: 0,
      cellAreaMm2: P * P,
    });
    // At the recommended 1 mm band the same 1.5 mm step IS a wall line: the step moved with the band.
    expect(check(goalOf(STEP15), proud(STEP15), { tallMm: 1 }).leftoverTall).toEqual({
      wallLineCells: 11,
      wallFootCells: 0,
      openCells: 0,
      cellAreaMm2: P * P,
    });
  });

  it('8: an exact step counts through float32 (the tolerance is slack, not a different step)', () => {
    // A 1.0 mm step at the 1 mm band: the goal heights 0 and −1 round-trip float32 exactly and
    // |Δ| = 1.0 must count (>= band − TOL), and a step 0.01 mm short of the band must not.
    const exact = (i: number): number => (i < 20 ? 0 : -1);
    const short = (i: number): number => (i < 20 ? 0 : -0.99);
    const proud = (zAt: (i: number) => number) => cutByColumn((i) => (i === 20 ? 1 : zAt(i)));
    expect(check(goalOf(exact), proud(exact)).leftoverTall?.wallLineCells).toBe(11);
    expect(check(goalOf(short), proud(short)).leftoverTall?.wallLineCells).toBe(0);
  });
});
