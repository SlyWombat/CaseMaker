/**
 * #829 — A TARGET MESH'S TOP RIM, as the chains a V-bit chamfer follows.
 *
 * A 3D chamfer is a property of the GOAL object (Studio's own model: `ChooseObj3DChamferDlg` picks
 * the object, `Chamfer3DPath` cuts its edges — docs/reverse/makera-studio). The edges a 3-axis
 * V-bit can bevel from above are the part's TOP RIM: an edge shared by a face that is the part's
 * top and a face that is not (a wall, or a cavity wall). The extractor returns them as polylines in
 * the WORK frame, each with the direction that faces the AIR at every point — where the cutter's
 * centre is offset to — so `cam/chamfer3d.ts` can apply the 2D bevel rule along them.
 *
 * THE AIR SIDE IS THE OTHER FACE'S NORMAL, PROJECTED HORIZONTALLY, and that one rule serves both
 * cases: on a raised part the wall faces away from the part (air outside), and in a mold cavity
 * the wall faces into the cavity (air inside). Nothing here decides which it is.
 *
 * WHY TRIANGLES, NOT THE HEIGHTFIELD: the sampler's grid would put a rim on its own cell boundary
 * (a staircase), while the mesh's edges are the geometry the operator drew. The two share
 * `targetPlace.ts`'s placement, so they cannot disagree about where the mesh sits.
 *
 * WHAT IT DOES NOT DO (stated in the guide's row): a top face tilted more than `topTiltMaxDeg` is
 * not a bevel a cone's flank can lie on, and its edges are left out with a note; an edge where
 * three or more faces meet stops its chain (a junction has no one air side). Neither is a
 * refusal — the goal itself is still cut.
 */

import type { EngraveTargetObject } from '@/types/engraveJob';
import { targetObjectMesh } from '@/engine/import/targetObject';
import type { ParsedMesh } from '@/engine/import/stlParser';
import { placeTarget, type PlacementTarget } from './targetPlace';

export interface RimPoint {
  x: number;
  y: number;
  z: number;
}

/** One rim chain in the work frame: the edge points, and the air side at each of them. */
export interface RimChain {
  points: RimPoint[];
  /** Unit horizontal vector toward the AIR at every point (the cutter centre's offset side). */
  outward: { x: number; y: number }[];
  /** True when the chain returns to its first point. */
  closed: boolean;
  /** The chain's own length, mm. */
  lengthMm: number;
  /** The shallowest-to-steepest TOP face along the chain, degrees from horizontal (0 = flat). */
  topTiltDeg: number;
}

export interface RimResult {
  chains: RimChain[];
  /** What could not be used, in operator words; empty when everything was. */
  notes: string[];
}

export interface RimOptions {
  /** The steepest face still read as the part's top, degrees from horizontal (default 20). */
  topTiltMaxDeg?: number;
  /** Mesh points closer than this are one point, mm (default 0.01). */
  weldMm?: number;
  /** A point within this of the line through its neighbours is dropped, mm (default 0.005). */
  simplifyMm?: number;
}

const DEFAULT_TOP_TILT_MAX_DEG = 20;
const DEFAULT_WELD_MM = 0.01;
const DEFAULT_SIMPLIFY_MM = 0.005;

type Vec3 = [number, number, number];

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function unit(v: Vec3): Vec3 | null {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-12)) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

interface Edge {
  a: number;
  b: number;
  /** Indices into `faces` of the triangles that share the edge. */
  faces: number[];
}

interface RimEdge extends Edge {
  /** The TOP face's index, and the air direction (horizontal, unit). */
  top: number;
  air: { x: number; y: number };
}

/** `Math.round` at the weld scale, so duplicated STL corners land on one key. */
function weldKey(p: Vec3, weldMm: number): string {
  const q = 1 / weldMm;
  return `${Math.round(p[0] * q)},${Math.round(p[1] * q)},${Math.round(p[2] * q)}`;
}

/**
 * The goal's top rim, in the work frame. Pure: it reads the embedded mesh and the object's
 * placement, and it never touches a store or the wasm geometry.
 */
