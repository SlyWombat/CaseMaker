/**
 * #960 — THE TRAY'S SLOPES BESIDE MAKERA'S T1 FLAT, and the steepest slope the vendor's flat
 * actually finished. Not a spec: a measurement tool (it reads the local-only Makerables files,
 * which stay out of git).
 *
 * Inputs: a goal-heightfield base path (`<base>.json` + `.bin` + `.cov`, the app's own sampler's
 * output — see `.scratch/makerables/tools/goal-hf.mts`) and Makera's NC for the same part side.
 * Outputs: a printed summary and an SVG plan view — every covered cell coloured by its slope
 * under the two candidate flat thresholds (the equal-cusp 1.93° and the vendor-like 7.1°), with
 * T1's own feed moves drawn over it.
 *
 * Run:
 *   npx tsx --tsconfig tsconfig.tests.json tests/tools/tray-slope-960.ts \
 *     <hf base> <nc file> <out.svg> [--tool 1] [--thresholds 1.93,7.1]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1]!.startsWith('--')));
const [hfBase, ncPath, outSvg] = positional;
if (hfBase === undefined || ncPath === undefined || outSvg === undefined) {
  console.error('usage: tray-slope-960.ts <hf base> <nc file> <out.svg> [--tool 1] [--thresholds 1.93,7.1]');
  process.exit(2);
}
const toolNumber = Number(opt('--tool', '1'));
const thresholds = opt('--thresholds', '1.93,7.1').split(',').map(Number);

interface Hf {
  nx: number;
  ny: number;
  pitch: number;
  x0: number;
  y0: number;
  z: Float32Array;
  cov: Uint8Array;
}

const meta = JSON.parse(readFileSync(`${hfBase}.json`, 'utf8')) as { nx: number; ny: number; pitch: number; x0: number; y0: number };
// Buffers from `readFileSync` can sit inside Node's pooled ArrayBuffer; copy through their own
// range so the float view starts at the file's first byte.
const binBuf = readFileSync(`${hfBase}.bin`);
const covBuf = readFileSync(`${hfBase}.cov`);
const z = new Float32Array(binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength));
const cov = new Uint8Array(covBuf.buffer.slice(covBuf.byteOffset, covBuf.byteOffset + covBuf.byteLength));
if (z.length !== meta.nx * meta.ny || cov.length !== meta.nx * meta.ny) {
  throw new Error(`heightfield sizes do not match ${meta.nx}×${meta.ny}`);
}
const hf: Hf = { ...meta, z, cov };

/** Slope in degrees at a grid cell, central differences (NaN where any neighbour is uncovered). */
function slopeAt(i: number, j: number): number {
  const { nx, pitch } = hf;
  if (i <= 0 || j <= 0 || i >= hf.nx - 1 || j >= hf.ny - 1) return Number.NaN;
  const at = (ii: number, jj: number): number => (hf.cov[jj * nx + ii] === 1 ? hf.z[jj * nx + ii]! : Number.NaN);
  const c = at(i, j);
  const l = at(i - 1, j);
  const r = at(i + 1, j);
  const d = at(i, j - 1);
  const u = at(i, j + 1);
  if (![c, l, r, d, u].every((v) => Number.isFinite(v))) return Number.NaN;
  const gx = (r - l) / (2 * pitch);
  const gy = (u - d) / (2 * pitch);
  return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
}

const slopeOfCell = new Float32Array(hf.nx * hf.ny).fill(Number.NaN);
for (let j = 0; j < hf.ny; j++) for (let i = 0; i < hf.nx; i++) slopeOfCell[j * hf.nx + i] = slopeAt(i, j);

/** The heightfield cell under a stock-frame point, clamped to the grid; NaN outside. */
function cellSlope(x: number, y: number): number {
  const i = Math.round((x - hf.x0) / hf.pitch);
  const j = Math.round((y - hf.y0) / hf.pitch);
  if (i < 0 || j < 0 || i >= hf.nx || j >= hf.ny) return Number.NaN;
  return slopeOfCell[j * hf.nx + i]!;
}

