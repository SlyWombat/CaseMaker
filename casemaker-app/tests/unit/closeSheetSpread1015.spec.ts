/**
 * #1015 — THE DOOR'S DUPLICATE PASS COULD NOT TAKE A BIG MESH. `closeOpenSheet` collapsed the
 * kept-triangle list with `kept.push(...unique)`: a spread turns every element into a call
 * argument, and V8 refuses past ~125k of them, so the 12 MB dragon's 243,602-triangle heightfield
 * (and any goal above that count) failed at the door with `Maximum call stack size exceeded` —
 * before the mould, the solid or the tree. The fix is a plain loop (and a running minimum for the
 * boundary-sized `Math.min(...flatMap)` beside it); this pins the mesh that used to throw.
 *
 * The fixture is the acceptance's own: a 400 × 400-vertex grid — 2 × 399² = 318,402 triangles —
 * closed through the same `closeOpenSheet` the seam calls, once plain and once with every triangle
 * repeated. The repeated sheet must report its duplicates and close to the SAME mesh.
 */
import { describe, expect, it } from 'vitest';

import { closeOpenSheet } from '@/engine/cnc/engrave/closeSheet';
import type { ParsedMesh } from '@/engine/import/stlParser';
import { tl } from './helpers/manifoldExec';

/** A 400 × 400-vertex heightfield sheet: 2 × 399² = 318,402 triangles, one open boundary loop. */
function gridSheet(duplicateEvery: boolean): ParsedMesh {
  const n = 400;
  const positions: number[] = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // A little relief so the skirt's own lowest-boundary rule has something to pick.
      positions.push(i * 0.5, j * 0.5, 0.05 * ((i * 7 + j * 13) % 5));
    }
  }
  const indices: number[] = [];
  const tri = (a: number, b: number, c: number): void => {
    indices.push(a, b, c);
    if (duplicateEvery) indices.push(a, b, c);
  };
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = j * n + i + 1, c = (j + 1) * n + i + 1, d = (j + 1) * n + i;
      tri(a, b, c);
      tri(a, c, d);
    }
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleCount: indices.length / 3,
    bbox: { min: [0, 0, 0], max: [(n - 1) * 0.5, (n - 1) * 0.5, 0.2] },
  };
}

describe('#1015 the door closes a 318k-triangle grid without a spread', () => {
  it('a 400 × 400 grid sheet closes with no duplicates', () => {
    const closed = closeOpenSheet(tl, gridSheet(false), { skirtTo: 'lowestBoundary' });
    expect(closed.mesh.triangleCount).toBeGreaterThan(318_402);
    expect(closed.note).not.toContain('duplicate triangle(s) dropped');
  }, 240_000);

  it('with every triangle repeated once, the count is reported and the closed mesh is the same', () => {
    const plain = closeOpenSheet(tl, gridSheet(false), { skirtTo: 'lowestBoundary' });
    const repeated = closeOpenSheet(tl, gridSheet(true), { skirtTo: 'lowestBoundary' });
    expect(repeated.note).toContain('(318402 duplicate triangle(s) dropped)');
    // The same closed mesh, not merely an equally closed one.
    expect(repeated.mesh.triangleCount).toBe(plain.mesh.triangleCount);
    expect(Array.from(repeated.mesh.indices)).toEqual(Array.from(plain.mesh.indices));
    expect(Array.from(repeated.mesh.positions)).toEqual(Array.from(plain.mesh.positions));
  }, 240_000);
});
