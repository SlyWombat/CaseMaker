/**
 * cam/model/ceilingAbove.ts — #970, the maintainer's 2026-11-05 ruling (via the manager, on the
 * elephant gouge a distance-based fix let through): a genuine ceiling is identified by GEOMETRY —
 * never by distance to an edge or to this node's own wall.
 *
 * A plain floor, and the floor-to-wall fillet that rounds into it, are ENTIRELY upward- or
 * sideways-facing — a fillet's own arc always sweeps from horizontal, at the wall, to vertical-up,
 * at the floor, never down. A genuine overhang, by contrast, always has a DOWNWARD-facing
 * underside SOMEWHERE in its own column — material that hangs over the void below it. That one
 * fact is the gate: a column with no downward-facing face anywhere is just this node's own floor
 * and wall, open all the way down, full stop, however high an upward-facing hit (the floor's own
 * top, say) happens to read.
 *
 * Once a real overhang is confirmed present, the actual blocking height is the HIGHEST hit of
 * EITHER facing in the column, not the downward one alone: a 3-axis tool travelling straight down
 * is a rigid body, stopped by the FIRST thing it meets and never resuming past it, so an overhang
 * with real thickness (a slab's own top surface sitting above its own underside, in the same
 * column) blocks everything below its own outermost face, not just below the underside — the
 * genuinely open void it hangs over is real, but still unreachable from directly above while solid
 * sits in the way, exactly as the elephant's own back, sitting higher than its belly, is what
 * actually blocks the leg-gap beneath the belly, not the belly's underside alone (E's elephant
 * run: 3.91 % adjudicated cut-into, 13 mm max, in the flank bands near the open outline, where
 * `ops/pocket.ts`'s earlier erosion/ring fix went blind).
 *
 * Z-INDEPENDENT, exactly like `dropcutter.ts`'s own CL surface and `ops/pocket.ts`'s previous
 * ceiling grid: once the gate is decided, the one blocking height is sampled once per column and
 * reused at every depth pass.
 */

import type { DropCutterMesh } from './dropcutter';
import { binnedReachableTriangles, triangleBinsFor } from './triangleBins';

const EPS = 1e-9;

/**
 * A face counts as a real ceiling only when its own outward normal's Z component, as a fraction
 * of the normal's own length, is at least this far negative — a cosine threshold, not a distance
 * one. `-0.05` is about 87° off horizontal: a drafted wall's own small negative-Z component (most
 * production drafts are a few degrees off vertical) stays well short of it, while a genuine
 * overhang's underside — even a shallow one — reads far more negative than this.
 */
const DOWNWARD_COS_THRESHOLD = -0.05;

interface Tri {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  cx: number; cy: number; cz: number;
  minX: number; maxX: number; minY: number; maxY: number;
}

function triangleOf(mesh: DropCutterMesh, t: number): Tri {
  const i0 = mesh.indices[t * 3]! * 3;
  const i1 = mesh.indices[t * 3 + 1]! * 3;
  const i2 = mesh.indices[t * 3 + 2]! * 3;
  const p = mesh.positions;
  const ax = p[i0]!, ay = p[i0 + 1]!, az = p[i0 + 2]!;
  const bx = p[i1]!, by = p[i1 + 1]!, bz = p[i1 + 2]!;
  const cx = p[i2]!, cy = p[i2 + 1]!, cz = p[i2 + 2]!;
  return {
    ax, ay, az, bx, by, bz, cx, cy, cz,
    minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx),
    minY: Math.min(ay, by, cy), maxY: Math.max(ay, by, cy),
  };
}

/** Exact point-in-triangle, XY only — the same three-cross-product test `dropcutter.ts`'s own
 * (private) `insideTriangleXY` uses. */
