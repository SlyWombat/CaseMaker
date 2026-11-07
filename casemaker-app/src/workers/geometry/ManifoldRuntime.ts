import ManifoldModule from 'manifold-3d';

import type { BuildOp } from '@/engine/compiler/buildPlan';

import { decomposeCounts, meshOutputOf, type NodeMeshOutput } from './meshOutput';
import { executeOp, type GenerationCheck, type ManifoldToplevel } from './evaluateOp';

export type { GenerationCheck } from './evaluateOp';

let toplevelPromise: ReturnType<typeof ManifoldModule> | null = null;

/**
 * Vite's `?url` import, isolated behind a DYNAMIC `import()` reached only from the browser/worker
 * branch below (#966) — never a top-level `import … from 'manifold-3d/manifold.wasm?url'`. A
 * static import of a `.wasm`-suffixed specifier is resolved eagerly, by every consumer of this
 * module, the moment it loads — including a plain `tsx`/Node process with no Vite transform
 * (`casemaker cut`'s own CLI entry point, once anything in its import graph reaches this file).
 * There, after tsx strips the `?url` query it does not understand, Node's own loader sees a bare
 * `.wasm` file and tries to resolve it as a WASM/ESM module in its own right — which fails on the
 * wasm binary's own minified import namespace (`Cannot find package 'a'`), before any of this
 * file's runtime code — including the Node branch below — gets a chance to run at all. Keeping the
 * import dynamic means it is only ever evaluated when actually called, i.e. only in a realm where
 * nothing routes through the Node branch first.
 */
async function browserWasmUrl(): Promise<string> {
  const mod = (await import('manifold-3d/manifold.wasm?url')) as { default: string };
  return mod.default;
}

/** The slice of `node:module` the Node branch below uses. */
interface ModuleLike {
  createRequire(url: string | URL): { resolve(id: string): string };
}

/**
 * `process.getBuiltinModule`, not a static `import … from 'node:module'` — this file is compiled
 * under `tsconfig.app.json` (DOM/WebWorker libs, no `@types/node`; the same reason
 * `platform/headless/bootstrap.ts`'s own `builtin()` helper exists), so a type-level Node import
 * would not even compile here. Needs Node ≥ 22.3; only reached from the Node branch below.
 */
function nodeRequire(): { resolve(id: string): string } {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const getBuiltinModule = proc?.getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') {
    throw new Error('ManifoldRuntime needs Node ≥ 22.3 (process.getBuiltinModule) to resolve manifold.wasm outside a bundler');
  }
  const mod = getBuiltinModule('node:module') as ModuleLike | undefined;
  if (mod === undefined) throw new Error('Node has no built-in module "node:module"');
  return mod.createRequire(import.meta.url);
}

/**
 * Where the wasm lives, in the realm that is asking. Under NODE — `casemaker cut`'s own CLI entry
 * point, and the specs that plan through `planModelCam` (#964's check suite) — resolved with
 * `createRequire`, the same mechanism `platform/headless/bootstrap.ts`'s own manifold loader
 * already uses: a real filesystem path, with no bundler and no `?url` import involved at all. In
 * the app (browser or worker, where `process` is undefined) the dynamic `?url` import above is
 * awaited instead, and its resolved URL is used as-is.
 */
async function locateWasm(): Promise<string> {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (proc?.versions?.node !== undefined) {
    return nodeRequire().resolve('manifold-3d/manifold.wasm');
  }
  return browserWasmUrl();
}

export async function getToplevel(): Promise<ManifoldToplevel> {
  if (!toplevelPromise) {
    const wasmPath = await locateWasm();
    toplevelPromise = ManifoldModule({ locateFile: () => wasmPath });
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
