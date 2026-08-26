// Shared Manifold harness for the specs that assert on real meshes rather
// than on BuildOp tree shape.
//
// Every one of those specs used to carry its own copy of the BuildOp switch
// plus a vertex-dedupe helper. That meant a new primitive broke four files at
// once and, worse, a spec could silently drift from what the worker actually
// evaluates. They all run the production evaluator now.

import { createRequire } from 'node:module';

import ManifoldModule from 'manifold-3d';

import type { BuildOp } from '@/engine/compiler/buildPlan';
import { executeOpSync, type ManifoldToplevel } from '@/workers/geometry/evaluateOp';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('manifold-3d/manifold.wasm');

// manifold-3d types locateFile as zero-arg; the only file it ever requests is
// the wasm, so returning it unconditionally is equivalent.
export const tl: ManifoldToplevel = await ManifoldModule({ locateFile: () => wasmPath });
tl.setup();

export const Manifold = tl.Manifold;
export type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;

/** Evaluate a BuildOp with the same code path the geometry worker uses. */
export function exec(op: BuildOp): ManifoldInstance {
  return executeOpSync(tl, op);
}
