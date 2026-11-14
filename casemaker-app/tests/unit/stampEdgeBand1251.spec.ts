// #1251 — SIMULATOR_VERSION 9: A CELL WITHIN ONE POSTED STEP OF THE CUTTER'S EDGE IS AN EDGE
// CELL, AND AN EDGE CELL IS LOWERED ONLY WHEN THAT DOES NOT TAKE IT BELOW THE GOAL.
//
// The program is posted at three decimals, so the cutter is up to half a thousandth from where it
// was planned; a cell whose centre lies almost exactly on the disc's edge flips between "cut" and
// "not cut" on rounding alone. Read the strict way, a floor cell at the edge leaves a fin the full
// pocket depth (the tray top, #1219 → #1224) and a wall cell at the edge gouges the full wall
// height (the clamp cards, #1250). #1227 answered the fin by moving the wall pass one posted step;
// this issue puts the path back and judges the edge cell by the goal instead.
//
// Fixture: pitch 0.1, the goal grid x 0..80 mm, three rows; one flat cutter of radius 1.5875 fed
// along Y at a stated x, at z = -5. The cutter's disc edge is at qx ± 1.5875 and cells are named
// by their centre's x. `edgeBandMm = 0.001` — one posted step on the Z1.

import { describe, expect, it } from 'vitest';

import { buildTimeline, parseGcode, stubSetup } from '@/engine/cnc';
import { flatEndMill } from '@/engine/cnc/tool';
import { exactSweptField } from '@/workers/sim/sweptPoint';

const PITCH = 0.1;
const NX = 801; // x 0 .. 80 mm
const NY = 3; // y 0 .. 0.2 mm
const R = 1.5875;
const BAND = 0.001;

type GoalAt = (x: number) => number;

function goal(zAt: GoalAt): { nx: number; ny: number; x0: number; y0: number; pitch: number; z: Float32Array; edgeBandMm: number } {
  const z = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) z[j * NX + i] = zAt(i * PITCH);
  }
  return { nx: NX, ny: NY, x0: 0, y0: 0, pitch: PITCH, z, edgeBandMm: BAND };
}

function goalNoBand(zAt: GoalAt): { nx: number; ny: number; x0: number; y0: number; pitch: number } {
  const full = goal(zAt);
  return { nx: full.nx, ny: full.ny, x0: full.x0, y0: full.y0, pitch: full.pitch };
}

const SLAB = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [82, 4] as [number, number] }, thickness: 10 };
const SETUP = stubSetup(SLAB, { kind: 'tape-down', contact: SLAB.outline });
const FLAT = flatEndMill(2 * R, { name: '3.175 mm flat', fluteLength: 30 });
const BALL = flatEndMill(2 * R, { name: '3.175 mm ball', shape: 'ball', cornerRadius: R, typeText: 'Ball Nose', fluteLength: 30 });

/** One straight cut along Y at `qx`, at z = -5, past both ends of the grid. */
function stampAt(
  g: ReturnType<typeof goal> | ReturnType<typeof goalNoBand>,
  tool: typeof FLAT | typeof BALL,
  qx: number,
): Float32Array {
  const nc = ['G21 G90', 'S1000 M3', 'G0 X' + qx + ' Z5', 'G0 Y-2', 'G1 Z-5 F200', 'G1 Y5 F400', 'G0 Z5', 'M2'].join('\n');
  const field = exactSweptField(g, buildTimeline(parseGcode(nc), SETUP), tool);
  expect(field).not.toBeNull();
  return field as Float32Array;
}

/** The stamped value at the cell centred on `x` (row j = 1, the middle row). */
const atX = (f: Float32Array, x: number): number => f[1 * NX + Math.round(x / PITCH)]!;