export function targetRim(
  target: PlacementTarget & Pick<EngraveTargetObject, 'sha256' | 'format' | 'data'>,
  opts: RimOptions = {},
): RimResult {
  const topTiltMaxDeg = opts.topTiltMaxDeg ?? DEFAULT_TOP_TILT_MAX_DEG;
  const weldMm = opts.weldMm ?? DEFAULT_WELD_MM;
  const simplifyMm = opts.simplifyMm ?? DEFAULT_SIMPLIFY_MM;
  const mesh: ParsedMesh = targetObjectMesh(target);
  const placed = placeTarget(target, mesh);
  const cosTop = Math.cos((topTiltMaxDeg * Math.PI) / 180);

  // ---- weld the vertices, then place them once ----------------------------------------------
  const indexOf = new Map<string, number>();
  const points: Vec3[] = [];
  const vertex = (raw: number): number => {
    const p: Vec3 = [mesh.positions[raw * 3] ?? 0, mesh.positions[raw * 3 + 1] ?? 0, mesh.positions[raw * 3 + 2] ?? 0];
    const key = weldKey(p, weldMm);
    const found = indexOf.get(key);
    if (found !== undefined) return found;
    const [x, y, z] = placed.place(p[0], p[1], p[2]);
    points.push([x, y, z]);
    indexOf.set(key, points.length - 1);
    return points.length - 1;
  };

  // ---- triangles and their work-frame normals ------------------------------------------------
  const normals: Vec3[] = [];
  const tris: [number, number, number][] = [];
  for (let t = 0; t < mesh.triangleCount; t++) {
    const ia = vertex(mesh.indices[t * 3] ?? 0);
    const ib = vertex(mesh.indices[t * 3 + 1] ?? 0);
    const ic = vertex(mesh.indices[t * 3 + 2] ?? 0);
    if (ia === ib || ib === ic || ia === ic) continue; // a collapsed triangle has no plane
    const n = unit(cross(sub(points[ib]!, points[ia]!), sub(points[ic]!, points[ia]!)));
    if (n === null) continue;
    normals.push(n);
    tris.push([ia, ib, ic]);
  }
  const notes: string[] = [];

  // ---- edges, by welded vertex pair ----------------------------------------------------------
  const edges = new Map<string, Edge>();
  tris.forEach((tri, f) => {
    for (let k = 0; k < 3; k++) {
      const a = tri[k]!;
      const b = tri[(k + 1) % 3]!;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = `${lo}:${hi}`;
      const existing = edges.get(key);
      if (existing === undefined) edges.set(key, { a: lo, b: hi, faces: [f] });
      else existing.faces.push(f);
    }
  });

  // ---- the rim: a TOP face sharing an edge with a face that is NOT top ------------------------
  const rimEdges: RimEdge[] = [];
  let nonManifold = 0;
  for (const edge of edges.values()) {
    if (edge.faces.length !== 2) {
      if (edge.faces.length > 2) nonManifold += 1;
      // An open boundary belongs to no wall: there is no air side to carry the cone.
      continue;
    }
    const [f0, f1] = edge.faces as [number, number];
    const n0 = normals[f0]!;
    const n1 = normals[f1]!;
    const top0 = n0[2] >= cosTop;
    const top1 = n1[2] >= cosTop;
    if (top0 === top1) continue; // both top, or neither: not the rim
    const other = top0 ? n1 : n0;
    // The air side is the other face's normal, projected horizontally. A face that is nearly
    // horizontal itself (a chamfer facet, a ledge) has no horizontal direction to give, and a
    // knife edge is no wall.
    const airLen = Math.hypot(other[0], other[1]);
    if (!(airLen > 1e-9)) continue;
    rimEdges.push({ ...edge, top: top0 ? f0 : f1, air: { x: other[0] / airLen, y: other[1] / airLen } });
  }
  if (nonManifold > 0) {
    notes.push(
      `${nonManifold} mesh edge${nonManifold === 1 ? '' : 's'} where more than two faces meet ${nonManifold === 1 ? 'was' : 'were'} left out`,
    );
  }

  // ---- chains ----------------------------------------------------------------------------------
  const byVertex = new Map<number, RimEdge[]>();
  for (const e of rimEdges) {
    for (const v of [e.a, e.b]) {
      const list = byVertex.get(v);
      if (list === undefined) byVertex.set(v, [e]);
      else list.push(e);
    }
  }
  const usedKeys = new Set<string>();
  const keyOf = (e: RimEdge): string => `${e.a}:${e.b}`;
  const chains: RimChain[] = [];

  /** Walk the rim from one vertex, collecting the ordered vertices and the edges between them. */
  const walk = (start: number): void => {
    const firstEdge = (byVertex.get(start) ?? []).find((e) => !usedKeys.has(keyOf(e)));
    if (firstEdge === undefined) return;
    const verts: number[] = [start];
    const chainEdges: RimEdge[] = [];
    let at = start;
    let edge: RimEdge | undefined = firstEdge;
    let closed = false;
    while (edge !== undefined && !usedKeys.has(keyOf(edge))) {
      usedKeys.add(keyOf(edge));
      chainEdges.push(edge);
      const next: number = edge.a === at ? edge.b : edge.a;
      if (next === start) {
        closed = true;
        break;
      }
      verts.push(next);
      at = next;
      const options: RimEdge[] = (byVertex.get(next) ?? []).filter((e) => !usedKeys.has(keyOf(e)));
      // A junction (three or more rim edges) cannot be followed honestly: the chain ends there.
      edge = options.length === 1 ? options[0] : undefined;
    }
    if (chainEdges.length === 0) return;

    // The air direction at each raw vertex: the average of the edges meeting there (a corner's
    // bisector), which is exactly the offset a round tip takes at that corner.
    const raw = verts.map((v) => points[v]!);
    const sums = raw.map(() => ({ x: 0, y: 0 }));
    chainEdges.forEach((e, i) => {
      const j = closed ? (i + 1) % raw.length : i + 1;
      for (const k of [i, j]) {
        sums[k]!.x += e.air.x;
        sums[k]!.y += e.air.y;
      }
    });
    const airAt = sums.map((s) => {
      const len = Math.hypot(s.x, s.y);
      return len > 1e-12 ? { x: s.x / len, y: s.y / len } : { x: 0, y: 0 };
    });

    const keep = simplifyIndices(raw, closed, simplifyMm);
    const kept = keep.map((i) => raw[i]!);
    chains.push({
      points: kept.map((p) => ({ x: p[0], y: p[1], z: p[2] })),
      outward: keep.map((i) => airAt[i]!),
      closed,
      lengthMm: chainLength(kept, closed),
      topTiltDeg: chainTilt(chainEdges, normals),
    });
  };

  // Open chains from their ends first, so a ring cannot swallow them; then whatever is left.
  for (const [v, list] of byVertex) if (list.length === 1) walk(v);
  for (const [v] of byVertex) walk(v);

  if (rimEdges.length === 0) {
    notes.push('no top rim was found: the mesh has no edge where a top face meets a wall');
  }
  chains.sort((x, y) => y.lengthMm - x.lengthMm);
  return { chains, notes };
}

