/**
 * #958 §3.4: rims, the CAM's chamfer/edge-break input.
 *
 *   sharp            a convex edge where a floor (or the top land) meets a wall that drops
 *                    below it
 *   modelledChamfer  a narrow inclined PLANAR patch with a floor along its top edge and a wall
 *                    along its bottom edge (the design already carries the break)
 *
 * A rim belongs to the contour when it lies on the silhouette's outer boundary. Otherwise it
 * belongs to the pocket node whose mouth is at its height and whose region it borders.
 *
 * The gate never reads these (#958 §5). The edge-break allowance finds its edges from the goal
 * heightfield by its own rule.
 */

import type { FrameMesh, Patch } from './patches';

/** A modelled chamfer's vertical leg must be at most this, mm (#958 §3.2). */
export const MODELLED_CHAMFER_MAX_LEG_MM = 3;

export interface RawRim {
  polyline: [number, number][];
  z: number;
  kind: 'sharp' | 'modelledChamfer';
  legs?: [number, number];
}

const key = (x: number, y: number, z: number): string => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;

/** Chain undirected segments into polylines (open or closed) by shared endpoints. */
function chain(segments: [number, number, number, number, number, number][]): [number, number, number][][] {
  const ends = new Map<string, number[]>();
  segments.forEach((s, i) => {
    for (const k of [key(s[0], s[1], s[2]), key(s[3], s[4], s[5])]) {
      const list = ends.get(k);
      if (list === undefined) ends.set(k, [i]);
      else list.push(i);
    }
  });
  const used = new Uint8Array(segments.length);
  const out: [number, number, number][][] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const s = segments[start]!;
    const line: [number, number, number][] = [
      [s[0], s[1], s[2]],
      [s[3], s[4], s[5]],
    ];
    // Grow from the tail, then from the head.
    for (const atHead of [false, true]) {
      for (;;) {
        const end = atHead ? line[0]! : line[line.length - 1]!;
        const next = (ends.get(key(end[0], end[1], end[2])) ?? []).find((i) => !used[i]);
        if (next === undefined) break;
        used[next] = 1;
        const n = segments[next]!;
        const a: [number, number, number] = [n[0], n[1], n[2]];
        const b: [number, number, number] = [n[3], n[4], n[5]];
        const other = key(a[0], a[1], a[2]) === key(end[0], end[1], end[2]) ? b : a;
        if (atHead) line.unshift(other);
        else line.push(other);
      }
    }
    out.push(line);
  }
  return out;
}

export function findRims(mesh: FrameMesh, patches: readonly Patch[], adj: Int32Array, levelMergeMm: number): RawRim[] {
  const count = mesh.indices.length / 3;
  const p = mesh.positions;
  const patchOf = new Int32Array(count).fill(-1);
  for (const patch of patches) for (const t of patch.triangles) patchOf[t] = patch.id;
  const kindOf = (t: number): Patch['kind'] | null => (patchOf[t]! >= 0 ? patches[patchOf[t]!]!.kind : null);
  const vtx = (t: number, k: number): [number, number, number] => {
    const v = mesh.indices[3 * t + k]! * 3;
    return [p[v]!, p[v + 1]!, p[v + 2]!];
  };

  // ── Sharp rims: floor | wall edges where the wall drops below the edge ────────────────────
  const sharp: [number, number, number, number, number, number][] = [];
  for (let t = 0; t < count; t++) {
    if (kindOf(t) !== 'floor') continue;
    for (let e = 0; e < 3; e++) {
      const u = adj[3 * t + e]!;
      if (u < 0 || kindOf(u) !== 'wall') continue;
      const a = vtx(t, e);
      const b = vtx(t, (e + 1) % 3);
      const edgeZ = (a[2] + b[2]) / 2;
      // The wall's third vertex (the one not on the shared edge) is below: convex rim.
      let below = false;
      for (let k = 0; k < 3; k++) {
        const w = vtx(u, k);
        // In 3D: on a vertical wall the bottom vertex sits directly under a top one in XY.
        const same = (q: [number, number, number]): boolean =>
          Math.abs(w[0] - q[0]) < 1e-6 && Math.abs(w[1] - q[1]) < 1e-6 && Math.abs(w[2] - q[2]) < 1e-6;
        const onEdge = same(a) || same(b);
        if (!onEdge && w[2] < edgeZ - levelMergeMm) below = true;
      }
      if (below) sharp.push([a[0], a[1], a[2], b[0], b[1], b[2]]);
    }
  }
  const rims: RawRim[] = chain(sharp).map((line) => ({
    polyline: line.map((q) => [q[0], q[1]] as [number, number]),
    z: line.reduce((s, q) => s + q[2], 0) / line.length,
    kind: 'sharp',
  }));

  // ── Modelled chamfers: narrow inclined planar patches between a floor and a wall ─────────
  for (const patch of patches) {
    if (patch.kind !== 'remainder' || !patch.planar) continue;
    const vertical = patch.zMax - patch.zMin;
    if (vertical <= 0 || vertical > MODELLED_CHAMFER_MAX_LEG_MM) continue;
    // #994 — THE CONTACT MUST BE ON THE RIGHT BOUNDARY. A modelled chamfer is ONE planar patch
    // that alone spans wall to floor: its lower boundary lies on the wall, its upper boundary on
    // the floor. A fillet is a band of narrow facets that touch the wall only at an end cap and
    // chain into each other across their long edges — the old "touches a wall anywhere" test
    // cannot tell them apart and cut a V along every fillet facet. So: wall contact must be on
    // the LOWER boundary (both vertices at zMin), floor contact on the UPPER (both at zMax), and
    // a remainder neighbour across either boundary disqualifies the patch (it is one facet of a
    // band, not a whole bevel).
    const top: [number, number, number, number, number, number][] = [];
    let wallBelow = false;
    let remainderAcross = false;
    for (const t of patch.triangles) {
      for (let e = 0; e < 3; e++) {
        const a = vtx(t, e);
        const b = vtx(t, (e + 1) % 3);
        const lower = Math.abs(a[2] - patch.zMin) <= levelMergeMm && Math.abs(b[2] - patch.zMin) <= levelMergeMm;
        const upper = Math.abs(a[2] - patch.zMax) <= levelMergeMm && Math.abs(b[2] - patch.zMax) <= levelMergeMm;
        if (!lower && !upper) continue;
        const u = adj[3 * t + e]!;
        const k = u < 0 ? null : kindOf(u);
        if (k === 'remainder') { remainderAcross = true; break; }
        if (lower && k === 'wall') wallBelow = true;
        if (upper && k === 'floor') top.push([a[0], a[1], a[2], b[0], b[1], b[2]]);
      }
      if (remainderAcross) break;
    }
    if (remainderAcross || !wallBelow || top.length === 0) continue;
    const nz = Math.abs(patch.normal[2]);
    const horizontal = nz >= 1 ? 0 : vertical * (nz / Math.sqrt(1 - nz * nz));
    for (const line of chain(top)) {
      rims.push({
        polyline: line.map((q) => [q[0], q[1]] as [number, number]),
        z: line.reduce((s, q) => s + q[2], 0) / line.length,
        kind: 'modelledChamfer',
        legs: [horizontal, vertical],
      });
    }
  }
  return rims;
}