function insideTriangleXY(tri: Tri, px: number, py: number): boolean {
  const cross = (ox: number, oy: number, ax: number, ay: number, bx: number, by: number): number =>
    (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
  const d1 = cross(tri.ax, tri.ay, tri.bx, tri.by, px, py);
  const d2 = cross(tri.bx, tri.by, tri.cx, tri.cy, px, py);
  const d3 = cross(tri.cx, tri.cy, tri.ax, tri.ay, px, py);
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}


/**
 * TWO-PHASE, both over every non-near-vertical triangle the vertical line through `(x, y)`
 * crosses:
 *
 *  1. Does a genuinely DOWNWARD-facing one exist anywhere in the column at all? This is the
 *     gate: a plain floor, or a floor-to-wall fillet curving up out of it, is ENTIRELY
 *     upward-facing (a fillet that rounds a pocket's own corner always sweeps from horizontal,
 *     at the wall, to vertical-UP, at the floor — never down) — with nothing downward-facing
 *     anywhere, the gate stays shut and this column is open all the way, full stop, no matter
 *     how high an upward-facing hit (the floor's own top, say) reads.
 *  2. Only once the gate is open — a REAL overhang genuinely exists somewhere here — does the
 *     actual blocking height matter, and it is the HIGHEST hit of EITHER facing, not just the
 *     downward one. A 3-axis tool is a rigid body travelling straight down: it is stopped by the
 *     FIRST (topmost) thing it meets, overhang or not, and never resumes past it — so an
 *     overhang with real thickness (the table slab's own top AND underside both sit in the same
 *     column) blocks everything below its own OUTERMOST surface, not just below its underside;
 *     the genuinely open void it hangs over is real, but still unreachable from directly above
 *     while solid sits in the way, exactly like the elephant's belly blocks the leg-gap beneath
 *     it by way of the body's own back sitting higher still, not the belly's underside alone.
 *
 * Z-INDEPENDENT either way: once the gate is decided, the one blocking height is reused at every
 * depth pass, exactly like `dropcutter.ts`'s own CL surface.
 *
 * `minZMm` bounds the scan from below (inclusive, a small epsilon of slack): anything at or below
 * this Z is this node's own floor or deeper, and must never feed either phase above — otherwise
 * the stock's OWN underside (its bottom face is, by construction, downward-facing: material fills
 * above it, nothing below) or an unrelated feature on the opposite side of the part would trip the
 * gate for every column over it, for a reason that has nothing to do with this node at all. The
 * caller passes the node's own floor, in the mesh's absolute Z — never left unbounded, a plain
 * `-Infinity` default would silently reintroduce exactly that leak.
 */
export function ceilingAboveMm(mesh: DropCutterMesh, x: number, y: number, minZMm: number): number | null {
  const bins = triangleBinsFor(mesh);
  const candidates = binnedReachableTriangles(bins, x, y, 0);
  const floor = minZMm - EPS;
  let topmostAny: number | null = null;
  for (const t of candidates) {
    const tri = triangleOf(mesh, t);
    if (x < tri.minX || x > tri.maxX || y < tri.minY || y > tri.maxY) continue;
    const ux = tri.bx - tri.ax, uy = tri.by - tri.ay, uz = tri.bz - tri.az;
    const vx = tri.cx - tri.ax, vy = tri.cy - tri.ay, vz = tri.cz - tri.az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen < EPS) continue; // a degenerate (zero-area) triangle states no face at all
    const cosFromHorizon = nz / nlen;
    if (Math.abs(cosFromHorizon) < -DOWNWARD_COS_THRESHOLD) continue; // near-vertical: a wall, drafted or not — never a ceiling, never the gate
    if (!insideTriangleXY(tri, x, y)) continue;
    const z = tri.az - (nx * (x - tri.ax) + ny * (y - tri.ay)) / nz;
    if (z < floor) continue; // at or below this node's own floor: never this node's concern, see `minZMm`'s own doc above
    if (topmostAny === null || z > topmostAny) topmostAny = z;
  }
  // #1003 (6b's rule, the manager's ruling) — NO TWO-PHASE GATE: the blocking height is the
  // topmost non-vertical surface above the floor. The gate opened a dome's central columns (dome
  // top → solid → floor, no downward face) and a pocket's floor pass took the dome away. The
  // edge-shrinking the gate used to hide is fixed where it belongs: `ceilingMaskAt` now counts
  // only triangles that overlap the node's own region.
  return topmostAny;
}
