// Machine-screw pilot-hole test coupon — issue #140.
//
// Settles, empirically and with the operator's own screws, filament and
// printer, what starter hole a 60-degree metric MACHINE screw wants when it is
// driven straight into plastic. The arithmetic answer is not the answer: the
// ~0.8x-major rule everyone quotes is for thread-FORMING screws, and when this
// coupon was first printed for M5 it came back at 4.8, nearly a millimetre
// away from the 4.0-4.3 that rule predicts. A machine screw at 4.0 does not
// form thread in PLA, it splits the boss.
//
// Two rows, because layer direction changes thread strength and the rack uses
// both: holes down through the TOP face (axis across the layers, as the plate
// tab screws sit when the side panel prints inner-face-down) and holes into
// the FRONT face (axis along the layers). Same five diameters in each.
//
// The ladder is the table's pilot for the size and the four 0.2 mm steps below
// it, so the SHIPPED value is always the last column. If the best hole is that
// last column the optimum is not bracketed above — which is exactly where M5
// still stands.
//
//   npm run pilot:coupon           ->  samples/pilot-coupon-m5.stl
//   npm run pilot:coupon -- M3     ->  samples/pilot-coupon-m3.stl

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';

import { cube, cylinder, axisCylinder, translate, union, difference, type BuildOp } from '../src/engine/compiler/buildPlan';
import { FASTENERS, pilotDiameter, type FastenerSize } from '../src/engine/compiler/fasteners';
import { executeOpSync } from '../src/workers/geometry/evaluateOp';
import { buildBinaryStl } from '../src/workers/export/stlBinary';
import { engrave } from './coupon-glyphs';

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, '..', '..', 'samples');
mkdirSync(samplesDir, { recursive: true });
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();

const arg = (process.argv[2] ?? 'M5').toUpperCase();
const SIZE = (Object.keys(FASTENERS) as FastenerSize[]).find((s) => s.toUpperCase() === arg);
if (!SIZE) {
  console.error(`unknown size "${arg}" — one of ${Object.keys(FASTENERS).join(', ')}`);
  process.exit(1);
}
const SHIPPED = pilotDiameter(SIZE, 'machine');
const DIAMETERS = [4, 3, 2, 1, 0].map((k) => Math.round((SHIPPED - k * 0.2) * 100) / 100);
const PITCH = 19;
const X0 = 17;
const BAR_X = X0 * 2 + PITCH * (DIAMETERS.length - 1); // 110
const BAR_Y = 30;
const BAR_Z = 18;
const VERT_DEPTH = 14;   // blind, leaves a 4 mm floor
const VERT_Y = 22;
const HORIZ_DEPTH = 14;  // blind into a 30 mm bar
const HORIZ_Z = 7;
const ENGRAVE = 0.8;

const solid: BuildOp[] = [cube([BAR_X, BAR_Y, BAR_Z])];
const cuts: BuildOp[] = [];

DIAMETERS.forEach((d, i) => {
  const cx = X0 + i * PITCH;
  // Row 1 — down through the top face.
  cuts.push(translate([cx, VERT_Y, BAR_Z - VERT_DEPTH], cylinder(VERT_DEPTH + 1, d / 2, 48)));
  // Row 2 — into the front face.
  cuts.push(translate([cx, -0.5, HORIZ_Z], axisCylinder('+y', HORIZ_DEPTH + 0.5, d / 2, 48)));
  // Label: the digits of the diameter, e.g. 4.4 -> "44".
  cuts.push(...engrave(d.toFixed(1).replace('.', ''), cx, 11.5, BAR_Z, ENGRAVE));
});

const op = difference([union(solid), ...cuts]);
const m = executeOpSync(tl, op);
const mesh = m.getMesh();
const positions = new Float32Array(mesh.vertProperties);
const indices = new Uint32Array(mesh.triVerts);
// ---- self-check: measure what we just built ------------------------------
const { Manifold } = tl;
const solidAt = (x: number, y: number, z: number): boolean => {
  const c = Manifold.cube([0.35, 0.35, 0.35]).translate([x - 0.175, y - 0.175, z - 0.175]);
  const i = Manifold.intersection([m, c]);
  const v = i.volume();
  i.delete();
  c.delete();
  return v > 0.02;
};
// Blind holes are dimples, not handles — genus 0 is correct here.
console.log(`\ngenus ${m.genus()} (0 expected: every hole is blind)`);
// The 0.35 mm probe cube under-reads both figures by about 0.1-0.2 mm.
console.log('TOP ROW   nominal  measured  depth');
DIAMETERS.forEach((d, k) => {
  const cx = X0 + k * PITCH;
  let dia = 0;
  for (let r = 1.6; r < 3.0; r += 0.05) { if (!solidAt(cx + r, VERT_Y, BAR_Z - 1)) dia = r * 2; else break; }
  let depth = 0;
  for (let z = BAR_Z - 0.5; z > 0; z -= 0.25) { if (!solidAt(cx, VERT_Y, z)) depth = BAR_Z - z; else break; }
  console.log(`  x=${String(cx).padStart(3)}   ${d.toFixed(1)}      ${dia.toFixed(1)}      ${depth.toFixed(1)} mm`);
});
console.log('FRONT ROW nominal  measured  depth');
DIAMETERS.forEach((d, k) => {
  const cx = X0 + k * PITCH;
  let dia = 0;
  for (let r = 1.6; r < 3.0; r += 0.05) { if (!solidAt(cx + r, 3, HORIZ_Z)) dia = r * 2; else break; }
  let depth = 0;
  for (let y = 0.5; y < BAR_Y; y += 0.25) { if (!solidAt(cx, y, HORIZ_Z)) depth = y; else break; }
  console.log(`  x=${String(cx).padStart(3)}   ${d.toFixed(1)}      ${dia.toFixed(1)}      ${depth.toFixed(1)} mm`);
});
console.log('\nEngraved labels, top face sampled just under z = BAR_Z:');
for (let y = 19.5; y >= 9.5; y -= 0.75) {
  let row = '';
  for (let x = 6; x < 106; x += 0.5) row += solidAt(x, y, BAR_Z - ENGRAVE / 2) ? '#' : ' ';
  console.log('  ' + row);
}

const buf = buildBinaryStl([{ positions, indices }]);
const out = join(samplesDir, `pilot-coupon-${SIZE.toLowerCase().replace('.', '')}.stl`);
writeFileSync(out, Buffer.from(buf));
console.log(`${out.split(/[\\/]/).pop()}  ${indices.length / 3} triangles  ${(buf.byteLength / 1024).toFixed(1)} KB`);
console.log(`bar ${BAR_X} x ${BAR_Y} x ${BAR_Z} mm; volume ${(m.volume() / 1000).toFixed(1)} cm3`);
console.log(`diameters ${DIAMETERS.join(', ')} — top row blind ${VERT_DEPTH} mm, front row blind ${HORIZ_DEPTH} mm`);
m.delete();
