// Review claim: evaluateOp passes `segments ?? 0`, and Manifold's DEFAULT
// circular-segment count at r=0.5 is only 4 — so every small-radius round
// offset in this app is a square-cornered approximation. Verify, and find out
// how far the error reaches into geometry that already ships.
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();
const { CrossSection, Manifold } = tl;
const out = (s) => process.stdout.write(s + '\n');

out('=== Manifold.getCircularSegments(r) with shipped defaults ===');
for (const r of [0.2, 0.5, 1.0, 1.5875, 3.175, 5, 10]) {
  const n = tl.getCircularSegments(r);
  const chord = r * (1 - Math.cos(Math.PI / n));
  out(`  r=${String(r).padEnd(7)} segments=${String(n).padStart(3)}   chord error=${chord.toFixed(4)} mm`);
}

out('\n=== a circle at r=0.5: default vs explicit ===');
for (const seg of [0, 4, 16, 64, 256]) {
  const cs = CrossSection.circle(0.5, seg);
  out(`  segments=${String(seg).padStart(3)}  area=${cs.area().toFixed(5)}  (exact ${(Math.PI*0.25).toFixed(5)})`);
}

out('\n=== roundedRect(40, 20, 2) as the app builds it: pOffset(rect, r, round) ===');
// profile.ts roundedRect = pOffset(translate([r,r], rect(w-2r, h-2r)), r, 'round')
for (const seg of [0, 4, 16, 64]) {
  const inner = CrossSection.square([40 - 4, 20 - 4], false).translate([2, 2]);
  const cs = inner.offset(2, 'Round', 2, seg);
  const exact = (40 - 4) * (20 - 4) + 2 * 2 * (36 + 16) + Math.PI * 4;
  out(`  segments=${String(seg).padStart(3)}  area=${cs.area().toFixed(4)}  exact=${exact.toFixed(4)}  err=${(exact - cs.area()).toFixed(4)} mm2`);
}

out('\n=== the oracle case: opening of a 20 x 1.6 mm stroke with r=0.5 ===');
for (const seg of [0, 4, 16, 64, 256]) {
  const stroke = CrossSection.square([20, 1.6], false);
  const opened = stroke.offset(-0.5, 'Round', 2, seg).offset(0.5, 'Round', 2, seg);
  out(`  segments=${String(seg).padStart(3)}  opened area=${opened.area().toFixed(4)}  (ideal rect 20x1.6 = 32.0000)`);
}

out('\n=== badge corner R3.175 — does the shipped default hurt it? ===');
const n = tl.getCircularSegments(3.175);
out(`  segments at r=3.175: ${n}, chord error ${(3.175*(1-Math.cos(Math.PI/n))).toFixed(4)} mm`);
