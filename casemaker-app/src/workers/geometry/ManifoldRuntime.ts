import ManifoldModule from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';

import type { BuildOp } from '@/engine/compiler/buildPlan';

import { executeOp, type GenerationCheck, type ManifoldToplevel } from './evaluateOp';

export type { GenerationCheck } from './evaluateOp';

let toplevelPromise: ReturnType<typeof ManifoldModule> | null = null;

async function getToplevel(): Promise<ManifoldToplevel> {
  if (!toplevelPromise) {
    toplevelPromise = ManifoldModule({ locateFile: () => wasmUrl as string });
  }
  const tl = await toplevelPromise;
  tl.setup();
  return tl;
}

export class CancelledError extends Error {
  constructor() {
    super('Geometry build cancelled');
    this.name = 'CancelledError';
  }
}

export interface NodeMeshOutput {
  positions: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  vertexCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** Number of disjoint solid components in this node (issue #26). */
  componentCount: number;
}

export async function buildOp(op: BuildOp, check: GenerationCheck): Promise<NodeMeshOutput> {
  const tl = await getToplevel();
  const m = await executeOp(tl, op, check);
  try {
    check();
    let componentCount = 1;
    try {
      // Manifold's decompose() returns the disjoint components. We only need
      // the count, then dispose the children.
      const parts = (m as unknown as { decompose?: () => unknown[] }).decompose?.();
      if (Array.isArray(parts)) {
        componentCount = parts.length;
        for (const p of parts) {
          (p as { delete?: () => void }).delete?.();
        }
      }
    } catch {
      // older Manifold without decompose — leave at 1
    }
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
  } finally {
    m.delete();
  }
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
