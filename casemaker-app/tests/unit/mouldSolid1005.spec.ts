/**
 * #1005 — THE MOULD SOLID: the block minus the part, turned over about X.
 *
 * The acceptance specs (`goalMold`, `flipMouldShell`) drive the whole seam, and their parts are
 * Y-symmetric — the bowl is a circle and the mouse shell is an ellipse — so a cavity that was
 * REFLECTED instead of TURNED would slip through them. The old path's turn-over pin was a wedge,
 * row by row on the heightfield; this is the solid's own version: a wedge high at its low-Y edge
 * must leave the cavity deepest at the MIRRORED Y, because a casting has to read the right way
 * round.
 */
import { describe, expect, it } from 'vitest';

import { closeOpenSheet } from '@/engine/cnc/engrave/closeSheet';
import { mouldSolidOf, steepestFacetDeg } from '@/engine/cnc/engrave/mouldSolid';
import type { ParsedMesh } from '@/engine/import/stlParser';
import { tl } from './helpers/manifoldExec';

type V = [number, number, number];
type Tri = [V, V, V];

/** A wedge over [0,20]² sloping in Y only — z = −0.1·y (high at y = 0, low at y = 20). */
function wedgeTris(): Tri[] {
  const p = (x: number, y: number): V => [x, y, -0.1 * y];
  return [
    [p(0, 0), p(20, 0), p(20, 20)],
    [p(0, 0), p(20, 20), p(0, 20)],
  ];
}

/** A closed frustum: bottom 10×10 at z = −4, top 12×12 at z = 0 — four sloped walls (76.0°). */
function frustumTris(): Tri[] {
  const b: V[] = [[5, 5, -4], [15, 5, -4], [15, 15, -4], [5, 15, -4]];
  const t: V[] = [[4, 4, 0], [16, 4, 0], [16, 16, 0], [4, 16, 0]];
  const out: Tri[] = [];
  const quad = (a: V, b2: V, c: V, d: V): void => {
    out.push([a, b2, c], [a, c, d]);
  };
  quad(t[0]!, t[1]!, t[2]!, t[3]!);
  quad(b[3]!, b[2]!, b[1]!, b[0]!);
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    quad(b[i]!, b[j]!, t[j]!, t[i]!);
  }
  return out;
}

/** A closed box 10×10×4, top at z = 0 — a part with four vertical walls. */
function boxTris(): Tri[] {
  const c: V[] = [
    [0, 0, -4], [10, 0, -4], [10, 10, -4], [0, 10, -4],
    [0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
  ];
  const out: Tri[] = [];
  const q = (a: number, b: number, d: number, e: number): void => {
    out.push([c[a]!, c[b]!, c[d]!], [c[a]!, c[d]!, c[e]!]);
  };
  q(4, 5, 6, 7); q(0, 3, 2, 1); q(0, 1, 5, 4); q(2, 3, 7, 6); q(1, 2, 6, 5); q(3, 0, 4, 7);
  return out;
}

function meshOf(tris: Tri[], dx: number, dy: number): ParsedMesh {
  const positions = new Float32Array(tris.length * 9);
  const indices = new Uint32Array(tris.length * 3);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let k = 0;
  for (const t of tris) {
    for (const v of t) {
      positions[k * 3] = v[0] + dx;
      positions[k * 3 + 1] = v[1] + dy;
      positions[k * 3 + 2] = v[2];
      minX = Math.min(minX, v[0] + dx); maxX = Math.max(maxX, v[0] + dx);
      minY = Math.min(minY, v[1] + dy); maxY = Math.max(maxY, v[1] + dy);
      minZ = Math.min(minZ, v[2]); maxZ = Math.max(maxZ, v[2]);
      indices[k] = k;
      k++;
    }
  }
  return { positions, indices, triangleCount: tris.length, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

/** The topmost Z of the solid under a vertical ray at (x, y) — the mould's cavity floor there. */
function topZAt(mesh: ParsedMesh, x: number, y: number): number {
  let best = -Infinity;
  const p = mesh.positions;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]! * 3;
    const b = mesh.indices[t + 1]! * 3;
    const c = mesh.indices[t + 2]! * 3;
    const ax = p[a]!, ay = p[a + 1]!, az = p[a + 2]!;
    const bx = p[b]!, by = p[b + 1]!, bz = p[b + 2]!;
    const cx = p[c]!, cy = p[c + 1]!, cz = p[c + 2]!;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) continue; // a vertical triangle has no (x, y) interior
    const wa = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
    const wb = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
    const wc = 1 - wa - wb;
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue;
    const z = wa * az + wb * bz + wc * cz;
    if (z > best) best = z;
  }
  return best;
}

