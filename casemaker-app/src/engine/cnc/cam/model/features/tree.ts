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

import { weldVertices, type FrameMesh, type Patch, type FeatureTolerances } from './patches';
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

/** Twice a triangle's area (the cross product's length), mm². */
function doubleArea(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = p[3 * b]! - p[3 * a]!;
  const uy = p[3 * b + 1]! - p[3 * a + 1]!;
  const uz = p[3 * b + 2]! - p[3 * a + 2]!;
  const vx = p[3 * c]! - p[3 * a]!;
  const vy = p[3 * c + 1]! - p[3 * a + 1]!;
  const vz = p[3 * c + 2]! - p[3 * a + 2]!;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** Append one boundary loop's cap, triangulated in its dominant-axis projection. */
function capLoop(
  tl: ManifoldToplevel,
  p: Float32Array,
  loop: readonly number[],
  next: ReadonlyMap<number, number>,
  out: number[],
): void {
  // Newell normal: the loop's plane, used here only to pick the 2D projection.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]! * 3;
    const b = loop[(i + 1) % loop.length]! * 3;
    nx += (p[a + 1]! - p[b + 1]!) * (p[a + 2]! + p[b + 2]!);
    ny += (p[a + 2]! - p[b + 2]!) * (p[a]! + p[b]!);
    nz += (p[a]! - p[b]!) * (p[a + 1]! + p[b + 1]!);
  }
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  const project: (v: number) => [number, number] =
    ax >= ay && ax >= az
      ? (v) => [p[3 * v + 1]!, p[3 * v + 2]!]
      : ay >= az
        ? (v) => [p[3 * v + 2]!, p[3 * v]!]
        : (v) => [p[3 * v]!, p[3 * v + 1]!];
  const ring = loop.map(project);
  let winding = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    winding += x0 * y1 - x1 * y0;
  }
  // `triangulate` wants its polygon CCW; remember the reversal so its indices map back.
  const reversed = winding < 0;
  if (reversed) ring.reverse();
  const tris = tl.triangulate([ring]);
  const at = (i: number): number => (reversed ? loop[loop.length - 1 - i]! : loop[i]!);
  const cap = tris.map(([i, j, k]) => [at(i!), at(j!), at(k!)] as [number, number, number]);
  // The cap must traverse every boundary edge opposite the mesh's own edge, or the weld leaves
  // the surface inside-out on that seam.
  let same = 0;
  let opposite = 0;
  for (const [a, b, c] of cap) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as [number, number][]) {
      if (next.get(u) === v) same++;
      else if (next.get(v) === u) opposite++;
    }
  }
  for (const [a, b, c] of cap) {
    if (same > opposite) out.push(a, c, b);
    else out.push(a, b, c);
  }
}

/**
 * Close a triangle soup into the watertight solid the sections need (#966 blocker c). Goal meshes
 * are surfaces, not solids — j27's mouse shell is open at its bottom — so `new Manifold` refuses
 * them outright. Weld float32-duplicate vertices, drop zero-area triangles, and cap every boundary
 * loop; the cap is triangulated in the loop's dominant-axis projection.
 *
 * shortcut: a non-planar or self-intersecting boundary loop is still capped by that projection,
 * not by a 3D triangulation — upgrade when a goal mesh actually has one.
 */
function closeMesh(tl: ManifoldToplevel, mesh: FrameMesh, weldMm: number): { positions: Float32Array; indices: Uint32Array } {
  const { weld, canon } = weldVertices(mesh, weldMm);
  const p = mesh.positions;
  const W = canon.length;
  const positions = new Float32Array(W * 3);
  for (let v = 0; v < W; v++) {
    const o = canon[v]! * 3;
    positions[3 * v] = p[o]!;
    positions[3 * v + 1] = p[o + 1]!;
    positions[3 * v + 2] = p[o + 2]!;
  }
  const src = mesh.indices;
  const tris: number[] = [];
  const directed = new Map<number, number>();
  const count = (key: number): void => {
    directed.set(key, (directed.get(key) ?? 0) + 1);
  };
  for (let t = 0; t + 2 < src.length; t += 3) {
    const a = weld[src[t]!]!;
    const b = weld[src[t + 1]!]!;
    const c = weld[src[t + 2]!]!;
    if (a === b || b === c || c === a) continue;
    if (doubleArea(positions, a, b, c) <= 1e-12) continue;
    tris.push(a, b, c);
    count(a * W + b);
    count(b * W + c);
    count(c * W + a);
  }
  // A boundary edge is directed once and has no reverse; anything else is non-manifold and left
  // for Manifold to report, as before.
  const next = new Map<number, number>();
  for (const [key, uses] of directed) {
    if (uses !== 1) continue;
    const a = Math.floor(key / W);
    const b = key % W;
    if (!directed.has(b * W + a)) next.set(a, b);
  }
  const seen = new Set<number>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v = start;
    let closed = false;
    while (!seen.has(v)) {
      seen.add(v);
      loop.push(v);
      const w = next.get(v);
      if (w === undefined) break;
      if (w === start) {
        closed = true;
        break;
      }
      v = w;
    }
    if (closed && loop.length >= 3) capLoop(tl, positions, loop, next, tris);
  }
  return { positions, indices: Uint32Array.from(tris) };
}

/** Build the solid the sections are taken from; `closeMesh` is what makes an open goal mesh solid. */
export function solidOf(tl: ManifoldToplevel, mesh: FrameMesh, weldMm: number): Manifold {
  const closed = closeMesh(tl, mesh, weldMm);
  const mm = new tl.Mesh({ numProp: 3, vertProperties: closed.positions, triVerts: closed.indices });
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

  const solid = solidOf(tl, mesh, tol.weldMm);
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

    const topZ = levels.length > 0 && Math.abs(levels[0]! - partTop) <= tol.levelMergeMm ? levels[0]! : partTop;

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

    // ── The top land ──────────────────────────────────────────────────────────────────────
    // The floors at the top level, LESS the island tops: a top-level floor part inside a CLOSED
    // pocket's outline is that pocket's island (recorded there with `topZ` at the top), not land
    // (#958 E's second run: the tray's two island tops at −1.20).
    const topFloors = floors.filter((f) => Math.abs(levelOf((f.patch.zMin + f.patch.zMax) / 2) - topZ) <= tol.levelMergeMm);
    const topUnion = tl.CrossSection.union(topFloors.map((f) => f.cs));
    garbage.push(topUnion);
    const topParts = topUnion.decompose();
    garbage.push(...topParts);
    // Closed pockets only: an open shoulder's outline can surround the real top plateau.
    const nodeOuters = nodes.filter((n) => !n.open && !n.through).flatMap((n) => filledOuters(tl, n.cs));
    garbage.push(...nodeOuters);
    const landParts = topParts.filter((part) => {
      if (part.area() <= AREA_EPS) return false;
      return !nodeOuters.some((outer) => {
        const inside = part.intersect(outer);
        const share = inside.area() / part.area();
        inside.delete();
        return share > 0.5;
      });
    });
    const top = {
      z: topZ,
      floors: landParts.map((part) => ({ polygons: toPolygons(part), area: part.area() })),
      area: landParts.reduce((sum, part) => sum + part.area(), 0),
    };

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
