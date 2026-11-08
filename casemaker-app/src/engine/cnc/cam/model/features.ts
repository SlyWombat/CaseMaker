/**
 * cam/model/features.ts — feature recognition (#958, A), §1 of `docs/design/cam-model-engine.md`.
 *
 * Method (A's #958 note, as adopted, with D1/D2 from 6620460283):
 *   patches (features/patches.ts) → floor levels → sections at each level → the tree by booleans
 *   on those sections (features/tree.ts).
 *
 * Shapes are A's #958 §4 as adopted in the skeleton, plus these additions (each named on #958):
 *   - `Rim.id`, `regionRefs(tree)` (N1, 6620070868)
 *   - `PocketNode.through`, `report.slivers` (D2, 6620460283)
 *   - `PocketNode.floors`: the floor parts inside a node. One node's region can hold several
 *     separate floors (the tray's channel floors at 3.00 connect through the slots), so the
 *     acceptance compares floors, not nodes.
 *   - `FeatureTree.top`: the top land.
 *   - `RemainderRegion.area`, `.slopeMedianDeg`
 *   - `SetupFrame.stockBottom?`: needed to say whether the contour frees the part.
 *   - `FeatureTolerances`: the skeleton's placeholder replaced by the method's own numbers.
 *   - The kernel (Manifold) is a parameter: this module never loads wasm.
 * `PocketNode.narrowest` is the largest cutter diameter that can enter the region (twice the
 * region's largest inscribed radius), which is what "the largest flat that fits" (#961) reads.
 */

import type { ParsedMesh } from '@/engine/import/stlParser';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import type { RegionRef } from './plan';

import {
  DEFAULT_FEATURE_TOLERANCES,
  classifyPatches,
  patchesFromFaces,
  patchesFromMesh,
  remainderSurfaces,
  triangleAdjacency,
  type FeatureTolerances,
  type FrameMesh,
} from './features/patches';
import { findRims } from './features/rims';
import { buildTree, type TreeFloor, type TreeSliver } from './features/tree';

export { DEFAULT_FEATURE_TOLERANCES, type FeatureTolerances };

export interface FeatureSource {
  triangles: ParsedMesh;
  /** Per-triangle B-rep face id — STEP only. `faceId[i]` is the face triangle `i` came from. */
  faceId?: Uint32Array;
  /**
   * #987 — WHOSE EDGE THE OUTLINE IS. Absent/`'design'` (every existing caller): a real design
   * edge, as `closeOpenSheet`'s `'none'` (already closed) or a STEP/closed-mesh import reports it.
   * `'synthetic'`: the solid was closed by `closeOpenSheet`'s skirt — the outline is the kernel's
   * own requirement for a solid, not an edge the design drew, so no contour op is demanded against
   * it (`recogniseFeatures` carries this onto `tree.contour.synthetic`).
   */
  outline?: 'design' | 'synthetic';
}

export interface SetupFrame {
  up: [number, number, number];
  stockTop: number;
  /** The stock's bottom in the setup frame, mm. Without it `contour.frees` is assumed true. */
  stockBottom?: number;
  /**
   * #1073 — WHICH HALF TURN PUT THIS FACE UP. `up = [0, 0, -1]` does not say: a VISE's bottom
   * flip is a half turn about X (`RX180`, y and z negate) while a BRACKET/TAPE one is a half turn
   * about Y (`RY180`, x and z negate) — both leave `up` at −Z and map XY differently. Absent means
   * `'x'`, the vise turn every frame written before #1073 meant, so no existing frame changes.
   * Only meaningful on a flipped frame; a top frame is the identity and ignores it.
   */
  flipAxis?: 'x' | 'y';
}

export interface PocketNode {
  id: string;
  floorZ: number;
  mouthZ: number;
  open: boolean;
  /**
   * A hole of the part's silhouette: no material at any height (A's #958 D2, 6620460283, e.g. the
   * organizer's eleven through-holes at −22.80). `floorZ` is the part bottom; the contour op frees
   * it, not the pocket op's own floor pass.
   */
  through: boolean;
  /** Cleared area at `floorZ`, islands as holes. May extend below `floorZ` where remainder continues (A's N2) — the pocket op must not assume the whole region is floor. */
  region: Polygons;
  /** The floor patches inside this node at `floorZ`, as separate parts. Empty for a through node. */
  floors: TreeFloor[];
  islands: { outline: Polygons; topZ: number }[];
  children: PocketNode[];
  /** `RemainderRegion.id`s that continue below this node, per A's N2. */
  remainder: string[];
  /** The largest cutter diameter that can enter the region, mm. */
  narrowest: number;
}

export interface RemainderRegion {
  id: string;
  footprint: Polygons;
  area: number;
  zTop: number;
  zBottom: number;
  triangles: Uint32Array;
  slopeDeg: [number, number];
  slopeMedianDeg: number;
  in: string | 'top';
}

