// M5 thread-forming pilot-hole test coupon — issue #140.
//
// The rack's receiving holes are SCREW_THREAD_D = 4.7. For M5x0.8 (major
// 5.000, minor 4.134) that leaves (5.0 - 4.7) / 2 = 0.15 mm of radial thread
// engagement, which is a clearance hole pretending to hold. Thread forming
// into thermoplastic normally wants ~0.8x major, about 4.0-4.3. Rather than
// change it on arithmetic, this coupon settles it empirically with the
// operator's own screws, filament and printer.
//
// Two rows, because layer direction changes thread strength and the rack uses
// both: holes down through the TOP face (axis across the layers, as the plate
// tab screws sit when the side panel prints inner-face-down) and holes into
// the FRONT face (axis along the layers). Same five diameters in each.
//
//   npm run pilot:coupon   ->  samples/pilot-coupon-m5.stl

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';

import { cube, cylinder, axisCylinder, translate, union, difference, type BuildOp } from '../src/engine/compiler/buildPlan';
import { executeOpSync } from '../src/workers/geometry/evaluateOp';
import { buildBinaryStl } from '../src/workers/export/stlBinary';

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, '..', '..', 'samples');
mkdirSync(samplesDir, { recursive: true });
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();

const DIAMETERS = [4.0, 4.2, 4.4, 4.6, 4.8];
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

// ---- seven-segment digits, drawn as rectangles -----------------------------
// Only 0/2/4/6/8 are ever needed (the tenths of 4.0-4.8), plus the leading 4.
const H = 7;            // digit height
const W = 4.2;          // digit width
const T = 1.0;          // stroke thickness
type Seg = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';
const SEGMENTS: Record<string, Seg[]> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '2': ['a', 'b', 'g', 'e', 'd'],
  '4': ['f', 'g', 'b', 'c'],
  '6': ['a', 'f', 'g', 'e', 'c', 'd'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
};
// Each segment as [x, y, w, h] in a W x H box with origin at bottom-left.
const SEG_RECT: Record<Seg, [number, number, number, number]> = {
  a: [T, H - T, W - 2 * T, T],
  g: [T, H / 2 - T / 2, W - 2 * T, T],
  d: [T, 0, W - 2 * T, T],
  f: [0, H / 2, T, H / 2 - T / 2],
  b: [W - T, H / 2, T, H / 2 - T / 2],
  e: [0, T, T, H / 2 - T / 2],
  c: [W - T, T, T, H / 2 - T / 2],
};

/** Engraved glyph on the top face: shallow prisms cut into z = BAR_Z. */
function glyph(ch: string, x: number, y: number): BuildOp[] {
  const segs = SEGMENTS[ch]!;
  return segs.map((s) => {
    const [sx, sy, sw, sh] = SEG_RECT[s];
    return translate([x + sx, y + sy, BAR_Z - ENGRAVE], cube([sw, sh, ENGRAVE + 1]));
  });
}

const solid: BuildOp[] = [cube([BAR_X, BAR_Y, BAR_Z])];
const cuts: BuildOp[] = [];

DIAMETERS.forEach((d, i) => {
  const cx = X0 + i * PITCH;
  // Row 1 — down through the top face.
  cuts.push(translate([cx, VERT_Y, BAR_Z - VERT_DEPTH], cylinder(VERT_DEPTH + 1, d / 2, 48)));
  // Row 2 — into the front face.
  cuts.push(translate([cx, -0.5, HORIZ_Z], axisCylinder('+y', HORIZ_DEPTH + 0.5, d / 2, 48)));
  // Label: the two digits of the diameter, e.g. 4.4 -> "44".
  const text = `${d.toFixed(1)}`.replace('.', '');
  const totalW = text.length * W + (text.length - 1) * 1.4;
  text.split('').forEach((ch, k) => {
    cuts.push(...glyph(ch, cx - totalW / 2 + k * (W + 1.4), 11.5));
  });
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
const out = join(samplesDir, 'pilot-coupon-m5.stl');
writeFileSync(out, Buffer.from(buf));
console.log(`pilot-coupon-m5.stl  ${indices.length / 3} triangles  ${(buf.byteLength / 1024).toFixed(1)} KB`);
console.log(`bar ${BAR_X} x ${BAR_Y} x ${BAR_Z} mm; volume ${(m.volume() / 1000).toFixed(1)} cm3`);
console.log(`diameters ${DIAMETERS.join(', ')} — top row blind ${VERT_DEPTH} mm, front row blind ${HORIZ_DEPTH} mm`);
m.delete();
