/**
 * #1070 (C8) — THE PLACED BRACKET'S SEED, from the bed's hole grid.
 *
 * A bracket bolted to the locating pins has Makera's anchor datum. A bracket screwed to the
 * wasteboard "where you put it" has no datum — but the bed is full of holes, and the bracket has
 * five of its own: three screws (7.5 mm across, 15 and 70 along the front arm, 70 along the left)
 * and two dowels (81 along each arm). If those five holes line up with the bed's pattern, the
 * bracket's inside corner is KNOWN from the grid, to the drawing's accuracy.
 *
 * The table below is the Z1 bed (Z1-BED-STEP.zip) in MACHINE XY: the drawing's 47 mounting holes
 * and 17 dowel holes, `X = x − 205.89`, `Y = −2.83 − y`, so the anchored corner (drawing 15, 191)
 * is anchor 1's own (−190.89, −193.83). Derived once in the parked analysis (issue #1070 comment
 * 6713217743); it is a constant of the machine model, not of any job.
 */

/** The bed's holes, machine XY, from the Z1 bed's STEP/drawing (comment 6713217743). */
export const BED_HOLES_MACHINE = {
  mounting: [
    [-198.39, -190.829], [-175.89, -201.329], [-160.89, -196.829], [-120.89, -201.329],
    [-80.89, -198.329], [-32.89, -198.329], [-9.89, -198.329], [-7.39, -190.829],
    [-110.89, -190.829], [-193.89, -163.829], [-171.889, -166.329], [-125.848, -166.329],
    [-80.89, -166.329], [-32.89, -166.329], [-9.89, -166.329], [-171.889, -128.829],
    [-125.848, -128.829], [-80.89, -128.829], [-32.89, -128.829], [-9.89, -128.829],
    [-7.39, -123.829], [-110.89, -123.829], [-198.39, -123.829], [-165.89, -118.829],
    [-80.89, -85.829], [-32.89, -85.829], [-9.89, -85.829], [-125.848, -85.931],
    [-183.89, -87.829], [-110.89, -87.829], [-21.89, -87.829], [-195.39, -88.829],
    [-171.889, -88.829], [-35.89, -12.831], [-195.39, -12.83], [-171.89, -12.83],
    [-125.89, -12.831], [-80.89, -12.831], [-183.89, -20.831], [-110.89, -20.831],
    [-21.89, -20.831], [-195.39, -49.831], [-171.889, -49.831], [-125.848, -49.831],
    [-80.89, -49.831], [-32.89, -49.831], [-9.89, -49.831],
  ],
  dowel: [
    [-109.892, -201.327], [-45.892, -188.827], [-95.892, -188.827], [-140.889, -188.829],
    [-185.892, -188.827], [-185.89, -143.827], [-95.89, -143.827], [-45.89, -143.827],
    [-7.39, -112.827], [-185.89, -98.827], [-95.89, -98.827], [-45.89, -98.827],
    [-140.889, -98.829], [-185.89, -48.827], [-140.889, -48.832], [-95.89, -48.827],
    [-198.39, -112.827],
  ],
} as const;

/**
 * The bracket's five holes, machine-frame offsets from its INSIDE corner (the stock's front-left
 * corner): three screws on the arm centreline (7.5 mm across), two dowels 81 along each arm. From
 * the anchor-1 pattern the 2026-10-18 ledger entry records.
 */
export const BRACKET_HOLE_OFFSETS = [
  { kind: 'screw', dx: -7.5, dy: 70 },
  { kind: 'screw', dx: 15, dy: -7.5 },
  { kind: 'screw', dx: 70, dy: -7.5 },
  { kind: 'dowel', dx: -7.5, dy: 81 },
  { kind: 'dowel', dx: 81, dy: -7.5 },
] as const;

/** The bracket's own fixture id in the bed profile's placements (`machineChange`'s constant). */
export const BRACKET_FIXTURE_ID = 'fx-bracket-thin';

/** The tolerances the drawing and the physical board are matched to: 0.05 mm (the anchor's claim). */
export const GRID_MATCH_TOLERANCE_MM = 0.05;

const rotate = (dx: number, dy: number, quarter: number): [number, number] =>
  quarter === 0 ? [dx, dy] : quarter === 1 ? [-dy, dx] : quarter === 2 ? [-dx, -dy] : [dy, -dx];

const near = (holes: readonly (readonly [number, number])[], x: number, y: number, tol: number): boolean =>
  holes.some(([hx, hy]) => Math.hypot(hx - x, hy - y) <= tol);

export interface GridSeed {
  /** The bracket's inside corner, machine XY. */
  x: number;
  y: number;
  /** Which quarter-turn of the bracket's pattern admits this corner (0 = as drawn). */
  quarter: 0 | 1 | 2 | 3;
}

/**
 * EVERY corner where the bracket's five holes land on the bed's own: each screw within tolerance of
 * a mounting hole, each dowel of a dowel hole, at each of the four rotations. Sorted and de-duplicated.
 * PURE and constant-sized: 5 holes × 47 candidates × 4 rotations.
 */
export function gridSeeds(): GridSeed[] {
  const out: GridSeed[] = [];
  const seen = new Set<string>();
  for (let quarter = 0 as 0 | 1 | 2 | 3; quarter < 4; quarter = (quarter + 1) as 0 | 1 | 2 | 3) {
    const [s0x, s0y] = rotate(BRACKET_HOLE_OFFSETS[0].dx, BRACKET_HOLE_OFFSETS[0].dy, quarter);
    for (const [mx, my] of BED_HOLES_MACHINE.mounting) {
      const cx = mx - s0x;
      const cy = my - s0y;
      const fits = BRACKET_HOLE_OFFSETS.every((h) => {
        const [dx, dy] = rotate(h.dx, h.dy, quarter);
        const pool = h.kind === 'screw' ? BED_HOLES_MACHINE.mounting : BED_HOLES_MACHINE.dowel;
        return near(pool, cx + dx, cy + dy, GRID_MATCH_TOLERANCE_MM);
      });
      if (!fits) continue;
      const key = `${cx.toFixed(3)}:${cy.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x: Math.round(cx * 1000) / 1000, y: Math.round(cy * 1000) / 1000, quarter });
    }
  }
  return out.sort((a, b) => a.x - b.x || a.y - b.y);
}
