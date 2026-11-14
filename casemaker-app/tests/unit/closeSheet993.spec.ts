/**
 * #993 — THE DOOR SPLITS A NON-MANIFOLD EDGE INSTEAD OF REFUSING IT. Two sheets meeting along a
 * line (the organizer STL's one knife edge: four triangles, two opposite-normal pairs) are
 * separated by the vertex-link (umbrella) split: at each vertex of an overused edge the triangles
 * around it group into sheets through TWO-SIDED spokes — the overused edge is the seam, never a
 * spoke — and every sheet beyond the first gets a copy of that vertex, which is a zero-width slit
 * Manifold accepts. A split is only made where every sheet carries 0 or 2 of the edge's triangles;
 * a flap on a three-use edge is left to the caller's named refusal (count + first edge's position).
 * Exact duplicate triangles are dropped first. (A literal pair duplication was measured to leave
 * boundary edges: the pair's OTHER edges become single-sided.)
 */
import { describe, expect, it } from 'vitest';

import { closeOpenSheet } from '@/engine/cnc/engrave/closeSheet';
import type { ParsedMesh } from '@/engine/import/stlParser';
import { tl } from './helpers/manifoldExec';

type P = [number, number, number];

/** A closed axis-aligned box, outward-wound: 8 vertices, 12 triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): { positions: P[]; indices: number[] } {
  const v: P[] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces: [number, number, number, number][] = [
    [0, 3, 2, 1], // bottom (−z)
    [4, 5, 6, 7], // top (+z)
    [0, 1, 5, 4], // −y
    [1, 2, 6, 5], // +x
    [2, 3, 7, 6], // +y
    [3, 0, 4, 7], // −x
  ];
  const indices: number[] = [];
  for (const [a, b, c, d] of faces) indices.push(a, b, c, a, c, d);
  return { positions: v, indices };
}

/** Concatenate solids into one triangle soup; a shared coordinate welds at the door. */
function merge(...parts: { positions: P[]; indices: number[] }[]): ParsedMesh {
  const positions: P[] = [];
  const indices: number[] = [];
  for (const part of parts) {
    const base = positions.length;
    positions.push(...part.positions);
    for (const i of part.indices) indices.push(base + i);
  }
  const xs = positions.map((p) => p[0]), ys = positions.map((p) => p[1]), zs = positions.map((p) => p[2]);
  return {
    positions: new Float32Array(positions.flat()),
    indices: new Uint32Array(indices),
    triangleCount: indices.length / 3,
    bbox: { min: [Math.min(...xs), Math.min(...ys), Math.min(...zs)], max: [Math.max(...xs), Math.max(...ys), Math.max(...zs)] },
  };
}

/** Boundary edges (used by one triangle) of a welded mesh — 0 for a closed surface. */
function boundaryEdges(mesh: ParsedMesh): number {
  const idOf = new Map<string, number>();
  const weld = new Int32Array(mesh.indices.length);
  for (let v = 0; v < mesh.indices.length; v++) {
    const i = mesh.indices[v]! * 3;
    const key = `${Math.round(mesh.positions[i]! / 1e-4)}:${Math.round(mesh.positions[i + 1]! / 1e-4)}:${Math.round(mesh.positions[i + 2]! / 1e-4)}`;
    let id = idOf.get(key);
    if (id === undefined) { id = idOf.size; idOf.set(key, id); }
    weld[v] = id;
  }
  const use = new Map<string, number>();
  for (let t = 0; t < mesh.triangleCount; t++) {
    const ids = [weld[3 * t]!, weld[3 * t + 1]!, weld[3 * t + 2]!];
    for (const [a, b] of [[ids[0]!, ids[1]!], [ids[1]!, ids[2]!], [ids[2]!, ids[0]!]] as const) {
      const k = a < b ? `${a}:${b}` : `${b}:${a}`;
      use.set(k, (use.get(k) ?? 0) + 1);
    }
  }
  let boundary = 0;
  for (const n of use.values()) if (n === 1) boundary++;
  return boundary;
}

describe('#993 the door splits a knife edge', () => {
  it('two boxes sharing one vertical edge: closes with the split note and no boundary', () => {
    // Box A [0,10]² and box B [10,20]² share the edge x = y = 10, z 0..10. Both boxes use the
    // SAME coordinates at that edge, so the door's weld collapses it and four triangles (two per
    // box, one per wall) carry the one undirected edge.
    const mesh = merge(box(0, 0, 0, 10, 10, 10), box(10, 10, 0, 20, 20, 10));
    const closed = closeOpenSheet(tl, mesh, { skirtTo: 'lowestBoundary' });
    expect(closed.note).toContain('1 non-manifold edge(s) split');
    expect(boundaryEdges(closed.mesh)).toBe(0);
    // The kernel's own check — the one `solidOf` runs — must accept the split solid.
    const mm = new tl.Mesh({ numProp: 3, vertProperties: closed.mesh.positions, triVerts: closed.mesh.indices });
    mm.merge();
    const solid = new tl.Manifold(mm);
    expect(solid.volume()).toBeCloseTo(2000, 3);
    solid.delete();
  }, 120_000);

  it('a duplicated triangle is dropped, not refused', () => {
    const one = box(0, 0, 0, 10, 10, 10);
    // Append an exact copy of the first triangle (same three vertices).
    const dup = merge(one, { positions: one.positions, indices: [0, 3, 2] });
    const closed = closeOpenSheet(tl, dup, { skirtTo: 'lowestBoundary' });
    expect(closed.note).toContain('duplicate triangle(s) dropped');
    expect(closed.mesh.triangleCount).toBe(12);
    expect(boundaryEdges(closed.mesh)).toBe(0);
  }, 120_000);

  it('an edge with three triangles cannot be paired and is refused by name with its count and position', () => {
    const one = box(0, 0, 0, 10, 10, 10);
    // A flap hinged on the box's top edge (0,0,10)-(10,0,10): that edge now has three triangles.
    const flap = { positions: [[0, 0, 10], [10, 0, 10], [5, -5, 15]] as P[], indices: [0, 1, 2] };
    expect(() => closeOpenSheet(tl, merge(one, flap), { skirtTo: 'lowestBoundary' })).toThrow(
      /1 edge\(s\) shared by more than two triangles — the mesh is not a surface; the first at \(.*\), z 10\.000–10\.000/,
    );
  }, 120_000);
});
