// #948/#945 — THE GOAL CHECK'S VERDICT IS THE PAGE'S OWN STAMP, NOT THE COLUMN READ.
//
// The app and `goal_check.py` must read the same field. The column read takes the HIGHEST of the
// four columns bracketing a cell, so a gouge narrower than a cell is invisible to it — that is how
// the top-clamp card's 1,930 cells at 0.165 mm read as 0 in the receipt while the page saw them.
// With the exact stamp supplied, the verdict is the stamp and the column read is the diagnostic.
import { describe, expect, it } from 'vitest';

import { checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

const PITCH = 0.25;
const N = 40;

function goal(): GoalHeightfield {
  const z = new Float32Array(N * N).fill(-1);
  const covered = new Uint8Array(N * N).fill(1);
  return {
    nx: N,
    ny: N,
    x0: 0,
    y0: 0,
    pitch: PITCH,
    topZ: 0,
    minZ: -1,
    z,
    covered,
    coveredCount: N * N,
    resolutionNote: 'test',
  };
}

const CENTRE = { i: N / 2, j: N / 2 };

/** The exact stamp: the goal, with a one-cell gouge at the centre. */
function exact(x: number, y: number): number | null {
  const i = Math.round(x / PITCH);
  const j = Math.round(y / PITCH);
  if (i === CENTRE.i && j === CENTRE.j) return -1.2; // 0.2 mm below the goal
  return -1;
}

/** The column read: the HIGHEST of the four bracketing columns — the one-cell gouge is invisible. */
function column(_x: number, _y: number): number | null {
  return -1;
}

describe('#948/#945 the goal check judges on the exact stamp', () => {
  it('a sub-column gouge the stamp sees is cut-into, and the column read is the stated diagnostic', () => {
    const r = checkGoalCutInto(goal(), column, { leftoverTop: exact });
    expect(r.cutIntoFraction).toBeCloseTo(1 / (N * N), 12);
    expect(r.maxCutIntoMm).toBeCloseTo(0.2, 6);
    expect(r.ok).toBe(false);
    // The conservative read beside the verdict: it cannot see the gouge at all.
    expect(r.columnCutInto).toEqual({ fraction: 0, maxMm: 0, at: null });
  });

  it('with no exact stamp the old column read is the verdict (and says so by no diagnostic)', () => {
    const r = checkGoalCutInto(goal(), column);
    expect(r.cutIntoFraction).toBe(0);
    expect(r.columnCutInto).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it('a cell the stamp does not answer falls back to the column read, never dropped', () => {
    // The stamp is null everywhere except a 0.4 mm patch; the column read answers everywhere.
    const sparse = (x: number, y: number): number | null => {
      const i = Math.round(x / PITCH);
      const j = Math.round(y / PITCH);
      return i >= 20 && i <= 21 && j >= 20 && j <= 21 ? -1 : null;
    };
    const r = checkGoalCutInto(goal(), column, { leftoverTop: sparse });
    expect(r.goalCells).toBe(N * N); // every covered cell still counted via the fallback
    expect(r.cutIntoFraction).toBe(0);
    expect(r.columnCutInto).toEqual({ fraction: 0, maxMm: 0, at: null });
  });
});