export interface Rim {
  /** A's N1 amendment — `PlannedOp.region` (a `RegionRef`) needs an id to point at. */
  id: string;
  polyline: [number, number][];
  z: number;
  of: string | 'contour';
  kind: 'sharp' | 'modelledChamfer';
  legs?: [number, number];
}

export interface FeatureTree {
  frame: SetupFrame & { partTop: number; partBottom: number };
  /** Floor Z levels, descending. */
  levels: number[];
  top: { z: number; floors: TreeFloor[]; area: number };
  /** `synthetic` is absent/`false` for every existing (real design edge) tree — only
   * `recogniseFeatures` itself sets it `true`, and only when `src.outline === 'synthetic'`. */
  contour: { outline: Polygons; area: number; zTo: number; frees: boolean; shoulders: string[]; synthetic?: boolean };
  pockets: PocketNode[];
  rims: Rim[];
  remainder: RemainderRegion[];
  unreachable: { footprint: Polygons; zRange: [number, number]; reason: 'undercut' }[];
  report: {
    source: 'step' | 'mesh';
    patches: number;
    planarArea: number;
    remainderArea: number;
    tolerances: FeatureTolerances;
    /**
     * A's #958 D2 (comment 6620460283): a would-be floor patch whose largest inscribed circle is
     * under 0.25 mm diameter is listed here, never silently dropped — its area joins the
     * neighbouring region instead of becoming its own `PocketNode`.
     */
    slivers: TreeSliver[];
    notes: string[];
  };
}

/**
 * Rotate the source into the setup frame: `up` becomes +Z (Rodrigues). Triangle order is kept.
 * `flipAxis` (#1073) picks WHICH half turn does it when `up` is −Z — about X (the vise, the
 * default and every pre-#1073 caller) or about Y (a bracket/tape flip); see `SetupFrame.flipAxis`.
 */
export function toSetupFrame(mesh: ParsedMesh, up: readonly [number, number, number], flipAxis: 'x' | 'y' = 'x'): FrameMesh {
  const len = Math.hypot(up[0], up[1], up[2]);
  if (!(len > 0)) throw new Error('cam/model/features: the setup frame has a zero up vector');
  const u = [up[0] / len, up[1] / len, up[2] / len] as const;
  const positions = Float64Array.from(mesh.positions);
  // Axis k = u × ẑ, angle θ with cos θ = u·ẑ.
  const kx = u[1];
  const ky = -u[0];
  const s = Math.hypot(kx, ky);
  const c = u[2];
  if (s > 1e-12) {
    const ax = kx / s;
    const ay = ky / s;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i]!;
      const y = positions[i + 1]!;
      const z = positions[i + 2]!;
      // v' = v cosθ + (k × v) sinθ + k (k·v)(1 − cosθ), with k = (ax, ay, 0).
      const kdotv = ax * x + ay * y;
      positions[i] = x * c + ay * z * s + ax * kdotv * (1 - c);
      positions[i + 1] = y * c - ax * z * s + ay * kdotv * (1 - c);
      positions[i + 2] = z * c + (ax * y - ay * x) * s;
    }
  } else if (c < 0) {
    // Up is −Z: a half turn — about X by default (RX180: y and z negate), about Y for a
    // bracket/tape flip (RY180: x and z negate). #1073: up alone cannot tell the two apart.
    for (let i = 0; i < positions.length; i += 3) {
      if (flipAxis === 'y') {
        positions[i] = -positions[i]!;
        positions[i + 2] = -positions[i + 2]!;
      } else {
        positions[i + 1] = -positions[i + 1]!;
        positions[i + 2] = -positions[i + 2]!;
      }
    }
  }
  return { positions, indices: mesh.indices };
}

/**
 * Patches → levels → sections → booleans (#958). `kernel` is the Manifold toplevel; the caller owns
 * loading it.
 */
