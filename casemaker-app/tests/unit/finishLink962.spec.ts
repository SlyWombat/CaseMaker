/**
 * #959 review item 6, REFINED (the manager's ruling on C's 8,800 s measurement): feeding every
 * vertical leg of a link at `plungeFeed` is stricter than real CAM, and Makera's own NC retracts
 * at G0. The restated rule, in `linking.ts`'s `retract()`:
 *   - UP legs, retracting out of material the op just cut, are RAPIDS — the op finishing at
 *     `from` already proves that XY is clear up to `from.z`, so there is nothing hopeful about
 *     going straight up from there.
 *   - DOWN legs rapid from the clearance plane down to the material field's own report at the
 *     LANDING xy plus the op's hop clearance, then feed (at `plungeFeed`) the rest of the way —
 *     a hopeful rapid past that point is not a retract, so the feed only ever starts at or below
 *     the floor.
 *   - When the field cannot prove anything there (not finite — outside the footprint, or no
 *     field at all, as in `chamfer.ts`), the whole down leg stays a feed, exactly as before.
 *
 * The single universal check this file pins, covering every rapid in the program at once: NO
 * RAPID MOVE EVER ENDS BELOW the material field's own `topAt` at that (x, y) plus the hop
 * clearance — an UP leg's landing (the clearance plane) and the horizontal traverse both clear
 * this trivially by construction; the DOWN leg's rapid segment lands EXACTLY on it. A vertical
 * leg that is a FEED must never start above that floor either (a feed above the floor would mean
 * the new rapid segment was skipped for no reason).
 */

import { describe, expect, it } from 'vitest';

import { finish } from '../../src/engine/cnc/cam/model/ops/finish';
import type { ClSurface } from '../../src/engine/cnc/cam/model/clsurface';
import type { RemainderRegion } from '../../src/engine/cnc/cam/model/features';
import type { Box2, RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const FEEDS = { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 };
const ball6: Tool = { ...flatEndMill(6, { number: 1, id: 'ball-6', name: 'ball-6' }), shape: 'ball' };

const X0 = 0;
const X1 = 30;
const Y0 = -10;
const Y1 = 10;
const FLAT_Z = 0;
const HOP_Z_MM = 3;
const REGION_CLEARANCE_Z = 5;

/** A perfectly flat surface at `FLAT_Z` over the rectangle, null outside it. */
const flatSurface: ClSurface = {
  dropCutter: (x, y) => (x >= X0 && x <= X1 && y >= Y0 && y <= Y1 ? FLAT_Z : null),
  toleranceMm: 0.005,
  minSpacingMm: 0.1,
  maxSpacingMm: 0.5,
  sampleCount: 0,
};

const footprint: [number, number][][] = [[[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]];
const region: RemainderRegion = {
  id: 'flat', footprint, area: (X1 - X0) * (Y1 - Y0), zTop: FLAT_Z, zBottom: FLAT_Z,
  triangles: new Uint32Array(), slopeDeg: [0, 0], slopeMedianDeg: 0, in: 'top',
};
const bounds: Box2 = { min: [X0, Y0], max: [X1, Y1] };
const regionRef: RegionRef = { id: 'flat', kind: 'curved', bounds, topZ: FLAT_Z, bottomZ: FLAT_Z, obstacles: [], regionClearanceZ: REGION_CLEARANCE_Z };

describe('#959 review item 6, refined — finish() links rapid above material, feed only below it', () => {
  it('on a flat region swept over several rows: every rapid lands at or above topAt(x,y) + hopZMm; a feed never starts above it', () => {
    const out = finish({
      cutter: ball6, region, regionRef, clSurface: flatSurface, kind: 'ball-scallop', scallopMm: 0.1, stepDownMm: 100,
      feeds: FEEDS, safeZMm: 10, hopZMm: HOP_Z_MM, toolNumber: 1, spindleRpm: 12000, air: true, rapid: RAPID,
    });
    const moves = out.ir.operations[0]!.moves;
    expect(out.passes.length, 'the fixture must actually sweep more than one row for this to mean anything').toBeGreaterThan(2);

    // The fixture's own field (see finish.ts's materialFor): inside the footprint, at this single
    // level, topAt(x, y) = max(levelZ, dropCutter(x, y)) = FLAT_Z everywhere. The floor every
    // rapid must respect is therefore a single constant here.
    const FLOOR = FLAT_Z + HOP_Z_MM;
    const EPS = 1e-6;

    let rowToRowLinksSeen = 0;
    for (let i = 1; i < moves.length - 1; i++) {
      const m = moves[i]!;
      const prev = moves[i - 1]!;
      if (m.x !== prev.x || m.y !== prev.y || m.z === prev.z) continue; // not a vertical leg
      rowToRowLinksSeen++;
      if (m.kind === 'rapid') {
        expect(m.z, `move ${i}: a rapid vertical leg landed at z=${m.z}, below the floor ${FLOOR} (topAt + hopZMm)`).toBeGreaterThanOrEqual(FLOOR - EPS);
        continue;
      }
      // `CamMove` has exactly two kinds (ir.ts) — ruling out 'rapid' above, not a cast, is what
      // narrows `m` to 'feed' here for the `.f` read below, the same reasoning item 6 first used.
      expect(m.f, `move ${i}'s fed vertical leg ran at ${m.f} mm/min, not the ${FEEDS.plungeFeedMmPerMin} mm/min plunge rate`).toBe(FEEDS.plungeFeedMmPerMin);
      // A feed leg starting above the floor means the new rapid segment down to the floor was
      // skipped for no reason — the whole point of the ruling.
      expect(prev.z, `move ${i}'s fed vertical leg started at z=${prev.z}, above the floor ${FLOOR} — the rapid-down segment to the floor was skipped`).toBeLessThanOrEqual(FLOOR + EPS);
    }
    expect(rowToRowLinksSeen, 'the fixture must actually produce vertical legs for this to mean anything').toBeGreaterThan(0);

    // At least one DOWN leg must actually show the split (a rapid ending at the floor, followed
    // immediately by a feed down into material) — otherwise this fixture isn't exercising the
    // new rule at all, just re-confirming the old one by accident.
    let sawSplitDownLeg = false;
    for (let i = 1; i < moves.length; i++) {
      const m = moves[i]!;
      const prev = moves[i - 1]!;
      if (m.kind === 'feed' && prev.kind === 'rapid' && m.x === prev.x && m.y === prev.y && m.z < prev.z && Math.abs(prev.z - FLOOR) <= EPS) {
        sawSplitDownLeg = true;
        break;
      }
    }
    expect(sawSplitDownLeg, 'no row-to-row down leg showed the rapid-to-floor, then feed-into-material split').toBe(true);
  });
});
