/**
 * #1033 — A JOIN ACROSS GROUND THE FOOTPRINT DOES NOT OWN IS STILL PROVABLE.
 *
 * #1030 made the ride test sample INSIDE a short join; where the region is holed (an island, a
 * pocket mouth) the clipped `clSurface.dropCutter` answers null on the unowned ground and the join
 * retracts — 159 of the organizer's 165 nulls, 113 extra retracts, +422.7 s (4.06 %).
 *
 * Lever (b): the physical CL over the unowned ground is the same mesh's drop-cutter without the
 * footprint clip. A chord AT OR ABOVE that CL rides — it grazes the neighbouring surface and cuts
 * nothing below it; a chord BELOW it must still be refused (a false ride would cut the island).
 *
 * The fixture: a plate top at z = 0 with a flat raised island (⌀6 ball, R = 3; island top at
 * z = 3, so its CL is 6). The region's footprint is the plate less the island's own ring, exactly
 * as a holed remainder region presents itself.
 *
 * RED at the #1030 tip: every sample inside the hole is null and the ride is refused.
 */
import { describe, expect, it } from 'vitest';

import { clSurface } from '@/engine/cnc/cam/model/clsurface';
import { ridesTheCl } from '@/engine/cnc/cam/model/ops/finish';
import type { FeatureSource, RemainderRegion } from '@/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';

type P2 = [number, number];
type P3 = [number, number, number];

const PLATE = 30;
const ISLAND = { x0: 11, x1: 19, y0: 11, y1: 19 };
const ISLAND_TOP = 3;
const BALL6: Tool = { ...flatEndMill(6, { number: 1, id: 'ball-6', name: 'ball-6' }), shape: 'ball' };

/** A triangle soup of the visible surface: the plate top at z = 0 and the island's walls + top. */
function geometry(): FeatureSource {
  const positions: number[] = [];
  const indices: number[] = [];
  const tri = (a: P3, b: P3, c: P3): void => {
    indices.push(positions.length / 3, positions.length / 3 + 1, positions.length / 3 + 2);
    positions.push(...a, ...b, ...c);
  };
  const quad = (a: P3, b: P3, c: P3, d: P3): void => {
    tri(a, b, c);
    tri(a, c, d);
  };
  // The plate top (the island's walls/top stand above it; the drop-cutter takes the highest).
  quad([-1, -1, 0], [PLATE + 1, -1, 0], [PLATE + 1, PLATE + 1, 0], [-1, PLATE + 1, 0]);
  const { x0, x1, y0, y1 } = ISLAND;
  const t = ISLAND_TOP;
  // The island's four walls and its flat top.
  quad([x0, y0, 0], [x1, y0, 0], [x1, y0, t], [x0, y0, t]);
  quad([x1, y1, 0], [x0, y1, 0], [x0, y1, t], [x1, y1, t]);
  quad([x1, y0, 0], [x1, y1, 0], [x1, y1, t], [x1, y0, t]);
  quad([x0, y1, 0], [x0, y0, 0], [x0, y0, t], [x0, y1, t]);
  quad([x0, y0, t], [x0, y1, t], [x1, y1, t], [x1, y0, t]);
  return {
    triangles: {
      positions: Float32Array.from(positions),
      indices: Uint32Array.from(indices),
      triangleCount: indices.length / 3,
      bbox: { min: [-1, -1, 0], max: [PLATE + 1, PLATE + 1, t] },
    },
  };
}

/** The plate less the island: the outer ring with the island's own ring as a hole (even-odd). */
function region(): RemainderRegion {
  const outer: P2[] = [[0, 0], [PLATE, 0], [PLATE, PLATE], [0, PLATE]];
  const hole: P2[] = [[ISLAND.x0, ISLAND.y0], [ISLAND.x1, ISLAND.y0], [ISLAND.x1, ISLAND.y1], [ISLAND.x0, ISLAND.y1]];
  return {
    id: 'holed-plate',
    footprint: [outer, hole],
    area: PLATE * PLATE - (ISLAND.x1 - ISLAND.x0) * (ISLAND.y1 - ISLAND.y0),
    zTop: 0,
    zBottom: 0,
    triangles: new Uint32Array(),
    slopeDeg: [0, 0],
    slopeMedianDeg: 0,
    in: 'top',
  };
}

const surface = clSurface(geometry(), region(), BALL6, 3);
/** The island's own CL (a TIP height, as every posted Z is): its flat top's surface. */
const ISLAND_TIP = ISLAND_TOP;
/** A hair outside the hole's edge — where a row's own end lands (the op's edge inset). */
const EDGE_Y0 = ISLAND.y0 - 0.01;
const EDGE_Y1 = ISLAND.y1 + 0.01;

describe('#1033 a run-to-run join over the footprint\'s hole (lever b)', () => {
  it('rides when the chord is at the neighbouring CL — grazing the island, never cutting it', () => {
    // The row ends either side of the island, at the CL the ball has where it meets the island's
    // edge; the straight chord across the hole runs at that height — a hair under the island's
    // own top, inside the surface's tolerance.
    const edgeZ = surface.dropCutter(15, EDGE_Y0)!;
    expect(edgeZ).toBeCloseTo(ISLAND_TIP, 2);
    const rides = ridesTheCl(
      { x: 15, y: EDGE_Y0, z: edgeZ },
      { x: 15, y: EDGE_Y1, z: edgeZ },
      surface,
      0.05,
    );
    expect(rides, 'the chord grazes the island\'s CL: it must ride, not retract').toBe(true);
    // The fixture's own facts: the hole has no clipped CL, and the unclipped one is the island's
    // surface (reached only once the ride has been proven).
    expect(surface.dropCutter(15, 15)).toBeNull();
    expect(surface.dropCutterUnclipped!(15, 15)).toBeCloseTo(ISLAND_TIP, 6);
  });

  it('refuses a chord BELOW the neighbouring CL — riding it would cut the island', () => {
    const rides = ridesTheCl(
      { x: 15, y: EDGE_Y0, z: 0 },
      { x: 15, y: EDGE_Y1, z: 0 },
      surface,
      0.05,
    );
    expect(rides, `a chord at the floor level dives under the island's ${ISLAND_TIP} mm CL`).toBe(false);
  });

  it('still proves a chord wholly inside the footprint exactly as before', () => {
    const rides = ridesTheCl({ x: 5, y: 5, z: 0 }, { x: 5, y: 9, z: 0 }, surface, 0.05);
    expect(rides).toBe(true);
  });
});
