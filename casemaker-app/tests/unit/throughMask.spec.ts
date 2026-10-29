// The verifier's spatial through mask (#218). Every expected number is computed by hand from
// the geometry stated in the test: a square centre path, a tab span by arc length, a drill disc.

import { describe, expect, it } from 'vitest';
import { buildThroughMask, pointInPolygons } from '@/engine/cnc/engrave/throughMask';
import type { Polygons } from '@/engine/cnc/cam/pocket';

const T = 6;
const B = 0.3;
const THROUGH = T + B;

/** A square centre path from (10,10) to (30,30), CCW. Perimeter 80, arc 0 at (10,10). */
const SQUARE: Polygons = [
  [
    [10, 10],
    [30, 10],
    [30, 30],
    [10, 30],
  ],
];

/** A tab span from arc 5 to 15 (the bottom edge), 10 mm long, centred at (15, 10). */
const SPAN = {
  startArc: 5,
  endArc: 15,
  start: [15, 10] as [number, number],
  end: [25, 10] as [number, number],
  points: [
    [15, 10],
    [25, 10],
  ] as [number, number][],
};

describe('buildThroughMask (#218)', () => {
  it('is null when the job has no through work', () => {
    expect(buildThroughMask({ thickness: T, breakthrough: B })).toBeNull();
    expect(buildThroughMask({ thickness: T, breakthrough: B, regions: [] })).toBeNull();
  });

  it('a through region lifts the limit to thickness + breakthrough inside it', () => {
    const mask = buildThroughMask({
      thickness: T,
      breakthrough: B,
      regions: [{ polygons: [[[0, 0], [5, 0], [5, 5], [0, 5]]] }],
    })!;
    expect(mask(2, 2)).toBe(THROUGH);
    expect(mask(6, 2)).toBeNull();
  });

  it('a through drill region adds the point below the full diameter (#218)', () => {
    // A 3 mm 118° drill's point is 0.901 mm; the file's deepest move is the tip at T + B + 0.901.
    const mask = buildThroughMask({
      thickness: T,
      breakthrough: B,
      regions: [{ polygons: [[[0, 0], [5, 0], [5, 5], [0, 5]]], extraDepth: 0.901 }],
    })!;
    expect(mask(2, 2)).toBeCloseTo(THROUGH + 0.901, 9);
  });

  it('a through drill lifts the limit inside the cutter disc only', () => {
    const mask = buildThroughMask({
      thickness: T,
      breakthrough: B,
      drills: [{ holes: [[4, 4]], radius: 1.5 }],
    })!;
    expect(mask(4, 4)).toBe(THROUGH);
    expect(mask(5.4, 4)).toBe(THROUGH);
    expect(mask(5.6, 4)).toBeNull();
  });

  it('a cut-out kerf is a band around the centre path, not a filled region', () => {
    const mask = buildThroughMask({
      thickness: T,
      breakthrough: B,
      cutouts: [{ path: SQUARE, spans: [[]], toolRadius: 1, tabHeight: 1 }],
    })!;
    // On the path, and at its edge (distance exactly the radius).
    expect(mask(20, 10)).toBe(THROUGH);
    expect(mask(20, 11)).toBe(THROUGH);
    expect(mask(20, 11.01)).toBeNull();
    // Inside the part and outside it are both untouched by the mask.
    expect(mask(20, 20)).toBeNull();
    expect(mask(5, 5)).toBeNull();
  });

  it('a tab span caps the kerf at the tab top', () => {
    const mask = buildThroughMask({
      thickness: T,
      breakthrough: B,
      cutouts: [{ path: SQUARE, spans: [[SPAN]], toolRadius: 1, tabHeight: 1 }],
    })!;
    // Arc 10 is the middle of the span, x = 20 on the bottom edge.
    expect(mask(20, 10)).toBe(T - 1);
    // The span's ends are exclusive; just outside it the kerf is through again.
    expect(mask(14.5, 10)).toBe(THROUGH);
    expect(mask(25.5, 10)).toBe(THROUGH);
  });

  it('reads the arc at the NEAREST path point, not the first segment within the kerf', () => {
    // The bottom edge is split at x = 24.7, so the span's end at x = 25 is 0.3 mm past a vertex —
    // inside the 1 mm kerf of the segment before it. That segment's arc (14.7) is inside the tab,
    // but the nearest path point to (25, 10) is the span end itself (arc 15), where the span is
    // exclusive. Reading the earlier segment read the plunge at the tab's end as inside the tab.
    const split: Polygons = [
      [
        [10, 10],
        [24.7, 10],
        [30, 10],
        [30, 30],
        [10, 30],
      ],
    ];
    const mask = buildThroughMask({
      thickness: T,
      breakthrough: B,
      cutouts: [{ path: split, spans: [[SPAN]], toolRadius: 1, tabHeight: 1 }],
    })!;
    expect(mask(25, 10)).toBe(THROUGH);
    expect(mask(20, 10)).toBe(T - 1);
  });

  it('a tab span that crosses the contour seam covers both sides of it (#736)', () => {
    // The square's arc 0 is its first vertex (10, 10). A span from arc 75 to 85 runs over the
    // contour's start: the left edge from (10, 15) down to (10, 10), then the bottom edge from
    // (10, 10) to (15, 10). Its arc interval is `[75, 80) ∪ [0, 5)`; an unwrapped test sees only
    // the first half and reads the cutter's plunge on the other side as a through cut.
    const wrapped = {
      startArc: 75,
      endArc: 85,
      start: [10, 15] as [number, number],
      end: [15, 10] as [number, number],
      points: [
        [10, 15],
        [10, 10],
        [15, 10],
      ] as [number, number][],
    };
    const mask = buildThroughMask({
      thickness: T,
      breakthrough: B,
      cutouts: [{ path: SQUARE, spans: [[wrapped]], toolRadius: 1, tabHeight: 1 }],
    })!;
    // Left-edge midpoint of the span (arc 77.5) and bottom-edge midpoint (arc 2.5).
    expect(mask(10, 12.5)).toBe(T - 1);
    expect(mask(12.5, 10)).toBe(T - 1);
    // Just outside it on either edge the kerf is through again.
    expect(mask(10, 17)).toBe(THROUGH);
    expect(mask(18, 10)).toBe(THROUGH);
  });

  it('a second span on another contour is keyed to that contour’s own arc length', () => {
    const other: Polygons[number] = [
      [50, 10],
      [60, 10],
      [60, 20],
      [50, 20],
    ];
    // The same span numbers on the second contour: arc 5..15 is its bottom edge, (55..65, 10).
    const mask = buildThroughMask({
      thickness: T,
      breakthrough: B,
      cutouts: [{ path: [SQUARE[0]!, other], spans: [[], [SPAN]], toolRadius: 1, tabHeight: 2 }],
    })!;
    expect(mask(57, 10)).toBe(T - 2);
    expect(mask(20, 10)).toBe(THROUGH);
  });

  it('kerf wins over a through region where they overlap', () => {
    const mask = buildThroughMask({
      thickness: T,
      breakthrough: B,
      // A region covering the whole path; the tab must still cap its own kerf.
      regions: [{ polygons: [[[0, 0], [40, 0], [40, 40], [0, 40]]] }],
      cutouts: [{ path: SQUARE, spans: [[SPAN]], toolRadius: 1, tabHeight: 1 }],
    })!;
    expect(mask(20, 10)).toBe(T - 1);
    expect(mask(20, 20)).toBe(THROUGH);
  });
});

describe('pointInPolygons', () => {
  it('is even-odd across a hole', () => {
    const ring: Polygons = [
      [[0, 0], [10, 0], [10, 10], [0, 10]],
      [[4, 4], [4, 6], [6, 6], [6, 4]],
    ];
    expect(pointInPolygons(ring, 2, 2)).toBe(true);
    expect(pointInPolygons(ring, 5, 5)).toBe(false);
    expect(pointInPolygons(ring, 11, 5)).toBe(false);
  });
});
