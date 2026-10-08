// Re-measure after the adversarial review found two defects in probes 1-4:
//   (a) the capsule rectangle was wound CLOCKWISE, so under Clipper2's
//       'Positive' fill it CANCELLED the end discs instead of unioning. Every
//       area and timing in Simulation.md §4 was taken on half-discs.
//   (b) Manifold is lazy and numTri() sat OUTSIDE the timer, so
//       "extrude + subtract = 2 ms" never timed the subtract.
//   (c) glyphPath was a golden-angle random walk of 0.35 mm steps that never
//       left a 1.4 mm box, so every contour overlapped every other -- the worst
//       case for a sweep-line union, not a glyph.
// This probe asserts a closed-form area FIRST, then measures both loads.
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();
const { CrossSection, Manifold } = tl;
const out = (s) => process.stdout.write(s + '\n');

const SEG = 16, R = 0.5, EPS = 0.002;
const SIZES = (process.env.SIZES || '1000,4000').split(',').map(Number);
const SINGLE_CAP = Number(process.env.SINGLE_CAP || 4000);
const ONLY = process.env.ONLY || '';
const circle = (cx, cy, r) => {               // CCW: increasing angle
  const p = [];
  for (let i = 0; i < SEG; i++) { const a = 2 * Math.PI * i / SEG; p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
  return p;
};
// CCW rectangle: down the RIGHT side first, back up the LEFT.
const capsule = (x0, y0, x1, y1, r, out2) => {
  out2.push(circle(x0, y0, r), circle(x1, y1, r));
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  if (len < 1e-9) return;
  const nx = -dy / len * r, ny = dx / len * r;
  out2.push([[x0 - nx, y0 - ny], [x1 - nx, y1 - ny], [x1 + nx, y1 + ny], [x0 + nx, y0 + ny]]);
};

// ---- gate: closed form before anything else -------------------------------
{
  const L = 10, polys = [];
  capsule(0, 0, L, 0, R, polys);
  const got = new CrossSection(polys, 'Positive').area();
  const want = 2 * R * L + 8 * R * R * Math.sin(2 * Math.PI / SEG); // rect + inscribed 16-gon disc
  out(`GATE one capsule (L=${L}, r=${R}): area ${got.toFixed(4)}  expected ${want.toFixed(4)}  ` +
      (Math.abs(got - want) < 0.01 ? 'OK' : `*** WRONG (ratio ${(got / want).toFixed(3)}) ***`));
  // what the OLD (clockwise) rectangle produced, for the record
  const old = [];
  old.push(circle(L, 0, R));
  old.push([[0, R], [L, R], [L, -R], [0, -R]]);
  out(`     old CW rectangle gave: ${new CrossSection(old, 'Positive').area().toFixed(4)}`);
}

// ---- loads ---------------------------------------------------------------
const blob = (n) => { const s = []; let x = 10, y = 19;
  for (let i = 0; i < n; i++) { const a = (i * 2.39996) % (2 * Math.PI);
    const nx = Math.min(66, Math.max(4, x + 0.35 * Math.cos(a))), ny = Math.min(34, Math.max(4, y + 0.35 * Math.sin(a)));
    s.push([x, y, nx, ny]); x = nx; y = ny; } return s; };
// contour-parallel raster over a 60 x 20 face: what pocketing actually emits
const raster = (n) => { const s = []; const step = 1.0 * 0.63; let y = 8, flip = false, i = 0;
  while (i < n) { const segs = 24;                        // break each pass into short moves
    for (let k = 0; k < segs && i < n; k++, i++) {
      const xa = 6 + (flip ? 60 - k * 2.5 : k * 2.5), xb = 6 + (flip ? 60 - (k + 1) * 2.5 : (k + 1) * 2.5);
      s.push([xa, y, xb, y]); }
    y += step; flip = !flip; if (y > 28) y = 8; } return s; };

const T = (l, f) => { const t = performance.now(); const v = f(); out(`    ${l.padEnd(36)}${(performance.now() - t).toFixed(0).padStart(8)} ms`); return v; };

for (const [name, gen] of [['BLOB (probes 1-4 load)', blob], ['RASTER (real pocketing)', raster]]) {
  if (ONLY && !name.startsWith(ONLY)) continue;
  for (const n of SIZES) {
    const polys = []; for (const [a, b, c, d] of gen(n)) capsule(a, b, c, d, R, polys);
    out(`\n### ${name}  ${n} moves -> ${polys.length} contours`);
    const single = (n <= SINGLE_CAP) ? T('single CrossSection(all)', () => { const cs = new CrossSection(polys, 'Positive'); cs.area(); return cs; }) : null;
    const tree = T('chunk64 -> simplify -> 8-way tree', () => {
      let lvl = []; for (let i = 0; i < polys.length; i += 64) lvl.push(new CrossSection(polys.slice(i, i + 64), 'Positive').simplify(EPS));
      while (lvl.length > 1) { const nx = []; for (let i = 0; i < lvl.length; i += 8) nx.push(CrossSection.union(lvl.slice(i, i + 8)).simplify(EPS)); lvl = nx; }
      lvl[0].area(); return lvl[0]; });
    out(`      areas: single ${single ? single.area().toFixed(3) : 'skipped'}  tree ${tree.area().toFixed(3)}`);
    // forced evaluation INSIDE the timer this time
    for (const [lbl, cs] of [['unsimplified', single], ['simplified', tree]]) {
      if (!cs) continue;
      T(`extrude+subtract (${lbl}, forced)`, () => {
        const stock = Manifold.cube([76.2, 38.1, 3.81]).translate([0, 0, -3.81]);
        const r = stock.subtract(Manifold.extrude(cs, 0.41).translate([0, 0, -0.4]));
        return r.volume() + r.numTri(); });
    }
  }
}
