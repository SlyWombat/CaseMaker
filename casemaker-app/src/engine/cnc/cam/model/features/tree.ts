/**
 * #958 §3.3–3.4: floor levels → sections → the feature tree, by booleans on the sections.
 *
 * The input is a mesh already in the setup frame (+Z up), its patches classified, and its
 * remainder surfaces (D1). The kernel is Manifold (`slice`, `project`, `CrossSection` booleans).
 * It is passed in, the way `pocket.ts` takes its offset: this module never loads wasm.
 *
 * The rules, in the order they are applied (#958 §3.4, D1 and D2 in 6620460283):
 *   - Levels are the heights of FLOOR patches (planar, facing up), merged within
 *     `levelMergeMm`. A level slice never creates a floor, so a slope crossing a level is not a
 *     pocket by construction (D2).
 *   - O is the part's silhouette. At each level z below the top, C(z) = O − section(z + ε) is the
 *     area where the part is below z. Each connected component of C(z) that holds a floor patch at
 *     z is a PocketNode; its holes are islands. A component with no floor at its level belongs to
 *     its parent and to the remainder (D2's node rule).
 *   - A hole of O is a through feature (`through: true`): the part has no material there at all.
 *   - A floor patch whose largest inscribed circle is narrower than `minFloorWidthMm` is a sliver,
 *     listed in `report.slivers`, never a node and never a level of its own.
 *   - Each remainder SURFACE (3D-connected) is one RemainderRegion: its projected footprint, its
 *     z range and slope range (D1).
 */

import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import type { Polygons } from '@/engine/cnc/cam/pocket';

import type { FrameMesh, Patch, FeatureTolerances } from './patches';
import type { RawRim } from './rims';

type CrossSection = InstanceType<ManifoldToplevel['CrossSection']>;
type Manifold = InstanceType<ManifoldToplevel['Manifold']>;

/** Lift above a level for its section, mm: a floor exactly at z must read as "below z + ε". */
export const SECTION_LIFT_MM = 1e-3;
/** Areas below this are boolean noise, mm². */
const AREA_EPS = 1e-6;

export interface TreeFloor {
  /** The floor patches' projection at this level within the node, as one or more parts. */
  polygons: Polygons;
  area: number;
}

export interface TreeNode {
  id: string;
  floorZ: number;
  mouthZ: number;
  open: boolean;
  through: boolean;
  region: Polygons;
  floors: TreeFloor[];
  islands: { outline: Polygons; topZ: number }[];
  children: TreeNode[];
  remainder: string[];
  /** The largest cutter diameter that can enter the region (twice its largest inscribed radius). */
  narrowest: number;
}

export interface TreeRemainder {
  id: string;
  footprint: Polygons;
  area: number;
  zTop: number;
  zBottom: number;
  triangles: Uint32Array;
  slopeDeg: [number, number];
  /** Area-weighted median slope, degrees (the acceptance compares it with E's, ±3°). */
  slopeMedianDeg: number;
  in: string;
}

export interface TreeSliver {
  z: number;
  area: number;
  centroid: [number, number];
  bbox: { min: [number, number]; max: [number, number] };
}

export interface TreeRim extends RawRim {
  id: string;
  of: string;
}

export interface BuiltTree {
  partTop: number;
  partBottom: number;
  levels: number[];
  top: { z: number; floors: TreeFloor[]; area: number };
  contour: { outline: Polygons; area: number; zTo: number };
  pockets: TreeNode[];
  remainder: TreeRemainder[];
  unreachable: { footprint: Polygons; zRange: [number, number]; reason: 'undercut' }[];
  slivers: TreeSliver[];
  rims: TreeRim[];
  notes: string[];
}

const toPolygons = (cs: CrossSection): Polygons =>
  cs.toPolygons().map((ring) => ring.map((p) => [p[0], p[1]] as [number, number]));

/** An empty CrossSection (the constructor rejects an empty polygon list). */
function emptySection(tl: ManifoldToplevel): CrossSection {
  const unit = tl.CrossSection.square([1, 1]);
  const empty = unit.subtract(unit);
  unit.delete();
  return empty;
}