// ---- Makera's own moves for the chosen tool --------------------------------------------------
const nc = readFileSync(ncPath, 'utf8').split('\n');
let currentTool: number | null = null;
// The NC names its tool paths in a header comment; a 3D relief/pocket follows the surface (its
// slope is the question this tool asks), a contour steps down walls (its moves are not rasters,
// so their wall cells are not evidence of a raster's slope).
const pathNames = new Map<number, string>();
for (const line of nc) {
  const m = /^;@MKR\|TOOLPATH\|number=(\d+)\|tool_number=\d+\|name=(.+)$/.exec(line.trim());
  if (m !== null) pathNames.set(Number(m[1]), m[2]!);
}
const pathFilter = opt('--paths', 'relief,pocket').split(',').map((v) => v.trim().toLowerCase());
let currentPath: number | null = null;
const moves: { a: [number, number]; b: [number, number]; z: number }[] = [];
let px = 0;
let py = 0;
let pz = 0;
for (const rawLine of nc) {
  const line = rawLine.trim();
  const start = /^;@MKR\|TOOLPATH_START\|toolpath_number=(\d+)$/.exec(line);
  if (start !== null) {
    currentPath = Number(start[1]);
    continue;
  }
  const tool = /^T(\d+)\s+M6/.exec(line);
  if (tool !== null) {
    currentTool = Number(tool[1]);
    continue;
  }
  if (line.startsWith(';')) continue;
  const feed = /^G1\s+(.*)$/.exec(line);
  if (feed === null) {
    const rapid = /^G0\s+(.*)$/.exec(line);
    if (rapid !== null) {
      const x = /X(-?[\d.]+)/.exec(rapid[1]!);
      const y = /Y(-?[\d.]+)/.exec(rapid[1]!);
      const zz = /Z(-?[\d.]+)/.exec(rapid[1]!);
      if (x) px = Number(x[1]);
      if (y) py = Number(y[1]);
      if (zz) pz = Number(zz[1]);
    }
    continue;
  }
  if (currentTool !== toolNumber) continue;
  const pathName = currentPath === null ? '' : (pathNames.get(currentPath) ?? '').toLowerCase();
  if (!pathFilter.some((f) => pathName.includes(f))) continue;
  const words = feed[1]!;
  const nxv = /X(-?[\d.]+)/.exec(words);
  const nyv = /Y(-?[\d.]+)/.exec(words);
  const nzv = /Z(-?[\d.]+)/.exec(words);
  const tx = nxv ? Number(nxv[1]) : px;
  const ty = nyv ? Number(nyv[1]) : py;
  const tz = nzv ? Number(nzv[1]) : pz;
  // A cutting move: XY travel at a depth below the stock top (Z ≤ 0 here).
  if ((nxv || nyv) && (px !== tx || py !== ty) && tz <= 0) {
    moves.push({ a: [px, py], b: [tx, ty], z: tz });
  }
  px = tx;
  py = ty;
  pz = tz;
}

const sampleSlopes: number[] = [];
const STEP_MM = 0.5;
for (const m of moves) {
  const len = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1]);
  const n = Math.max(1, Math.ceil(len / STEP_MM));
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const s = cellSlope(m.a[0] + (m.b[0] - m.a[0]) * t, m.a[1] + (m.b[1] - m.a[1]) * t);
    if (Number.isFinite(s)) sampleSlopes.push(s);
  }
}
sampleSlopes.sort((a, b) => a - b);
const pct = (p: number): number => sampleSlopes[Math.min(sampleSlopes.length - 1, Math.floor((p / 100) * sampleSlopes.length))] ?? Number.NaN;
console.log(
  JSON.stringify({
    tool: toolNumber,
    moves: moves.length,
    samples: sampleSlopes.length,
    slopeDeg: {
      max: Number((sampleSlopes[sampleSlopes.length - 1] ?? Number.NaN).toFixed(2)),
      p99: Number(pct(99).toFixed(2)),
      p95: Number(pct(95).toFixed(2)),
      median: Number(pct(50).toFixed(2)),
    },
    thresholds,
    shareUnder: thresholds.map((t) => Number(((sampleSlopes.filter((s) => s <= t).length / Math.max(1, sampleSlopes.length)) * 100).toFixed(1))),
  }),
);

