// Scratch probe for Simulation.md's performance budget (#182).
//
// Question: is exact CSG sweep-and-subtract fast enough to be the simulator,
// or does it force the deferred dexel engine back into scope?
//
// Method: parse a real Makera Studio .nc, build the swept volume of the tool as
// 2D capsules unioned per Z level, extrude, subtract from the stock, and time
// each stage. Then the same for a synthetic constant-Z load shaped like V1's
// actual job (glyph pocketing), which is the case that matters.
//
// Run from Windows node (this checkout's node_modules is win32-x64):
//   powershell.exe -NoProfile -Command "node probe-sim-perf.mjs"

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';

const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();
const { Manifold, CrossSection } = tl;

const NC = process.env.NC_PATH;
const MAX_LEVELS = Number(process.env.MAX_LEVELS ?? 64);
const ONLY = process.env.ONLY ?? '';

// ---- parse ----------------------------------------------------------------
function parseMoves(text) {
  const moves = [];
  let cur = null, rapid = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('(')) continue;
    const m = /^G0?([01])\b/.exec(line);
    if (m) rapid = m[1] === '0';
    else if (/^[GMTSF]/.test(line)) continue;
    const g = (ax) => {
      const r = new RegExp(`${ax}(-?\\d*\\.?\\d+)`).exec(line);
      return r ? parseFloat(r[1]) : null;
    };
    const x = g('X'), y = g('Y'), z = g('Z');
    if (x === null && y === null && z === null) continue;
    const next = { x: x ?? cur?.x ?? 0, y: y ?? cur?.y ?? 0, z: z ?? cur?.z ?? 0 };
    if (cur) moves.push({ ...cur, x1: next.x, y1: next.y, z1: next.z, rapid });
    cur = next;
  }
  return moves;
}

