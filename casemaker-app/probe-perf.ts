import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
import { executeOpSync } from './src/workers/geometry/evaluateOp';
import { buildRackNodes } from './src/engine/compiler/rack';
import type { RackParams } from './src/types';
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();
const rack = { width: 252, depth: 250, slots: 16, wallMount: 'none', accessories: [] } as unknown as RackParams;
const t0 = Date.now();
const nodes = buildRackNodes(rack);
const tPlan = Date.now() - t0;
let tris = 0;
for (const n of nodes) {
  const s = Date.now();
  const m = executeOpSync(tl, n.op);
  const t = Date.now() - s;
  tris += m.numTri();
  console.log(`${n.id.padEnd(17)} ${String(t).padStart(6)} ms   ${String(m.numTri()).padStart(7)} tris`);
  m.delete();
}
console.log(`plan ${tPlan} ms; TOTAL ${Date.now() - t0} ms, ${tris} tris   [before lightening: 65304 tris, app reported ~4.8 s]`);
