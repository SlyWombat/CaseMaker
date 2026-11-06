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
 * the facet count a vendor STL of this class carries. Vertices are SHARED between the side quads
 * and the caps (the kernel's merge is not relied on here), so the solid is manifold by
 * construction: sides wound outward for the CCW profile, the x = 0 cap reversed, x = 20 as is. */
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
  const n = profile.length;
  const X0 = 0;
  const X1 = 20;
  const positions: number[] = [];
  for (const [y, z] of profile) positions.push(X0, y, z);
  for (const [y, z] of profile) positions.push(X1, y, z);
  const indices: number[] = [];
  // Side quads: outward normals for a CCW profile (interior on the left of the travel).
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, j, n + j, i, n + j, n + i);
  }
  // Caps: a fan from profile point 0 (the profile is convex). x = 0 faces −X (reversed order);
  // x = 20 faces +X (the profile's own CCW order).
  for (let k = 1; k + 1 < n; k++) {
    indices.push(0, k + 1, k); // x = 0, faces −X
    indices.push(n, n + k, n + k + 1); // x = 20, faces +X
  }
  const bbox = { min: [X0, 0, 0] as P, max: [X1, 10, 5] as P };
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices), triangleCount: indices.length / 3, bbox };
}

describe('#991 the mesh path must not read a fillet as a modelled chamfer', () => {
  it('a 1 mm rounded edge at 12 facets yields no modelledChamfer rim', () => {
    const mesh = roundedEdgeSolid(12);
    const tree = recogniseFeatures({ triangles: mesh }, { up: [0, 0, 1], stockTop: 0 }, tl);
    const modelled = tree.rims.filter((r) => r.kind === 'modelledChamfer');
    expect(modelled.length, modelled.map((r) => `legs ${r.legs?.map((v) => v.toFixed(3)).join(' x ')}`).join('; ')).toBe(0);
    // The design edge is a curve the finish must leave to the ball: it belongs to the curved
    // remainder, not to the V's chamfer stage.
    expect(tree.remainder.length, 'the fillet must reach the curved remainder').toBeGreaterThan(0);
  });

  // #994 — the stricter rule must not lose a REAL modelled chamfer: ONE inclined planar patch
  // spanning wall to floor is still one modelledChamfer rim, with its legs.
  it('a ONE-facet chamfer (45°, 1 mm legs) still counts: exactly 1 modelledChamfer with legs (1, 1)', () => {
    const mesh = roundedEdgeSolid(1);
    const tree = recogniseFeatures({ triangles: mesh }, { up: [0, 0, 1], stockTop: 0 }, tl);
    const modelled = tree.rims.filter((r) => r.kind === 'modelledChamfer');
    expect(modelled.length, modelled.map((r) => r.id).join(', ')).toBe(1);
    expect(modelled[0]!.legs?.[0]).toBeCloseTo(1, 6);
    expect(modelled[0]!.legs?.[1]).toBeCloseTo(1, 6);
  });
});
