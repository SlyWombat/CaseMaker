/**
 * #958 §3.1–3.2: planar patches, from a STEP's B-rep faces or from a mesh's coplanar triangles,
 * and their classification against the setup's up.
 *
 * Pure TypeScript, no geometry kernel. The input is a triangle soup already in the SETUP FRAME
 * (+Z up; `frame.ts` rotates it there).
 *
 * - A STEP gives a per-triangle `faceId` (occt-import-js `brep_faces`, #958 §2), so one B-rep face
 *   is one patch. Grouping is exact; only the plane test is numeric, because the kernel exposes no
 *   surface types.
 * - A mesh is clustered by region growth over welded edge adjacency. A neighbour joins when its
 *   normal is within the angle tolerance of the CLUSTER's area-weighted normal and its vertices lie
 *   within the plane tolerance of the cluster's plane. Comparing against the cluster, not the
 *   neighbour, is the fix for Kiri:Moto's `findConnectedSurface` drift on smooth curvature (#958 §1).
 *   Triangles that join no planar cluster form CURVED patches: maximal edge-connected sets of
 *   leftover triangles.
 *
 * Classification (#958 §3.2, D1 in 6620460283):
 *   floor     planar, normal within the angle tolerance of +Z
 *   wall      every triangle's normal within the angle tolerance of horizontal (curved walls too:
 *             fillets, bores)
 *   undercut  any triangle facing down, above the part's bottom (cannot be reached from this setup)
 *   bottom    planar, facing down, at the part's bottom (the stock side, not a feature)
 *   remainder everything else (inclined planes and curved surfaces)
 */

/** Tolerances, mm and degrees. Defaults from #958 §3. */
export interface FeatureTolerances {
  /** Max vertex distance from a patch's plane for it to be planar, mm. */
  planeMm: number;
  /** Max angle between normals for "same plane" / "horizontal" / "vertical", degrees. */
  angleDeg: number;
  /** Vertex weld distance for the mesh path's adjacency, mm. */
  weldMm: number;
  /** Floor levels closer than this merge into one level, mm. */
  levelMergeMm: number;
  /** A floor whose largest inscribed circle is narrower than this is a sliver (D2), mm. */
  minFloorWidthMm: number;
  /** Tangent-cap rule (D2): max dihedral, degrees, for a floor to count as a curved surface's cap. */
  tangentCapDeg: number;
}

export const DEFAULT_FEATURE_TOLERANCES: FeatureTolerances = {
  planeMm: 0.005,
  angleDeg: 0.5,
  weldMm: 1e-4,
  levelMergeMm: 0.01,
  minFloorWidthMm: 0.25,
  tangentCapDeg: 2,
};

export type PatchKind = 'floor' | 'wall' | 'undercut' | 'bottom' | 'remainder';

export interface Patch {
  id: number;
  /** Triangle indices into the source mesh. */
  triangles: number[];
  planar: boolean;
  /** Area-weighted unit normal. */
  normal: [number, number, number];
  /** Plane offset: normal · p = d for points on the plane (meaningful when `planar`). */
  d: number;
  area: number;
  zMin: number;
  zMax: number;
  kind: PatchKind;
  /** The plane fit's largest vertex deviation, mm: the evidence for `planar`. */
  planeDevMm: number;
  /** The largest angle between a triangle's normal and the fitted plane's, degrees. */
  normalSpreadDeg: number;
}

/** A triangle soup in the setup frame: positions xyz triplets, indices three per triangle. */
export interface FrameMesh {
  positions: Float32Array | Float64Array;
  indices: Uint32Array;
}

const DEG = Math.PI / 180;

interface TriInfo {
  n: Float64Array; // 3 per triangle, unit normal (0,0,0 for degenerate)
  area: Float64Array;
}

export function triangleInfo(mesh: FrameMesh): TriInfo {
  const count = mesh.indices.length / 3;
  const n = new Float64Array(count * 3);
  const area = new Float64Array(count);
  const p = mesh.positions;
  for (let t = 0; t < count; t++) {
    const a = mesh.indices[3 * t]! * 3;
    const b = mesh.indices[3 * t + 1]! * 3;
    const c = mesh.indices[3 * t + 2]! * 3;
    const ux = p[b]! - p[a]!;
    const uy = p[b + 1]! - p[a + 1]!;
    const uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!;
    const vy = p[c + 1]! - p[a + 1]!;
    const vz = p[c + 2]! - p[a + 2]!;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const len = Math.hypot(cx, cy, cz);
    area[t] = len / 2;
    if (len > 0) {
      n[3 * t] = cx / len;
      n[3 * t + 1] = cy / len;
      n[3 * t + 2] = cz / len;
    }
  }
  return { n, area };
}