// ---- the picture ----------------------------------------------------------------------------
const colours = ['#3f8f4f', '#c9a227', '#8a3b3b'];
const legend = [`≤ ${thresholds[0]}°`, `${thresholds[0]}–${thresholds[1] ?? '∞'}°`, `> ${thresholds[1] ?? thresholds[0]}°`];
const SCALE = 4; // px per mm
const W = Math.round(hf.nx * hf.pitch * SCALE);
const H = Math.round(hf.ny * hf.pitch * SCALE);
// One cell per BLOCK×BLOCK of the 0.1 mm grid (the block's steepest cell wins — a wall shows
// through a gentle block), with equal-colour runs merged along each row so the SVG stays small.
const BLOCK = 4;
const rects: string[] = [];
const bw = hf.pitch * BLOCK;
for (let jb = 0; jb < hf.ny; jb += BLOCK) {
  let runColour = -1;
  let runStart = 0;
  const flush = (endBlock: number): void => {
    if (runColour < 0) return;
    const x = runStart * bw * SCALE;
    const y = (hf.ny - 1 - Math.min(hf.ny - 1, jb + BLOCK - 1)) * hf.pitch * SCALE;
    const h = Math.min(BLOCK, hf.ny - jb) * hf.pitch * SCALE;
    rects.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${((endBlock - runStart) * bw).toFixed(1)}" height="${h.toFixed(1)}" fill="${colours[runColour]}"/>`,
    );
  };
  for (let ib = 0; ib < hf.nx; ib += BLOCK) {
    let steepest = Number.NaN;
    let covered = false;
    for (let dj = 0; dj < BLOCK; dj++) {
      const j = jb + dj;
      if (j >= hf.ny) break;
      for (let di = 0; di < BLOCK; di++) {
        const i = ib + di;
        if (i >= hf.nx) break;
        if (hf.cov[j * hf.nx + i] !== 1) continue;
        const v = slopeOfCell[j * hf.nx + i]!;
        if (!Number.isFinite(v)) continue;
        covered = true;
        if (!(steepest >= v)) steepest = v;
      }
    }
    const band = !covered ? -1 : thresholds.length > 1 && steepest > thresholds[1]! ? 2 : steepest > thresholds[0]! ? 1 : 0;
    if (band !== runColour) {
      flush(ib);
      runColour = band;
      runStart = ib;
    }
  }
  flush(Math.ceil(hf.nx / BLOCK) * BLOCK);
}
const paths = moves
  .map((m) => {
    const x1 = (m.a[0] - hf.x0) * SCALE;
    const y1 = H - (m.a[1] - hf.y0) * SCALE;
    const x2 = (m.b[0] - hf.x0) * SCALE;
    const y2 = H - (m.b[1] - hf.y0) * SCALE;
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
  })
  .join('');
const legendSvg = legend
  .map((label, i) => `<rect x="10" y="${12 + i * 22}" width="16" height="16" fill="${colours[i]}"/><text x="34" y="${25 + i * 22}" fill="#e8e8e8" font-size="14">${label}</text>`)
  .join('');
const summary = `T${toolNumber}: ${moves.length} cutting moves, steepest ${(sampleSlopes[sampleSlopes.length - 1] ?? 0).toFixed(1)}°, p99 ${pct(99).toFixed(1)}°, median ${pct(50).toFixed(1)}°`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W + 260}" height="${H + 40}" viewBox="0 0 ${W + 260} ${H + 40}">
<rect width="100%" height="100%" fill="#14181d"/>
<g transform="translate(0,20)">${rects.join('')}</g>
<g stroke="#7fb3ff" stroke-width="0.6" opacity="0.9" transform="translate(0,20)">${paths}</g>
<g>${legendSvg}<text x="${W + 20}" y="30" fill="#e8e8e8" font-size="13">${summary}</text></g>
</svg>`;
writeFileSync(outSvg, svg);
console.log(`wrote ${outSvg}`);
