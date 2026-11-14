// The profile CAM (#218): the centre path's side and offset, tab placement on straight and curved
// edges, the kept bands and the retract/plunge move pattern. The offset is Manifold's real
// Clipper2 wrapper, but every reference number is computed by hand.

import { describe, expect, it } from 'vitest';
import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import { zPasses } from '@/engine/cnc/cam/engraveJob';
import { feedsFor, type CutParams } from '@/engine/cnc/feeds';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import { roundedDiamondPoints } from './fixtures/roundedDiamond';
import {
  generateProfile,
  kerfPolygons,
  longestTabGap,
  placeTabs,
  profilePath,
  signedArea,
  tabBars,
  tabBridgeRectangles,
  type ProfileCut,
} from '@/engine/cnc/cam/profile';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { NO_SHOP } from '../tools/noShop';

const offset = makeClipperOffset(tl);
const D = 3.175;
const R = D / 2;
const MILL = flatEndMill(D);
const PARAMS: CutParams = { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 1, stepOver: 0.4, peck: 1, air: false };

/** A CCW rectangle with its front-left at the origin. */
function rect(w: number, h: number): Polygons {
  return [
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
  ];
}

/** A CCW regular polygon for a circle of `radius`, at the CAM's own chord resolution. */
function circle(radius: number): Polygons {
  const n = segmentsForRadius(radius);
  const contour: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    contour.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return [contour];
}

/** The polyline length of a span's own points, mm — the span measured ALONG the cut path. */
function spanAlong(span: { points: readonly (readonly [number, number])[] }): number {
  let total = 0;
  for (let i = 1; i < span.points.length; i++) {
    total += Math.hypot(span.points[i]![0] - span.points[i - 1]![0], span.points[i]![1] - span.points[i - 1]![1]);
  }
  return total;
}

/** A band's vertices as polar coordinates about the origin. */
function polar(contour: readonly (readonly [number, number])[]): { angle: number; radius: number }[] {
  return contour.map(([x, y]) => ({ angle: Math.atan2(y, x), radius: Math.hypot(x, y) }));
}

function bbox(region: Polygons): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const contour of region) {
    for (const [x, y] of contour) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1 };
}

describe('profilePath (#218)', () => {
  it('follows the outside of a 40 x 20 outline one radius out, keeping CCW winding', () => {
    // 40 + 2 x 1.5875 = 43.175; 20 + 2 x 1.5875 = 23.175.
    const path = profilePath(rect(40, 20), 'outside', R, 0, offset);
    expect(path.length).toBe(1);
    const b = bbox(path);
    expect(b.x1 - b.x0).toBeCloseTo(43.175, 6);
    expect(b.y1 - b.y0).toBeCloseTo(23.175, 6);
    expect(b.x0).toBeCloseTo(-R, 6);
    expect(signedArea(path[0]!)).toBeGreaterThan(0);
  });

  it('inset adds to the path distance on either side', () => {
    const outside = profilePath(rect(40, 20), 'outside', R, 2, offset);
    expect(bbox(outside).x1 - bbox(outside).x0).toBeCloseTo(40 + 2 * (R + 2), 6);
    const inside = profilePath(rect(40, 20), 'inside', R, 2, offset);
    expect(bbox(inside).x1 - bbox(inside).x0).toBeCloseTo(40 - 2 * (R + 2), 6);
  });

  it('reverses an INSIDE path to CW, the conventional-milling direction', () => {
    const path = profilePath(rect(40, 20), 'inside', R, 0, offset);
    expect(path.length).toBe(1);
    expect(signedArea(path[0]!)).toBeLessThan(0);
  });
});

