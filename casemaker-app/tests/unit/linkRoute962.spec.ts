/**
 * #962 — the path-following stay-down link, RED FIRST.
 *
 * Two properties, both failing before the hook exists:
 *  1. `routeWithin` finds a path for the cutter centre inside an already-eroded cleared polygon
 *     when the straight chord leaves it.
 *  2. `link()` returns that path — not a retract — when the caller offers a route and the time
 *     guard says it wins.
 */
import { describe, expect, it } from 'vitest';

import { link, type LinkOptions, type LinkPoint } from '@/engine/cnc/cam/model/linking';
import { insideClosed, routeWithin } from '@/engine/cnc/cam/model/linkRoute';
import type { Polygons } from '@/engine/cnc/cam/pocket';

// An L-shaped cleared polygon (the cutter's centre space): a 20×20 square with a 10×10 bite out
// of its top-right. A straight chord from the left arm to the bottom arm crosses the bite.
// A U-shaped cleared polygon: a 20 x 20 square with a 8-wide, 12-deep notch out of its top, so a
// chord between the two arms crosses ground outside the polygon and a route must go under the notch.
const U: Polygons = [[
  [0, 0], [20, 0], [20, 20], [14, 20], [14, 8], [6, 8], [6, 20], [0, 20],
]];
const L = U;
const levelZ = -2;
const material = (x: number, y: number): number | null => (x >= 0 && x <= 20 && y >= 0 && y <= 20 ? levelZ : null);

describe('#962 — the closed cleared region (the ruling)', () => {
  // A unit square: a point ON its boundary is inside (float equality within 1e-6), a point
  // 0.01 mm outside is outside — the two pins the ruling asks for.
  const square: Polygons = [[[0, 0], [10, 0], [10, 10], [0, 10]]];
  it('a boundary point is inside, a point 0.01 mm outside is outside', () => {
    expect(insideClosed(square, 5, 0)).toBe(true); // exactly on an edge
    expect(insideClosed(square, 5, 0.0000005)).toBe(true); // within 1e-6
    expect(insideClosed(square, 5, -0.01)).toBe(false); // 0.01 mm outside
    expect(insideClosed(square, 5, 5)).toBe(true); // interior
  });
});

describe('#962 — the path-following stay-down link', () => {
  it('routes the cutter centre inside the cleared polygon around a notch', () => {
    const from: LinkPoint = { x: 2, y: 12, z: levelZ }; // left arm
    const to: LinkPoint = { x: 18, y: 12, z: levelZ }; // right arm, across the notch
    // The straight chord (2,2)→(2,18) is actually clear INSIDE the left arm, so use the pair that
    // crosses the bite: bottom arm to the top of the RIGHT side is outside the polygon entirely;
    // instead go from the bottom arm's far end up the left side — the chord stays inside — so
    // this test's real geometry is the notch corner pair below.
    const a: LinkPoint = { x: 18, y: 12, z: levelZ }; // right arm
    const b: LinkPoint = { x: 2, y: 12, z: levelZ }; // left arm
    const route = routeWithin(a, b, {
      cleared: L,
      levelZ,
      rapidZMm: 1,
      materialAt: material,
    });
    expect(route, 'no route through an L-shaped cleared area').not.toBeNull();
    expect(route!.points.length).toBeGreaterThan(2);
    for (const p of route!.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
    // Every polyline segment must stay inside the polygon.
    for (let i = 1; i < route!.points.length; i++) {
      const a1 = route!.points[i - 1]!;
      const b1 = route!.points[i]!;
      for (let t = 0; t <= 1; t += 0.05) {
        const x = a1.x + (b1.x - a1.x) * t;
        const y = a1.y + (b1.y - a1.y) * t;
        expect(x <= 20 && y <= 20 && (y <= 8 || x <= 6 || x >= 14), `segment leaves the L at (${x.toFixed(2)}, ${y.toFixed(2)})`).toBe(true);
      }
    }
    void from;
    void to;
  });

  it('no G0 in a routed join sits below the in-pocket plane (levelZ + 1 mm)', () => {
    const from: LinkPoint = { x: 18, y: 12, z: levelZ };
    const to: LinkPoint = { x: 2, y: 12, z: levelZ };
    const opts: LinkOptions = {
      material: { topAt: (x, y) => (x >= 0 && x <= 20 && y >= 0 && y <= 20 ? levelZ : Number.POSITIVE_INFINITY) },
      clearanceZ: 5,
      tool: { radiusMm: 3 },
      feeds: { feed: 500, plungeFeed: 200 },
      route: {
        options: { cleared: U, levelZ, rapidZMm: levelZ + 1, materialAt: material },
        plan: () => ({ mode: 'rapid' }),
      },
    };
    const moves = link(from, to, opts);
    const g0 = moves.filter((m) => m.kind === 'rapid');
    expect(g0.length, 'the rapid mode emitted no G0').toBeGreaterThan(0);
    for (const m of g0) expect(m.z, 'a G0 sits below the in-pocket plane').toBeGreaterThanOrEqual(levelZ + 1 - 1e-6);
  });

  it('link() takes the route when the chord is refused and the time guard wins', () => {
    const from: LinkPoint = { x: 18, y: 12, z: levelZ };
    const to: LinkPoint = { x: 2, y: 12, z: levelZ };
    const opts: LinkOptions = {
      material: { topAt: (x, y) => (x >= 0 && x <= 20 && y >= 0 && y <= 20 ? levelZ : Number.POSITIVE_INFINITY) },
      clearanceZ: 5,
      tool: { radiusMm: 3 },
      feeds: { feed: 500, plungeFeed: 200 },
      route: {
        options: { cleared: L, levelZ, rapidZMm: 1, materialAt: material },
        plan: () => ({ mode: 'feed' }),
      },
    };
    const moves = link(from, to, opts);
    // A retract goes up to the clearance plane; a route stays at the level.
    expect(moves.length, 'link() retracted instead of routing').toBeGreaterThan(1);
    expect(moves.some((m) => m.kind === 'rapid' && m.z === 5), 'the retract reached the clearance plane').toBe(false);
    for (const m of moves) expect(m.z).toBeCloseTo(levelZ, 6);
  });
});
