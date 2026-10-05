// Magnet-pocket FIT coupon — issue #152.
//
// Every row in `MAGNETS` (fasteners.ts) is `derived`: the 6x2 pocket is the
// reviewed system's own printed number (ToolStack, /Toolbox.md construct 7),
// and 8x3 / 10x2 are that +0.25 radial / +0.4 deep rule extrapolated to two
// more sizes. One data point is not a rule. This coupon is how the table stops
// being arithmetic.
//
// It is the SAME shape as the M5 pilot coupon (#140) and the thread coupon,
// because that shape is the lesson: a ladder of fits printed in TWO layer
// orientations, the shipped value sitting in the MIDDLE so the coupon brackets
// it on both sides. The pilot put the shipped value LAST because it was asking
// "is the optimum above us?"; a magnet can be too TIGHT as easily as too loose,
// so this ladder reaches into INTERFERENCE (a press fit — pocket smaller than
// the disc) and out into a loose slip.
//
// A real magnet is the OTHER half of the fit, and it is a bought part — so only
// the pocket prints, exactly like the thread coupon (the screw is bought too).
// Press a real magnet into every hole in both rows and report:
//   • the smallest pocket that holds without splitting the boss (the press fit)
//   • the largest that still seats and stays put (the glue/slip fit)
//
//   npm run magnet:coupon            -> all three sizes
//   npm run magnet:coupon -- 8x3     -> samples/magnet-coupon-8x3.stl only

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';

import { MAGNETS, type MagnetSize } from '../src/engine/compiler/fasteners';
import {
  buildMagnetCoupon,
  magnetCouponLayout,
  magnetPocketDiameterFor,
  shippedMagnetClearance,
} from '../src/engine/compiler/fitCoupons';
import { executeOpSync } from '../src/workers/geometry/evaluateOp';
import { buildBinaryStl } from '../src/workers/export/stlBinary';
import { engrave } from './coupon-glyphs';

const here = dirname(fileURLToPath(import.meta.url));
// Default output is the shared `samples/` (same as pilot/thread). `COUPON_OUT`
// redirects it — used to verify the generator without touching that directory.
const outDir = process.env.COUPON_OUT
  ? join(process.env.COUPON_OUT)
  : join(here, '..', '..', 'samples');
mkdirSync(outDir, { recursive: true });
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();

const ALL: MagnetSize[] = ['6x2', '8x3', '10x2'];
const arg = process.argv[2];
let sizes: MagnetSize[];
if (!arg) {
  sizes = ALL;
} else {
  const wanted = ALL.find((s) => s.toUpperCase() === arg.toUpperCase());
  if (!wanted) {
    console.error(`unknown magnet size "${arg}" — one of ${ALL.join(', ')}`);
    process.exit(1);
  }
  sizes = [wanted];
}

const { Manifold } = tl;

for (const size of sizes) {
  const built = buildMagnetCoupon(size, engrave);
  const m = executeOpSync(tl, built.op);
  const spec = MAGNETS[size];

  const solidAt = (x: number, y: number, z: number): boolean => {
    const c = Manifold.cube([0.3, 0.3, 0.3]).translate([x - 0.15, y - 0.15, z - 0.15]);
    const i = Manifold.intersection([m, c]);
    const v = i.volume();
    i.delete();
    c.delete();
    return v > (0.3 * 0.3 * 0.3) / 2;
  };

  const BAR_Z = built.dims.z;
  const pocketDepth = spec.pocket.h;
  const L = magnetCouponLayout(size);
  const VERT_Y = L.vertY;
  const HORIZ_Z = L.horizZ;

  console.log(`\n${size} — disc ${spec.d}x${spec.h}, shipped pocket ${spec.pocket.d}x${spec.pocket.h}`);
  console.log(`ladder is DIAMETRAL clearance (pocket − disc), shipped = ${shippedMagnetClearance()}`);
  console.log(`components ${m.decompose().length} (1 expected)   genus ${m.genus()} (0: every pocket blind)`);
  console.log('\nTOP ROW   clearance  pocketØ  measuredØ  depth');
  for (const col of built.columns) {
    const cx = col.x;
    // Radial scan at mid-depth: the pocket wall is where solid starts.
    let dia = 0;
    for (let r = 1.5; r < Math.max(6, spec.d) ; r += 0.05) {
      if (!solidAt(cx + r, VERT_Y, BAR_Z - pocketDepth / 2)) dia = r * 2;
      else break;
    }
    let depth = 0;
    for (let z = BAR_Z - 0.5; z > 0; z -= 0.25) {
      if (!solidAt(cx, VERT_Y, z)) depth = BAR_Z - z;
      else break;
    }
    const want = magnetPocketDiameterFor(size, col.value);
    const tag = col.shipped ? '  <- shipped' : '';
    console.log(
      `  x=${String(Math.round(cx)).padStart(3)}   ${String(col.value).padStart(5)}     ` +
        `${want.toFixed(2).padStart(5)}      ${dia.toFixed(1).padStart(4)}    ${depth.toFixed(1)}${tag}`,
    );
  }
  console.log('FRONT ROW  clearance  pocketØ  measuredØ  depth');
  for (const col of built.columns) {
    const cx = col.x;
    let dia = 0;
    for (let r = 1.5; r < Math.max(6, spec.d); r += 0.05) {
      if (!solidAt(cx + r, pocketDepth / 2, HORIZ_Z)) dia = r * 2;
      else break;
    }
    let depth = 0;
    for (let y = 0.5; y < built.dims.y; y += 0.25) {
      if (!solidAt(cx, y, HORIZ_Z)) depth = y;
      else break;
    }
    const want = magnetPocketDiameterFor(size, col.value);
    const tag = col.shipped ? '  <- shipped' : '';
    console.log(
      `  x=${String(Math.round(cx)).padStart(3)}   ${String(col.value).padStart(5)}     ` +
        `${want.toFixed(2).padStart(5)}      ${dia.toFixed(1).padStart(4)}    ${depth.toFixed(1)}${tag}`,
    );
  }

  console.log('\nEngraved labels, top face sampled just under z = BAR_Z:');
  for (let y = L.labelY + 7.5; y >= L.labelY - 1; y -= 0.75) {
    let row = '';
    for (let x = 4; x < built.dims.x - 4; x += 0.5) {
      row += solidAt(x, y, BAR_Z - L.engrave / 2) ? '#' : ' ';
    }
    console.log('  ' + row);
  }

  const mesh = m.getMesh();
  const buf = buildBinaryStl([
    { positions: new Float32Array(mesh.vertProperties), indices: new Uint32Array(mesh.triVerts) },
  ]);
  const name = `magnet-coupon-${size}.stl`;
  writeFileSync(join(outDir, name), Buffer.from(buf));
  console.log(
    `\n${name}  ${mesh.triVerts.length / 3} triangles  ${(buf.byteLength / 1024).toFixed(1)} KB`,
  );
  console.log(
    `bar ${built.dims.x.toFixed(0)} x ${built.dims.y.toFixed(0)} x ${built.dims.z.toFixed(0)} mm; ` +
      `volume ${(m.volume() / 1000).toFixed(1)} cm3`,
  );
  console.log(`settles ${built.settles}`);
  console.log(built.provenance);
  m.delete();
}