describe('placeTabs (#218)', () => {
  it('places four tabs on a long-edged rectangle, each wholly on one edge', () => {
    const path = profilePath(rect(40, 20), 'outside', R, 0, offset);
    const placement = placeTabs(path[0]!, 4, 4, R);
    expect(placement.unplaceable).toBe(0);
    expect(placement.spans.length).toBe(4);
    // Centre-path span = tab width + 2r = 7.175.
    for (const span of placement.spans) {
      const length = Math.hypot(span.end[0] - span.start[0], span.end[1] - span.start[1]);
      expect(length).toBeCloseTo(7.175, 6);
      const onHorizontal = span.start[1] === span.end[1];
      const onVertical = span.start[0] === span.end[0];
      expect(onHorizontal || onVertical).toBe(true);
    }
  });

  it('reports tabs it cannot place when the only edge is shorter than the span', () => {
    // A 5 x 2 rectangle has four edges; 4 + 2r = 7.175 fits none of them.
    const placement = placeTabs(rect(5, 2)[0]!, 4, 4, R);
    expect(placement.spans.length).toBe(0);
    expect(placement.unplaceable).toBe(4);
  });

  it('a short edge holds one centred tab; the 3 mm sides take none (#1206)', () => {
    // #1206 — on a 20 x 3 rectangle the margin is max(2 x 4, 10 % of 20) = 8 mm; a tab is 4 mm of
    // material at the edge's midpoint, its kept edge exactly 8 mm from the corner, so ONE tab fits
    // each 20 mm side. The 3 mm sides are shorter than the 7.175 mm span and take none; the other
    // four of six are unplaceable.
    const placement = placeTabs(rect(20, 3)[0]!, 6, 4, R);
    expect(placement.spans.length).toBe(2);
    expect(placement.unplaceable).toBe(4);
    expect(placement.added).toBe(0);
  });

  it('places four tabs on a polygonised circle, each following the arc (#736)', () => {
    // A 60 mm round cut-out: every joint turns 2°, far below the 20° corner, so the whole outline
    // is ONE smooth arc edge. None of its ~1 mm segments is 6.175 mm long; before #736 each was
    // its own edge and all four tabs were `tab-unplaceable`.
    const outline = circle(30);
    const placement = placeTabs(outline[0]!, 4, 3, R);
    expect(placement.unplaceable).toBe(0);
    expect(placement.spans).toHaveLength(4);
    for (const span of placement.spans) {
      // The span is the tab width plus a radius at each end, measured along the PATH.
      expect(spanAlong(span)).toBeCloseTo(3 + 2 * R, 6);
      // It crosses the polygon's joints, so more than its two ends define it...
      expect(span.points.length).toBeGreaterThan(2);
      // ...and its ends are a chord, shorter than the path between them: it is not a straight
      // rectangle across the circle.
      const chord = Math.hypot(span.end[0] - span.start[0], span.end[1] - span.start[1]);
      expect(chord).toBeLessThan(spanAlong(span) - 0.001);
      // Every point is on the circle (interpolated ends lie on a chord, within the 0.005 mm
      // chord tolerance of it).
      for (const [x, y] of span.points) {
        expect(Math.hypot(x, y)).toBeGreaterThan(29.99);
        expect(Math.hypot(x, y)).toBeLessThanOrEqual(30 + 1e-9);
      }
    }
  });

  it('treats a traced straight side as one edge, however many collinear segments it holds (#736)', () => {
    // j23's diamond sign: four 70 mm straight sides, each traced as 14 five-mm collinear pieces,
    // joined by 4 mm fillets. A 6.175 mm span fits none of the pieces and none of the fillets'
    // segments; it fits the 70 mm SIDE. Before collinear segments were merged into one edge, all
    // four tabs refused.
    const outline = roundedDiamondPoints();
    let perimeter = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    const placement = placeTabs(outline, 4, 3, R);
    expect(placement.unplaceable).toBe(0);
    expect(placement.spans).toHaveLength(4);
    for (const span of placement.spans) {
      expect(spanAlong(span)).toBeCloseTo(3 + 2 * R, 6);
      // The span is straight (every side piece is collinear) and crosses a traced joint.
      const [ax, ay] = span.start;
      const [bx, by] = span.end;
      const length = Math.hypot(bx - ax, by - ay);
      for (const [x, y] of span.points) {
        expect(Math.abs((bx - ax) * (ay - y) - (ax - x) * (by - ay)) / length).toBeLessThan(1e-6);
      }
      expect(span.points.length).toBeGreaterThan(2);
    }
    // One tab in each quarter of the path: four different sides, not four tabs on one.
    const quarters = new Set(placement.spans.map((span) => Math.floor(span.startArc / (perimeter / 4))));
    expect(quarters.size).toBe(4);
  });
});

