import { deduplicateMesh, type ManifoldToplevel } from './evaluateOp';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;

export interface NodeMeshOutput {
  positions: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  vertexCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** Number of disjoint solid components in this node (issue #26). */
  componentCount: number;
}

/**
 * Copy a Manifold's mesh into transferable buffers. Reads the handle and keeps nothing of it:
 * the caller still owns (and deletes) `m`. Shared by the geometry worker and the sim worker so
 * both ship the same `NodeMeshOutput`.
 */
export function meshOutputOf(m: ManifoldInstance, componentCount = 1): NodeMeshOutput {
  const mesh = m.getMesh();
  const positions = new Float32Array(mesh.vertProperties);
  const indices = new Uint32Array(mesh.triVerts);
  const numProp = mesh.numProp;
  const numVert = positions.length / numProp;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < numVert; i++) {
    const x = positions[i * numProp]!;
    const y = positions[i * numProp + 1]!;
    const z = positions[i * numProp + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return {
    positions: numProp === 3 ? positions : flattenPositions(positions, numProp, numVert),
    indices,
    triangleCount: indices.length / 3,
    vertexCount: numVert,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
    componentCount,
  };
}

/**
 * The OTHER direction: a closed solid from a mesh this module produced. Returns null when the
 * mesh is not one — an empty mesh, a mesh that is not closed, or one Manifold rejects — because
 * every caller has an honest answer for "there is nothing to measure against" and none for a crash
 * mid-report.
 *
 * `deduplicateMesh` is not optional here. Manifold rejects a mesh whose shared edges do not
 * reference identical vertex indices, and `positions` is a Float32 array, so two triangles that
 * meet exactly can carry two spellings of the same corner. `manifoldOfMesh(meshOutputOf(m))`
 * round-trips, which is what makes it usable as a leaf: a solid with no lazy children cannot be
 * disturbed by deleting the handle it was built from (playback.ts, ONE MANIFOLD TRAP).
 */
export function manifoldOfMesh(tl: ManifoldToplevel, mesh: NodeMeshOutput): ManifoldInstance | null {
  return manifoldOfTriangles(tl, mesh.positions, mesh.indices);
}

/**
 * The same conversion for a triangle soup that is not a {@link NodeMeshOutput} — #811's goal mesh
 * is transformed straight out of the parser, so there is no bbox or count to fabricate just to
 * hand it over. Null under exactly the `manifoldOfMesh` rule: not closed, or Manifold rejects it.
 */
export function manifoldOfTriangles(
  tl: ManifoldToplevel,
  positions: Float32Array,
  indices: Uint32Array,
): ManifoldInstance | null {
  if (indices.length < 3 || positions.length < 9) return null;
  const deduped = deduplicateMesh(positions, indices);
  // `ofMesh` THROWS `ManifoldError: Not manifold` for a mesh that is not closed — it does not
  // report through `status()` and carry on — so the two failure paths are both here. Measured, not
  // assumed: an open triangle mesh throws, which is why this is a `try` and not just the check below.
  let solid: ManifoldInstance;
  try {
    solid = tl.Manifold.ofMesh(
      new tl.Mesh({ numProp: 3, vertProperties: deduped.positions, triVerts: deduped.indices }),
    );
  } catch {
    return null;
  }
  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    return null;
  }
  return solid;
}

function flattenPositions(src: Float32Array, numProp: number, numVert: number): Float32Array {
  const out = new Float32Array(numVert * 3);
  for (let i = 0; i < numVert; i++) {
    out[i * 3] = src[i * numProp]!;
    out[i * 3 + 1] = src[i * numProp + 1]!;
    out[i * 3 + 2] = src[i * numProp + 2]!;
  }
  return out;
}
