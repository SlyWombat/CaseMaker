// Where is the side panel's material? Slice by y (depth) band and z (height).
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
import { executeOpSync } from './src/workers/geometry/evaluateOp';
import { buildRackNodes, computeRackDims } from './src/engine/compiler/rack';
import type { RackParams } from './src/types';
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();
const { Manifold } = tl;
const rack = { width: 252, depth: 250, slots: 16, wallMount: 'none',
  accessories: [{ type: 'shelf', slots: 3, shelfDepth: 123, vented: true }] } as unknown as RackParams;
const dims = computeRackDims(rack);
const nodes = buildRackNodes(rack);
const get = (id: string) => executeOpSync(tl, nodes.find((n) => n.id === id)!.op);

const side = get('rack-side-left');
console.log(`side total ${(side.volume() / 1000).toFixed(1)} cm3, envelope ${(15 * dims.depth * dims.totalH / 1000).toFixed(0)} cm3`);
const slab = (y0: number, y1: number, z0: number, z1: number) => {
  const b = Manifold.cube([40, y1 - y0, z1 - z0]).translate([-5, y0, z0]);
  const i = Manifold.intersection([side, b]);
  const v = i.volume(); i.delete(); b.delete();
  return v;
};
const H = dims.totalH, RAIL = 14, FOOT_H = 5;
const bands: [string, number, number][] = [
  ['front band  y 0-34', 0, 34],
  ['window A    y 34-92', 34, 92],
  ['rear rib    y 92-108', 92, 108],
  ['window B    y 108-235', 108, 235],
  ['rear band   y 235-250', 235, 250],
];
const zbands: [string, number, number][] = [
  ['feet+btm rail z 0-19', 0, FOOT_H + RAIL],
  ['web           z 19-' + (H - RAIL), FOOT_H + RAIL, H - RAIL],
  ['top rail      z ' + (H - RAIL) + '-' + H, H - RAIL, H],
];
console.log('\n                      ' + zbands.map(([l]) => l.padStart(22)).join(''));
let grand = 0;
for (const [yl, y0, y1] of bands) {
  let row = yl.padEnd(22);
  for (const [, z0, z1] of zbands) {
    const v = slab(y0, y1, z0, z1); grand += v;
    row += `${(v / 1000).toFixed(1).padStart(10)} cm3        `.slice(0, 22);
  }
  console.log(row);
}
console.log(`\naccounted ${(grand / 1000).toFixed(1)} cm3`);
const shelf = get('rack-shelf-0');
console.log(`\nshelf(3-slot,123deep) ${(shelf.volume() / 1000).toFixed(1)} cm3  envelope ${(252 * 49.5 * 123 / 1000).toFixed(0)} cm3  fill ${(shelf.volume() / (252 * 49.5 * 123) * 100).toFixed(1)}%  [sample 63.7 cm3 / 4.2%]`);