describe('placeTabs mid-side (#1206)', () => {
  /** The geometric centre of a span on a straight edge (its ends' midpoint). */
  const centreOf = (span: { start: readonly [number, number]; end: readonly [number, number] }): [number, number] => [
    (span.start[0] + span.end[0]) / 2,
    (span.start[1] + span.end[1]) / 2,
  ];
  /** A cyclic arc gap from each span's end to the next span's start. */
  function gaps(spans: readonly { startArc: number; endArc: number }[], perimeter: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < spans.length; i++) {
      const next = spans[(i + 1) % spans.length]!;
      const span = spans[i]!;
      if (spans.length === 1) {
        out.push(perimeter - (span.endArc - span.startArc));
        continue;
      }
      let gap = (next.startArc - span.endArc) % perimeter;
      if (gap < 0) gap += perimeter;
      out.push(gap);
    }
    return out;
  }

  it('four tabs on a 160 x 126 rectangle are centred on the four side midpoints', () => {
    const placement = placeTabs(rect(160, 126)[0]!, 4, 4, R);
    expect(placement.unplaceable).toBe(0);
    expect(placement.added).toBe(0);
    expect(placement.spans).toHaveLength(4);
    const mids: [number, number][] = [
      [80, 0],
      [160, 63],
      [80, 126],
      [0, 63],
    ];
    for (const [mx, my] of mids) {
      expect(
        placement.spans.some((span) => {
          const [cx, cy] = centreOf(span);
          return Math.hypot(cx - mx, cy - my) <= 0.01;
        }),
        `a span is centred at (${mx}, ${my})`,
      ).toBe(true);
    }
  });

  it('two tabs on the same rectangle take the two 160 mm sides', () => {
    const placement = placeTabs(rect(160, 126)[0]!, 2, 4, R);
    expect(placement.spans).toHaveLength(2);
    const centres = placement.spans.map(centreOf);
    for (const [cx, cy] of centres) {
      expect(cx).toBeCloseTo(80, 2);
      expect(cy === 0 || cy === 126).toBe(true);
    }
  });

  it('the same rule holds on the REAL offset path (four side midpoints, 160 x 126)', () => {
    // The CAM never places on the raw outline: it places on the offset centre path, whose sides
    // are ONE segment each between the round joins. Before #1206's single-segment edge rule the
    // whole offset rectangle was one smooth edge and every tab kept equal spacing.
    const path = profilePath(rect(160, 126), 'outside', R, 0, offset);
    expect(path).toHaveLength(1);
    const placement = placeTabs(path[0]!, 4, 4, R);
    expect(placement.unplaceable).toBe(0);
    expect(placement.spans).toHaveLength(4);
    const mids: [number, number][] = [
      [80, -R],
      [160 + R, 63],
      [80, 126 + R],
      [-R, 63],
    ];
    for (const [mx, my] of mids) {
      expect(
        placement.spans.some((span) => {
          const [cx, cy] = centreOf(span);
          return Math.hypot(cx - mx, cy - my) <= 0.01;
        }),
        `a span is centred at (${mx}, ${my})`,
      ).toBe(true);
    }
  });

  it('an L-shaped outline centres every tab on an edge, outside the corner margins', () => {
    // Side lengths 120, 40, 80, 60, 40, 100. The four longest take the four requested tabs, each
    // at its own midpoint.
    const outline: [number, number][] = [
      [0, 0],
      [120, 0],
      [120, 40],
      [40, 40],
      [40, 100],
      [0, 100],
    ];
    const placement = placeTabs(outline, 4, 4, R);
    expect(placement.unplaceable).toBe(0);
    expect(placement.spans).toHaveLength(4);
    const mids: [number, number][] = [
      [60, 0],
      [80, 40],
      [40, 70],
      [0, 50],
    ];
    for (const [mx, my] of mids) {
      expect(
        placement.spans.some((span) => {
          const [cx, cy] = centreOf(span);
          return Math.hypot(cx - mx, cy - my) <= 0.01;
        }),
        `a span is centred at (${mx}, ${my})`,
      ).toBe(true);
    }
  });

  it('a hexagonal outline puts one tab at each of its six edge midpoints', () => {
    const r = 60;
    const outline: [number, number][] = Array.from({ length: 6 }, (_, i) => [
      r * Math.cos((i * Math.PI) / 3),
      r * Math.sin((i * Math.PI) / 3),
    ]);
    const placement = placeTabs(outline, 6, 4, R);
    expect(placement.unplaceable).toBe(0);
    expect(placement.spans).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % 6]!;
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      expect(
        placement.spans.some((span) => {
          const [cx, cy] = centreOf(span);
          return Math.hypot(cx - mx, cy - my) <= 0.01;
        }),
        `a span is centred on edge ${i}`,
      ).toBe(true);
    }
  });

  it('the span limit adds tabs until no stretch of the outline is longer than it', () => {
    // A 400 x 400 square: the 10 % margin is 40 mm a side and six tabs a side divide it into
    // 57.1 mm steps, so a 120 mm limit is met everywhere (the corner stretch is 107.1 mm).
    const placement = placeTabs(rect(400, 400)[0]!, 2, 4, R, { maxSpanMm: 120 });
    expect(placement.spans.length).toBeGreaterThan(2);
    expect(placement.unplaceable).toBe(0);
    expect(placement.added).toBe(placement.spans.length - 2);
    // Every gap around the whole outline is within the limit.
    for (const gap of gaps(placement.spans, 4 * 400)) expect(gap).toBeLessThanOrEqual(120 + 1e-6);
  });

  it('the analyst’s 300 x 60 x 3 case: 2 tabs requested, every stretch within 40 mm', () => {
    // The 3 mm-stock recommendation (40 mm) is met: each long side divides into eighths and each
    // short side into sixths, and the corner stretches come to 36.2 mm.
    const placement = placeTabs(rect(300, 60)[0]!, 2, 4, R, { maxSpanMm: 40 });
    expect(placement.unplaceable).toBe(0);
    expect(placement.added).toBeGreaterThan(0);
    expect(placement.spans.length).toBe(placement.added + 2);
    for (const gap of gaps(placement.spans, 2 * (300 + 60))) expect(gap).toBeLessThanOrEqual(40 + 1e-6);
  });

  it('a short 15–25 mm edge keeps one centred tab even with the shop’s 6 mm tabs (#1206)', () => {
    // The regression the base-samples diff caught: relief perimeters are 15–25 mm edges, and
    // 2 x 6 mm of margin at each end would empty every one — the part would post with no tabs and
    // no finding. The capped margin keeps one centred tab on any edge that fits a span.
    const placement = placeTabs(rect(22, 18)[0]!, 4, 6, R);
    expect(placement.unplaceable).toBe(0);
    expect(placement.added).toBe(0);
    expect(placement.spans).toHaveLength(4);
    const mids: [number, number][] = [
      [11, 0],
      [22, 9],
      [11, 18],
      [0, 9],
    ];
    for (const [mx, my] of mids) {
      expect(
        placement.spans.some((span) => {
          const [cx, cy] = centreOf(span);
          return Math.hypot(cx - mx, cy - my) <= 0.01;
        }),
        `a span is centred at (${mx}, ${my})`,
      ).toBe(true);
    }
  });

  it('a stretch no margin-respecting place can close takes one tight centred tab (step 2)', () => {
    // Two margin-respecting edges (27 and 15) and a wall of 7 mm teeth — each too short for a
    // margin tab but wide enough for the 6 mm tab's width. The margin places two tabs; the stretch
    // they leave is ~170 mm, so step 2 puts centred tabs on the longest edges inside it until no
    // stretch is longer than the 80 mm limit.
    const outline: [number, number][] = [
      [0, 0],
      [27, 0],
      [27, 15],
    ];
    for (let k = 1; k <= 18; k++) outline.push([27 - 2 * k, k % 2 === 1 ? 21.7 : 15]);
    outline.push([-3, 12], [0, 9], [-3, 6], [0, 3], [0, 0]);
    let perimeter = 0;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    const placement = placeTabs(outline, 4, 6, R, { maxSpanMm: 80 });
    expect(placement.tight.length).toBeGreaterThan(0);
    expect(longestTabGap(placement.spans, perimeter)).toBeLessThanOrEqual(80 + 1e-6);
    for (const tight of placement.tight) {
      expect(tight.stretchMm).toBeGreaterThan(80);
      // The tab sits inside the usual 2 x width corner margin — that is what makes it "tight".
      expect(tight.cornerMm).toBeLessThan(12);
      // On this outline the span crosses the teeth's joins; the sheet states the count.
      expect(tight.joins).toBeGreaterThanOrEqual(1);
      expect(tight.sharpJoins).toBeGreaterThanOrEqual(0);
      expect(tight.sharpJoins).toBeLessThanOrEqual(tight.joins);
    }
    expect(placement.added).toBe(placement.spans.length - 4);
  });

  it('a limit the corner margins cannot meet still fills every edge, and the margin wins', () => {
    // A 20 x 12 part with a 7 mm limit: each side holds one centred tab (the capped margin keeps
    // a tab as far from the corners as the edge allows), so the span limit adds one to each 12 mm
    // side. Four tabs is every edge's capacity; the corner stretches are 12 mm and stay longer
    // than the limit — the margins are the hard rule and the planner places what it can.
    const placement = placeTabs(rect(20, 12)[0]!, 2, 4, R, { maxSpanMm: 7 });
    expect(placement.unplaceable).toBe(0);
    expect(placement.spans).toHaveLength(4);
    expect(placement.added).toBe(2);
    const worst = Math.max(...gaps(placement.spans, 2 * (20 + 12)));
    expect(worst).toBeGreaterThan(7);
  });

  it('without a span limit the requested count is all that is placed', () => {
    const placement = placeTabs(rect(300, 60)[0]!, 2, 4, R);
    expect(placement.spans).toHaveLength(2);
    expect(placement.added).toBe(0);
  });
});

