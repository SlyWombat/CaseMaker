/**
 * #960 — WHERE THE LEFTOVER RISES between two acceptance runs, as a picture.
 *
 * Reads the two `acceptancePics.ts` output roots (`<card>/grid.json`, `goal.f32`, `union.f32`),
 * computes each cell's leftover (goal top-Z minus the swept top-Z), and draws the cells whose
 * leftover rose above the base run's: amber where the risen cell still sits within the 0.1 mm
 * coverage band, red where it stands above it (the acceptance's failure case). Stock-frame plan
 * view, one block per BLOCK×BLOCK cells of the 0.1 mm grid, equal-colour runs merged.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json tests/tools/risen-cells-960.ts \
 *     --before <root> --after <root> --card tray --out <out.svg> [--png <out.png>]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const before = opt('--before');
const after = opt('--after');
const card = opt('--card');
const out = opt('--out');
const png = opt('--png');
if (before === undefined || after === undefined || card === undefined || out === undefined) {
  console.error('usage: risen-cells-960.ts --before <root> --after <root> --card <name> --out <svg> [--png <png>]');
  process.exit(2);
}

const BAND_MM = 0.1;
interface Field {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  pitch: number;
  goal: Float32Array;
  union: Float32Array;
}
function read(root: string): Field {
  const grid = JSON.parse(readFileSync(path.join(root, card!, 'grid.json'), 'utf8')) as { nx: number; ny: number; x0: number; y0: number; pitch: number };
  const f32 = (name: string): Float32Array => {
    const b = readFileSync(path.join(root, card!, name));
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };
  return { ...grid, goal: f32('goal.f32'), union: f32('union.f32') };
}
const b = read(before);
const a = read(after);
if (b.nx !== a.nx || b.ny !== a.ny || b.x0 !== a.x0 || b.y0 !== a.y0 || b.pitch !== a.pitch) {
  throw new Error('the two runs were not measured on the same goal grid');
}

// Per cell: 0 = not risen, 1 = risen but within the band, 2 = risen above the band.
const cls = new Uint8Array(b.nx * b.ny);
let risen = 0;
let above = 0;
let worstRise = 0;
let worstLeftover = 0;
let worstAt = '';
for (let k = 0; k < cls.length; k++) {
  const base = Math.max(0, b.goal[k]! - b.union[k]!);
  const now = Math.max(0, a.goal[k]! - a.union[k]!);
  if (!(now > base + 1e-6)) continue;
  risen++;
  // 'Newly above' is the acceptance's rule: the cell was WITHIN the band and is now ABOVE it.
  const newlyAbove = now > BAND_MM + 1e-6 && base <= BAND_MM + 1e-6;
  cls[k] = newlyAbove ? 2 : 1;
  if (newlyAbove) above++;
  if (now - base > worstRise) {
    worstRise = now - base;
    if (now > worstLeftover) worstLeftover = now;
    const i = k % b.nx;
    const j = Math.floor(k / b.nx);
    worstAt = `(${(b.x0 + i * b.pitch).toFixed(1)}, ${(b.y0 + j * b.pitch).toFixed(1)})`;
  }
}
console.log(
  JSON.stringify({ card, risen, aboveBand: above, worstRiseMm: Number(worstRise.toFixed(3)), worstLeftoverMm: Number(worstLeftover.toFixed(3)), worstAt }, null, 0),
);

// ---- the picture: the stock frame, one block per BLOCK×BLOCK cells -----------------------------
const SCALE = 4; // px per mm
const BLOCK = 4;
const W = Math.round(Math.ceil(b.x0 + b.nx * b.pitch) * SCALE);
const H = Math.round(Math.ceil(b.y0 + b.ny * b.pitch) * SCALE);
const colours = ['none', '#c9a227', '#b23a3a'];
const rects: string[] = [];
const bw = b.pitch * BLOCK;
for (let jb = 0; jb < b.ny; jb += BLOCK) {
  let run = 0;
  let start = 0;
  const flush = (endBlock: number): void => {
    if (run === 0) return;
    const x = (b.x0 + start * b.pitch) * SCALE;
    const y = H - (b.y0 + (jb + Math.min(BLOCK, b.ny - jb)) * b.pitch) * SCALE;
    const h = Math.min(BLOCK, b.ny - jb) * b.pitch * SCALE;
    rects.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${((endBlock - start) * bw).toFixed(1)}" height="${h.toFixed(1)}" fill="${colours[run]}"/>`);
  };
  for (let ib = 0; ib < b.nx; ib += BLOCK) {
    let steep = 0;
    for (let dj = 0; dj < BLOCK && jb + dj < b.ny; dj++) {
      for (let di = 0; di < BLOCK && ib + di < b.nx; di++) {
        const v = cls[(jb + dj) * b.nx + ib + di]!;
        if (v > steep) steep = v;
      }
    }
    if (steep !== run) {
      flush(ib);
      run = steep;
      start = ib;
    }
  }
  flush(Math.ceil(b.nx / BLOCK) * BLOCK);
}
const summary = `${card}: ${risen} risen cell(s), ${above} above the ${BAND_MM} mm band`;
const legend = [
  ['#c9a227', `risen, within ${BAND_MM} mm`],
  ['#b23a3a', `risen, above ${BAND_MM} mm`],
]
  .map(([c, label], i) => `<rect x="10" y="${12 + i * 22}" width="16" height="16" fill="${c}"/><text x="34" y="${25 + i * 22}" fill="#e8e8e8" font-size="14">${label}</text>`)
  .join('');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 300}" height="${H + 40}" viewBox="0 0 ${W + 300} ${H + 40}">
<rect width="100%" height="100%" fill="#14181d"/>
<g transform="translate(0,20)">${rects.join('')}</g>
<g>${legend}<text x="${W + 20}" y="30" fill="#e8e8e8" font-size="13">${summary}</text>
<text x="${W + 20}" y="52" fill="#e8e8e8" font-size="13">worst rise +${worstRise.toFixed(3)} mm at ${worstAt || '—'}</text></g>
</svg>`;
writeFileSync(out, svg);
console.log(`wrote ${out}`);
if (png !== undefined) {
  execFileSync(process.execPath, [path.join(process.env.HOME ?? '', 'projects', 'cm-gate2', 'casemaker-app', 'svg2png.tmp.mjs'), out, png], { stdio: 'pipe' });
  console.log(`wrote ${png}`);
}
