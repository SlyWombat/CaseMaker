/**
 * #962 — THE FINISH'S STAY-DOWN LINK, RED-FIRST: adjacent rows on a slope must not lift.
 *
 * THE CAUSE, corrected by measurement (2026-11-05): the design note said the ball's CL is its
 * CENTRE, about R above the surface. It is not — `dropCutter` reports the TIP for every shape
 * (`clSurface957.spec.ts`'s own case: "a ball dropped on the same flat plane also posts exactly
 * the plane's own Z, never the ball centre"). The real defect is in the TEST, not the field:
 * `linkIsClear` applies the FLAT rule — material at or below the link's z at every DISC OFFSET —
 * and the field at an offset is the CL of the ground BESIDE the link, higher than the link's own
 * z on any slope. So every sloped link is refused even though the cutter's flank would clear the
 * rise, and the organizer's ball is 71.6 % air.
 *
 * THE TEST a shaped cutter needs is the drop-cutter definition read backwards: the CL surface at
 * (x, y) IS the cutter's whole profile dropped onto the design, so a link that rides at or above
 * the CL surface along its whole path clears the design under the cutter — footprint and flank,
 * not just the centre point. `finish.ts`'s `ridesTheCl` is that test; these cases pin it:
 *   1. on a ramp the adjacent-row transition is one horizontal FEED link (the air goes down);
 *   2. across a rise between two rows the link RETRACTS — a stay-down chord there would cut the
 *      design by the height of the rise (the whole-profile refusal).
 */

import { describe, expect, it } from 'vitest';

import { finish } from '../../src/engine/cnc/cam/model/ops/finish';
import type { ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { Box2, RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { CamMove, RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const FEEDS = { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 };
const ball6: Tool = { ...flatEndMill(6, { number: 1, id: 'ball-6', name: 'ball-6' }), shape: 'ball' };
const BALL_R = 3;

const X0 = 0;
const X1 = 12;
const Y0 = -10;
const Y1 = 10;
/** A 10-degree ramp descending in +y: adjacent rows differ by stepOver * tan(10deg). */
const SLOPE = Math.tan((10 * Math.PI) / 180);
const zAt = (y: number): number => -SLOPE * (y - Y0);
/** The ball's TIP CL on that ramp: the cutter's own `R(sec(theta) - 1)` rise, not the centre. */
const TIP_RISE = BALL_R * (1 / Math.cos(Math.atan(SLOPE)) - 1);

function surface(drop: (x: number, y: number) => number | null): ClSurface {
  return { dropCutter: drop, toleranceMm: 0.005, minSpacingMm: 0.1, minSpacingSource: 'derived', minSpacingFromStepOverMm: 1, maxSpacingMm: 0.5, sampleCount: 0 };
}

const inside = (x: number, y: number): boolean => x >= X0 && x <= X1 && y >= Y0 && y <= Y1;

const rampCl = surface((x, y) => (inside(x, y) ? zAt(y) + TIP_RISE : null));

// THE RISE BETWEEN TWO ROWS: a plateau standing 0.2 mm above the land across the middle of the
// first row step-over. The CL is the plateau's own top there — the ball would have to ride over it.
const RISE_MM = 0.2;
const RISE_X0 = 0.2;
const RISE_X1 = 1.3;
const riseCl = surface((x, y) => (inside(x, y) ? (x >= RISE_X0 && x <= RISE_X1 ? RISE_MM : 0) : null));

const footprint: [number, number][][] = [[[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]];
function regionOf(zTop: number, zBottom: number, slopeDeg: [number, number]): RemainderRegion {
  return {
    id: 'ramp', footprint, area: (X1 - X0) * (Y1 - Y0), zTop, zBottom,
    triangles: new Uint32Array(), slopeDeg, slopeMedianDeg: slopeDeg[1], in: 'top',
  };
}
const bounds: Box2 = { min: [X0, Y0], max: [X1, Y1] };
const regionRef = (zTop: number, zBottom: number): RegionRef => ({
  id: 'ramp', kind: 'curved', bounds, topZ: zTop, bottomZ: zBottom, obstacles: [], regionClearanceZ: 10,
});

function plan(clSurface: ClSurface, region: RemainderRegion): CamMove[] {
  const out = finish({
    cutter: ball6, region, regionRef: regionRef(region.zTop, region.zBottom), clSurface,
    kind: 'ball-scallop', scallopMm: 0.1, stepDownMm: 100,
    feeds: FEEDS, safeZMm: 20, hopZMm: 5, toolNumber: 1, spindleRpm: 12000, air: true, rapid: RAPID,
  });
  return out.ir.operations[0]!.moves;
}

/** A row-to-row link is a move that steps ACROSS the raster (x) with y held: the rows run in y. */
function isRowCross(m: CamMove, prev: CamMove): boolean {
  return m.kind === 'feed' && Math.abs(m.x - prev.x) > 0.5 && Math.abs(m.y - prev.y) < 1e-6;
}

describe('#962 — the finish joins adjacent rows by the cutter\'s whole profile', () => {
  it('on a ramp the adjacent-row transition is one horizontal FEED link', () => {
    const moves = plan(rampCl, regionOf(0, zAt(Y1), [0, 10]));
    let links = 0;
    for (let i = 1; i < moves.length; i++) if (isRowCross(moves[i]!, moves[i - 1]!)) links++;
    expect(links, 'every row-to-row transition retracted').toBeGreaterThan(2);
  });

  it('a rise between two rows is not crossed by a stay-down chord: it retracts', () => {
    const moves = plan(riseCl, regionOf(0, 0, [0, 0]));
    // The first row is at x = min[0] + the raster nudge; no feed may leave it ACROSS the raster —
    // that is the link over the rise, and staying down there would cut 0.2 mm into the design.
    const firstRowX = moves.find((m) => m.kind === 'feed')?.x ?? X0;
    for (let i = 1; i < moves.length; i++) {
      const prev = moves[i - 1]!;
      const m = moves[i]!;
      if (Math.abs(prev.x - firstRowX) < 1e-6 && isRowCross(m, prev)) {
        throw new Error(`a feed link left the first row at (${prev.x}, ${prev.y}, ${prev.z}) for (${m.x}, ${m.y}, ${m.z}) across a ${RISE_MM} mm rise`);
      }
    }
    // And the refusal is a real retract: the link lifts to the hop plane instead of feeding.
    const hasRapidUp = moves.some((m) => m.kind === 'rapid' && m.z >= 5);
    expect(hasRapidUp, 'the refused link did not lift to the hop plane').toBe(true);
    // The test is not vacuous: the LAND between the other rows does link, so the refusal above is
    // the rise, not a linker that never stays down.
    let landLinks = 0;
    for (let i = 1; i < moves.length; i++) {
      const prev = moves[i - 1]!;
      if (Math.abs(prev.x - firstRowX) > 1e-6 && isRowCross(moves[i]!, prev)) landLinks++;
    }
    expect(landLinks, 'the flat land between rows did not link — the refusal above proves nothing').toBeGreaterThan(0);
  });
});
