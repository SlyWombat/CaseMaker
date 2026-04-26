import * as Comlink from 'comlink';
import type { BuildPlan, BuildNode } from '@/engine/compiler/buildPlan';
import { buildOp, CancelledError, type NodeMeshOutput } from './geometry/ManifoldRuntime';

interface NodeOutputWire extends NodeMeshOutput {
  id: string;
}

interface BuildOutputWire {
  generation: number;
  nodes: NodeOutputWire[];
  combinedTriangleCount: number;
  combinedVertexCount: number;
  combinedBBox: { min: [number, number, number]; max: [number, number, number] };
  durationMs: number;
}

let currentGeneration = 0;

function makeCheck(myGen: number) {
  return () => {
    if (myGen !== currentGeneration) throw new CancelledError();
  };
}

const api = {
  setGeneration(gen: number): void {
    currentGeneration = gen;
  },
  async build(plan: BuildPlan, generation: number): Promise<BuildOutputWire | null> {
    currentGeneration = generation;
    const check = makeCheck(generation);
    const start = performance.now();
    const nodes: NodeOutputWire[] = [];
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    let triCount = 0;
    let vertCount = 0;
    try {
      for (const node of plan.nodes as BuildNode[]) {
        const out = await buildOp(node.op, check);
        nodes.push({ id: node.id, ...out });
        triCount += out.triangleCount;
        vertCount += out.vertexCount;
        if (out.bbox.min[0] < minX) minX = out.bbox.min[0];
        if (out.bbox.min[1] < minY) minY = out.bbox.min[1];
        if (out.bbox.min[2] < minZ) minZ = out.bbox.min[2];
        if (out.bbox.max[0] > maxX) maxX = out.bbox.max[0];
        if (out.bbox.max[1] > maxY) maxY = out.bbox.max[1];
        if (out.bbox.max[2] > maxZ) maxZ = out.bbox.max[2];
      }
    } catch (e) {
      if (e instanceof CancelledError) return null;
      throw e;
    }
    const result: BuildOutputWire = {
      generation,
      nodes,
      combinedTriangleCount: triCount,
      combinedVertexCount: vertCount,
      combinedBBox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      durationMs: performance.now() - start,
    };
    const transferables: Transferable[] = [];
    for (const n of nodes) {
      transferables.push(n.positions.buffer, n.indices.buffer);
    }
    return Comlink.transfer(result, transferables);
  },
};

export type GeometryWorkerApi = typeof api;
export type { BuildOutputWire, NodeOutputWire };

Comlink.expose(api);
