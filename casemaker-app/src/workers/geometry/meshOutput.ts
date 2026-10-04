import type { ManifoldToplevel } from './evaluateOp';

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

function flattenPositions(src: Float32Array, numProp: number, numVert: number): Float32Array {
  const out = new Float32Array(numVert * 3);
  for (let i = 0; i < numVert; i++) {
    out[i * 3] = src[i * numProp]!;
    out[i * 3 + 1] = src[i * numProp + 1]!;
    out[i * 3 + 2] = src[i * numProp + 2]!;
  }
  return out;
}