describe('#1005 — mouldSolidOf', () => {
  it('turns the part over, not reflect it: a wedge high at y = 0 leaves the cavity deepest at y = 40', () => {
    // The wedge sits at (10, 10)…(30, 30) on a 40×40 stock, turned over about y = 20.
    const part = closeOpenSheet(tl, meshOf(wedgeTris(), 10, 10), { skirtTo: 'lowestBoundary' }).mesh;
    const mould = mouldSolidOf(tl, part, { stock: { length: 40, width: 40, thickness: 10 }, centreY: 20 });
    // The block is the stock, top at 0, bottom at −10.
    expect(mould.mesh.bbox.min[0]).toBeCloseTo(0, 6);
    expect(mould.mesh.bbox.max[0]).toBeCloseTo(40, 6);
    expect(mould.mesh.bbox.min[1]).toBeCloseTo(0, 6);
    expect(mould.mesh.bbox.max[1]).toBeCloseTo(40, 6);
    expect(mould.mesh.bbox.min[2]).toBeCloseTo(-10, 6);
    expect(mould.mesh.bbox.max[2]).toBeCloseTo(0, 6);
    // The part is high at y = 10 (z = 0) and low at y = 30 (z = −2). Turned over about the line
    // y = 20, the cavity is shallowest at the mirrored Y = 10 and deepest at Y = 30.
    expect(mould.partHeightMm).toBeCloseTo(2, 6);
    // Sampled a millimetre inside the cavity's mouth: at the mirrored Y the wedge is nearly at
    // its high edge (flush), at the far side nearly at its low edge (deepest).
    expect(topZAt(mould.mesh, 20, 11)).toBeCloseTo(-0.1, 6);
    expect(topZAt(mould.mesh, 20, 29)).toBeCloseTo(-1.9, 6);
    // Halfway, the turned wedge's slope gives exactly 1 mm of depth.
    expect(topZAt(mould.mesh, 20, 20)).toBeCloseTo(-1, 6);
  });

  it('measures a cavity wall: a box is exactly 90°, a frustum is its own slope', () => {
    const box = closeOpenSheet(tl, meshOf(boxTris(), 15, 15), { skirtTo: 'lowestBoundary' });
    expect(box.closedBy).toBe('none'); // the box is a closed solid already
    expect(steepestFacetDeg(box.mesh)).toBeCloseTo(90, 6);
    // A frustum's four walls slope 4 mm over 1 mm: atan(4) ≈ 75.96°.
    const frustum = closeOpenSheet(tl, meshOf(frustumTris(), 15, 15), { skirtTo: 'lowestBoundary' }).mesh;
    expect(frustum).toBeDefined();
    expect(steepestFacetDeg(frustum)).toBeCloseTo((Math.atan(4) * 180) / Math.PI, 4);
    // An open sheet's skirt is a real cavity wall too (the old heightfield measured the same
    // boundary drop-off): the wedge's edge falls 2 mm vertically.
    const wedge = closeOpenSheet(tl, meshOf(wedgeTris(), 10, 10), { skirtTo: 'lowestBoundary' }).mesh;
    expect(steepestFacetDeg(wedge)).toBeCloseTo(90, 6);
  });

  it('refuses a stock with no thickness — a mould needs a block', () => {
    const box = closeOpenSheet(tl, meshOf(boxTris(), 15, 15), { skirtTo: 'lowestBoundary' }).mesh;
    expect(() => mouldSolidOf(tl, box, { stock: { length: 40, width: 40, thickness: 0 }, centreY: 20 })).toThrow(/thickness/);
  });
});
