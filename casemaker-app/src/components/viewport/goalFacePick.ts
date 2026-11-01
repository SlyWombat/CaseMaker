/**
 * #876 — THE GOAL'S PICKABLE FACES, for place-on-face.
 *
 * A CAD mesh has exact planar faces; an organic mesh (the panther) has almost none. Both are
 * handled by one growing rule: a region starts at an unassigned triangle and grows across shared
 * edges while a neighbour's normal stays within {@link REGION_NORMAL_DEG} of the region's SEED
 * normal. On a CAD face every normal is identical, so each face is one region; on an organic flank
 * the region is the near-flat patch a hand would call a side. Growing from the SEED normal (rather
 * than the running mean) also bounds a curved surface: a cap where every normal is within a few
 * degrees of one direction cannot wrap around a body.
 *
 * Regions are ranked by area, and a picker offers only the largest {@link TOP_REGIONS}, so a bumpy
 * mesh does not present a thousand slivers. A click on ANY triangle still has an answer: its
 * region's mean normal — the point fallback — so a tiny facet with no highlight of its own is
 * still usable, in the direction it actually faces.
 *
 * Pure (no three, no React), so the grouping can be tested on synthetic meshes — including the
 * non-CAD ones.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface GoalFaceRegion {
  /** Area-weighted mean normal, unit, in the mesh's own (unrotated) frame. */
  normal: Vec3;
  /** Summed triangle area, mm². */
  areaMm2: number;
  /** Triangle indices in the mesh's triangle order. */
  triangles: number[];
}

export interface GoalFaceMap {
  /** Region index per triangle; -1 for a degenerate triangle with no normal. */
  regionOf: Int32Array;
  regions: GoalFaceRegion[];
  /** Region indices, largest area first. */
  ranked: number[];
}

/** A neighbour joins while its normal is within this angle of the region's seed normal. */
export const REGION_NORMAL_DEG = 8;
/** How many regions a picker offers, largest first. */
export const TOP_REGIONS = 24;

const cosDeg = (deg: number): number => Math.cos((deg * Math.PI) / 180);

/**
 * Group the mesh's triangles into near-flat regions. `indices` may be null (an STL carries three
 * fresh vertices per triangle): vertices are welded by position first, so edge adjacency works
 * for both.
 */
export function goalFaceRegions(
  positions: ArrayLike<number>,
  indices: ArrayLike<number> | null = null,
  opts: { normalDeg?: number } = {},
): GoalFaceMap {
  const vertexCount = Math.floor(positions.length / 3);
  const triCount = indices === null ? Math.floor(vertexCount / 3) : Math.floor(indices.length / 3);
  const vAt = (t: number, k: number): number => (indices === null ? t * 3 + k : indices[t * 3 + k]!);
  const p = (v: number, k: number): number => positions[v * 3 + k]!;

  // Weld by position (0.0001 mm): an STL's triangles share no vertex indices at all.
  const canon = new Int32Array(vertexCount);
  {
    const seen = new Map<string, number>();
    for (let v = 0; v < vertexCount; v++) {
      const key = `${Math.round(p(v, 0) * 1e4)},${Math.round(p(v, 1) * 1e4)},${Math.round(p(v, 2) * 1e4)}`;
      let id = seen.get(key);
      if (id === undefined) {
        id = seen.size;
        seen.set(key, id);
      }
      canon[v] = id;
    }
  }

  const nrm = new Float64Array(triCount * 3);
  const area = new Float64Array(triCount);
  const valid = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = vAt(t, 0), b = vAt(t, 1), c = vAt(t, 2);
    const ax = p(a, 0), ay = p(a, 1), az = p(a, 2);
    const e1x = p(b, 0) - ax, e1y = p(b, 1) - ay, e1z = p(b, 2) - az;
    const e2x = p(c, 0) - ax, e2y = p(c, 1) - ay, e2z = p(c, 2) - az;
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const len = Math.hypot(cx, cy, cz);
    if (!(len > 1e-12)) continue; // degenerate: no normal to grow by
    nrm[t * 3] = cx / len;
    nrm[t * 3 + 1] = cy / len;
    nrm[t * 3 + 2] = cz / len;
    area[t] = len / 2;
    valid[t] = 1;
  }

  // Edge adjacency on welded vertex ids.
  const edgeKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const edges = new Map<string, number[]>();
  for (let t = 0; t < triCount; t++) {
    if (!valid[t]) continue;
    const v0 = canon[vAt(t, 0)]!, v1 = canon[vAt(t, 1)]!, v2 = canon[vAt(t, 2)]!;
    for (const [a, b] of [[v0, v1], [v1, v2], [v2, v0]] as const) {
      const key = edgeKey(a, b);
      let list = edges.get(key);
      if (list === undefined) edges.set(key, (list = []));
      list.push(t);
    }
  }
  const neighbours: number[][] = Array.from({ length: triCount }, () => []);
  for (const list of edges.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        neighbours[list[i]!]!.push(list[j]!);
        neighbours[list[j]!]!.push(list[i]!);
      }
    }
  }

  const cosTol = cosDeg(opts.normalDeg ?? REGION_NORMAL_DEG);
  const regionOf = new Int32Array(triCount).fill(-1);
  const regions: GoalFaceRegion[] = [];
  const queue: number[] = [];
  for (let seed = 0; seed < triCount; seed++) {
    if (!valid[seed] || regionOf[seed]! >= 0) continue;
    const index = regions.length;
    const sx = nrm[seed * 3]!, sy = nrm[seed * 3 + 1]!, sz = nrm[seed * 3 + 2]!;
    regionOf[seed] = index;
    queue.length = 0;
    queue.push(seed);
    const triangles: number[] = [];
    let sumArea = 0;
    let wx = 0, wy = 0, wz = 0;
    while (queue.length > 0) {
      const t = queue.pop()!;
      triangles.push(t);
      const a = area[t]!;
      sumArea += a;
      // Area-weighted: a dense patch of small triangles must not outvote a big one.
      wx += nrm[t * 3]! * a;
      wy += nrm[t * 3 + 1]! * a;
      wz += nrm[t * 3 + 2]! * a;
      for (const u of neighbours[t]!) {
        if (regionOf[u]! >= 0 || !valid[u]) continue;
        // The SEED's normal, never the running mean: a region cannot creep round a curve.
        if (nrm[u * 3]! * sx + nrm[u * 3 + 1]! * sy + nrm[u * 3 + 2]! * sz < cosTol) continue;
        regionOf[u] = index;
        queue.push(u);
      }
    }
    const weight = Math.hypot(wx, wy, wz);
    regions.push({
      normal: weight > 1e-12 ? { x: wx / weight, y: wy / weight, z: wz / weight } : { x: sx, y: sy, z: sz },
      areaMm2: sumArea,
      triangles,
    });
  }

  const ranked = regions.map((_, i) => i).sort((a, b) => regions[b]!.areaMm2 - regions[a]!.areaMm2);
  return { regionOf, regions, ranked };
}