/** The indices of the points that matter: an end always, a middle point only off the line. */
function simplifyIndices(raw: Vec3[], closed: boolean, tol: number): number[] {
  const n = raw.length;
  if (n <= 2) return raw.map((_p, i) => i);
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) {
      keep.push(i);
      continue;
    }
    const prev = raw[(i - 1 + n) % n]!;
    const next = raw[(i + 1) % n]!;
    if (distanceToLine(raw[i]!, prev, next) > tol) keep.push(i);
  }
  if (closed && keep.length < 3) return raw.map((_p, i) => i);
  return keep;
}

function distanceToLine(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const ap = sub(p, a);
  const c = cross(ab, ap);
  const len = Math.hypot(ab[0], ab[1], ab[2]);
  return len > 1e-12 ? Math.hypot(c[0], c[1], c[2]) / len : Math.hypot(ap[0], ap[1], ap[2]);
}

function chainLength(points: Vec3[], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(...(sub(points[i]!, points[i - 1]!) as [number, number, number]));
  if (closed && points.length > 1) total += Math.hypot(...(sub(points[0]!, points[points.length - 1]!) as [number, number, number]));
  return total;
}

function chainTilt(chainEdges: RimEdge[], normals: Vec3[]): number {
  let worst = 0;
  for (const e of chainEdges) {
    const n = normals[e.top]!;
    const tilt = (Math.acos(Math.min(1, Math.max(-1, n[2]))) * 180) / Math.PI;
    worst = Math.max(worst, tilt);
  }
  return worst;
}
