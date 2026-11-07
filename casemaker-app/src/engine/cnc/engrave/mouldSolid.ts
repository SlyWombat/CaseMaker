/**
 * #1005 — A MOULD, AS A SOLID THE MODEL ENGINE CAN CUT.
 *
 * The old heightfield path built a mould by INVERTING the goal's heights (`moldHeightfield`,
 * `engrave/goalHeightfield.ts`): cavity depth below the stock top = the part's height above its
 * own base, rows mirrored in Y so the part is turned over about its X axis, and the uncovered
 * cells left at the stock top as the rim. This module builds the same object as a SOLID, for
 * `planModelCam`'s feature tree: the stock block minus the part (closed by `closeOpenSheet`, #993)
 * turned over by a half turn about X through the footprint's centre line.
 *
 * The half turn is a proper rotation — (y, z) → (2·c − y, 2·d − z) with `c` the part's own centre
 * line in Y and `d` the midpoint between the stock top and the part's base — so triangle winding
 * (and so every normal the tree reads) is preserved. The result is an ordinary solid with a
 * cavity; `planModelCam` plans it exactly as it plans any block with a pocket-class tree.
 *
 * The cavity's steepest wall is measured FROM THE PART'S OWN SURFACE, because the tree cannot
 * report it: a planar wall (the box's vertical sides) is classified as a pocket wall and appears in
 * neither `pockets[].slopeDeg` nor the remainder regions — only curved walls do. The part's surface
 * IS the cavity's wall after the turn, so its steepest facet is the honest number, and it is the
 * same measurement the old path took from the heightfield (`steepestWallDeg`), which sampled the
 * same surface.
 */
import type { ParsedMesh } from '@/engine/import/stlParser';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;

export interface MouldSolidOptions {
  /** The stock's rectangle and thickness, mm — the block the cavity is cut from. */
  stock: { length: number; width: number; thickness: number };
  /** The turn-over line's Y, mm — the placed part's own centre line in the work frame. */
  centreY: number;
  /** The stock's top face in the work frame, mm (the job's own 0 by convention). */
  stockTopZ?: number;
}

export interface MouldSolid {
  /** The block with the cavity — the feature source `planModelCam` plans. */
  mesh: ParsedMesh;
  /**
   * The cavity's steepest wall, degrees from horizontal: the steepest facet of the part's own
   * surface (invariant under the turn). A vertical wall reads 90°.
   */
  steepestWallDeg: number;
  /** The part's own height, mm (top above base) — the deepest the cavity can reach. */
  partHeightMm: number;
}

/** The steepest facet of a mesh, degrees from horizontal — `atan(|n_xy| / |n_z|)`. */
export function steepestFacetDeg(mesh: Pick<ParsedMesh, 'positions' | 'indices'>): number {
  const p = mesh.positions;
  let steepest = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]! * 3;
    const b = mesh.indices[t + 1]! * 3;
    const c = mesh.indices[t + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue; // a degenerate triangle carries no surface
    const deg = (Math.atan2(Math.hypot(nx, ny), Math.abs(nz)) * 180) / Math.PI;
    if (deg > steepest) steepest = deg;
  }
  return steepest;
}

/**
 * The mould solid: the stock block minus the part's closed solid, turned over about X through its
 * own centre line. `part` must be a closed solid in the work frame (the seam hands the
 * `closeOpenSheet` result). The caller owns the Manifold toplevel; this function deletes every
 * instance it creates except the returned mesh's data (a plain `ParsedMesh`).
 */
export function mouldSolidOf(tl: ManifoldToplevel, part: ParsedMesh, opts: MouldSolidOptions): MouldSolid {
  const topZ = opts.stockTopZ ?? 0;
  const { length, width, thickness } = opts.stock;
  if (!(length > 0 && width > 0 && thickness > 0)) {
    throw new Error('cam/model seam (#1005): a mould needs a stock with a length, width and thickness');
  }
  const p = part.positions;
  let minY = Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i + 1]! < minY) minY = p[i + 1]!;
    if (p[i + 2]! < minZ) minZ = p[i + 2]!;
    if (p[i + 2]! > maxZ) maxZ = p[i + 2]!;
  }
  // The half turn about X through (centreY, d): y → 2c − y, z → 2d − z. `c` is the placement's own
  // centre line (the same line `placeTarget` centres the part on); `d` puts the part's base plane
  // at the stock top, so the part's height becomes the cavity's depth.
  const d = (topZ + minZ) / 2;
  // #1029 — one non-finite coordinate traps the kernel on the x86 build; refuse it by name.
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i]!)) {
      throw new Error(`cam: non-finite coordinate in the mould solid at vertex ${Math.floor(i / 3)}`);
    }
  }
  const partMesh = new tl.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(p),
    triVerts: Uint32Array.from(part.indices),
  });
  partMesh.merge();
  const partSolid: ManifoldInstance = new tl.Manifold(partMesh);
  const turned: ManifoldInstance = partSolid
    .translate([0, -opts.centreY, -d])
    .rotate([180, 0, 0])
    .translate([0, opts.centreY, d]);
  partSolid.delete();

  const block: ManifoldInstance = tl.Manifold.cube([length, width, thickness], false).translate([0, 0, topZ - thickness]);
  const mould: ManifoldInstance = block.subtract(turned);
  block.delete();
  turned.delete();

  const m = mould.getMesh();
  mould.delete();
  let minX = Infinity, minB = Infinity, minZ2 = Infinity, maxX = -Infinity, maxB = -Infinity, maxZ2 = -Infinity;
  for (let i = 0; i < m.vertProperties.length; i += 3) {
    const x = m.vertProperties[i]!, y = m.vertProperties[i + 1]!, z = m.vertProperties[i + 2]!;
    if (x < minX) minX = x;
    if (y < minB) minB = y;
    if (z < minZ2) minZ2 = z;
    if (x > maxX) maxX = x;
    if (y > maxB) maxB = y;
    if (z > maxZ2) maxZ2 = z;
  }
  return {
    mesh: {
      positions: Float32Array.from(m.vertProperties),
      indices: Uint32Array.from(m.triVerts),
      triangleCount: m.triVerts.length / 3,
      bbox: { min: [minX, minB, minZ2], max: [maxX, maxB, maxZ2] },
    },
    steepestWallDeg: steepestFacetDeg(part),
    partHeightMm: maxZ - minZ,
  };
}
