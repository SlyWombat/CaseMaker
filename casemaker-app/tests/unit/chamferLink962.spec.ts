/**
 * #959 review item 6, REFINED (the manager's ruling): `generateChamfer`'s inter-ring transition
 * goes through #962's `link()`. `chamfer.ts` has no material field of its own (a V bit tracing a
 * rim's edge does not clear territory the way a flat's pocketing does — `chamfer.ts`'s own header),
 * so `retract()`'s `Number.isFinite(materialTop)` check is always false there: the DOWN leg is
 * unaffected by the ruling and stays a feed at `plungeFeed`, exactly as item 6 first fixed it. The
 * UP leg is the one that changes — retracting out of material the op just cut is never hopeful,
 * so it is now a rapid like Makera's own NC, not a feed.
 */

import { describe, expect, it } from 'vitest';

import { generateChamfer, type ChamferCut } from '../../src/engine/cnc/cam/chamfer';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { CutParams } from '../../src/engine/cnc/feeds';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const PARAMS: CutParams = { rpm: 12000, feed: 900, plungeFeed: 250, stepDown: 1, stepOver: 0.5, peck: 0, air: true };
const V90: Tool = flatEndMill(3.175, {
  number: 1, id: 'v90', name: '90° chamfer', shape: 'chamfer', typeText: 'Chamfer',
  angle: 90, halfAngle: 45, tipDiameter: 0.1, diameter: 3.175,
});

function ring(cx: number, cy: number, half: number): [number, number][] {
  return [[cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half], [cx - half, cy - half]];
}

describe('#959 review item 6, refined — generateChamfer() rapids the UP leg, feeds the DOWN leg (no material field of its own)', () => {
  it('two disjoint rings in one cut: an UP vertical leg is always a rapid, a DOWN vertical leg is always a plunge-rate feed', () => {
    const cut: ChamferCut = {
      id: 'two-rings',
      name: 'two rings',
      path: [ring(0, 0, 5), ring(20, 0, 5)],
      depth: 0.5,
    };
    const ir = generateChamfer([cut], V90, PARAMS, RAPID);
    const moves = ir.operations[0]!.moves;
    expect(moves.filter((m) => m.kind === 'rapid').length, 'the fixture must actually exercise a rapid').toBeGreaterThan(0);

    let sawUpLeg = false;
    let sawDownLeg = false;
    for (let i = 1; i < moves.length - 1; i++) {
      const m = moves[i]!;
      const prev = moves[i - 1]!;
      if (m.x !== prev.x || m.y !== prev.y || m.z === prev.z) continue;
      if (m.z > prev.z) {
        // UP — out of material the op just cut: always a rapid now, never a feed.
        sawUpLeg = true;
        if (m.kind !== 'rapid') {
          throw new Error(`move ${i}, an UP vertical leg from z=${prev.z} to z=${m.z}, posted as a '${m.kind}', not a rapid`);
        }
        continue;
      }
      // DOWN — chamfer has no material field of its own, so this leg is unchanged: a feed.
      sawDownLeg = true;
      // The `throw` (not an `expect`) is what narrows `m` to the 'feed' variant for the `.f` read
      // below — `CamMove`'s 'rapid' branch carries no `f` field at all, so reading it without
      // first ruling out 'rapid' is exactly the bug this test exists to catch, not a type cast to
      // paper over: a vertical leg posted as 'rapid' must fail HERE, on its own kind, never fall
      // through to compare an undefined `f` against the plunge rate.
      if (m.kind !== 'feed') {
        throw new Error(`move ${i}, a DOWN vertical leg from z=${prev.z} to z=${m.z}, posted as a '${m.kind}', not a feed`);
      }
      expect(m.f, `move ${i}'s DOWN vertical leg ran at ${m.f} mm/min, not the ${PARAMS.plungeFeed} mm/min plunge rate`).toBe(PARAMS.plungeFeed);
    }
    expect(sawUpLeg, 'the fixture must actually exercise an UP vertical leg').toBe(true);
    expect(sawDownLeg, 'the fixture must actually exercise a DOWN vertical leg').toBe(true);
  });
});
