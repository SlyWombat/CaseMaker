/**
 * #991 — THE MESH PATH'S RED-FIRST CASE, as `it.fails`: a ROUNDED edge tessellated at a real
 * facet count must not be read as a modelled chamfer. `findRims` gives every narrow planar
 * remainder patch that touches a wall a `modelledChamfer` rim with legs — which is right for a
 * modelled bevel and wrong for a fillet's facets, where the design intent is a curve the ball
 * finishes. The shipped tray STL shows the class at 28 of its 63 rims (the tray's STL row in
 * `opsAcceptance959`); the fix belongs to the mesh-path item filed from those numbers, so this
 * case is expected to FAIL until that item lands, and turning it green is its acceptance.
 */
import { describe, expect, it } from 'vitest';

import { recogniseFeatures } from '@/engine/cnc/cam/model/features';
import type { ParsedMesh } from '@/engine/import/stlParser';
import { tl } from './helpers/manifoldExec';

type P = [number, number, number];

/** A closed solid: the (y, z) profile below extruded along X from 0 to 20. The profile is a
 * 10 × 5 block with its top-right edge rounded by a 1 mm quarter arc over `segments` facets —
 * the facet count a vendor STL of this class carries. */
function roundedEdgeSolid(segments: number): ParsedMesh {
  const profile: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 4],
  ];
  for (let k = 1; k <= segments; k++) {
    const a = (k / segments) * (Math.PI / 2);
    profile.push([9 + Math.cos(a), 4 + Math.sin(a)]);
  }
  profile.push([0, 5]);

  const positions: number[] = [];
  const indices: number[] = [];
  const X0 = 0;
  const X1 = 20;
  const add = (x: number, y: number, z: number): number => {
    positions.push(x, y, z);
    return positions.length / 3 - 1;
  };
  // Side quads, one per profile edge.
  for (let e = 0; e < profile.length; e++) {
    const [ya, za] = profile[e]!;
    const [yb, zb] = profile[(e + 1) % profile.length]!;
    const a0 = add(X0, ya, za), b0 = add(X0, yb, zb), b1 = add(X1, yb, zb), a1 = add(X1, ya, za);
    indices.push(a0, b0, b1, a0, b1, a1);
  }
  // End caps: a fan from the first profile point (the profile is convex at every fan triangle).
  const fan = (x: number, flip: boolean): void => {
    const ids = profile.map(([y, z]) => add(x, y, z));
    for (let k = 1; k + 1 < ids.length; k++) {
      if (flip) indices.push(ids[0]!, ids[k + 1]!, ids[k]!);
      else indices.push(ids[0]!, ids[k]!, ids[k + 1]!);
    }
  };
  fan(X0, false);
  fan(X1, true);

  // Outward normals: flip every triangle if the closed solid's signed volume came out negative.
  const pos = new Float32Array(positions);
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
    vol +=
      (pos[a]! * (pos[b + 1]! * pos[c + 2]! - pos[c + 1]! * pos[b + 2]!) -
        pos[a + 1]! * (pos[b]! * pos[c + 2]! - pos[c]! * pos[b + 2]!) +
        pos[a + 2]! * (pos[b]! * pos[c + 1]! - pos[c]! * pos[b + 1]!)) / 6;
  }
  if (vol < 0) {
    for (let t = 0; t < indices.length; t += 3) {
      const tmp = indices[t + 1]!;
      indices[t + 1] = indices[t + 2]!;
      indices[t + 2] = tmp;
    }
  }
  const bbox = {
    min: [X0, 0, 0] as P,
    max: [X1, 10, 5] as P,
  };
  return { positions: pos, indices: new Uint32Array(indices), triangleCount: indices.length / 3, bbox };
}

describe('#991 the mesh path must not read a fillet as a modelled chamfer', () => {
  it.fails('a 1 mm rounded edge at 12 facets yields no modelledChamfer rim', () => {
    const mesh = roundedEdgeSolid(12);
    const tree = recogniseFeatures({ triangles: mesh }, { up: [0, 0, 1], stockTop: 0 }, tl);
    const modelled = tree.rims.filter((r) => r.kind === 'modelledChamfer');
    expect(modelled.length, modelled.map((r) => `legs ${r.legs?.map((v) => v.toFixed(3)).join(' x ')}`).join('; ')).toBe(0);
    // The design edge is a curve the finish must leave to the ball: it belongs to the curved
    // remainder, not to the V's chamfer stage.
    expect(tree.remainder.length, 'the fillet must reach the curved remainder').toBeGreaterThan(0);
  });
});
