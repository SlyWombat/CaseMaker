/**
 * #970 — THE SKIN TARGET GRID'S OWN CORNERS, RED-FIRST.
 *
 * `skinTargetGrid` (`cam/model/ops/rough.ts`) replaced the skin's per-cell five real `dropCutter`
 * calls (centre + four half-pitch corners) with one `dropCutter` call per grid point, reused as
 * both a cell's own centre and a corner of its diagonal neighbours. The bug this pins (E's
 * SKIN-EQUIV classification on #970, `rough.ts:679-681`, the loop at `:694`): the old corner
 * lookup asked `clAt(x ± half, y ± half)` — a point that never lands exactly on a grid sample —
 * and `Math.round`'s tie-break (round HALF UP) is directional: `+half` always rounds to the NEXT
 * cell, `-half` always rounds BACK to the SAME cell. So a wall visible only through a cell's own
 * `-half` corner was never seen at all (the substitute re-read the cell's own centre), while the
 * organizer's gentle cells alone (88,559 of them) showed 79 differences, 9 of them over 0.1 mm,
 * the worst by the full 22 mm — not a rounding hair, a missed wall.
 */
import { describe, expect, it } from 'vitest';

import { skinTargetGrid } from '../../src/engine/cnc/cam/model/ops/rough';
import type { ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';

describe('#970 skinTargetGrid — a wall straddling a cell', () => {
  const pitch = 2;
  const HIGH = 10;
  const LOW = 0;
  const WALL_X = 5.7;
  const half = pitch / 2;

  // HIGH for x < 5.7, LOW at and past it — independent of y, so the bug's y-rounding (identical
  // mechanism) cannot mask or fix the x-axis case this test targets.
  const surface: ClSurface = {
    dropCutter: (x) => (x < WALL_X ? HIGH : LOW),
    toleranceMm: 0.01,
    minSpacingMm: 0.1,
    minSpacingSource: 'derived',
    minSpacingFromStepOverMm: 1,
    maxSpacingMm: 1,
    sampleCount: 0,
  };
  // Wide enough to cover the full 3x3 neighbourhood around the cell under test (centre (6, 6)).
  const foot: Polygons = [[[0, 0], [10, 0], [10, 10], [0, 10]]];

  /** The reference rule `skinTargetGrid` replaces: five REAL `dropCutter` calls, centre plus the
   * four true half-pitch corners — never a grid lookup. */
  function trueFiveSampleTarget(x: number, y: number): number {
    let hi = -Infinity;
    for (const [dx, dy] of [[0, 0], [-half, -half], [half, -half], [-half, half], [half, half]] as const) {
      const cl = surface.dropCutter(x + dx, y + dy);
      if (cl !== null && cl > hi) hi = cl;
    }
    return hi;
  }

  it('the cell at (6, 6) carries the wall only through its own -half corner', () => {
    // The scenario, stated: centre and the +half corner are both low; only the -half corner
    // (at x = 5) is on the high side of the wall — so a rule that cannot reach it misses the wall
    // entirely for this cell, not by a rounding hair.
    expect(surface.dropCutter(6, 6)).toBe(LOW);
    expect(surface.dropCutter(7, 7)).toBe(LOW);
    expect(surface.dropCutter(5, 5)).toBe(HIGH);
    expect(trueFiveSampleTarget(6, 6)).toBe(HIGH);
  });

  it('the grid target equals the true five-sample target — HIGH, not the old rule’s LOW', () => {
    const expected = trueFiveSampleTarget(6, 6);
    const grid = skinTargetGrid(surface, foot, pitch);
    const i = Math.round((6 - grid.min[0]) / pitch);
    const j = Math.round((6 - grid.min[1]) / pitch);
    expect(grid.clGrid[j * grid.nx + i]).toBe(LOW); // the cell's own centre sample, for context
    expect(grid.target[j * grid.nx + i]).toBe(expected);
  });

  it('no cell anywhere in this grid reads lower than the true five-sample target (the safety side)', () => {
    const grid = skinTargetGrid(surface, foot, pitch);
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const t = grid.target[j * grid.nx + i]!;
        if (!Number.isFinite(t)) continue;
        const x = grid.min[0] + i * pitch;
        const y = grid.min[1] + j * pitch;
        const trueTarget = trueFiveSampleTarget(x, y);
        expect(t, `cell (${i}, ${j}) at (${x}, ${y}): grid ${t} < true ${trueTarget}`).toBeGreaterThanOrEqual(trueTarget);
      }
    }
  });
});