describe('kerf and tab rectangles (#218)', () => {
  it('the kerf is a band one diameter wide around the path', () => {
    const path = profilePath(rect(40, 20), 'outside', R, 0, offset);
    const kerf = kerfPolygons(path, R, offset);
    const b = bbox(kerf);
    // Outer by r past the path, inner by r inside it.
    expect(b.x1 - b.x0).toBeCloseTo(43.175 + 2 * R, 6);
    expect(kerf.length).toBe(2);
    // The inner contour is a hole (CW) so the positive fill rule subtracts it.
    expect(kerf.filter((c) => signedArea(c) < 0).length).toBe(1);
  });

  it('a tab bridge is `width` long and reaches a whisker past the kerf either side', () => {
    const span = {
      startArc: 0,
      endArc: 7.175,
      start: [0, 0] as [number, number],
      end: [7.175, 0] as [number, number],
      points: [
        [0, 0],
        [7.175, 0],
      ] as [number, number][],
    };
    const [rectangle] = tabBridgeRectangles([span], R, 0.05);
    expect(rectangle).toBeDefined();
    const b = bbox([rectangle!]);
    expect(b.x1 - b.x0).toBeCloseTo(7.175 - 2 * R, 6);
    // The kerf is one diameter across; the bridge is that plus the overshoot on each side, so it
    // MEETS the part and the waste by area instead of on a shared edge (#750).
    expect(b.y1 - b.y0).toBeCloseTo(2 * R + 2 * 0.05, 6);
  });
});

