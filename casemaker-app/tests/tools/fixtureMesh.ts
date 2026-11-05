/**
 * #964 — THE SYNTHETIC FIXTURES' MESH GUARD (the manager's ruling on #959 6649361890).
 *
 * A hand-built quad in B's synthetic repro was entered with a vertex count one short, dropping a
 * corner from the index buffer. The result was still "a mesh" — the checker accepted it — and the
 * missing facet read as a 4 mm drop-cutter error that cost a round of engine review. The geometry
 * was wrong in the FIXTURE, not the engine; nothing in the harness said so.
 *
 * `assertFixtureMesh` is that missing statement. It accepts a closed triangle surface (what every
 * Manifold-built fixture is) and throws, naming the defect, when:
 *
 *   - a triangle has zero area (a dropped or repeated vertex — the #959 defect);
 *   - an edge is shared by anything other than exactly two triangles (a hole, a duplicated
 *     facet, or a non-manifold seam);
 *   - an index is out of range or the buffers are not whole triangles.
 *
 * It is deliberately strict about the closed-surface rule: a top-only heightfield mesh is NOT a
 * closed solid and must not be passed through this guard. Every caller here builds its geometry
 * with Manifold, so the closed rule is the right one.
 */

export interface FixtureMeshLike {
  positions: ArrayLike<number>;
  /** A flat triangle index buffer (three vertex indices per triangle). */
  indices: ArrayLike<number>;
}

/** Cross-product magnitude below this is a degenerate triangle; mm² for a millimetre fixture. */
const MIN_TRIANGLE_AREA_TWICE = 1e-9;

export function assertFixtureMesh(mesh: FixtureMeshLike, label = 'fixture mesh'): void {
  const { positions, indices } = mesh;
  const vertexCount = Math.floor(positions.length / 3);
  if (positions.length % 3 !== 0) {
    throw new Error(`${label}: positions are ${positions.length} numbers — not whole vertices`);
  }
  if (indices.length % 3 !== 0) {
    throw new Error(`${label}: ${indices.length} indices — not whole triangles`);
  }

  // 1 — every index addresses a real vertex, and every triangle has area.
  const triangles = indices.length / 3;
  for (let t = 0; t < triangles; t++) {
    const a = indices[3 * t]!, b = indices[3 * t + 1]!, c = indices[3 * t + 2]!;
    for (const [name, i] of [['a', a], ['b', b], ['c', c]] as const) {
      if (!Number.isInteger(i) || i < 0 || i >= vertexCount) {
        throw new Error(`${label}: triangle ${t} vertex ${name} is index ${i}, outside 0..${vertexCount - 1}`);
      }
    }
    if (a === b || b === c || a === c) {
      throw new Error(`${label}: triangle ${t} repeats a vertex (${a}, ${b}, ${c}) — a dropped vertex?`);
    }
    const ax = positions[3 * a]!, ay = positions[3 * a + 1]!, az = positions[3 * a + 2]!;
    const bx = positions[3 * b]!, by = positions[3 * b + 1]!, bz = positions[3 * b + 2]!;
    const cx = positions[3 * c]!, cy = positions[3 * c + 1]!, cz = positions[3 * c + 2]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const twiceArea = Math.hypot(nx, ny, nz);
    if (!(twiceArea > MIN_TRIANGLE_AREA_TWICE)) {
      throw new Error(
        `${label}: triangle ${t} (${a}, ${b}, ${c}) has zero area — a dropped or repeated vertex reads as a false surface`,
      );
    }
  }

  // 2 — every undirected edge belongs to exactly two triangles (a closed surface).
  const edgeCounts = new Map<string, number>();
  const addEdge = (i: number, j: number): void => {
    const key = i < j ? `${i}:${j}` : `${j}:${i}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  };
  for (let t = 0; t < triangles; t++) {
    const a = indices[3 * t]!, b = indices[3 * t + 1]!, c = indices[3 * t + 2]!;
    addEdge(a, b);
    addEdge(b, c);
    addEdge(c, a);
  }
  for (const [edge, count] of edgeCounts) {
    if (count !== 2) {
      const [i, j] = edge.split(':');
      throw new Error(
        `${label}: edge ${i}–${j} is shared by ${count} triangle(s), not 2 — the surface is not closed (a missing or duplicated facet)`,
      );
    }
  }
}
