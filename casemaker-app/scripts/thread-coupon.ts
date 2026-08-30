// Printed-thread FIT coupon — issue #140.
//
// `screwStarter({ mode: 'pre-threaded' })` cuts a modelled ISO thread into the
// receiving part instead of a starter hole the screw taps for itself. Its one
// unproven number is THREAD_FIT: the radial clearance between the modelled
// thread and the real screw. Everything else about the thread comes from a
// standard; the fit comes from how the printer lays plastic, so it has to come
// from a printed part.
//
// The pilot coupon settled the self-tap diameter the same way and taught the
// lesson worth repeating here: the arithmetic answer (4.0-4.3) was wrong and
// the printed answer (4.8) was nearly a millimetre away from it. Do not adopt
// a fit for a structural joint until one of these has been driven.
//
// Two rows, because layer direction changes a thread as much as it changes a
// pilot: holes DOWN through the top face (axis across the layers) and holes
// INTO the front face (axis along them). Same fit ladder in each.
//
//   npm run thread:coupon           -> samples/thread-coupon-m5.stl
//   npm run thread:coupon -- M6     -> samples/thread-coupon-m6.stl
//
// Drive a real screw into every hole, in both rows, and report the LARGEST fit
// that still holds and the SMALLEST that goes in without forcing. If the best
// is at either end of the ladder the optimum is not bracketed — widen it and
// print again, which is exactly the state the 4.8 pilot is still in.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';

import { cube, difference, translate, union, type BuildOp } from '../src/engine/compiler/buildPlan';
import {
  FASTENERS,
  THREAD_FIT,
  preThreadPrintable,
  screwStarter,
  type FastenerSize,
} from '../src/engine/compiler/fasteners';
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
if (!preThreadPrintable(SIZE)) {
  console.error(
    `${SIZE} has a ${FASTENERS[SIZE].pitch} mm pitch, under two 0.4 mm nozzle widths — a modelled\n` +
      `thread there prints as a smooth bore, so there is nothing to test. See preThreadPrintable().`,
  );
  process.exit(1);
}

/** The ladder. THREAD_FIT sits inside it so the shipped value gets driven too. */
const FITS = [0.05, 0.1, 0.15, 0.2, 0.25];

const spec = FASTENERS[SIZE];
const COL = Math.max(19, spec.major * 4);
const X0 = Math.max(14, spec.major * 3);
const BAR_X = X0 * 2 + COL * (FITS.length - 1);
const BAR_Y = 30;
const BAR_Z = 18;
const VERT_DEPTH = 12; // blind, leaves a floor
const VERT_Y = 22;
const HORIZ_DEPTH = 12;
const HORIZ_Z = 7;
const ENGRAVE = 0.8;

const solid: BuildOp[] = [cube([BAR_X, BAR_Y, BAR_Z])];
const cuts: BuildOp[] = [];

FITS.forEach((fit, i) => {
  const cx = X0 + i * COL;
  // Row 1 — threaded DOWN into the top face. The lead-in cone opens upward,
  // which is also the way the hole prints, so its ceiling is never a bridge.
  cuts.push(
    screwStarter({
      size: SIZE,
      at: [cx, VERT_Y, BAR_Z],
      axis: '-z',
      depth: VERT_DEPTH,
      mode: 'pre-threaded',
      thread: { fit },
    }),
  );
  // Row 2 — threaded INTO the front face, axis along the layers.
  cuts.push(
    screwStarter({
      size: SIZE,
      at: [cx, 0, HORIZ_Z],
      axis: '+y',
      depth: HORIZ_DEPTH,
      mode: 'pre-threaded',
      thread: { fit },
    }),
  );
  // Label: the two digits of the fit, e.g. 0.15 -> "15".
  cuts.push(...engrave(fit.toFixed(2).slice(2), cx, 11.5, BAR_Z, ENGRAVE));
});

const m = executeOpSync(tl, difference([union(solid), ...cuts]));

// ---- self-check: measure what we just built --------------------------------
const { Manifold } = tl;
const solidAt = (x: number, y: number, z: number, s = 0.3): boolean => {
  const c = Manifold.cube([s, s, s], true).translate([x, y, z]);
  const i = Manifold.intersection([m, c]);
  const v = i.volume();
  i.delete();
  c.delete();
  return v > (s * s * s) / 2;
};
/** Fraction of the ring at (r, z) that is material — a thread reads part-solid. */
const ringSolid = (cx: number, cy: number, r: number, z: number): number => {
  let hits = 0;
  for (let k = 0; k < 36; k++) {
    const a = (2 * Math.PI * k) / 36;
    if (solidAt(cx + r * Math.cos(a), cy + r * Math.sin(a), z, 0.18)) hits++;
  }
  return hits / 36;
};

console.log(`\n${SIZE} — major ${spec.major}, pitch ${spec.pitch}, minor ${spec.minor}`);
console.log(`shipped THREAD_FIT = ${THREAD_FIT} (row ${FITS.indexOf(THREAD_FIT) + 1} of ${FITS.length})`);
console.log(`components ${m.decompose().length} (1 expected)   genus ${m.genus()}`);
console.log('\nTOP ROW    fit   crest r   groove r   band solid   (a thread is PART solid)');
FITS.forEach((fit, k) => {
  const cx = X0 + k * COL;
  const rMaj = spec.major / 2 + fit;
  const rMin = rMaj - 0.5413 * spec.pitch;
  const z = BAR_Z - VERT_DEPTH / 2;
  const band = ringSolid(cx, VERT_Y, (rMin + rMaj) / 2, z);
  const inner = ringSolid(cx, VERT_Y, rMin - 0.15, z);
  const outer = ringSolid(cx, VERT_Y, rMaj + 0.15, z);
  console.log(
    `  x=${String(Math.round(cx)).padStart(3)}   ${fit.toFixed(2)}   ${rMin.toFixed(3)}    ${rMaj.toFixed(3)}` +
      `      ${(band * 100).toFixed(0)}%   inside ${(inner * 100).toFixed(0)}%  outside ${(outer * 100).toFixed(0)}%`,
  );
});
console.log('\nEngraved labels, top face sampled just under z = BAR_Z:');
for (let y = 19.5; y >= 9.5; y -= 0.75) {
  let row = '';
  for (let x = 4; x < BAR_X - 4; x += 0.5) row += solidAt(x, y, BAR_Z - ENGRAVE / 2) ? '#' : ' ';
  console.log('  ' + row);
}

const mesh = m.getMesh();
const buf = buildBinaryStl([
  { positions: new Float32Array(mesh.vertProperties), indices: new Uint32Array(mesh.triVerts) },
]);
const name = `thread-coupon-${SIZE.toLowerCase().replace('.', '')}.stl`;
writeFileSync(join(samplesDir, name), Buffer.from(buf));
console.log(
  `\n${name}  ${mesh.triVerts.length / 3} triangles  ${(buf.byteLength / 1024).toFixed(1)} KB`,
);
console.log(`bar ${BAR_X} x ${BAR_Y} x ${BAR_Z} mm; volume ${(m.volume() / 1000).toFixed(1)} cm3`);
console.log(`fits ${FITS.join(', ')} — both rows blind, ${VERT_DEPTH} mm deep`);
m.delete();