describe('tab bands follow the span (#736)', () => {
  // A tight circle makes the chord and the arc measurably different: at 8 mm radius an 8 mm span
  // along the path is 1 rad, so its chord sags 0.98 mm below the arc — a rectangle across the
  // chord cannot pass as the arc's band.
  const RC = 8;
  const outline = circle(RC);

  /** One 8 mm span, centred on the circle's vertex at angle π (the −X side). */
  function arcSpan() {
    const placement = placeTabs(outline[0]!, 1, 8 - 2 * R, R);
    expect(placement.spans).toHaveLength(1);
    return placement.spans[0]!;
  }

  it('the kept band follows the arc instead of chording it', () => {
    // The oracle's own kept region: the swept band at zero inset, one radius either side.
    const band = tabBars([arcSpan()], 0, R)[0];
    expect(band).toBeDefined();
    // More than a four-corner rectangle: it has a vertex at each intermediate path point.
    expect(band!.length).toBeGreaterThan(4);
    expect(signedArea(band!)).toBeLessThan(0);
    // At the span's midpoint (the vertex at angle π) both sides are one radius off the path.
    // A band built across the chord has no vertex at its midpoint at all — its ends are its only
    // vertices.
    const atMid = polar(band!).filter((p) => Math.abs(Math.abs(p.angle) - Math.PI) < 1e-6);
    expect(atMid.some((p) => Math.abs(p.radius - (RC + R)) < 0.005)).toBe(true);
    expect(atMid.some((p) => Math.abs(p.radius - (RC - R)) < 0.005)).toBe(true);
  });

  it('the bridge band reaches past BOTH kerf edges at the arc midpoint, so part and waste meet', () => {
    const bridge = tabBridgeRectangles([arcSpan()], R, 0.05)[0];
    expect(bridge).toBeDefined();
    expect(bridge!.length).toBeGreaterThan(4);
    expect(signedArea(bridge!)).toBeLessThan(0);
    const atMid = polar(bridge!).filter((p) => Math.abs(Math.abs(p.angle) - Math.PI) < 1e-6);
    // The kerf spans [RC - R, RC + R]. A tab is the bridge between the part and the waste, so the
    // widened band must reach past each side of that band.
    expect(Math.min(...atMid.map((p) => p.radius))).toBeLessThan(RC - R);
    expect(Math.max(...atMid.map((p) => p.radius))).toBeGreaterThan(RC + R);
    // And it is the widened band, not the tab's own width: half-width r plus the 0.05 mm
    // overshoot at the midpoint (#750).
    const reach = R + 0.05;
    expect(atMid.some((p) => Math.abs(p.radius - (RC - reach)) < 0.01)).toBe(true);
    expect(atMid.some((p) => Math.abs(p.radius - (RC + reach)) < 0.01)).toBe(true);
  });
});