/**
 * Weld vertices closer than `weldMm` (hash grid) and return, per triangle, its three neighbours
 * across its edges (-1 where an edge has no partner or more than one: a non-manifold edge is a
 * boundary for clustering).
 */
export function triangleAdjacency(mesh: FrameMesh, weldMm: number): Int32Array {
  const p = mesh.positions;
  const vCount = p.length / 3;
  const weld = new Int32Array(vCount);
  const cells = new Map<string, number[]>();
  const inv = 1 / weldMm;
  let next = 0;
  const canon: number[] = [];
  for (let v = 0; v < vCount; v++) {
    const x = p[3 * v]!;
    const y = p[3 * v + 1]!;
    const z = p[3 * v + 2]!;
    const gx = Math.floor(x * inv);
    const gy = Math.floor(y * inv);
    const gz = Math.floor(z * inv);
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const bucket = cells.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (bucket === undefined) continue;
          for (const w of bucket) {
            const cv = canon[w]!;
            if (Math.abs(p[3 * cv]! - x) <= weldMm && Math.abs(p[3 * cv + 1]! - y) <= weldMm && Math.abs(p[3 * cv + 2]! - z) <= weldMm) {
              found = w;
              break;
            }
          }
        }
      }
    }
    if (found < 0) {
      found = next++;
      canon.push(v);
      const key = `${gx},${gy},${gz}`;
      const bucket = cells.get(key);
      if (bucket === undefined) cells.set(key, [found]);
      else bucket.push(found);
    }
    weld[v] = found;
  }

  const triCount = mesh.indices.length / 3;
  const adj = new Int32Array(triCount * 3).fill(-1);
  // Pass 1: every welded edge -> the (triangle * 3 + edge) slots that use it.
  const edges = new Map<number, number[]>();
  const W = next;
  for (let t = 0; t < triCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = weld[mesh.indices[3 * t + e]!]!;
      const b = weld[mesh.indices[3 * t + ((e + 1) % 3)]!]!;
      if (a === b) continue;
      const key = a < b ? a * W + b : b * W + a;
      const slots = edges.get(key);
      if (slots === undefined) edges.set(key, [t * 3 + e]);
      else slots.push(t * 3 + e);
    }
  }
  // Pass 2: an edge shared by exactly two distinct triangles joins them; any other count (a
  // boundary, or a non-manifold fan) is a boundary for clustering.
  for (const slots of edges.values()) {
    if (slots.length !== 2) continue;
    const [s, u] = slots as [number, number];
    const ts = Math.floor(s / 3);
    const tu = Math.floor(u / 3);
    if (ts === tu) continue;
    adj[s] = tu;
    adj[u] = ts;
  }
  return adj;
}

/** Fit a plane to a set of triangles: area-weighted normal and centroid; max vertex deviation. */
function fitPlane(mesh: FrameMesh, info: TriInfo, tris: readonly number[]) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let area = 0;
  const p = mesh.positions;
  for (const t of tris) {
    const a = info.area[t]!;
    nx += info.n[3 * t]! * a;
    ny += info.n[3 * t + 1]! * a;
    nz += info.n[3 * t + 2]! * a;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * t + k]! * 3;
      cx += (p[v]! * a) / 3;
      cy += (p[v + 1]! * a) / 3;
      cz += (p[v + 2]! * a) / 3;
    }
    area += a;
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  const normal: [number, number, number] = [nx / len, ny / len, nz / len];
  const c = area > 0 ? [cx / area, cy / area, cz / area] : [0, 0, 0];
  const d = normal[0] * c[0]! + normal[1] * c[1]! + normal[2] * c[2]!;
  let dev = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  let minDot = 1;
  for (const t of tris) {
    const dot = info.n[3 * t]! * normal[0] + info.n[3 * t + 1]! * normal[1] + info.n[3 * t + 2]! * normal[2];
    if (info.area[t]! > 0 && dot < minDot) minDot = dot;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[3 * t + k]! * 3;
      const e = Math.abs(normal[0] * p[v]! + normal[1] * p[v + 1]! + normal[2] * p[v + 2]! - d);
      if (e > dev) dev = e;
      if (p[v + 2]! < zMin) zMin = p[v + 2]!;
      if (p[v + 2]! > zMax) zMax = p[v + 2]!;
    }
  }
  return { normal, d, area, dev, zMin, zMax, minDot };
}