export function recogniseFeatures(
  src: FeatureSource,
  frame: SetupFrame,
  kernel: ManifoldToplevel,
  tolIn?: Partial<FeatureTolerances>,
): FeatureTree {
  const tol: FeatureTolerances = { ...DEFAULT_FEATURE_TOLERANCES, ...tolIn };
  const mesh = toSetupFrame(src.triangles, frame.up, frame.flipAxis);
  const triCount = mesh.indices.length / 3;
  if (src.faceId !== undefined && src.faceId.length !== triCount) {
    throw new Error(`cam/model/features: faceId has ${src.faceId.length} entries for ${triCount} triangles`);
  }
  const path = src.faceId !== undefined ? 'step' : 'mesh';
  const patches = path === 'step' ? patchesFromFaces(mesh, src.faceId!, tol) : patchesFromMesh(mesh, tol);

  let partBottom = Infinity;
  for (let i = 2; i < mesh.positions.length; i += 3) partBottom = Math.min(partBottom, mesh.positions[i]!);
  // #965 — `path` routes the mesh path's per-triangle split; the STEP B-rep path keeps the
  // whole-face rule (one face = one surface).
  classifyPatches(mesh, patches, partBottom, tol, path);
  const adj = triangleAdjacency(mesh, tol.weldMm);
  const { surfaces, demoted } = remainderSurfaces(mesh, patches, adj, tol, path);

  const rawRims = findRims(mesh, patches, adj, tol.levelMergeMm);
  const built = buildTree(kernel, mesh, patches, surfaces, tol, rawRims);
  // #1003 — THE STOCK BOTTOM CLIPS THE TREE ITSELF. Every op takes its depth from the tree's own
  // nodes and regions (a pocket steps `mouthZ → floorZ`, a rough/finish step a region's
  // `zTop → zBottom`), so clipping HERE bounds every op kind at once: a 34 mm figure on a 20 mm
  // blank pockets, roughs and finishes no lower than the blank's bottom. Clipping inside any one
  // op (the contour, a pocket feature's stated depth) leaves the others free to cut through the
  // vise, which is exactly how the fitting case failed with 19,505 moves below the stock.
  if (frame.stockBottom !== undefined) {
    const floorZ = frame.stockBottom;
    const clipNodes = (nodes: PocketNode[]): void => {
      for (const node of nodes) {
        if (node.floorZ < floorZ) node.floorZ = floorZ;
        clipNodes(node.children);
      }
    };
    clipNodes(built.pockets);
    // The CONTOUR is deliberately NOT clipped here: it has its own floor at plan time, which also
    // carries the board's breakthrough (#1003's allowance) — clipping it here would take that away
    // and lose the pre-clip depth the statement reports.
    for (const region of built.remainder) if (region.zBottom < floorZ) region.zBottom = floorZ;
  }
  const notes = [...built.notes];
  if (demoted.length > 0) notes.push(`${demoted.length} near-flat tangent cap(s) merged into the curved remainder (D2)`);
  if (built.slivers.length > 0) notes.push(`${built.slivers.length} floor sliver(s) under ${tol.minFloorWidthMm} mm wide listed, not cut as pockets (D2)`);

  const shoulders: string[] = [];
  const walk = (nodes: PocketNode[]): void => {
    for (const n of nodes) {
      if (n.open) shoulders.push(n.id);
      walk(n.children);
    }
  };
  walk(built.pockets);

  let planarArea = 0;
  for (const patch of patches) if (patch.planar) planarArea += patch.area;
  const frees = frame.stockBottom === undefined ? true : Math.abs(built.partBottom - frame.stockBottom) <= tol.levelMergeMm;
  // #987 — a skirt-closed relief's outline is the kernel's own requirement for a solid, not a
  // design edge; `frees` (whether the contour reaches the stock bottom) is a different question
  // from whether a contour exists at all, so this reads `src.outline`, not `frees`.
  const synthetic = src.outline === 'synthetic';

  return {
    frame: { ...frame, partTop: built.partTop, partBottom: built.partBottom },
    levels: built.levels,
    top: built.top,
    contour: { ...built.contour, frees, shoulders, synthetic },
    pockets: built.pockets,
    rims: built.rims.map((r) => ({ id: r.id, polyline: r.polyline, z: r.z, of: r.of, kind: r.kind, ...(r.legs ? { legs: r.legs } : {}) })),
    remainder: built.remainder,
    unreachable: built.unreachable,
    report: {
      source: path,
      patches: patches.length,
      planarArea,
      remainderArea: built.remainder.reduce((s, r) => s + r.area, 0),
      tolerances: tol,
      slivers: built.slivers,
      notes,
    },
  };
}

const boundsOf = (polys: Polygons): { min: [number, number]; max: [number, number] } => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of polys) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { min: [minX, minY], max: [maxX, maxY] };
};

/**
 * `RegionRef`s derived from a `FeatureTree` — A's N1: so #961/#962 read bounds/`topZ`/`bottomZ` from
 * the tree instead of re-deriving them. `obstacles` and `regionClearanceZ` are filled in by
 * `plan.ts` from the resolved fixture envelope, not by this function, which has no fixture data.
 */
export function regionRefs(tree: FeatureTree): Omit<RegionRef, 'obstacles' | 'regionClearanceZ'>[] {
  const out: Omit<RegionRef, 'obstacles' | 'regionClearanceZ'>[] = [];
  const walk = (nodes: PocketNode[]): void => {
    for (const n of nodes) {
      out.push({ id: n.id, kind: 'pocket', bounds: boundsOf(n.region), topZ: n.mouthZ, bottomZ: n.floorZ });
      walk(n.children);
    }
  };
  walk(tree.pockets);
  for (const r of tree.remainder) out.push({ id: r.id, kind: 'curved', bounds: boundsOf(r.footprint), topZ: r.zTop, bottomZ: r.zBottom });
  out.push({ id: 'contour', kind: 'contour', bounds: boundsOf(tree.contour.outline), topZ: tree.frame.partTop, bottomZ: tree.contour.zTo });
  for (const rim of tree.rims) {
    out.push({ id: rim.id, kind: 'rim', bounds: boundsOf([rim.polyline]), topZ: rim.z, bottomZ: rim.z - (rim.legs?.[1] ?? 0) });
  }
  return out;
}
