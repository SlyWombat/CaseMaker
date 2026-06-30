// Inspect the user's exported STL for the lens floor cutout. The cutout
// should appear as a 16 mm round hole in the bottom face (z = 0). Strategy:
//   1. Parse all triangles
//   2. Filter triangles with normal ~= (0, 0, -1) AND all-z = 0 → bottom face
//   3. Compute the 2D occupancy map of the bottom face; report the hole.
import fs from 'node:fs';

const FILE = process.argv[2] ||
  '/mnt/c/Users/DavidSeaman/OneDrive/My Documents/ElectricRV/Development/Projects/Case Maker/samples/ELP-USBGS1200P01-H120_AR0234_USB_camera_Case.ascii.stl';

const text = fs.readFileSync(FILE, 'utf8');

// Parse ASCII STL
const tris = [];
const re = /facet normal\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)[\s\S]+?vertex\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)[\s\S]+?vertex\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)[\s\S]+?vertex\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)/g;
let m;
while ((m = re.exec(text)) !== null) {
  const n = m.slice(1, 4).map(parseFloat);
  const v1 = m.slice(4, 7).map(parseFloat);
  const v2 = m.slice(7, 10).map(parseFloat);
  const v3 = m.slice(10, 13).map(parseFloat);
  tris.push({ n, v: [v1, v2, v3] });
}
console.log(`parsed ${tris.length} triangles`);

// Bbox sanity check
let bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
for (const t of tris) {
  for (const v of t.v) {
    for (let i = 0; i < 3; i++) {
      if (v[i] < bbox.min[i]) bbox.min[i] = v[i];
      if (v[i] > bbox.max[i]) bbox.max[i] = v[i];
    }
  }
}
console.log('bbox:', bbox);

// Bottom-facing triangles at z ≈ 0
const eps = 0.01;
const bottomTris = tris.filter((t) =>
  Math.abs(t.n[2] + 1) < 0.01 && t.v.every((v) => Math.abs(v[2] - 0) < eps),
);
console.log(`bottom-face triangles (n=(0,0,-1), all z=0): ${bottomTris.length}`);

// Edges that are interior (not on the case outer rectangle) and NOT shared
// with another bottom triangle on both sides → these trace the inner hole.
// Simpler: rasterize the bottom face as a 2D occupancy grid and find
// missing pixels = the cutout.
const W = 200; // grid resolution
const H = 200;
const x0 = bbox.min[0], y0 = bbox.min[1];
const xs = bbox.max[0] - bbox.min[0];
const ys = bbox.max[1] - bbox.min[1];

const occ = new Uint8Array(W * H);
function rasterizeTri(a, b, c) {
  // Convert to grid coords
  const ax = ((a[0] - x0) / xs) * W;
  const ay = ((a[1] - y0) / ys) * H;
  const bx = ((b[0] - x0) / xs) * W;
  const by = ((b[1] - y0) / ys) * H;
  const cx = ((c[0] - x0) / xs) * W;
  const cy = ((c[1] - y0) / ys) * H;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
  // Edge-function point-in-triangle
  const e = (px, py, x1, y1, x2, y2) => (px - x1) * (y2 - y1) - (py - y1) * (x2 - x1);
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const w0 = e(px + 0.5, py + 0.5, bx, by, cx, cy);
      const w1 = e(px + 0.5, py + 0.5, cx, cy, ax, ay);
      const w2 = e(px + 0.5, py + 0.5, ax, ay, bx, by);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
        occ[py * W + px] = 1;
      }
    }
  }
}
for (const t of bottomTris) rasterizeTri(t.v[0], t.v[1], t.v[2]);

// Also find triangles whose vertices all sit at z=0 even if normal isn't
// exactly (0,0,-1) — STL exports sometimes split the bottom face into
// non-axis-aligned tris if there's a hole.
const flatBottomTris = tris.filter((t) =>
  t.v.every((v) => Math.abs(v[2] - 0) < eps),
);
console.log(`flat-bottom triangles (all z=0): ${flatBottomTris.length}`);
for (const t of flatBottomTris) rasterizeTri(t.v[0], t.v[1], t.v[2]);

// Print the occupancy as ASCII art (downsampled)
const D = 4;
console.log('\nbottom-face occupancy (1 = solid, . = hole, scale: each cell = 0.92mm):');
for (let py = 0; py < H; py += D) {
  let row = '';
  for (let px = 0; px < W; px += D) {
    let any = 0;
    for (let dy = 0; dy < D; dy++) for (let dx = 0; dx < D; dx++) {
      if (occ[(py + dy) * W + (px + dx)]) any = 1;
    }
    row += any ? '#' : ' ';
  }
  console.log(row);
}

