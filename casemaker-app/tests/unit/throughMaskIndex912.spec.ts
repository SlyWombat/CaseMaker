// Issue #912 — THE THROUGH MASK'S SPATIAL INDEX CHANGES NOTHING IT ANSWERS.
//
// `buildThroughMask` used to walk every segment of every kerf contour (and recompute each
// contour's perimeter) at every query; the verifier queries it at every cutting move, so the
// demo coaster spent 28.5 minutes of a run in this file (V8 profile: 93 % of samples). The
// geometry is now prepared once and bucketed in a grid. This test answers the same points with a
// brute-force reference — the one-pass algorithm, written out here — and requires the two to
// agree everywhere: depths, tab spans, region parity and drill discs.

import { describe, expect, it } from 'vitest';

import { buildThroughMask, type MaskGeometry } from '@/engine/cnc/engrave/throughMask';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { ProfileSpan } from '@/engine/cnc/cam/profile';

/** A polygonised circle, 48 vertices: many short segments and a contour seam to cross. */
function circle(cx: number, cy: number, r: number, n = 48): Polygons[number] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });
}

/** An L-shaped through region with a square hole: even-odd parity must see both contours. */
const REGION: Polygons = [
  [
    [0, 0],
    [30, 0],
    [30, 4],
    [4, 4],
    [4, 30],
    [0, 30],
  ],
  [
    [10, 10],
    [12, 10],
    [12, 12],
    [10, 12],
  ],
];

const OUTLINE = circle(20, 20, 10, 64);

/** Two tab spans: one crossing the seam (arc > perimeter), one in the middle. */
const PERIM = (() => {
  let p = 0;
  for (let i = 0; i < OUTLINE.length; i++) {
    const a = OUTLINE[i]!;
    const b = OUTLINE[(i + 1) % OUTLINE.length]!;
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
})();
const SPANS: ProfileSpan[] = [
  { startArc: 5, endArc: 9, start: [0, 0], end: [0, 0], points: [] },
  { startArc: PERIM - 2, endArc: PERIM + 3, start: [0, 0], end: [0, 0], points: [] },
];

const GEOMETRY: MaskGeometry = {
  thickness: 6,
  breakthrough: 0.3,
  regions: [{ polygons: REGION, extraDepth: 0.2 }],
  drills: [{ holes: [[20, 20], [26, 24]], radius: 1.5 }],
  cutouts: [{ path: [OUTLINE], spans: [SPANS], toolRadius: 2, tabHeight: 1.1 }],
};

/** The one-pass mask, as the first cut computed it — the reference this index must equal. */
function referenceMask(geometry: MaskGeometry): (x: number, y: number) => number | null {
  const throughLimit = geometry.thickness + geometry.breakthrough;
  const pointIn = (polygons: Polygons, x: number, y: number): boolean => {
    let inside = false;
    for (const contour of polygons) {
      for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
        const [xi, yi] = contour[i]!;
        const [xj, yj] = contour[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  };
  return (x, y) => {
    for (const cutout of geometry.cutouts ?? []) {
      for (let c = 0; c < cutout.path.length; c++) {
        const contour = cutout.path[c]!;
        const spans = cutout.spans[c] ?? [];
        let perimeter = 0;
        for (let i = 0; i < contour.length; i++) {
          const a = contour[i]!;
          const b = contour[(i + 1) % contour.length]!;
          perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        let arc = 0;
        let bestDistance = Infinity;
        let bestArc = 0;
        for (let i = 0; i < contour.length; i++) {
          const a = contour[i]!;
          const b = contour[(i + 1) % contour.length]!;
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const len2 = dx * dx + dy * dy;
          const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
          const d = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (d <= cutout.toolRadius + 1e-6 && d < bestDistance) {
            bestDistance = d;
            bestArc = arc + t * length;
          }
          arc += length;
        }
        if (bestDistance <= cutout.toolRadius + 1e-6) {
          let insideSpan = false;
          for (const span of spans) {
            const tol = 0.001;
            if (perimeter > 0 && span.endArc > perimeter) {
              const end = span.endArc - perimeter;
              if (bestArc > span.startArc + tol && bestArc <= perimeter) insideSpan = true;
              if (bestArc < end - tol) insideSpan = true;
            } else if (bestArc > span.startArc + tol && bestArc < span.endArc - tol) {
              insideSpan = true;
            }
          }
          return insideSpan ? geometry.thickness - cutout.tabHeight : throughLimit;
        }
      }
    }
    for (const region of geometry.regions ?? []) {
      if (pointIn(region.polygons, x, y)) return throughLimit + (region.extraDepth ?? 0);
    }
    for (const drill of geometry.drills ?? []) {
      for (const [hx, hy] of drill.holes) {
        if (Math.hypot(x - hx, y - hy) <= drill.radius + 1e-6) return throughLimit;
      }
    }
    return null;
  };
}

describe('#912 — the indexed through mask answers exactly what the one-pass one did', () => {
  it('agrees cell for cell across the coaster-sized field', () => {
    const indexed = buildThroughMask(GEOMETRY)!;
    const reference = referenceMask(GEOMETRY);
    let checked = 0;
    let nonNull = 0;
    // A 0.37 mm sweep crosses cell boundaries, contour seams and both tab spans.
    for (let y = -1; y <= 32; y += 0.37) {
      for (let x = -1; x <= 32; x += 0.37) {
        const a = indexed(x, y);
        const b = reference(x, y);
        expect(a, `x=${x} y=${y}`).toBe(b);
        checked++;
        if (a !== null) nonNull++;
      }
    }
    expect(checked).toBeGreaterThan(7000);
    expect(nonNull).toBeGreaterThan(1000);
  });

  it('still reads the tab at the point nearest a span end', () => {
    const indexed = buildThroughMask(GEOMETRY)!;
    // The point ON the contour at an arc length, walking the segments in order (the arc the mask
    // itself reads). Arc 7 is inside the [5, 9] span (the tab top); arc 10 is past its end (the
    // through depth). The index must not pick a nearer-looking neighbour segment instead.
    const atArc = (want: number): [number, number] => {
      let arc = 0;
      for (let i = 0; i < OUTLINE.length; i++) {
        const a = OUTLINE[i]!;
        const b = OUTLINE[(i + 1) % OUTLINE.length]!;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (want <= arc + len || i === OUTLINE.length - 1) {
          const t = len > 0 ? Math.min(1, Math.max(0, (want - arc) / len)) : 0;
          return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        }
        arc += len;
      }
      throw new Error('unreachable');
    };
    const inside = atArc(7);
    expect(indexed(inside[0], inside[1])).toBe(6 - 1.1);
    const outside = atArc(10);
    expect(indexed(outside[0], outside[1])).toBe(6.3);
  });
});
