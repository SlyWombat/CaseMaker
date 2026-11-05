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

/** One sharp floor|wall edge (or a modelled chamfer's top edge) and the patch it bounds. */
export interface RimSegment {
  a: [number, number, number];
  b: [number, number, number];
  /** The source floor (or remainder) patch: the region whose rim this edge lies on. */
  patch: number;
}

/**
 * #974 — THE RIM LOOPS, FROM THE PLANAR FACE DECOMPOSITION.
 *
 * The old chainer stitched undirected segments greedily. Where the sharp-edge graph has a branch
 * vertex (degree > 2) it walked from one cycle onto another: on the organizer the top land's
 * outer boundary and a pocket's mouth share vertices, and the greedy walk produced a 7-point rim
 * whose two ends sat 77.2 mm apart across the land (#962's phantom bridge; since the guard, an
 * un-chamfered rim). A local angle rule cannot pair the edges at such a vertex — which two edges
 * belong to the same loop is a GLOBAL fact: the loops are the graph's inner faces.
 *
 * This is the standard planar face decomposition. Every undirected segment is two directed
 * half-edges; at each vertex the outgoing half-edges are sorted by angle; a face's next half-edge
 * is the one before the reverse of the incoming one in rotation order (the face on the left).
 * A face's signed area separates the bounded inner loops (one sign) from the unbounded outer face
 * (the other); the bounded loops ARE the pocket rims and the contour's closed outline, and each
 * closes on its own vertices by construction — no bridging is possible.
 *
 * Open strands (a contour shoulder that runs to the stock's edge, a dangling edge at a
 * tessellation seam) are not faces of a closed graph: the segments no kept face used are chained
 * with the old two-ended walk, so an open rim still comes out as an open polyline. Nothing is
 * invented: every output point is a segment endpoint.
 */
export function chainRimSegments(segments: readonly RimSegment[]): [number, number, number][][] {
  const out: [number, number, number][][] = [];
  if (segments.length === 0) return out;
  const keyOf = (q: [number, number, number]): string => key(q[0], q[1], q[2]);
  // Half-edges: 2i = a->b, 2i+1 = b->a.
  const tail: [number, number, number][] = [];
  const head: [number, number, number][] = [];
  const twin: number[] = [];
  segments.forEach((s, i) => {
    tail.push(s.a, s.b);
    head.push(s.b, s.a);
    twin.push(2 * i + 1, 2 * i);
  });
  // Outgoing half-edges per vertex, sorted by XY angle.
  const outgoing = new Map<string, number[]>();
  for (let h = 0; h < tail.length; h++) {
    const k = keyOf(tail[h]!);
    const list = outgoing.get(k);
    if (list === undefined) outgoing.set(k, [h]);
    else list.push(h);
  }
  const angleOf = (h: number): number => Math.atan2(head[h]![1] - tail[h]![1], head[h]![0] - tail[h]![0]);
  for (const list of outgoing.values()) list.sort((h1, h2) => angleOf(h1) - angleOf(h2));
  // The face-next of a half-edge: at its head vertex, the rotation PREDECESSOR of the reverse
  // (the face on the left of the directed edge).
  const nextOf = (h: number): number => {
    const list = outgoing.get(keyOf(head[h]!))!;
    return list[(list.indexOf(twin[h]!) - 1 + list.length) % list.length]!;
  };
  const faceOf = new Int32Array(tail.length).fill(-1);
  const keptFace: boolean[] = [];
  for (let h = 0; h < tail.length; h++) {
    if (faceOf[h] !== -1) continue;
    const faceId = keptFace.length;
    const cycle: number[] = [];
    let cur = h;
    for (;;) {
      faceOf[cur] = faceId;
      cycle.push(cur);
      cur = nextOf(cur);
      if (cur === h || cycle.length > tail.length + 1) break;
    }
    let area = 0;
    for (const hh of cycle) {
      const a = tail[hh]!;
      const b = head[hh]!;
      area += a[0] * b[1] - b[0] * a[1];
    }
    const kept = area / 2 > 1e-9 && cycle.length >= 3;
    keptFace.push(kept);
    if (kept) {
      // The polyline carries its start vertex again at the end, like every closed rim the
      // chainer ever produced: the guard compares first and last, and `closedRing` builds the
      // ring from the points as given.
      const loop = cycle.map((hh) => tail[hh]!);
      loop.push(loop[0]!);
      out.push(loop);
    }
  }
  // Segments covered by a kept face's boundary: either half-edge lies in a kept face.
  const covered = new Uint8Array(segments.length);
  for (let h = 0; h < tail.length; h++) {
    if (keptFace[faceOf[h]!] === true) covered[h >> 1] = 1;
  }
  // Open strands: the old two-ended greedy walk over the uncovered segments.
  out.push(...chainOpenStrands(segments, covered));
  return out;
}

