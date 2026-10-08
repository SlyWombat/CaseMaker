// Combined rack probe: material, joint retention, print orientation.
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
import { executeOpSync } from './src/workers/geometry/evaluateOp';
import { buildRackNodes, computeRackDims } from './src/engine/compiler/rack';
import type { RackParams, RackAccessory } from './src/types';
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();
const { Manifold } = tl;
let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); if (!c) fail++; };
const mk = (o: Partial<RackParams>): RackParams =>
  ({ width: 252, depth: 250, slots: 16, wallMount: 'none', accessories: [], ...o }) as unknown as RackParams;

// ---- material ----
{
  const rack = mk({});
  const d = computeRackDims(rack);
  const m = new Map(buildRackNodes(rack).map((n) => [n.id, executeOpSync(tl, n.op)]));
  const side = m.get('rack-side-left')!.volume();
  const plate = m.get('rack-bottom')!.volume();
  const env = 15 * d.depth * d.totalH;
  console.log(`side  ${(side / 1000).toFixed(1)} cm3  fill ${(side / env * 100).toFixed(1)}%   [was 329.8 / 32.0%, sample 226.2 / 16.4%]`);
  console.log(`plate ${(plate / 1000).toFixed(1)} cm3   [was 226.8, sample 246.9]`);
  const acc = new Map(buildRackNodes({ ...rack, accessories: [
    { type: 'shelf', slots: 3, shelfDepth: 123, vented: true },
    { type: 'cable-tray' },
  ] } as unknown as RackParams).map((n) => [n.id, executeOpSync(tl, n.op)]));
  const shelf = acc.get('rack-shelf-0')!.volume();
  const tray = acc.get('rack-cable-tray-1')!.volume();
  console.log(`shelf ${(shelf / 1000).toFixed(1)} cm3   [was 124.9, sample 63.7]`);
  console.log(`tray  ${(tray / 1000).toFixed(1)} cm3   [was 113.9, sample 75.5]`);
  acc.forEach((x) => x.delete());
  const frame = 2 * side + 2 * plate;
  console.log(`FRAME ${(frame / 1000).toFixed(1)} cm3 (${(frame / 1000 * 1.24).toFixed(0)} g)  [was 1113.1 / 1380 g, sample 946.2 / 1173 g  -> ${((frame - 946200) / 946200 * 100).toFixed(0)}% vs sample]`);
  m.forEach((x) => x.delete());
}
// ---- joint retention across configs ----
const configs: [string, Partial<RackParams>][] = [
  ['default', {}],
  ['shallow 180x80x4', { width: 180, depth: 80, slots: 4 }],
  ['mid-seat 200x180x8', { width: 200, depth: 180, slots: 8 }],
  ['cleat', { wallMount: 'cleat' }],
  ['ears', { wallMount: 'ears' }],
  ['keyhole+shelf', { wallMount: 'keyhole', accessories: [{ type: 'shelf', slots: 3, shelfDepth: 123 }] as unknown as RackAccessory[] }],
  ['fan on the mid seat', { fans: [{ id: 'f1', side: 'left', size: 120, y: 125, z: 140 }] } as Partial<RackParams>],
];
for (const [label, over] of configs) {
  const m = new Map(buildRackNodes(mk(over)).map((n) => [n.id, executeOpSync(tl, n.op)]));
  let comps = 0;
  for (const [id, mm] of m) {
    const c = mm.decompose(); if (c.length !== 1) { comps++; console.log(`   ${id}: ${c.length} components`); } c.forEach((x) => x.delete());
  }
  ok(comps === 0, `${label}: every part one component`);
  const sides = [m.get('rack-side-left')!, m.get('rack-side-right')!];
  for (const pid of ['rack-bottom', 'rack-top']) {
    const p = m.get(pid)!;
    const clash = (dv: [number, number, number]): number => {
      const mv = p.translate(dv); let v = 0;
      for (const s of sides) { const i = Manifold.intersection([s, mv]); v += i.volume(); i.delete(); }
      mv.delete(); return v;
    };
    const [seat, up, down, fore] = [clash([0, 0, 0]), clash([0, 0, 1]), clash([0, 0, -1]), clash([0, 3, 0])];
    console.log(`   ${pid}: seat ${seat.toFixed(1)}  up ${up.toFixed(0)}  down ${down.toFixed(0)}  fore ${fore.toFixed(0)} mm3`);
    ok(seat < 1 && down > 20 && fore > 20, `${label}/${pid}: seats clean, blocked downward and fore/aft`);
    // The two ends differ BY DESIGN and the probe has to say so. At the bottom
    // the tab tucks under rail material, so the plate is captured and the frame
    // is built onto it. At the top the ledge is open upward — the plate drops
    // into an assembled frame and lifts back out — so uplift is held by the M5
    // through each end tab, not by geometry. Asserting the bottom's capture on
    // the top plate is what made this probe read 14 FAILs.
    if (pid === 'rack-bottom') ok(up > 20, `${label}/${pid}: bottom plate is captured in z`);
    else ok(up < 1, `${label}/${pid}: top plate lifts out of an assembled frame`);
  }
  m.forEach((x) => x.delete());
}
console.log(fail ? `\n${fail} FAILED` : '\nALL PASSED');
process.exit(fail ? 1 : 0);
