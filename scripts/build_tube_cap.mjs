// Generates a TPU friction-fit cap for a 2.25" ID / 2.5" OD tube.
// Profile (r,z in mm) is revolved around the +Z axis.
// z=0 is the deepest insertion point (tip); +Z exits the tube.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IN = 25.4;

const TUBE_ID_R = (2.25 * IN) / 2;   // 28.575
const TUBE_OD_R = (2.50 * IN) / 2;   // 31.75
const INSERT_LEN = 0.5  * IN;        // 12.7
const FLANGE_THK = 0.25 * IN;        // 6.35

const BODY_R     = TUBE_ID_R - 0.575;  // 28.000  — 0.575 mm/side clearance
const BARB_R     = TUBE_ID_R + 0.325;  // 28.900  — 0.325 mm/side interference
const TIP_R      = BODY_R - 1.0;       // 27.000  — generous lead-in
const FLANGE_R   = TUBE_OD_R;          // flush with tube OD

const Z_TIP        = 0;
const Z_LEAD_END   = 1.5;
const Z_BARB1_RAMP = 3.0;
const Z_BARB1_PEAK = 4.8;
const Z_BARB1_BACK = 5.2;
const Z_BARB2_RAMP = 7.0;
const Z_BARB2_PEAK = 8.8;
const Z_BARB2_BACK = 9.2;
const Z_INSERT_TOP = INSERT_LEN;             // 12.70
const Z_CAP_TOP    = INSERT_LEN + FLANGE_THK; // 19.05

// (r, z) — must form a closed cross-section: starts and ends on the axis.
const profile = [
  [0,         Z_TIP],
  [TIP_R,     Z_TIP],
  [BODY_R,    Z_LEAD_END],
  [BODY_R,    Z_BARB1_RAMP],
  [BARB_R,    Z_BARB1_PEAK],
  [BODY_R,    Z_BARB1_BACK],
  [BODY_R,    Z_BARB2_RAMP],
  [BARB_R,    Z_BARB2_PEAK],
  [BODY_R,    Z_BARB2_BACK],
  [BODY_R,    Z_INSERT_TOP],
  [FLANGE_R,  Z_INSERT_TOP],
  [FLANGE_R,  Z_CAP_TOP],
  [0,         Z_CAP_TOP],
];

const SEGMENTS = 128; // angular resolution

function revolve(profile, n) {
  const tris = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r1, z1] = profile[i];
    const [r2, z2] = profile[i + 1];
    if (r1 === 0 && r2 === 0) continue; // degenerate (both on axis)

    for (let j = 0; j < n; j++) {
      const a1 = (j / n) * 2 * Math.PI;
      const a2 = ((j + 1) / n) * 2 * Math.PI;
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      const c2 = Math.cos(a2), s2 = Math.sin(a2);

      const A = [r1 * c1, r1 * s1, z1];
      const B = [r1 * c2, r1 * s2, z1];
      const C = [r2 * c2, r2 * s2, z2];
      const D = [r2 * c1, r2 * s1, z2];

      if (r1 === 0)      tris.push([A, C, D]);            // fan from axis
      else if (r2 === 0) tris.push([A, B, C]);            // fan to axis
      else { tris.push([A, B, C]); tris.push([A, C, D]); } // quad
    }
  }
  return tris;
}

function triNormal([a, b, c]) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function fmt(n) { return Number.isFinite(n) ? n.toExponential(6) : '0'; }

function toAsciiSTL(tris, name) {
  const lines = [`solid ${name}`];
  for (const tri of tris) {
    const [nx, ny, nz] = triNormal(tri);
    lines.push(`  facet normal ${fmt(nx)} ${fmt(ny)} ${fmt(nz)}`);
    lines.push(`    outer loop`);
    for (const [x, y, z] of tri) {
      lines.push(`      vertex ${fmt(x)} ${fmt(y)} ${fmt(z)}`);
    }
    lines.push(`    endloop`);
    lines.push(`  endfacet`);
  }
  lines.push(`endsolid ${name}`);
  return lines.join('\n') + '\n';
}

const tris = revolve(profile, SEGMENTS);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '..', 'tube-cap-2.25id-tpu.stl');
fs.writeFileSync(outPath, toAsciiSTL(tris, 'tube_cap_2p25id_tpu'));

console.log(`Wrote ${outPath}`);
console.log(`Triangles: ${tris.length}  |  Profile pts: ${profile.length}  |  Segments: ${SEGMENTS}`);
console.log(`Insert: ${INSERT_LEN.toFixed(2)} mm | Flange: Ø${(FLANGE_R*2).toFixed(2)} × ${FLANGE_THK.toFixed(2)} mm`);
console.log(`Body Ø${(BODY_R*2).toFixed(3)}  Barb Ø${(BARB_R*2).toFixed(3)}  Tip Ø${(TIP_R*2).toFixed(3)}`);
