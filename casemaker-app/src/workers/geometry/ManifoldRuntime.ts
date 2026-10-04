import ManifoldModule from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';

import type { BuildOp } from '@/engine/compiler/buildPlan';

import { meshOutputOf, type NodeMeshOutput } from './meshOutput';
import { executeOp, type GenerationCheck, type ManifoldToplevel } from './evaluateOp';

export type { GenerationCheck } from './evaluateOp';

let toplevelPromise: ReturnType<typeof ManifoldModule> | null = null;

export async function getToplevel(): Promise<ManifoldToplevel> {
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

export type { NodeMeshOutput };

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
    return meshOutputOf(m, componentCount);
  } finally {
    m.delete();
  }
}
