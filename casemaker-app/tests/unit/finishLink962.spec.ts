/**
 * #959 review item (6), RED-FIRST: `finish()` must link row to row through #962's `link()`, whose
 * own `retract()` feeds every VERTICAL leg at the plunge rate (#956 §5, Review B's F8) — never a
 * rapid, even when the link has to retract. The op's own hand-rolled transition did the opposite:
 * all three of its moves (`rapid` to the region's clearance plane, `rapid` across, `rapid` down to
 * the hop height) were rapids, including the two pure-vertical legs — a straight-up/straight-down
 * RAPID starting right at the previous row's own cut depth, never fed, on every single row.
 *
 * The raster's own rows run edge to edge on the footprint's Y bound by construction, so the
 * material-aware short-hop path essentially never fires here (the cutter's disc pokes past the
 * known footprint at the row ends, and an unmodelled boundary is correctly treated as uncleared,
 * `linking.ts`'s own "a retract is always safe, a hopeful link is not") — the property that must
 * hold either way is that NO rapid is ever a pure vertical move (the same (x, y) as the move
 * immediately before it): a vertical leg is always a `feed`, at the plunge rate.
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
const regionRef: RegionRef = { id: 'flat', kind: 'curved', bounds, topZ: FLAT_Z, bottomZ: FLAT_Z, obstacles: [], regionClearanceZ: 5 };

describe('#959 review — finish() feeds every vertical leg of a link, never a rapid', () => {
  it('on a flat region swept over several rows, no rapid is ever a pure vertical move except the op\'s own final retract', () => {
    const out = finish({
      cutter: ball6, region, regionRef, clSurface: flatSurface, kind: 'ball-scallop', scallopMm: 0.1, stepDownMm: 100,
      feeds: FEEDS, safeZMm: 10, hopZMm: 3, toolNumber: 1, spindleRpm: 12000, air: true, rapid: RAPID,
    });
    const moves = out.ir.operations[0]!.moves;
    expect(out.passes.length, 'the fixture must actually sweep more than one row for this to mean anything').toBeGreaterThan(2);

    // A "vertical leg" is any move whose (x, y) exactly matches the move before it, with a
    // different z. Every link that has to retract climbs and descends along one of these — the
    // op's own final safeZ retreat (the LAST move of the whole program) is the one legitimate
    // exception every op in this codebase posts as a plain rapid.
    for (let i = 1; i < moves.length - 1; i++) {
      const m = moves[i]!;
      const prev = moves[i - 1]!;
      if (m.x !== prev.x || m.y !== prev.y || m.z === prev.z) continue;
      // The `throw` (not an `expect`) is what narrows `m` to the 'feed' variant for the `.f` read
      // below — `CamMove`'s 'rapid' branch carries no `f` field at all, so reading it without
      // first ruling out 'rapid' is exactly the bug this test exists to catch, not a type cast to
      // paper over: a vertical leg posted as 'rapid' must fail HERE, on its own kind, never fall
      // through to compare an undefined `f` against the plunge rate.
      if (m.kind !== 'feed') {
        throw new Error(`move ${i}, a vertical leg from z=${prev.z} to z=${m.z}, posted as a '${m.kind}', not a feed`);
      }
      expect(m.f, `move ${i}'s vertical leg ran at ${m.f} mm/min, not the ${FEEDS.plungeFeedMmPerMin} mm/min plunge rate`).toBe(FEEDS.plungeFeedMmPerMin);
    }
  });
});