/**
 * Patches from a STEP's per-triangle face ids: one B-rep face, one patch. Planar when the fit
 * deviates by at most `planeMm` and no triangle's normal departs from the plane's by more than
 * `angleDeg` (a cylinder sliver can fit a plane within the distance tolerance; it cannot pass both).
 */
export function patchesFromFaces(mesh: FrameMesh, faceId: Uint32Array, tol: FeatureTolerances): Patch[] {
  const info = triangleInfo(mesh);
  const groups = new Map<number, number[]>();
  for (let t = 0; t < faceId.length; t++) {
    const f = faceId[t]!;
    const g = groups.get(f);
    if (g === undefined) groups.set(f, [t]);
    else g.push(t);
  }
  const cosTol = Math.cos(tol.angleDeg * DEG);
  const out: Patch[] = [];
  for (const tris of groups.values()) {
    const fit = fitPlane(mesh, info, tris);
    if (fit.area <= 0) continue;
    const planar = fit.dev <= tol.planeMm && fit.minDot >= cosTol;
    out.push({ id: out.length, triangles: tris, planar, normal: fit.normal, d: fit.d, area: fit.area, zMin: fit.zMin, zMax: fit.zMax, kind: 'remainder', planeDevMm: fit.dev, normalSpreadDeg: (Math.acos(Math.min(1, fit.minDot)) * 180) / Math.PI, });
  }
  return out;
}

/**
 * Patches from a mesh by region growth (#958 §3.1). Seeds are taken in descending triangle area,
 * so a large flat claims its triangles before a sliver neighbour can start a cluster of its own.
 */
export function patchesFromMesh(mesh: FrameMesh, tol: FeatureTolerances): Patch[] {
  const info = triangleInfo(mesh);
  const adj = triangleAdjacency(mesh, tol.weldMm);
  const count = mesh.indices.length / 3;
  const owner = new Int32Array(count).fill(-1);
  const cosTol = Math.cos(tol.angleDeg * DEG);
  const p = mesh.positions;
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => info.area[b]! - info.area[a]!);

  const planarClusters: number[][] = [];
  for (const seed of order) {
    if (owner[seed] !== -1 || info.area[seed]! <= 0) continue;
    // Running cluster normal (area-weighted sum) and centroid-weighted plane.
    let sx = info.n[3 * seed]! * info.area[seed]!;
    let sy = info.n[3 * seed + 1]! * info.area[seed]!;
    let sz = info.n[3 * seed + 2]! * info.area[seed]!;
    const cid = planarClusters.length;
    const tris = [seed];
    owner[seed] = cid;
    // The plane passes through the seed's first vertex; its normal is the running mean.
    const v0 = mesh.indices[3 * seed]! * 3;
    const px = p[v0]!;
    const py = p[v0 + 1]!;
    const pz = p[v0 + 2]!;
    const queue = [seed];
    while (queue.length > 0) {
      const t = queue.pop()!;
      for (let e = 0; e < 3; e++) {
        const u = adj[3 * t + e]!;
        if (u < 0 || owner[u] !== -1 || info.area[u]! <= 0) continue;
        const len = Math.hypot(sx, sy, sz);
        const nx = sx / len;
        const ny = sy / len;
        const nz = sz / len;
        const dot = info.n[3 * u]! * nx + info.n[3 * u + 1]! * ny + info.n[3 * u + 2]! * nz;
        if (dot < cosTol) continue;
        let ok = true;
        for (let k = 0; k < 3 && ok; k++) {
          const v = mesh.indices[3 * u + k]! * 3;
          const dist = Math.abs(nx * (p[v]! - px) + ny * (p[v + 1]! - py) + nz * (p[v + 2]! - pz));
          if (dist > tol.planeMm) ok = false;
        }
        if (!ok) continue;
        owner[u] = cid;
        tris.push(u);
        queue.push(u);
        sx += info.n[3 * u]! * info.area[u]!;
        sy += info.n[3 * u + 1]! * info.area[u]!;
        sz += info.n[3 * u + 2]! * info.area[u]!;
      }
    }
    planarClusters.push(tris);
  }

  // A cluster is planar only if the final fit holds; a lone triangle on a curved surface is a
  // "planar cluster" of one and must be returned to the curved pool. A single-triangle cluster is
  // planar only when its own normal is axis-aligned (a horizontal or vertical facet).
  const out: Patch[] = [];
  const curvedPool = new Uint8Array(count);
  const horizontalOrVertical = (n: readonly number[]): boolean =>
    Math.abs(n[2]!) >= cosTol || Math.abs(n[2]!) <= Math.sin(tol.angleDeg * DEG);
  for (const tris of planarClusters) {
    const fit = fitPlane(mesh, info, tris);
    const planar = fit.dev <= tol.planeMm && fit.minDot >= cosTol && (tris.length > 1 || horizontalOrVertical(fit.normal));
    if (planar) {
      out.push({ id: out.length, triangles: tris, planar: true, normal: fit.normal, d: fit.d, area: fit.area, zMin: fit.zMin, zMax: fit.zMax, kind: 'remainder', planeDevMm: fit.dev, normalSpreadDeg: (Math.acos(Math.min(1, fit.minDot)) * 180) / Math.PI, });
    } else {
      for (const t of tris) curvedPool[t] = 1;
    }
  }
  // Curved patches: edge-connected components of the pool.
  const seen = new Uint8Array(count);
  for (let s = 0; s < count; s++) {
    if (!curvedPool[s] || seen[s]) continue;
    const tris: number[] = [];
    const queue = [s];
    seen[s] = 1;
    while (queue.length > 0) {
      const t = queue.pop()!;
      tris.push(t);
      for (let e = 0; e < 3; e++) {
        const u = adj[3 * t + e]!;
        if (u >= 0 && curvedPool[u] && !seen[u]) {
          seen[u] = 1;
          queue.push(u);
        }
      }
    }
    const fit = fitPlane(mesh, info, tris);
    out.push({ id: out.length, triangles: tris, planar: false, normal: fit.normal, d: fit.d, area: fit.area, zMin: fit.zMin, zMax: fit.zMax, kind: 'remainder', planeDevMm: fit.dev, normalSpreadDeg: (Math.acos(Math.min(1, fit.minDot)) * 180) / Math.PI, });
  }
  return out;
}