/** The old two-ended greedy walk, for segments a kept face did not cover (open rims). */
function chainOpenStrands(segments: readonly RimSegment[], skip: Uint8Array): [number, number, number][][] {
  const keyOf = (q: [number, number, number]): string => key(q[0], q[1], q[2]);
  const ends = new Map<string, number[]>();
  segments.forEach((s, i) => {
    if (skip[i] === 1) return;
    for (const q of [s.a, s.b]) {
      const k = keyOf(q);
      const list = ends.get(k);
      if (list === undefined) ends.set(k, [i]);
      else list.push(i);
    }
  });
  const used = new Uint8Array(segments.length);
  const out: [number, number, number][][] = [];
  for (let start = 0; start < segments.length; start++) {
    if (used[start] === 1 || skip[start] === 1) continue;
    used[start] = 1;
    const s = segments[start]!;
    const line: [number, number, number][] = [s.a, s.b];
    for (const atHead of [false, true]) {
      for (;;) {
        const at = atHead ? line[0]! : line[line.length - 1]!;
        const next = (ends.get(keyOf(at)) ?? []).find((i) => used[i] === 0);
        if (next === undefined) break;
        used[next] = 1;
        const n = segments[next]!;
        const other = keyOf(n.a) === keyOf(at) ? n.b : n.a;
        if (atHead) line.unshift(other);
        else line.push(other);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * #974 — THE SHARP RIM SEGMENTS, with the floor patch each belongs to. Extracted from `findRims`
 * so the specs can read exactly what the chainer is given (a rim's edges are the mouth edges of
 * one top-land/floor face; the chainer now decomposes them into the graph's face loops).
 */
export function sharpRimSegments(
  mesh: FrameMesh,
  patches: readonly Patch[],
  adj: Int32Array,
  levelMergeMm: number,
): RimSegment[] {
  const count = mesh.indices.length / 3;
  const p = mesh.positions;
  const patchOf = new Int32Array(count).fill(-1);
  for (const patch of patches) for (const t of patch.triangles) patchOf[t] = patch.id;
  const kindOf = (t: number): Patch['kind'] | null => (patchOf[t]! >= 0 ? patches[patchOf[t]!]!.kind : null);
  const vtx = (t: number, k: number): [number, number, number] => {
    const v = mesh.indices[3 * t + k]! * 3;
    return [p[v]!, p[v + 1]!, p[v + 2]!];
  };
  const sharp: RimSegment[] = [];
  // #974 — THE TOP LAND IS NOT ALWAYS 'floor'-CLASSIFIED. At the organizer's corners the
  // tessellation splits a near-flat land facet off as a tiny 'remainder' sliver; the floor|wall
  // test skipped that edge, so the mouth polyline ended at the sliver (the 77.2 mm open rim and
  // its 0.2–27.5 mm siblings). The top face is any non-wall face whose outward normal is UPWARD
  // and near vertical, whatever kind the classifier gave it — a land facet however it was split.
  const TOP_FACE_NZ_MIN = 0.999; // within ~2.6° of vertical
  const topFace = (t: number): boolean => {
    const kind = kindOf(t);
    if (kind === null || kind === 'wall') return false;
    const va = vtx(t, 0);
    const vb = vtx(t, 1);
    const vc = vtx(t, 2);
    const ux = vb[0] - va[0], uy = vb[1] - va[1], uz = vb[2] - va[2];
    const wx = vc[0] - va[0], wy = vc[1] - va[1], wz = vc[2] - va[2];
    const nx = uy * wz - uz * wy;
    const ny = uz * wx - ux * wz;
    const nz = ux * wy - uy * wx;
    const len = Math.hypot(nx, ny, nz);
    return len > 0 && nz / len > TOP_FACE_NZ_MIN;
  };
  for (let t = 0; t < count; t++) {
    if (!topFace(t)) continue;
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
      if (below) sharp.push({ a, b, patch: patchOf[t]! });
    }
  }
  return sharp;
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
  const sharp = sharpRimSegments(mesh, patches, adj, levelMergeMm);
  const rims: RawRim[] = chainRimSegments(sharp).map((line) => ({
    polyline: line.map((q) => [q[0], q[1]] as [number, number]),
    z: line.reduce((s, q) => s + q[2], 0) / line.length,
    kind: 'sharp',
  }));

  // ── Modelled chamfers: narrow inclined planar patches between a floor and a wall ─────────
  for (const patch of patches) {
    if (patch.kind !== 'remainder' || !patch.planar) continue;
    const vertical = patch.zMax - patch.zMin;
    if (vertical <= 0 || vertical > MODELLED_CHAMFER_MAX_LEG_MM) continue;
    const top: RimSegment[] = [];
    let touchesWall = false;
    for (const t of patch.triangles) {
      for (let e = 0; e < 3; e++) {
        const u = adj[3 * t + e]!;
        if (u < 0) continue;
        const k = kindOf(u);
        if (k === 'wall') touchesWall = true;
        if (k === 'floor') {
          const a = vtx(t, e);
          const b = vtx(t, (e + 1) % 3);
          top.push({ a, b, patch: patch.id });
        }
      }
    }
    if (!touchesWall || top.length === 0) continue;
    const nz = Math.abs(patch.normal[2]);
    const horizontal = nz >= 1 ? 0 : vertical * (nz / Math.sqrt(1 - nz * nz));
    for (const line of chainRimSegments(top)) {
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