// Look for triangles with vertices that lie on a circle of radius ~8 mm
// centered around any candidate center. The lens cutout would produce 32+
// triangles whose verts cluster on a circle of radius 8.
const candidates = new Map();
for (const t of tris) {
  for (const v of t.v) {
    // Only consider verts at z=0..2 (within the floor zone) or floor inner 2..2
    if (v[2] > 4) continue;
    // For each pair of nearby verts in this tri, look for circle signature
    // Skip — direct approach: for each vert, check if there exists a center
    // (cx, cy) such that distance is near 8. Use known PCB center first.
  }
}
// Try known candidate centers: the lens center is supposed to be at
// (wall + clearance + 19, wall + clearance + 19) = (23, 23) on the SHELL.
// In a side-by-side print export the lid is offset; the shell's bbox starts
// at x=0 so the shell-relative (23,23) maps to world (23, 23).
const TARGETS = [[23, 23, 'shell-lens-center'], [23 + 51, 23, 'lid-mirror-23']];
for (const [cx, cy, label] of TARGETS) {
  let onCircle = 0;
  let nearCenter = 0;
  for (const t of tris) {
    for (const v of t.v) {
      if (v[2] > 3) continue; // only floor zone
      const d = Math.hypot(v[0] - cx, v[1] - cy);
      if (d < 9) nearCenter++;
      if (Math.abs(d - 8) < 0.3) onCircle++;
    }
  }
  console.log(`target ${label} (${cx}, ${cy}): verts within 9mm = ${nearCenter}, on r=8 circle = ${onCircle}`);
}

// Detect a circular hole: count holes inside the case footprint
let solidCount = 0, holeCount = 0;
for (let py = 10; py < H - 10; py++) {
  for (let px = 10; px < W - 10; px++) {
    if (occ[py * W + px]) solidCount++; else holeCount++;
  }
}
console.log(`\nsolid pixels: ${solidCount} | hole pixels (inside footprint): ${holeCount}`);
const expectedHolePx = Math.round(Math.PI * Math.pow(8 / xs * W, 2));
console.log(`expected hole pixels for a 16mm-dia circle (r=8mm): ~${expectedHolePx}`);

// Verify through-hole: rasterize triangles at the floor INNER surface
// (z = floorThickness ≈ 2). If the hole punches through, the inner
// surface should also have a hole at the same location.
const innerOcc = new Uint8Array(W * H);
const innerTris = tris.filter((t) =>
  t.v.every((v) => Math.abs(v[2] - 2) < eps) &&
  Math.abs(t.n[2] - 1) < 0.05,
);
console.log(`\nfloor-INNER-face triangles (n=(0,0,+1), all z=2): ${innerTris.length}`);
function rasterizeOnGrid(grid, a, b, c) {
  const ax = ((a[0] - x0) / xs) * W, ay = ((a[1] - y0) / ys) * H;
  const bx = ((b[0] - x0) / xs) * W, by = ((b[1] - y0) / ys) * H;
  const cx = ((c[0] - x0) / xs) * W, cy = ((c[1] - y0) / ys) * H;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
  const e = (px, py, x1, y1, x2, y2) => (px - x1) * (y2 - y1) - (py - y1) * (x2 - x1);
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const w0 = e(px + 0.5, py + 0.5, bx, by, cx, cy);
      const w1 = e(px + 0.5, py + 0.5, cx, cy, ax, ay);
      const w2 = e(px + 0.5, py + 0.5, ax, ay, bx, by);
      if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) {
        grid[py * W + px] = 1;
      }
    }
  }
}
for (const t of innerTris) rasterizeOnGrid(innerOcc, t.v[0], t.v[1], t.v[2]);
// Sample around the lens center (~23, 23): is the inner face also missing material?
let innerSolid = 0, innerHole = 0;
const cxC = Math.round((23 - x0) / xs * W);
const cyC = Math.round((23 - y0) / ys * H);
for (let py = cyC - 12; py <= cyC + 12; py++) {
  for (let px = cxC - 12; px <= cxC + 12; px++) {
    if (innerOcc[py * W + px]) innerSolid++; else innerHole++;
  }
}
console.log(`floor INNER surface near (23,23): solid=${innerSolid}, hole=${innerHole}`);
console.log(`  ${innerHole > innerSolid ? '✓ inner surface ALSO has the hole — through-hole CONFIRMED' : '✗ inner surface still solid — NOT a through-hole'}`);

// Per-piece bbox — split flat-bottom triangles into clusters by x-position.
const pieceBBoxes = (function() {
  const sorted = [...flatBottomTris].sort((a, b) => Math.min(...a.v.map((v) => v[0])) - Math.min(...b.v.map((v) => v[0])));
  // Find x-gap to split pieces
  const xRanges = sorted.map((t) => ({
    minX: Math.min(...t.v.map((v) => v[0])),
    maxX: Math.max(...t.v.map((v) => v[0])),
    minY: Math.min(...t.v.map((v) => v[1])),
    maxY: Math.max(...t.v.map((v) => v[1])),
  }));
  return xRanges;
})();
const xMins = [...new Set(pieceBBoxes.map((p) => Math.round(p.minX)))].sort((a, b) => a - b);
console.log('\nx-mins of bottom triangles:', xMins.slice(0, 10), '...');
console.log('total flat-bottom tris:', flatBottomTris.length);