/**
 * D1 (#958, 6620460283): the curved remainder as SURFACES — maximal sets of remainder triangles
 * joined across shared edges in 3D. A tessellated curve arrives from §3.1 as many small inclined
 * patches (adjacent facets that happen to fit one plane); this is where they become one surface.
 *
 * D2's tangent cap, MESH PATH ONLY: an up-facing planar patch whose every boundary edge meets a
 * remainder triangle at a dihedral under `tangentCapDeg`, and whose area is under
 * `TANGENT_CAP_MAX_AREA_MM2`, is the near-flat cap a tessellated dish leaves at its bottom. It is
 * demoted to remainder. The area bound keeps a real flat-bottomed bowl (a planar face with tangent
 * blends all round, which a STEP reports as a plane) a floor on the mesh path too, so the two paths
 * agree. The STEP path never demotes: its planes are B-rep faces.
 */
export const TANGENT_CAP_MAX_AREA_MM2 = 1;

export function remainderSurfaces(
  mesh: FrameMesh,
  patches: Patch[],
  adj: Int32Array,
  tol: FeatureTolerances,
  path: 'step' | 'mesh',
): { surfaces: number[][]; demoted: number[] } {
  const info = triangleInfo(mesh);
  const count = mesh.indices.length / 3;
  const patchOf = new Int32Array(count).fill(-1);
  for (const patch of patches) for (const t of patch.triangles) patchOf[t] = patch.id;
  const isRemainder = (t: number): boolean => {
    const id = patchOf[t]!;
    return id >= 0 && patches[id]!.kind === 'remainder';
  };

  const demoted: number[] = [];
  if (path === 'mesh') {
    const cosCap = Math.cos(tol.tangentCapDeg * DEG);
    for (const patch of patches) {
      if (patch.kind !== 'floor' || patch.area >= TANGENT_CAP_MAX_AREA_MM2) continue;
      let boundary = 0;
      let tangent = 0;
      for (const t of patch.triangles) {
        for (let e = 0; e < 3; e++) {
          const u = adj[3 * t + e]!;
          if (u >= 0 && patchOf[u] === patch.id) continue;
          boundary++;
          if (u < 0 || !isRemainder(u)) continue;
          const dot = info.n[3 * t]! * info.n[3 * u]! + info.n[3 * t + 1]! * info.n[3 * u + 1]! + info.n[3 * t + 2]! * info.n[3 * u + 2]!;
          if (dot >= cosCap) tangent++;
        }
      }
      if (boundary > 0 && tangent === boundary) demoted.push(patch.id);
    }
    for (const id of demoted) patches[id]!.kind = 'remainder';
  }

  const seen = new Uint8Array(count);
  const surfaces: number[][] = [];
  for (let s = 0; s < count; s++) {
    if (seen[s] || !isRemainder(s)) continue;
    const tris: number[] = [];
    const queue = [s];
    seen[s] = 1;
    while (queue.length > 0) {
      const t = queue.pop()!;
      tris.push(t);
      for (let e = 0; e < 3; e++) {
        const u = adj[3 * t + e]!;
        if (u >= 0 && !seen[u] && isRemainder(u)) {
          seen[u] = 1;
          queue.push(u);
        }
      }
    }
    surfaces.push(tris);
  }
  return { surfaces, demoted };
}

