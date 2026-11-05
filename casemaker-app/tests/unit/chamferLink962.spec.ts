/**
 * #959 review item (6), RED-FIRST: `generateChamfer`'s inter-ring transition must go through
 * #962's `link()`, whose own `retract()` feeds every VERTICAL leg at the plunge rate (#956 §5,
 * Review B's F8) — never a rapid. The op's own hand-rolled transition (`rapid` to `HOP_Z` at the
 * END of a ring, `rapid` to the next ring's `HOP_Z` start) did the opposite: every one of the
 * three legs between two rings, including the two pure-vertical ones, was a rapid.
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

describe('#959 review — generateChamfer() feeds every vertical leg of a link, never a rapid', () => {
  it('two disjoint rings in one cut: no rapid is ever a pure vertical move except the op\'s own final retract', () => {
    const cut: ChamferCut = {
      id: 'two-rings',
      name: 'two rings',
      path: [ring(0, 0, 5), ring(20, 0, 5)],
      depth: 0.5,
    };
    const ir = generateChamfer([cut], V90, PARAMS, RAPID);
    const moves = ir.operations[0]!.moves;
    expect(moves.filter((m) => m.kind === 'rapid').length, 'the fixture must actually exercise a rapid').toBeGreaterThan(0);

    for (let i = 1; i < moves.length - 1; i++) {
      const m = moves[i]!;
      const prev = moves[i - 1]!;
      if (m.x !== prev.x || m.y !== prev.y || m.z === prev.z) continue;
      expect(m.kind, `move ${i}, a vertical leg from z=${prev.z} to z=${m.z}, posted as a '${m.kind}'`).toBe('feed');
      expect(m.f, `move ${i}'s vertical leg ran at ${m.f} mm/min, not the ${PARAMS.plungeFeed} mm/min plunge rate`).toBe(PARAMS.plungeFeed);
    }
  });
});
