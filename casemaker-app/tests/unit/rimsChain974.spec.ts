/**
 * #974 — THE RIM CHAIN CLOSES EVERY POCKET'S OWN LOOP.
 *
 * `features/rims.ts`'s old chainer stitched every sharp floor|wall segment in one pool and took
 * the FIRST unused edge at every endpoint. Where two pockets' rims touch at one vertex it can
 * walk from one floor's loop onto the other's, leaving the first closed loop open — the
 * organizer's rim-5, 77.2 mm open (E/B, #962). `closedRing()` used to bridge that gap (the
 * 77.2 mm phantom groove); the #962 guard now refuses the rim instead.
 *
 * These cases are the chainer's own contract, red first: a pocket's rim is the boundary of ITS
 * floor, so at a branch it continues on its own floor patch and closes on its own vertices.
 */
import { describe, expect, it } from 'vitest';

import { chainRimSegments, type RimSegment } from '@/engine/cnc/cam/model/features/rims';

const seg = (a: [number, number], b: [number, number], patch: number): RimSegment => ({
  a: [a[0], a[1], 0],
  b: [b[0], b[1], 0],
  patch,
});
const at = (q: [number, number, number]): string => `${q[0]},${q[1]}`;

describe('#974 the rim chain closes every pocket loop at a branch point', () => {
  it('two pockets whose rims meet at one vertex chain to TWO closed loops, one per floor patch', () => {
    // Square A (first quadrant) and square B (third quadrant) share only the vertex (0,0); they
    // are different floors (patches 0 and 1). Today's chainer walks one polyline through both.
    const segments: RimSegment[] = [
      seg([0, 0], [1, 0], 0),
      seg([1, 0], [1, 1], 0),
      seg([1, 1], [0, 1], 0),
      seg([0, 1], [0, 0], 0),
      seg([0, 0], [-1, 0], 1),
      seg([-1, 0], [-1, -1], 1),
      seg([-1, -1], [0, -1], 1),
      seg([0, -1], [0, 0], 1),
    ];
    const loops = chainRimSegments(segments);
    expect(loops, 'one loop per pocket').toHaveLength(2);
    for (const loop of loops) {
      expect(loop.length, 'four corners and the repeated start').toBe(5);
      expect(at(loop[0]!), 'the loop closes on its own start vertex').toBe(at(loop[loop.length - 1]!));
    }
    const corners = loops.map((loop) => new Set(loop.slice(0, 4).map(at)));
    expect(corners).toContainEqual(new Set(['0,0', '1,0', '1,1', '0,1']));
    expect(corners).toContainEqual(new Set(['0,0', '-1,0', '-1,-1', '0,-1']));
  });

  it('a plain square rim closes on its own four vertices', () => {
    const loops = chainRimSegments([
      seg([0, 0], [10, 0], 0),
      seg([10, 0], [10, 10], 0),
      seg([10, 10], [0, 10], 0),
      seg([0, 10], [0, 0], 0),
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(5);
    expect(at(loops[0]![0]!)).toBe(at(loops[0]![4]!));
  });

  it('a pocket rim with a branch spur of another patch closes; the spur is its own chain', () => {
    // The pocket's square plus a spur leaving its corner into another region (patch 1). The spur
    // must not be walked into the pocket's ring: the ring still closes on its own vertices.
    const segments: RimSegment[] = [
      seg([0, 0], [10, 0], 0),
      seg([10, 0], [10, 10], 0),
      seg([10, 10], [0, 10], 0),
      seg([0, 10], [0, 0], 0),
      seg([0, 0], [-4, 0], 1),
    ];
    const loops = chainRimSegments(segments);
    const ring = loops.find((loop) => loop.length === 5);
    expect(ring, 'the pocket ring is one closed loop').toBeDefined();
    expect(at(ring![0]!)).toBe(at(ring![4]!));
    expect(loops.filter((loop) => loop.length === 2), 'the spur chains on its own').toHaveLength(1);
  });
});
