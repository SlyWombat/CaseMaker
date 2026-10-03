// Scratch probe: how does the 2D sweep union scale, and does chunking fix it?
//
// probe-sim-perf.mjs showed the V1-shaped case at 37 moves running in 45 ms, and
// a real Studio 3D file producing 482 Z levels. The open question is the middle:
// a realistic glyph pocket is thousands of SHORT segments at only a few Z levels.
// The sweep there is one big 2D union, so this isolates that union and compares
// one giant constructor call against a chunked tree reduction.
//
//   powershell.exe -NoProfile -Command "node probe-sim-2d.mjs"

import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';

const require = createRequire(import.meta.url);
const tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
tl.setup();
const { CrossSection, Manifold } = tl;

const out = (s) => process.stdout.write(s + '\n');

const SEG = 16;
function circle(cx, cy, r) {
  const p = [];
  for (let i = 0; i < SEG; i++) {
    const a = (2 * Math.PI * i) / SEG;
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return p;
}

// A glyph-like path: short segments wandering inside the badge face.
function glyphPath(n) {
  const segs = [];
  let x = 10, y = 19;
  for (let i = 0; i < n; i++) {
    const a = (i * 2.39996) % (2 * Math.PI);
    const nx = Math.min(66, Math.max(4, x + 0.35 * Math.cos(a)));
    const ny = Math.min(34, Math.max(4, y + 0.35 * Math.sin(a)));
    segs.push([x, y, nx, ny]);
    x = nx; y = ny;
  }
  return segs;
}

function contoursFor(segs, r) {
  const polys = [];
  for (const [x0, y0, x1, y1] of segs) {
    polys.push(circle(x1, y1, r));
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const nx = (-dy / len) * r, ny = (dx / len) * r;
    polys.push([[x0 + nx, y0 + ny], [x1 + nx, y1 + ny], [x1 - nx, y1 - ny], [x0 - nx, y0 - ny]]);
  }
  return polys;
}

function timed(label, fn) {
  const t = performance.now();
  let v;
  try { v = fn(); } catch (e) {
    out(`  ${label.padEnd(34)} THREW after ${(performance.now() - t).toFixed(0)} ms: ${e.message}`);
    return null;
  }
  out(`  ${label.padEnd(34)} ${(performance.now() - t).toFixed(0).padStart(7)} ms`);
  return v;
}

for (const n of [250, 500, 1000, 2000, 4000]) {
  const polys = contoursFor(glyphPath(n), 0.5);
  out(`\n### ${n} segments  ->  ${polys.length} contours, ${polys.reduce((a, p) => a + p.length, 0)} points`);

  const single = timed('single CrossSection(all)', () => new CrossSection(polys, 'Positive'));

  const chunked = timed('chunked 64 + CrossSection.union', () => {
    const parts = [];
    for (let i = 0; i < polys.length; i += 64) {
      parts.push(new CrossSection(polys.slice(i, i + 64), 'Positive'));
    }
    return CrossSection.union(parts);
  });

  for (const [nm, cs] of [['single', single], ['chunked', chunked]]) {
    if (!cs) continue;
    out(`    ${nm}: area ${cs.area().toFixed(3)} mm2`);
  }
  if (chunked) {
    timed('extrude + subtract from stock', () => {
      const stock = Manifold.cube([76.2, 38.1, 3.81]).translate([0, 0, -3.81]);
      const solid = Manifold.extrude(chunked, 0.41).translate([0, 0, -0.4]);
      const r = stock.subtract(solid);
      out(`    result ${r.numTri()} tris, removed ${(stock.volume() - r.volume()).toFixed(2)} mm3`);
      return r;
    });
  }
}
