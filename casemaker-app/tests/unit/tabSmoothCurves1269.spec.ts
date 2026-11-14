/**
 * #1269 — A SMOOTH CURVE HAS NO CORNERS.
 *
 * petit-pot-lid is a circle. Its centre path reached the corner-margin rule as 160 edges: 36 joints
 * read as corners beside segments of 0.0002 mm (rounding, not geometry), and a collinear PAIR of
 * chords was promoted to a straight edge and cut the arc. And a clean circle never had its tab count
 * raised to meet the span limit. Three changes in the placement — nothing moves a path, only where the
 * tabs go:
 *   1. a segment shorter than the posted step has no direction (skipped for direction only);
 *   2. a collinear run shorter than `minStraightLength` does not end an arc edge;
 *   3. the round branch raises the count to what the span limit needs, evenly (reported in `added`).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { edgesOf, placeTabs, segmentsOf } from '../../src/engine/cnc/cam/profile';

type Ring = [number, number][];
const polygon = (n: number, radius: number): Ring =>
  Array.from({ length: n }, (_, i) => [radius * Math.cos((2 * Math.PI * i) / n), radius * Math.sin((2 * Math.PI * i) / n)] as [number, number]);

/** Insert, after vertex `i`, a second vertex `eps` mm further along the same edge — the offset's join noise. */
function withNoise(ring: Ring, at: number[], eps: number): Ring {
  const out: Ring = [];
  ring.forEach((p, i) => {
    out.push(p);
    if (at.includes(i)) {
      const q = ring[(i + 1) % ring.length]!;
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      // a point eps along the edge, perturbed sideways by the rounding the posted grid would cause
      out.push([p[0] + ((q[0] - p[0]) / len) * eps, p[1] + ((q[1] - p[1]) / len) * eps + eps * 0.8]);
    }
  });
  return out;
}

const STEP = 0.001; // the Z1's posted step
const CORNER = (20 * Math.PI) / 180;
const edgeCount = (ring: Ring, minStraight: number): number => {
  const { segments, perimeter } = segmentsOf(ring);
  return edgesOf(segments, perimeter, minStraight, CORNER, STEP).length;
};

describe('#1269 change 1: a segment shorter than the posted step has no direction', () => {
  it('a 64-gon with a 0.0002 mm vertex at five joints has no corners', () => {
    const circle = polygon(64, 12);
    const noisy = withNoise(circle, [3, 17, 30, 44, 58], 0.0002);
    expect(edgeCount(noisy, 12)).toBe(1);
  });

  it('a square with the same noise at each corner still has exactly four edges', () => {
    const square: Ring = [[0, 0], [20, 0], [20, 20], [0, 20]];
    const noisy = withNoise(square, [0, 1, 2, 3], 0.0002);
    expect(edgeCount(square, 12)).toBe(4);
    expect(edgeCount(noisy, 12)).toBe(4);
  });

  it('nothing moves in arc length: the noisy path keeps its perimeter and every position', () => {
    const circle = polygon(64, 12);
    const noisy = withNoise(circle, [3, 17], 0.0002);
    const a = placeTabs(circle, 4, 6, 3, { maxSpanMm: 80 });
    const b = placeTabs(noisy, 4, 6, 3, { maxSpanMm: 80 });
    expect(b.spans.length).toBe(a.spans.length);
    for (let i = 0; i < a.spans.length; i++) {
      expect(Math.hypot(b.spans[i]!.start[0] - a.spans[i]!.start[0], b.spans[i]!.start[1] - a.spans[i]!.start[1])).toBeLessThan(0.01);
    }
  });
});

describe('#1269 change 2: a short collinear run does not end an arc', () => {
  const petit = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tabs1269', 'petit-path.json'), 'utf8')) as { ring: Ring }).ring;

  it("petit-pot-lid's own path is ONE edge spanning the perimeter", () => {
    const { segments, perimeter } = segmentsOf(petit);
    const edges = edgesOf(segments, perimeter, 10, CORNER, STEP);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.end - edges[0]!.start).toBeGreaterThanOrEqual(perimeter - 1e-6);
  });

  it('a stadium (two 40 mm straights, two semicircles) has four edges', () => {
    const r = 10;
    const arc = (cx: number, from: number): Ring =>
      Array.from({ length: 17 }, (_, i) => {
        const a = from + (Math.PI * i) / 16;
        return [cx + r * Math.cos(a), r * Math.sin(a)] as [number, number];
      });
    // right semicircle from -90° to +90° around x = 40, then left from 90° to 270° around x = 0
    const stadium: Ring = [...arc(40, -Math.PI / 2), ...arc(0, Math.PI / 2).slice(0, 17)];
    expect(edgeCount(stadium, 12)).toBe(4);
  });
});

describe('#1269 change 3: a cornerless closed outline gets as many evenly spaced tabs as the limit needs', () => {
  const circle = polygon(64, 12); // perimeter ≈ 75.3 mm; a 6 mm tab with a 3 mm cutter spans 12 mm

  it('limit 40, count 1: tabs are added until no stretch is over the limit — no refusal, no question', () => {
    for (const tabChoice of [undefined, 'ask' as const]) {
      const placed = placeTabs(circle, 1, 6, 3, { maxSpanMm: 40, ...(tabChoice === undefined ? {} : { tabChoice }) });
      expect(placed.spans.length).toBeGreaterThan(1);
      expect(placed.added).toBe(placed.spans.length - 1);
      expect(placed.unplaceable).toBe(0);
      expect(placed.stretches ?? []).toEqual([]);
      // evenly spaced
      const gaps = placed.spans.map((s, i) => {
        const next = placed.spans[(i + 1) % placed.spans.length]!;
        let g = next.startArc - s.endArc;
        if (g < 0) g += 75.3982;
        return g;
      });
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.5);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(40 + 1e-6);
    }
  });

  it('the count asked is already enough: unchanged', () => {
    const placed = placeTabs(circle, 4, 6, 3, { maxSpanMm: 80 });
    expect(placed.spans).toHaveLength(4);
    expect(placed.added).toBe(0);
  });

  it('even n tabs would touch: the count asked is placed and the stretch is reported with no candidates', () => {
    const asked = placeTabs(circle, 1, 6, 3, { maxSpanMm: 0.5, tabChoice: 'ask' });
    expect(asked.spans).toHaveLength(1);
    expect(asked.added).toBe(0);
    expect(asked.stretches).toHaveLength(1);
    expect(asked.stretches![0]!.candidates).toEqual([]);
  });

  it("petit-pot-lid: four evenly spaced tabs (the count asked; three would meet the limit), nothing asked", () => {
    const petit = (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tabs1269', 'petit-path.json'), 'utf8')) as { ring: Ring }).ring;
    const placed = placeTabs(petit, 4, 6, 2, { maxSpanMm: 80, tabChoice: 'ask' });
    expect(placed.spans).toHaveLength(4);
    expect(placed.added).toBe(0);
    expect(placed.stretches).toEqual([]);
    expect(placed.tight).toEqual([]);
  });
});
