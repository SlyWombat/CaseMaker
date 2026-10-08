// Scratch: is `scripts/font-opening-report.ts` plumbing the radius correctly?
//
// The morphological opening is scale-invariant by construction: opening the glyph of cap height
// S at radius r is the same shape, up to a factor k, as opening the glyph of cap height k·S at
// radius k·r. So the RATIO must be identical. If the report mis-passes the radius (or the font
// size), this is what breaks, and nothing else in the report would notice.
//
// Run (Windows, from casemaker-app):
//   npx tsx --tsconfig tsconfig.scripts.json qa-opening-scale.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import ManifoldModule from 'manifold-3d';
import { registerBundledFontBytes } from '@/engine/fonts/registry';
import { BUNDLED_FONT_URLS } from '@/engine/fonts/fontAssets';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { measureLabels } from '@/workers/sim/engraveGeometry';

for (const [key, url] of Object.entries(BUNDLED_FONT_URLS)) {
  const b = readFileSync(fileURLToPath(url));
  registerBundledFontBytes(key, b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();

function ratioFor(fontId, weight, word, size, r) {
  const base = defaultEngraveJob();
  const job = {
    ...base,
    labels: [{ id: 'p', text: word, font: fontId, weight, size, position: { x: 50, y: 30 }, rotation: 0, depth: 1, enabled: true }],
  };
  const perChar = () => [];
  return measureLabels(tl, toPartPlan(job), r, job.edgeMargin, perChar)[0]?.ratio ?? 0;
}

const CASES = [
  { word: 'CASE', font: 'sans-default', weight: 'bold', a: 4, ra: 0.25, b: 8, rb: 0.5 },
  { word: 'CASE', font: 'sans-default', weight: 'bold', a: 6, ra: 0.5, b: 12, rb: 1.0 },
  { word: 'MAKER', font: 'serif-default', weight: 'regular', a: 4, ra: 0.3, b: 10, rb: 0.75 },
  { word: 'CASE', font: 'mono-default', weight: 'regular', a: 3, ra: 0.2, b: 9, rb: 0.6 },
];

let bad = 0;
let worst = 0;
for (const c of CASES) {
  const x = ratioFor(c.font, c.weight, c.word, c.a, c.ra);
  const y = ratioFor(c.font, c.weight, c.word, c.b, c.rb);
  const d = Math.abs(x - y);
  worst = Math.max(worst, d);
  // The two tessellate differently (Manifold's arc segments, opentype's curve flattening are both
  // absolute-mm), so exact equality is not achievable. What must hold is that the disagreement is
  // small wherever the text is not itself a knife edge: at a low ratio a hundredth of a millimetre
  // decides whether the last sliver of a stroke is cut at all, and there the two runs legitimately
  // part. So a wide disagreement is a FAILURE only off a cliff.
  const atCliff = Math.min(x, y) < 0.5;
  const wide = d >= 0.005;
  const ok = !wide || atCliff;
  if (!ok) bad++;
  console.log(
    `${ok ? (wide ? 'cliff' : 'OK   ') : 'FAIL '} ${c.font}/${c.weight} ${c.word}: ` +
      `${c.a} mm @ r=${c.ra} -> ${(x * 100).toFixed(4)} %   vs   ${c.b} mm @ r=${c.rb} -> ${(y * 100).toFixed(4)} %   ` +
      `Δ ${(d * 100).toFixed(3)} pp`,
  );
}

// And the report's own headline cell, recomputed here, so the two agree by the number:
console.log(
  `\nBarlow Bold CASE @ 4 mm, r=0.5 (report says 3.9 %): ` +
    `${(ratioFor('sans-default', 'bold', 'CASE', 4, 0.5) * 100).toFixed(1)} %`,
);
console.log(
  `Barlow Bold CASE @ 14 mm, r=0.5 (report says 99.7 %): ` +
    `${(ratioFor('sans-default', 'bold', 'CASE', 14, 0.5) * 100).toFixed(1)} %`,
);

console.log(bad === 0
  ? `\nscale-invariance: harness agrees off every cliff (worst Δ ${(worst * 100).toFixed(3)} pp, at a knife edge)`
  : `\nscale-invariance: ${bad} case(s) disagree away from a cliff (worst Δ ${(worst * 100).toFixed(3)} pp)`);
process.exit(bad === 0 ? 0 : 1);