/**
 * Classify patches against +Z (the setup's up, after `frame.ts`). `partBottom` is the lowest z of
 * the part; a down-facing planar patch there is the stock side, not an undercut.
 *
 * #965 — THE MESH PATH CLASSIFIES PER TRIANGLE. A B-rep face (the STEP path) is one surface and
 * one orientation; a MESH path's curved pool is one edge-connected component of every non-planar
 * triangle, and a closed sculpture's connected surface spans both its up-facing top and its
 * down-facing underside — on the panther, one down facet in a 119,262-triangle component demoted
 * 73 % of the mesh to `undercut`, no RemainderRegion projected over it, and the finish never ran
 * there. When `path === 'mesh'`, a non-planar patch whose facets disagree is therefore SPLIT by
 * each triangle's own orientation: up-facing triangles stay remainder ground (they are the top of
 * the material from above), vertical ones become walls, and down-facing ones keep the undercut
 * exclusion. The STEP path keeps the whole-patch rule unchanged (one face = one surface).
 */
export function classifyPatches(mesh: FrameMesh, patches: Patch[], partBottom: number, tol: FeatureTolerances, path: 'mesh' | 'step' = 'mesh'): void {
  const info = triangleInfo(mesh);
  const cosTol = Math.cos(tol.angleDeg * DEG);
  const sinTol = Math.sin(tol.angleDeg * DEG);
  // Snapshot: the mesh path APPENDS the split pieces, and each of those is classified on its own
  // in the same pass (a pure-down piece reads `undercut`, a pure-vertical one `wall`).
  for (const patch of [...patches]) {
    const nz = patch.normal[2];
    if (patch.planar && nz >= cosTol) {
      patch.kind = 'floor';
      continue;
    }
    if (patch.planar && nz <= -cosTol && Math.abs(patch.zMax - partBottom) <= tol.planeMm) {
      patch.kind = 'bottom';
      continue;
    }
    let allVertical = true;
    let anyDown = false;
    for (const t of patch.triangles) {
      if (info.area[t]! <= 0) continue;
      const tz = info.n[3 * t + 2]!;
      if (Math.abs(tz) > sinTol) allVertical = false;
      if (tz < -sinTol) anyDown = true;
    }
    if (allVertical) patch.kind = 'wall';
    else if (anyDown) {
      if (path !== 'mesh' || patch.planar) {
        patch.kind = 'undercut';
        continue;
      }
      // #965 — the split (see this function's header). Up-facing triangles ARE remainder ground.
      const up: number[] = [];
      const vertical: number[] = [];
      const down: number[] = [];
      for (const t of patch.triangles) {
        const tz = info.area[t]! <= 0 ? 0 : info.n[3 * t + 2]!;
        if (tz > sinTol) up.push(t);
        else if (tz < -sinTol) down.push(t);
        else vertical.push(t);
      }
      const piece = (tris: number[], kind: PatchKind): void => {
        const fit = fitPlane(mesh, info, tris);
        patches.push({
          id: patches.length,
          triangles: tris,
          planar: false,
          normal: fit.normal,
          d: fit.d,
          area: fit.area,
          zMin: fit.zMin,
          zMax: fit.zMax,
          kind,
          planeDevMm: fit.dev,
          normalSpreadDeg: fit.minDot === undefined ? 0 : (Math.acos(Math.min(1, fit.minDot)) * 180) / Math.PI,
        });
      };
      // The original patch keeps the up-facing set; the other two are appended as their own
      // patches (classified by the loop above — no guessing here). A component with NO up-facing
      // facet is a true undercut and keeps the whole-patch exclusion.
      if (up.length === 0) {
        patch.kind = 'undercut';
        continue;
      }
      patch.triangles = up;
      patch.kind = 'remainder';
      if (vertical.length > 0) piece(vertical, 'wall');
      if (down.length > 0) piece(down, 'undercut');
    } else patch.kind = 'remainder';
  }
}