// ---- sweep ----------------------------------------------------------------
const SEG = 16;
const circle = (cx, cy, r) => {
  const p = [];
  for (let i = 0; i < SEG; i++) {
    const a = (2 * Math.PI * i) / SEG;
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return p;
};
// A flat end mill's sweep along a segment is circle ∪ rect ∪ circle. Emitting
// the three as separate CCW contours lets the CrossSection constructor's
// Positive fill rule union them, which avoids doing hull maths in JS.
function capsuleContours(m, r, out) {
  const dx = m.x1 - m.x, dy = m.y1 - m.y;
  const len = Math.hypot(dx, dy);
  out.push(circle(m.x1, m.y1, r));
  if (len < 1e-9) return;
  const nx = (-dy / len) * r, ny = (dx / len) * r;
  out.push([
    [m.x + nx, m.y + ny], [m.x1 + nx, m.y1 + ny],
    [m.x1 - nx, m.y1 - ny], [m.x - nx, m.y - ny],
  ]);
}

function sweepAndSubtract(moves, r, stock, stockTopZ, label) {
  const t0 = performance.now();
  // Bucket cutting moves by quantised Z. A constant-Z job gives few buckets; a
  // ramping 3D job gives many, which is the thing being measured.
  const levels = new Map();
  let cutting = 0;
  for (const m of moves) {
    if (m.rapid && m.z >= stockTopZ && m.z1 >= stockTopZ) continue;
    const zLo = Math.min(m.z, m.z1);
    const key = Math.round(zLo * 1000);
    if (!levels.has(key)) levels.set(key, []);
    capsuleContours(m, r, levels.get(key));
    cutting++;
  }
  const tParse = performance.now();

  let contours = 0, pts = 0;
  for (const polys of levels.values()) {
    contours += polys.length;
    for (const p of polys) pts += p.length;
  }
  console.log(`\n### ${label}`);
  console.log(`  moves parsed        ${moves.length}  (cutting: ${cutting})`);
  console.log(`  Z levels            ${levels.size}`);
  console.log(`  contours / points   ${contours} / ${pts}`);
  if (levels.size > MAX_LEVELS) {
    console.log(`  SKIPPED 3D: ${levels.size} Z levels exceeds the ${MAX_LEVELS} cap.`);
    console.log(`  -> exact CSG needs one extrude per level; this is the dexel case.`);
    return null;
  }

  const sections = [];
  for (const [key, polys] of levels) sections.push([key / 1000, new CrossSection(polys, 'Positive')]);
  const t2d = performance.now();

  const solids = [];
  for (const [z, cs] of sections) {
    const h = stockTopZ - z + 0.01;
    if (h > 0) solids.push(Manifold.extrude(cs, h).translate([0, 0, z]));
  }
  const removal = solids.length ? Manifold.union(solids) : null;
  const t3d = performance.now();

  const result = removal ? stock.subtract(removal) : stock;
  const vol = result.volume();
  const t4 = performance.now();

  console.log(`  2D union (Clipper2) ${(t2d - tParse).toFixed(0)} ms`);
  console.log(`  extrude + union 3D  ${(t3d - t2d).toFixed(0)} ms`);
  console.log(`  subtract + volume   ${(t4 - t3d).toFixed(0)} ms`);
  console.log(`  TOTAL               ${(t4 - t0).toFixed(0)} ms`);
  console.log(`  stock vol ${stock.volume().toFixed(1)} -> ${vol.toFixed(1)} mm^3  removed ${(stock.volume() - vol).toFixed(1)}`);
  console.log(`  result triangles    ${result.numTri()}`);
  return t4 - t0;
}

// ---- case A: a real Studio file ------------------------------------------
if (NC && ONLY !== 'B') {
  const moves = parseMoves(readFileSync(NC, 'utf8'));
  // TopClamp: 100 x 100 x 5 stock, origin at top-front-left corner, Z=0 at top.
  const stock = Manifold.cube([100, 100, 5]).translate([0, 0, -5]);
  sweepAndSubtract(moves, 3.175 / 2, stock, 0, 'A. Studio TopClamp.nc (3D, ramping)');
}

// ---- case B: V1's actual shape — constant-Z glyph pocketing ---------------
// Three labels, 1 mm flat end, 63% stepover, contour-parallel raster over the
// glyph area. One Z level per depth; three depths.
if (ONLY !== 'A') {
  const moves = [];
  const r = 0.5, step = 1.0 * 0.63;
  for (const [z, x0, y0, w, h] of [[-0.4, 8, 22, 60, 10], [-0.9, 8, 10, 48, 8], [-1.2, 8, 3, 30, 5]]) {
    let flip = false;
    for (let y = y0; y <= y0 + h; y += step) {
      const a = flip ? x0 + w : x0, b = flip ? x0 : x0 + w;
      moves.push({ x: a, y, z, x1: b, y1: y, z1: z, rapid: false });
      flip = !flip;
    }
  }
  const stock = Manifold.cube([76.2, 38.1, 3.81]).translate([0, 0, -3.81]);
  sweepAndSubtract(moves, r, stock, 0, 'B. V1 badge: 3 labels, constant Z, 1 mm flat');
}

// ---- case C: honest V1 load — glyph-shaped short segments, few Z levels ----
// Real contour-parallel pocketing of text follows glyph outlines, so the move
// count is high and the segments are short. Three labels, ~N segments each,
// still only three Z levels. This is the number the budget must be built on.
if (ONLY !== 'A' && ONLY !== 'B') {
  for (const N of [2000, 6000, 20000]) {
    const moves = [];
    for (const [zi, z] of [[0, -0.4], [1, -0.9], [2, -1.2]].entries()) {
      let x = 8, y = 20 - zi * 7;
      for (let i = 0; i < N; i++) {
        // short wandering segments, ~0.3 mm, inside the badge face
        const a = (i * 2.39996) % (2 * Math.PI);
        const nx = Math.min(68, Math.max(2, x + 0.3 * Math.cos(a)));
        const ny = Math.min(36, Math.max(2, y + 0.3 * Math.sin(a)));
        moves.push({ x, y, z: z[1] ?? z, x1: nx, y1: ny, z1: z[1] ?? z, rapid: false });
        x = nx; y = ny;
      }
    }
    const stock = Manifold.cube([76.2, 38.1, 3.81]).translate([0, 0, -3.81]);
    sweepAndSubtract(moves, 0.5, stock, 0, `C. V1 glyph load: ${N} segs x 3 labels = ${N * 3} moves`);
  }
}
