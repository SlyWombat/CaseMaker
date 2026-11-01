import ManifoldModule from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';

import type { BuildOp } from '@/engine/compiler/buildPlan';

import { decomposeCounts, meshOutputOf, type NodeMeshOutput } from './meshOutput';
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
    // Manifold's decompose() returns the disjoint components. A SEALED VOID
    // comes back as its own component with negative volume; it is a cavity
    // inside a part, not a loose part the slicer would print on its own, so it
    // does not count toward issue #83's bodies (issue #152: a captured magnet
    // pocket is exactly such a void, on purpose). Issue #850 — the voids are
    // reported separately, with size and position, so an ACCIDENTAL one can be
    // stated while a deliberate magnet pocket stays quiet (the compiler
    // classifies them).
    const decomposed = decomposeCounts(m);
    return meshOutputOf(m, decomposed.componentCount, decomposed.sealedVoids);
  } finally {
    m.delete();
  }
}