/** The union of a set of triangles' XY projections, every triangle made CCW first. */
function projectTriangles(tl: ManifoldToplevel, mesh: FrameMesh, tris: readonly number[]): CrossSection {
  const p = mesh.positions;
  const rings: [number, number][][] = [];
  for (const t of tris) {
    const a = mesh.indices[3 * t]! * 3;
    const b = mesh.indices[3 * t + 1]! * 3;
    const c = mesh.indices[3 * t + 2]! * 3;
    const ax = p[a]!;
    const ay = p[a + 1]!;
    const bx = p[b]!;
    const by = p[b + 1]!;
    const cx = p[c]!;
    const cy = p[c + 1]!;
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(cross) < 1e-12) continue; // vertical in projection: no area
    rings.push(
      cross > 0
        ? [
            [ax, ay],
            [bx, by],
            [cx, cy],
          ]
        : [
            [ax, ay],
            [cx, cy],
            [bx, by],
          ],
    );
  }
  if (rings.length === 0) return emptySection(tl);
  return tl.CrossSection.ofPolygons(rings, 'Positive');
}

/** Twice the largest r for which the region eroded by r is non-empty (bisection to 0.005 mm). */
function inscribedDiameter(cs: CrossSection): number {
  const b = cs.bounds();
  let hi = Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1]) / 2;
  let lo = 0;
  while (hi - lo > 0.0025) {
    const mid = (lo + hi) / 2;
    const eroded = cs.offset(-mid, 'Round', 2, 32);
    const empty = eroded.area() <= AREA_EPS;
    eroded.delete();
    if (empty) hi = mid;
    else lo = mid;
  }
  return 2 * lo;
}

function centroidOf(cs: CrossSection): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (const ring of cs.toPolygons()) {
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % ring.length]!;
      const w = x0 * y1 - x1 * y0;
      a += w;
      cx += (x0 + x1) * w;
      cy += (y0 + y1) * w;
    }
  }
  return a === 0 ? [0, 0] : [cx / (3 * a), cy / (3 * a)];
}

function bboxOf(cs: CrossSection): { min: [number, number]; max: [number, number] } {
  const b = cs.bounds();
  return { min: [b.min[0], b.min[1]], max: [b.max[0], b.max[1]] };
}

/** Holes of a single component, each as its own CrossSection (a CW ring, reversed to CCW). */
function holesOf(tl: ManifoldToplevel, component: CrossSection): CrossSection[] {
  const out: CrossSection[] = [];
  for (const ring of component.toPolygons()) {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % ring.length]!;
      a += x0 * y1 - x1 * y0;
    }
    if (a < 0) out.push(tl.CrossSection.ofPolygons([[...ring].reverse()], 'Positive'));
  }
  return out;
}

/** Outer boundaries only, as one CrossSection per outer ring (holes filled). */
function filledOuters(tl: ManifoldToplevel, cs: CrossSection): CrossSection[] {
  const out: CrossSection[] = [];
  for (const ring of cs.toPolygons()) {
    let a = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i]!;
      const [x1, y1] = ring[(i + 1) % ring.length]!;
      a += x0 * y1 - x1 * y0;
    }
    if (a > 0) out.push(tl.CrossSection.ofPolygons([ring], 'Positive'));
  }
  return out;
}

const overlaps = (a: CrossSection, b: CrossSection): boolean => {
  const i = a.intersect(b);
  const hit = i.area() > AREA_EPS;
  i.delete();
  return hit;
};

/** Build the solid the sections are taken from. The mesh must close; the merge welds seams. */
export function solidOf(tl: ManifoldToplevel, mesh: FrameMesh): Manifold {
  const mm = new tl.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(mesh.positions),
    triVerts: Uint32Array.from(mesh.indices),
  });
  mm.merge();
  return new tl.Manifold(mm);
}

