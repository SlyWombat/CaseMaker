/**
 * #723 P2-2b — the carried-stock transform, pinned between the two frames a flip joins.
 *
 * A job frame is the blank as mounted for one setup: origin at the stock's front-left corner as
 * mounted, Z0 on that setup's up face, cuts negative. The carrier maps a point (and a mesh) from
 * one setup's job frame to the next one's. The fixtures here are the #754 acceptance's blank
 * (80 × 50 × 26) and its flip: a stock turned over about X has its old top at the new BOTTOM,
 * which is precisely the fact a top-Z heightfield cannot express.
 */
import { describe, expect, it } from 'vitest';

import { carryPointBetweenSetups, carryRemovalBetweenSetups, type CarrySetup } from '@/engine/cnc/setups';
import type { Mat } from '@/engine/cnc/setups/orient';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

const BOUNDS = { min: [0, 0, 0] as [number, number, number], max: [80, 50, 26] as [number, number, number] };
const I: Mat = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const RX180: Mat = [
  [1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
];
const TOP: CarrySetup = { rotation: I, bounds: BOUNDS };
const FLIP: CarrySetup = { rotation: RX180, bounds: BOUNDS };

function mesh(tris: [number, number, number][]): NodeMeshOutput {
  const positions = new Float32Array(tris.flat());
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, t[i]!);
      max[i] = Math.max(max[i]!, t[i]!);
    }
  }
  const indices = new Uint32Array(tris.map((_, i) => i));
  return {
    positions,
    indices,
    triangleCount: tris.length / 3,
    vertexCount: tris.length,
    bbox: { min, max },
    componentCount: 1,
  };
}

describe('#723 P2-2b — the carried-stock transform', () => {
  it('the same setup carries the solid unchanged (a fresh mesh, for the next worker)', () => {
    const m = mesh([[10, 10, -5], [20, 10, -5], [20, 20, -8]]);
    const out = carryRemovalBetweenSetups(m, TOP, TOP);
    expect(Array.from(out.positions)).toEqual(Array.from(m.positions));
    expect(out.positions).not.toBe(m.positions);
    expect(Array.from(out.indices)).toEqual(Array.from(m.indices));
    expect(out.bbox).toEqual(m.bbox);
    expect(out.triangleCount).toBe(m.triangleCount);
    expect(out.componentCount).toBe(1);
  });

  it('turned 180 about X, the old top is the new bottom and the old bottom the new top', () => {
    const map = carryPointBetweenSetups(TOP, FLIP);
    expect(map([40, 25, 0] as [number, number, number])).toEqual([40, 25, -26]); // old top centre → new bottom
    expect(map([40, 25, -26] as [number, number, number])).toEqual([40, 25, 0]); // old bottom → new top
    // A point off-centre: 10 mm from the left, 10 from the front, 5 below the old top.
    expect(map([10, 10, -5] as [number, number, number])).toEqual([10, 40, -21]);
  });

  it('the reverse carry undoes the flip', () => {
    const there = carryPointBetweenSetups(TOP, FLIP);
    const back = carryPointBetweenSetups(FLIP, TOP);
    const before: [number, number, number] = [13, 7, -4];
    const after = back(there(before));
    for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(before[i]!, 9);
  });

  it('a mesh is moved vertex for vertex and its bbox follows', () => {
    const m = mesh([[10, 10, -5], [20, 10, -5], [20, 20, -8]]);
    const out = carryRemovalBetweenSetups(m, TOP, FLIP);
    const map = carryPointBetweenSetups(TOP, FLIP);
    for (let v = 0; v < m.positions.length; v += 3) {
      const want = map([m.positions[v]!, m.positions[v + 1]!, m.positions[v + 2]!]);
      expect(out.positions[v]).toBeCloseTo(want[0], 6);
      expect(out.positions[v + 1]).toBeCloseTo(want[1], 6);
      expect(out.positions[v + 2]).toBeCloseTo(want[2], 6);
    }
    expect(out.bbox.min[1]).toBeCloseTo(30, 6);
    expect(out.bbox.max[2]).toBeCloseTo(-18, 6);
    expect(out.bbox.min[2]).toBeCloseTo(-21, 6);
  });
});