describe('#1251 the stamp’s edge band — a flat cutter', () => {
  it('1. a floor cell half a step short of the edge is reached', () => {
    // qx = 64.012: the edge is at 65.5995; cell 65.6 is 0.0005 outside the disc.
    const withBand = stampAt(goal(() => -5), FLAT, 64.012);
    expect(atX(withBand, 65.6)).toBeCloseTo(-5, 9);
    // Without the goal and band the cell is not reached: this is the tray top's fin.
    const without = stampAt(goalNoBand(() => -5), FLAT, 64.012);
    expect(atX(without, 65.6)).toBe(0);
  });

  it('2. a wall cell half a step inside the edge is not gouged', () => {
    // qx = 64.013: the edge is at 65.6005; cell 65.6 is 0.0005 inside the disc, and the goal
    // there is the wall's top (0), so a cut to -5 would read as a gouge the wall's full height.
    const zAt = (x: number): number => (x < 65.6 - 1e-9 ? -5 : 0);
    expect(atX(stampAt(goal(zAt), FLAT, 64.013), 65.6)).toBe(0);
    // Without the band the same cell is charged: this is the clamp cards' gouge.
    expect(atX(stampAt(goalNoBand(zAt), FLAT, 64.013), 65.6)).toBeCloseTo(-5, 9);
  });

  it('3. inside the band’s inner edge nothing changes', () => {
    // Cell 65.5 is 0.1 mm inside the band's inner edge; it is cut whether or not the goal there
    // is high (an interior cell is always lowered, as today).
    const zAt = (x: number): number => (x < 65.6 - 1e-9 ? -5 : 0);
    expect(atX(stampAt(goal(zAt), FLAT, 64.013), 65.5)).toBeCloseTo(-5, 9);
    expect(atX(stampAt(goal(() => 0), FLAT, 64.013), 65.5)).toBeCloseTo(-5, 9);
  });

  it('4. outside the band’s outer edge nothing is cut', () => {
    // qx = 64.012: the band's outer edge is 65.6005; cell 65.7 is 0.1 mm beyond it.
    expect(atX(stampAt(goal(() => -5), FLAT, 64.012), 65.7)).toBe(0);
  });

  it('5. a real cut-in is still charged (seven posted steps is not an edge effect)', () => {
    // qx = 64.02: the disc edge is at 65.6075, 7.5 µm past the wall line at 65.6 — inside the
    // band's inner edge (1.5865), so the cell is interior and the cut is charged in full.
    const zAt = (x: number): number => (x < 65.6 - 1e-9 ? -5 : 0);
    expect(atX(stampAt(goal(zAt), FLAT, 64.02), 65.6)).toBeCloseTo(-5, 9);
  });

  it('6. a real strip still stands', () => {
    // qx = 64.00: the disc edge is at 65.5875, 12.5 µm short of cell 65.6 — beyond the band.
    expect(atX(stampAt(goal(() => -5), FLAT, 64.0), 65.6)).toBe(0);
  });
});

describe('#1251 the stamp’s edge band — a ball cutter', () => {
  // The ball's profile at the disc edge is R itself, so an edge cell can at best be lowered to
  // z + R = -5 + 1.5875 = -3.4125; a goal at or below that agrees, one above it does not.
  const EDGE = -5 + R;

  // The ball's profile at a distance d from the centre: p(d) = R - sqrt(R² - d²). The values
  // below are worked by hand from that profile at each cell's own distance; the Float32 field
  // carries ~1e-7, so five decimals is the comparison.
  const p = (d: number): number => R - Math.sqrt(R * R - d * d);

  it('1b. a floor cell in the band is reached to the ball’s edge height', () => {
    expect(atX(stampAt(goal(() => -5), BALL, 64.012), 65.6)).toBeCloseTo(EDGE, 5);
    expect(atX(stampAt(goalNoBand(() => -5), BALL, 64.012), 65.6)).toBe(0);
  });

  it('2b. a wall cell in the band is not gouged; without the band it is charged its profile', () => {
    const zAt = (x: number): number => (x < 65.6 - 1e-9 ? EDGE : 0);
    expect(atX(stampAt(goal(zAt), BALL, 64.013), 65.6)).toBe(0);
    // qx = 64.013: cell 65.6 is 1.587 from the centre, inside the disc, so without the band the
    // cell takes the ball's own profile there: -5 + p(1.587).
    expect(atX(stampAt(goalNoBand(zAt), BALL, 64.013), 65.6)).toBeCloseTo(-5 + p(1.587), 5);
  });

  it('3b. inside the band nothing changes for the ball either', () => {
    // Cell 65.5 is 1.487 from the centre: the ball's profile there, with or without the goal.
    expect(atX(stampAt(goal(() => 0), BALL, 64.013), 65.5)).toBeCloseTo(-5 + p(1.487), 5);
  });

  it('4b. outside the band nothing is cut', () => {
    expect(atX(stampAt(goal(() => -5), BALL, 64.012), 65.7)).toBe(0);
  });

  it('5b. a real cut-in is still charged', () => {
    // qx = 64.02: cell 65.6 is 1.58 from the centre, inside the band's inner edge, so the ball's
    // own profile at that distance is stamped: R - sqrt(R² - 1.58²).
    expect(atX(stampAt(goal(() => 0), BALL, 64.02), 65.6)).toBeCloseTo(-5 + p(1.58), 5);
  });

  it('6b. a real strip still stands', () => {
    expect(atX(stampAt(goal(() => -5), BALL, 64.0), 65.6)).toBe(0);
  });
});

describe('#1251 the band’s reason', () => {
  it('9. the old #1227 inset does not reach the wall — why the measure has a band', () => {
    // #1227 moved the wall pass to (65.6 - R) rounded to the posted grid then back out by R:
    // the resulting centre is still short of the wall line by this much, so a strict edge read
    // leaves a fin there. The band is what closes it without moving the path.
    expect(Number((65.6 - R).toFixed(3)) + R < 65.6).toBe(true);
  });
});