export function buildTree(
  tl: ManifoldToplevel,
  mesh: FrameMesh,
  patches: readonly Patch[],
  surfaces: readonly number[][],
  tol: FeatureTolerances,
  rawRims: readonly RawRim[] = [],
): BuiltTree {
  const notes: string[] = [];
  const p = mesh.positions;
  let partTop = -Infinity;
  let partBottom = Infinity;
  for (let i = 2; i < p.length; i += 3) {
    if (p[i]! > partTop) partTop = p[i]!;
    if (p[i]! < partBottom) partBottom = p[i]!;
  }

  const solid = solidOf(tl, mesh);
  const garbage: { delete(): void }[] = [solid];
  try {
    const silhouette = solid.project();
    garbage.push(silhouette);

    // ── Floors, slivers and levels ────────────────────────────────────────────────────────
    const slivers: TreeSliver[] = [];
    const floors: { patch: Patch; cs: CrossSection }[] = [];
    for (const patch of patches) {
      if (patch.kind !== 'floor') continue;
      const cs = projectTriangles(tl, mesh, patch.triangles);
      garbage.push(cs);
      if (cs.area() <= AREA_EPS) continue;
      if (inscribedDiameter(cs) < tol.minFloorWidthMm) {
        slivers.push({ z: patch.zMax, area: cs.area(), centroid: centroidOf(cs), bbox: bboxOf(cs) });
        continue;
      }
      floors.push({ patch, cs });
    }
    const heights = floors.map((f) => (f.patch.zMin + f.patch.zMax) / 2).sort((a, b) => b - a);
    const levels: number[] = [];
    for (const h of heights) {
      if (levels.length === 0 || levels[levels.length - 1]! - h > tol.levelMergeMm) levels.push(h);
    }
    const levelOf = (z: number): number => {
      for (const l of levels) if (Math.abs(l - z) <= tol.levelMergeMm) return l;
      return z;
    };

    // ── The top land ──────────────────────────────────────────────────────────────────────
    const topZ = levels.length > 0 && Math.abs(levels[0]! - partTop) <= tol.levelMergeMm ? levels[0]! : partTop;
    const topFloors = floors.filter((f) => Math.abs(levelOf((f.patch.zMin + f.patch.zMax) / 2) - topZ) <= tol.levelMergeMm);
    const topUnion = tl.CrossSection.union(topFloors.map((f) => f.cs));
    garbage.push(topUnion);
    const topParts = topUnion.decompose();
    garbage.push(...topParts);
    const top = {
      z: topZ,
      floors: topParts.filter((part) => part.area() > AREA_EPS).map((part) => ({ polygons: toPolygons(part), area: part.area() })),
      area: topUnion.area(),
    };

    // ── Nodes per level ───────────────────────────────────────────────────────────────────
    const nodes: (TreeNode & { cs: CrossSection })[] = [];
    let nextId = 0;
    for (const z of levels) {
      if (z === topZ) continue;
      const section = solid.slice(z + SECTION_LIFT_MM);
      const cleared = silhouette.subtract(section);
      section.delete();
      garbage.push(cleared);
      const levelFloors = floors.filter((f) => Math.abs(levelOf((f.patch.zMin + f.patch.zMax) / 2) - z) <= tol.levelMergeMm);
      const comps = cleared.decompose();
      garbage.push(...comps);
      for (const comp of comps) {
        if (comp.area() <= AREA_EPS) continue;
        const inside = levelFloors.filter((f) => overlaps(f.cs, comp));
        if (inside.length === 0) continue;
        const floorUnion = tl.CrossSection.union(inside.map((f) => f.cs)).intersect(comp);
        garbage.push(floorUnion);
        const floorParts = floorUnion.decompose();
        garbage.push(...floorParts);
        const open = (() => {
          const grown = comp.offset(0.01, 'Miter', 2, 8);
          const outside = grown.subtract(silhouette);
          const hit = outside.area() > AREA_EPS;
          grown.delete();
          outside.delete();
          return hit;
        })();
        nodes.push({
          id: `pocket-${nextId++}`,
          floorZ: z,
          mouthZ: topZ,
          open,
          through: false,
          region: toPolygons(comp),
          floors: floorParts.filter((part) => part.area() > AREA_EPS).map((part) => ({ polygons: toPolygons(part), area: part.area() })),
          islands: [],
          children: [],
          remainder: [],
          narrowest: inscribedDiameter(comp),
          cs: comp,
        });
      }
    }

    // ── Through features: holes of the silhouette ─────────────────────────────────────────
    for (const hole of holesOf(tl, silhouette)) {
      garbage.push(hole);
      nodes.push({
        id: `pocket-${nextId++}`,
        floorZ: partBottom,
        mouthZ: topZ,
        open: false,
        through: true,
        region: toPolygons(hole),
        floors: [],
        islands: [],
        children: [],
        remainder: [],
        narrowest: inscribedDiameter(hole),
        cs: hole,
      });
    }

    // ── Remainder regions (D1) ────────────────────────────────────────────────────────────
    const remainder: TreeRemainder[] = [];
    const remainderCs: CrossSection[] = [];
    let degenerate = 0;
    for (const tris of surfaces) {
      const footprint = projectTriangles(tl, mesh, tris);
      garbage.push(footprint);
      // A surface with no area in projection (a zero-area triangle a tessellator left at a pole)
      // is not a region. Counted in the report.
      if (footprint.area() <= AREA_EPS) {
        degenerate++;
        continue;
      }
      let zTop = -Infinity;
      let zBottom = Infinity;
      const slopes: { deg: number; area: number }[] = [];
      for (const t of tris) {
        const ia = mesh.indices[3 * t]! * 3;
        const ib = mesh.indices[3 * t + 1]! * 3;
        const ic = mesh.indices[3 * t + 2]! * 3;
        for (const v of [ia, ib, ic]) {
          zTop = Math.max(zTop, p[v + 2]!);
          zBottom = Math.min(zBottom, p[v + 2]!);
        }
        const ux = p[ib]! - p[ia]!;
        const uy = p[ib + 1]! - p[ia + 1]!;
        const uz = p[ib + 2]! - p[ia + 2]!;
        const vx = p[ic]! - p[ia]!;
        const vy = p[ic + 1]! - p[ia + 1]!;
        const vz = p[ic + 2]! - p[ia + 2]!;
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (len === 0) continue;
        slopes.push({ deg: (Math.acos(Math.min(1, Math.abs(nz) / len)) * 180) / Math.PI, area: len / 2 });
      }
      slopes.sort((a, b) => a.deg - b.deg);
      const total = slopes.reduce((s, x) => s + x.area, 0);
      let acc = 0;
      let median = slopes[0]?.deg ?? 0;
      for (const s of slopes) {
        acc += s.area;
        if (acc >= total / 2) {
          median = s.deg;
          break;
        }
      }
      remainder.push({
        id: `curved-${remainder.length}`,
        footprint: toPolygons(footprint),
        area: footprint.area(),
        zTop,
        zBottom,
        triangles: Uint32Array.from(tris),
        slopeDeg: [slopes[0]?.deg ?? 0, slopes[slopes.length - 1]?.deg ?? 0],
        slopeMedianDeg: median,
        in: 'top',
      });
      remainderCs.push(footprint);
    }

    if (degenerate > 0) notes.push(`${degenerate} curved surface(s) with no area in projection ignored`);

    // ── Relations: parents, mouths, islands, remainder membership ────────────────────────
    // Deepest first, so each node's parent is the nearest shallower node containing it.
    const ordered = [...nodes].sort((a, b) => a.floorZ - b.floorZ);
    const roots: TreeNode[] = [];
    for (const node of ordered) {
      const parent = ordered
        .filter((q) => q.floorZ > node.floorZ + tol.levelMergeMm && !q.through)
        .sort((a, b) => a.floorZ - b.floorZ)
        .find((q) => overlaps(q.cs, node.cs));
      if (parent === undefined) {
        roots.push(node);
      } else {
        parent.children.push(node);
        node.mouthZ = parent.floorZ;
      }
    }
    for (const node of nodes) {
      for (const hole of holesOf(tl, node.cs)) {
        // A hole of the silhouette (a through feature) is no island: there is no material in it.
        if (!overlaps(hole, silhouette)) {
          hole.delete();
          continue;
        }
        let islandTop = node.floorZ;
        for (const f of floors) if (f.patch.zMax > islandTop && overlaps(f.cs, hole)) islandTop = f.patch.zMax;
        for (let i = 0; i < remainder.length; i++) {
          if (remainder[i]!.zTop > islandTop && overlaps(remainderCs[i]!, hole)) islandTop = remainder[i]!.zTop;
        }
        node.islands.push({ outline: toPolygons(hole), topZ: Math.min(islandTop, topZ) });
        hole.delete();
      }
    }
    for (let i = 0; i < remainder.length; i++) {
      const r = remainder[i]!;
      // The region sits in the deepest node at or above its top that it overlaps; deeper nodes it
      // overlaps are where it continues below their floor (N2).
      const touching = nodes.filter((n) => !n.through && overlaps(n.cs, remainderCs[i]!));
      const home = touching.filter((n) => n.floorZ >= r.zTop - tol.levelMergeMm).sort((a, b) => a.floorZ - b.floorZ)[0];
      if (home !== undefined) r.in = home.id;
      for (const n of touching) if (n.floorZ > r.zBottom + tol.levelMergeMm) n.remainder.push(r.id);
    }

    // ── Undercuts ─────────────────────────────────────────────────────────────────────────
    const unreachable: BuiltTree['unreachable'] = [];
    for (const patch of patches) {
      if (patch.kind !== 'undercut') continue;
      const cs = projectTriangles(tl, mesh, patch.triangles);
      unreachable.push({ footprint: toPolygons(cs), zRange: [patch.zMin, patch.zMax], reason: 'undercut' });
      cs.delete();
    }

    // ── The contour ───────────────────────────────────────────────────────────────────────
    const outers = filledOuters(tl, silhouette);
    garbage.push(...outers);
    const outline = tl.CrossSection.union(outers);
    garbage.push(outline);

    // ── Rims: the contour's when on the outline's boundary, else the node whose mouth is at the
    // rim's height and whose region the rim borders ────────────────────────────────────────
    const probe = (x: number, y: number): CrossSection =>
      tl.CrossSection.square([0.1, 0.1], true).translate([x, y]);
    const rims: TreeRim[] = [];
    rawRims.forEach((raw, i) => {
      const mid = raw.polyline[Math.floor(raw.polyline.length / 2)]!;
      const a = raw.polyline[Math.max(0, Math.floor(raw.polyline.length / 2) - 1)]!;
      const m: [number, number] = raw.polyline.length > 1 ? [(a[0] + mid[0]) / 2, (a[1] + mid[1]) / 2] : mid;
      const sq = probe(m[0], m[1]);
      const inOutline = sq.intersect(outline);
      const onOutline = inOutline.area() < sq.area() - AREA_EPS;
      inOutline.delete();
      let of = 'contour';
      if (!onOutline) {
        const byMouth = nodes.filter((n) => Math.abs(n.mouthZ - raw.z) <= tol.levelMergeMm && overlaps(n.cs, sq));
        const any = byMouth.length > 0 ? byMouth : nodes.filter((n) => overlaps(n.cs, sq));
        of = any.sort((x, y) => y.floorZ - x.floorZ)[0]?.id ?? 'top';
      }
      sq.delete();
      rims.push({ ...raw, id: `rim-${i}`, of });
    });

    const strip = (n: TreeNode & { cs: CrossSection }): TreeNode => {
      const { cs: _cs, children, ...rest } = n;
      return { ...rest, children: children.map((c) => strip(c as TreeNode & { cs: CrossSection })) };
    };
    return {
      partTop,
      partBottom,
      levels,
      top,
      contour: { outline: toPolygons(outline), area: outline.area(), zTo: partBottom },
      pockets: roots.map((r) => strip(r as TreeNode & { cs: CrossSection })),
      remainder,
      unreachable,
      slivers,
      rims,
      notes,
    };
  } finally {
    for (const g of garbage) {
      try {
        g.delete();
      } catch {
        // already freed (decompose parts share nothing with their parent; a double delete is harmless to skip)
      }
    }
  }
}