describe('generateProfile (#218)', () => {
  const cut = (tabs: { count: number; width: number; height: number }): ProfileCut => ({
    id: 'cut-1',
    name: 'Cut-out',
    path: profilePath(rect(40, 20), 'outside', R, 0, offset),
    depth: 6.3,
    thickness: 6,
    tabs,
  });

  it('emits one through operation with all of the depth passes', () => {
    const { ir, tabs } = generateProfile([cut({ count: 4, width: 4, height: 1 })], MILL, PARAMS, Z1.rapidEstimate);
    expect(ir.operations.length).toBe(1);
    expect(ir.operations[0]!.passKind).toBe('through');
    expect(tabs[0]).toMatchObject({ id: 'cut-1', spans: 4, unplaceable: 0 });
    // 6.3 mm at 1 mm per pass -> z = -1 ... -6.3 (7 passes).
    const zs = [...new Set(ir.operations[0]!.moves.filter((m) => m.kind === 'feed').map((m) => m.z))].sort((a, b) => a - b);
    expect(zs[0]).toBeCloseTo(-6.3, 6);
    expect(zs.length).toBe(7);
  });

  it('retracts vertically to the tab top and crosses there on every pass below it', () => {
    const { ir } = generateProfile([cut({ count: 4, width: 4, height: 1 })], MILL, PARAMS, Z1.rapidEstimate);
    const moves = ir.operations[0]!.moves;
    const tabTopZ = -(6 - 1);
    const crossings = moves.filter(
      (m, i) => m.kind === 'feed' && m.z === tabTopZ && i > 0 && moves[i - 1]!.kind === 'rapid' && moves[i - 1]!.z === tabTopZ,
    );
    // Four tabs on each pass BELOW the tab top: at 1 mm steps the tab top is z = -5, so only
    // the -6 and -6.3 passes cross (two passes x 4 tabs).
    expect(crossings.length).toBe(2 * 4);
    // Each crossing is constant-Z: the retract and the cross share Z, and the following move is
    // the vertical plunge back to the pass.
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]!;
      if (m.kind !== 'feed' || m.z !== tabTopZ) continue;
      const previous = moves[i - 1]!;
      if (previous.kind !== 'rapid' || previous.z !== tabTopZ) continue;
      // The cross is horizontal, then the next move plunges at the same XY.
      const next = moves[i + 1]!;
      expect(next.kind).toBe('feed');
      expect(next.x).toBeCloseTo(m.x, 9);
      expect(next.y).toBeCloseTo(m.y, 9);
      expect(next.z).toBeLessThan(tabTopZ);
    }
  });

  it('with no tabs the contour runs continuously at every pass', () => {
    const { ir, tabs } = generateProfile([cut({ count: 0, width: 4, height: 1 })], MILL, PARAMS, Z1.rapidEstimate);
    expect(tabs[0]!.spans).toBe(0);
    const tabTopZ = -(6 - 1);
    // A pass lands exactly at the tab top (z = -5); with no tabs there is no RETRACT to that Z,
    // so no rapid at it. (The feed pass at -5 is the ordinary cut.)
    expect(ir.operations[0]!.moves.some((m) => m.kind === 'rapid' && m.z === tabTopZ)).toBe(false);
  });

  it('crosses an arc tab along the arc’s points, not across its chord (#736)', () => {
    // A round cut-out holds four tabs on its one smooth edge. Each crossing must feed through the
    // span's intermediate path points at the tab top: a single straight G1 from span start to
    // span end would be a chord, and the material the simulation keeps would differ from the
    // curved band the oracle predicts.
    const round: ProfileCut = {
      id: 'round',
      name: 'Round',
      path: circle(30),
      depth: 6.3,
      thickness: 6,
      tabs: { count: 4, width: 3, height: 1 },
    };
    const { ir, tabs } = generateProfile([round], MILL, PARAMS, Z1.rapidEstimate);
    expect(tabs[0]).toMatchObject({ spans: 4, unplaceable: 0 });
    const moves = ir.operations[0]!.moves;
    const tabTopZ = -(6 - 1);
    const runs: { x: number; y: number }[][] = [];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i]!;
      if (m.kind !== 'rapid' || m.z !== tabTopZ) continue;
      const run: { x: number; y: number }[] = [];
      for (let j = i + 1; j < moves.length; j++) {
        const next = moves[j]!;
        if (next.kind !== 'feed' || next.z !== tabTopZ) break;
        run.push({ x: next.x, y: next.y });
      }
      runs.push(run);
    }
    // Two passes below the tab top (z = -6 and -6.3), four tabs each.
    expect(runs).toHaveLength(2 * 4);
    for (const run of runs) {
      // More than one feed between the retract and the plunge: the crossing follows the arc.
      expect(run.length).toBeGreaterThan(1);
      for (const p of run) {
        // Every crossing point is on the 30 mm path (an interpolated end lies on a chord, within
        // the 0.005 mm chord tolerance of the circle).
        expect(Math.hypot(p.x, p.y)).toBeGreaterThan(29.99);
        expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(30 + 1e-9);
      }
    }
  });
});

