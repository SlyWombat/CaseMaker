// Interface FIT coupons — issue #157.
//
// The compiler emits several fit-critical interfaces (magnet pockets, board-snap
// clips, screw joints). Everyone who ships printed mating parts ships a way to
// print the INTERFACE ALONE first — ToolStack's standard/loose connectors,
// Multiboard's four clearance grades + `MultiboardTestPrint.stl`, the HIVE
// drawers' `drawer_fit_test.stl`. This repo already does it for two interfaces
// (`pilot:coupon`, `thread:coupon`); this is the general one.
//
// The geometry is NOT redrawn here. `fitCoupons.ts` builds each coupon from the
// SAME primitive the compiler uses (`magnetPocket`, `buildBoardSnapOps`), so the
// coupon is the feature, clipped and laid out flat — it cannot drift from what
// ships. This script only evaluates it, self-checks it, and writes the STL.
//
//   npm run fit:coupon                -> every coupon
//   npm run fit:coupon -- magnet-6x2  -> samples/fit-coupon-magnet-6x2.stl only
//   npm run fit:coupon -- --list      -> print the ids and exit

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';

import {
  FIT_COUPONS,
  fitCouponIds,
  buildFitCoupon,
  type FitCouponSpec,
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

const arg = process.argv[2];
if (arg === '--list') {
  for (const c of FIT_COUPONS) console.log(`${c.id.padEnd(14)} ${c.title}`);
  process.exit(0);
}

let specs: readonly FitCouponSpec[];
if (arg) {
  const one = FIT_COUPONS.find((c) => c.id === arg);
  if (!one) {
    console.error(`unknown coupon "${arg}" — one of ${fitCouponIds().join(', ')}`);
    process.exit(1);
  }
  specs = [one];
} else {
  specs = FIT_COUPONS;
}

for (const spec of specs) {
  const built = buildFitCoupon(spec.id, engrave);
  const m = executeOpSync(tl, built.op);
  const bodies = m.decompose().length;

  console.log(`\n${spec.id} — ${spec.title}`);
  console.log(`  ${built.settles}`);
  console.log(
    `  bodies ${bodies} (${built.bodies} expected)   genus ${m.genus()}   ` +
      `volume ${(m.volume() / 1000).toFixed(1)} cm3`,
  );
  console.log(
    `  bar ${built.dims.x.toFixed(0)} x ${built.dims.y.toFixed(0)} x ${built.dims.z.toFixed(0)} mm`,
  );
  if (bodies !== built.bodies) {
    console.log(`  !! expected ${built.bodies} separate bodies, meshed ${bodies}`);
  }
  if (built.columns.length) {
    console.log('  ladder (left to right):');
    for (const c of built.columns) {
      console.log(
        `    x=${String(Math.round(c.x)).padStart(3)}  value ${String(c.value).padStart(5)}  ` +
          `label "${c.label}"${c.shipped ? '   <- shipped' : ''}`,
      );
    }
  }
  console.log(`  ${built.provenance}`);

  const mesh = m.getMesh();
  const buf = buildBinaryStl([
    { positions: new Float32Array(mesh.vertProperties), indices: new Uint32Array(mesh.triVerts) },
  ]);
  const name = `fit-coupon-${spec.id}.stl`;
  writeFileSync(join(outDir, name), Buffer.from(buf));
  console.log(`  -> ${name}  ${mesh.triVerts.length / 3} triangles  ${(buf.byteLength / 1024).toFixed(1)} KB`);
  m.delete();
}
