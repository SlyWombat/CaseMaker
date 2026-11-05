// #965 — THE CREASE ADMISSION, RED-FIRST (the manager's ruling, 2026-11-05): beside `reach()`'s
// FACE rule — which refuses any region steeper than the V's flank — a V riding a CREASE is the
// opposite case: it fits where the walls are STEEPER than its flanks and the groove is narrower
// than the V at the leftover depth. `creaseFits()` is that rule; the pencil takes it as
// `admitCrease`. This fixture: an 80° V-groove (steeper than the 30° engraver's 75° flank) where
// `reach()` refuses the region and the crease rule admits, the pencil emits along the groove's
// apex, and the V's flanks clear both walls.
import { describe, expect, it } from 'vitest';

import { creaseFits, reach } from '../../src/engine/cnc/cam/model/clsurface';
import type { ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import { hasValley, pencil } from '../../src/engine/cnc/cam/model/ops/pencil';
import type { RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { Box2, RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const FEEDS = { feedMmPerMin: 900, plungeFeedMmPerMin: 250 };
/** The catalogue's 30° engraving bit (122111033830): tip 0.3, halfAngle 15 → flank 75°. */
const ENGRAVER: Tool = {
  ...flatEndMill(0.3, { number: 6, id: '122111033830', name: '3.175*0.3mm*30º Engraving(Metal)' }),
  shape: 'engraving',
  typeText: 'Engraving',
  handleDiameter: 3.175,
  tipDiameter: 0.3,
  diameter: 3.175,
  cornerRadius: null,
  halfAngle: 15,
  fluteLength: 5,
};
const PLATE = -1;
const APEX = -4;
const GROOVE_HALF_MOUTH = 0.53; // 3 mm of depth at 80°: half-mouth = 3 / tan(80°)
const WALL_DEG = 80;
const FOOT: Polygons = [[[0, -5], [20, -5], [20, 5], [0, 5]]];

/** The design's height at x: the plate, and the V-groove about x = 10 (80° walls). */
function designZ(x: number): number {
  const d = Math.abs(x - 10);
  if (d >= GROOVE_HALF_MOUTH) return PLATE;
  return APEX + d * Math.tan((WALL_DEG * Math.PI) / 180);
}

const bounds: Box2 = { min: [0, 0], max: [20, 10] };
const region: RemainderRegion = {
  id: 'groove', footprint: FOOT, area: 200, zTop: PLATE, zBottom: APEX,
  triangles: new Uint32Array(), slopeDeg: [0, WALL_DEG], slopeMedianDeg: 40, in: 'top',
};
const regionRef: RegionRef = { id: 'groove', kind: 'curved', bounds, topZ: PLATE, bottomZ: APEX, obstacles: [], regionClearanceZ: 2 };

/** The V's own CL: the groove's surface where the V's tip fits (its flanks clear 80° walls). */
function vCl(): ClSurface {
  return {
    dropCutter: (x: number): number | null => (x >= 0 && x <= 20 ? designZ(x) : null),
    toleranceMm: 0.005,
    minSpacingMm: 0.005,
    maxSpacingMm: 0.3,
    sampleCount: 0,
  };
}

/** The cheap pre-gate (C's review): a surface with no valley cell gets no V CL build, no pencil
 * grid and no line at all. */
describe('#965 the crease pre-gate — hasValley()', () => {
  it('sees the groove as a valley and a flat plate as none', () => {
    expect(hasValley(vCl(), bounds, 0.1)).toBe(true);
    const flat: ClSurface = { dropCutter: (x: number) => (x >= 0 && x <= 20 ? PLATE : null), toleranceMm: 0.005, minSpacingMm: 0.005, maxSpacingMm: 0.3, sampleCount: 0 };
    expect(hasValley(flat, bounds, 0.1)).toBe(false);
  });
});

describe('#965 the crease admission — a V-groove reach() refuses and the crease rule admits', () => {
  it('reach() refuses the region (the face rule); creaseFits admits the crease', () => {
    // THE PREMISE: reach() is the FACE rule — the region's 80° steepest slope is past the V's 75°
    // flank, so it refuses; that is why the crease pass was inert under it.
    expect(reach(ENGRAVER, region).reachable).toBe(false);
    // THE CREASE RULE: both walls steeper than 75°, and the groove at 3 mm depth is 1.06 mm wide,
    // inside the V's 1.68 mm there.
    const fits = creaseFits(ENGRAVER, { leftSlopeDeg: WALL_DEG, rightSlopeDeg: WALL_DEG, depthMm: 3 });
    expect(fits.reachable, fits.reachable ? '' : (fits as { note?: string }).note).toBe(true);
    // The rule refuses what it should: a wall shallower than the flank, and a groove wider than
    // the V at its depth (a 60° wall is shallower than 75°).
    expect(creaseFits(ENGRAVER, { leftSlopeDeg: 60, rightSlopeDeg: WALL_DEG, depthMm: 3 }).reachable).toBe(false);
  });

  it('the pencil admits the crease, emits along the groove apex, and cuts neither wall', () => {
    const out = pencil({
      cutter: ENGRAVER,
      region,
      regionRef,
      clSurface: vCl(),
      gridPitchMm: 0.1,
      admitCrease: (_i, _j, z, leftSlopeDeg, rightSlopeDeg) => {
        // The leftover depth at the crease: the plate minus the V's own height here (the material
        // the V removes) — 3 mm at the apex.
        const depth = Math.max(0, PLATE - z);
        return creaseFits(ENGRAVER, { leftSlopeDeg, rightSlopeDeg, depthMm: depth }).reachable;
      },
      feeds: FEEDS,
      safeZMm: 5,
      hopZMm: 1,
      toolNumber: 6,
      spindleRpm: 12000,
      air: true,
      rapid: RAPID,
    });
    const moves = out.ir.operations.flatMap((op) => op.moves);
    const feeds = moves.filter((m) => m.kind === 'feed');
    expect(feeds.length, 'the pencil emitted nothing at the groove').toBeGreaterThan(0);
    // The chain rides the apex: every feed sits within a grid pitch of x = 10 and at the floor.
    for (const f of feeds) {
      expect(Math.abs(f.x - 10), `a crease feed at x ${f.x.toFixed(3)} is off the groove's line`).toBeLessThanOrEqual(0.11);
      expect(f.z, `a crease feed at z ${f.z.toFixed(3)} is above the groove's apex`).toBeLessThanOrEqual(APEX + 0.12);
    }
    // NO CUT INTO EITHER WALL: at horizontal distance dx from the feed, the V's flank stands at
    // z + dx·tan(75°); the design's wall stands at z + dx·tan(80°) — steeper, so above the flank.
    const tanFlank = Math.tan((75 * Math.PI) / 180);
    for (const f of feeds) {
      for (const dx of [0.05, 0.1, 0.2, 0.3]) {
        for (const side of [-1, 1]) {
          const wallZ = designZ(f.x + side * dx);
          const flankZ = f.z + dx * tanFlank;
          expect(wallZ, `the V's flank at dx ${dx} stands at ${flankZ.toFixed(3)}, the wall at ${wallZ.toFixed(3)}`).toBeGreaterThanOrEqual(flankZ - 1e-6);
        }
      }
    }
  });
});
