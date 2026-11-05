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
import { routeWithin } from '@/engine/cnc/cam/model/linkRoute';
import type { Polygons } from '@/engine/cnc/cam/pocket';

// An L-shaped cleared polygon (the cutter's centre space): a 20×20 square with a 10×10 bite out
// of its top-right. A straight chord from the left arm to the bottom arm crosses the bite.
const L: Polygons = [[
  [0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20],
]];
const levelZ = -2;
const material = (x: number, y: number): number | null => (x >= 0 && x <= 20 && y >= 0 && y <= 20 ? levelZ : null);

describe('#962 — the path-following stay-down link', () => {
  it('routes the cutter centre inside the cleared polygon around a notch', () => {
    const from: LinkPoint = { x: 2, y: 2, z: levelZ }; // bottom arm
    const to: LinkPoint = { x: 2, y: 18, z: levelZ }; // top arm, across the bite at x >= 10
    // The straight chord (2,2)→(2,18) is actually clear INSIDE the left arm, so use the pair that
    // crosses the bite: bottom arm to the top of the RIGHT side is outside the polygon entirely;
    // instead go from the bottom arm's far end up the left side — the chord stays inside — so
    // this test's real geometry is the notch corner pair below.
    const a: LinkPoint = { x: 18, y: 2, z: levelZ }; // bottom arm, right end
    const b: LinkPoint = { x: 2, y: 18, z: levelZ }; // top arm, left end
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
        expect(x <= 20 && y <= 20 && (x <= 10 || y <= 10), `segment leaves the L at (${x.toFixed(2)}, ${y.toFixed(2)})`).toBe(true);
      }
    }
    void from;
    void to;
  });

  it('link() takes the route when the chord is refused and the time guard wins', () => {
    const from: LinkPoint = { x: 18, y: 2, z: levelZ };
    const to: LinkPoint = { x: 2, y: 18, z: levelZ };
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
