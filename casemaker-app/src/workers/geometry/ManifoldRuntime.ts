import ManifoldModule from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import type { BuildOp } from '@/engine/compiler/buildPlan';

type ManifoldClass = Awaited<ReturnType<typeof ManifoldModule>>['Manifold'];
type ManifoldInstance = InstanceType<ManifoldClass>;

let toplevelPromise: ReturnType<typeof ManifoldModule> | null = null;

async function getToplevel(): Promise<Awaited<ReturnType<typeof ManifoldModule>>> {
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

export type GenerationCheck = () => void;

function executeOp(
  Manifold: ManifoldClass,
  op: BuildOp,
  check: GenerationCheck,
): ManifoldInstance {
  check();
  switch (op.kind) {
    case 'cube':
      return Manifold.cube(op.size, op.center ?? false);
    case 'cylinder':
      return Manifold.cylinder(
        op.height,
        op.radiusLow,
        op.radiusHigh ?? op.radiusLow,
        op.segments ?? 0,
        op.center ?? false,
      );
    case 'translate': {
      const child = executeOp(Manifold, op.child, check);
      const result = child.translate(op.offset);
      child.delete();
      return result;
    }
    case 'rotate': {
      const child = executeOp(Manifold, op.child, check);
      const result = child.rotate(op.degrees);
      child.delete();
      return result;
    }
    case 'union':
    case 'difference':
    case 'intersection': {
      const children = op.children.map((c) => executeOp(Manifold, c, check));
      check();
      let result: ManifoldInstance;
      if (op.kind === 'union') result = Manifold.union(children);
      else if (op.kind === 'difference') result = Manifold.difference(children);
      else result = Manifold.intersection(children);
      children.forEach((c) => c.delete());
      return result;
    }
  }
}

export interface NodeMeshOutput {
  positions: Float32Array;
  indices: Uint32Array;
  triangleCount: number;
  vertexCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export async function buildOp(op: BuildOp, check: GenerationCheck): Promise<NodeMeshOutput> {
  const tl = await getToplevel();
  const m = executeOp(tl.Manifold, op, check);
  try {
    check();
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