describe('slotting feeds for a profile cut (#218)', () => {
  const cut = (tabs: { count: number; width: number; height: number }): ProfileCut => ({
    id: 'cut-1',
    name: 'Cut-out',
    path: profilePath(rect(40, 20), 'outside', R, 0, offset),
    depth: 6.3,
    thickness: 6,
    tabs,
  });

  it('halves the step-down, so the profile takes twice the pocket passes', () => {
    // The SAME row answers both: pocketing is what the feeds row describes, and a profile cut
    // is a full-width slot. `slotting` is the one difference.
    const pocket = feedsFor([], 'softwood', MILL, Z1, NO_SHOP.refuse);
    const slot = feedsFor([], 'softwood', MILL, Z1, NO_SHOP.refuse, undefined, undefined, { slotting: true });
    expect(pocket.ok).toBe(true);
    expect(slot.ok).toBe(true);
    if (!pocket.ok || !slot.ok) return;

    expect(slot.params.stepDown).toBeCloseTo(pocket.params.stepDown / 2, 9);

    // A depth that is a whole number of pocket passes: 6 passes become 12.
    const depth = pocket.params.stepDown * 6;
    expect(zPasses(depth, pocket.params.stepDown).length).toBe(6);
    expect(zPasses(depth, slot.params.stepDown).length).toBe(12);

    // And the CAM really uses the handed-down number: the same cut at the slotting step-down
    // reaches twice as many distinct Z levels.
    const cutDepth = {
      ...cut({ count: 0, width: 4, height: 1 }),
      depth,
      thickness: depth,
    };
    const levels = (params: CutParams): number =>
      new Set(
        generateProfile([cutDepth], MILL, params, Z1.rapidEstimate).ir.operations[0]!.moves
          .filter((m) => m.kind === 'feed')
          .map((m) => m.z),
      ).size;
    expect(levels(slot.params)).toBe(2 * levels(pocket.params));
  });
});
