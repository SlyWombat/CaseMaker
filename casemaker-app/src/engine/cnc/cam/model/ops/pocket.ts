/**
 * cam/model/ops/pocket.ts — §3.1 of `docs/design/cam-model-engine.md`.
 *
 * Z-level pocketing per recognised `PocketNode` (#958), largest flat that fits — uses the EXISTING
 * `pocketLoops` (`cam/pocket.ts:204`) unchanged for the 2D rings at each level; there is no new
 * pocketing math. What this file adds is the Z-level stepping and the ring→move conversion
 * `pocketLoops` itself does not do (it is deliberately kernel-free and 2D-only, returning rings,
 * not `CamMove[]`).
 *
 * The `offset` function is INJECTED, exactly as `pocketLoops` itself requires (`cam/pocket.ts`'s own
 * header: "Do NOT write polygon offsetting by hand" — the real one is Clipper2's `CrossSection.offset`,
 * built once by the caller; this file's own tests use a trivial fake, the same pattern `pocket.ts`'s
 * own tests use).
 *
 * Linking: EVERY move between one ring/level and the next — same-level ring-to-ring as much as
 * level-to-level — goes through #962's `link()` (A's review 6622610124, finding 1): a plain feed
 * from one ring's exit to the next ring's start is only safe when `pocketLoops`' own "ring i+1
 * lies one step-over inside ring i" holds for a SIMPLE nested region, and it does not for a
 * pocket with an island between the two rings, or a region whose erosion has split into separate
 * lobes — either gouges the island or cuts across the wall between lobes. The `MaterialField` this
 * op builds is a global one, not a per-ring one: `topAt(x, y)` reports the floor Z anywhere inside
 * `freeSpace` (`node.region` eroded by the cutter radius, less a 0.01 mm chord grace — the same
 * free space A's `pocketRedFirst959.spec.ts` checks the moves against) and "never cut" everywhere
 * else, so `link()` feeds through material this op WILL remove and retracts around anything it
 * will not (an island, the wall between lobes, open air outside the node). `link()`'s own
 * `retract()` is also what fixes the diagonal rapid-from-depth this file used to emit on every
 * level change (straight up, across, straight down — never X/Y/Z together below the safe plane).
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { RapidEstimate, ToolpathIR } from '@/engine/cnc/cam/ir';
import { estimateCycleSeconds } from '@/engine/cnc/cam/ir';
import type { BooleanFn } from '@/engine/cnc/cam/engraveJob';
import { pocketLoops, type OffsetFn, type Polygons } from '@/engine/cnc/cam/pocket';
import { FACING_EDGE_CLEARANCE_MM } from '@/engine/cnc/cam/facing';
import { tourNearest } from '@/engine/cnc/cam/tour';
import { pointInPolygons } from '@/engine/cnc/engrave/throughMask';
import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';
import { clearedGroundZ, link, type LinkOptions, type LinkPoint, type MaterialField } from '../linking';
import { cutterKeyOf } from '../sequence';
import type { PocketNode } from '../features';
import type { OpOutcome, PassRef, RegionAtZ, RegionRef } from '../plan';
import type { DropCutterMesh } from '../dropcutter';
import { binnedReachableTriangles, clippedTriangleToSquare, isNearVertical, planeMaxOverPolygon, planeMaxOverSquare, triangleBinsFor } from '../triangleBins';

/**
 * #1003 (6b's rule, the manager's correction) — DOES A TRIANGLE OVERLAP THE POCKET'S REGION WITH
 * POSITIVE AREA? "Any vertex inside" is not enough: a large flat or base-plate triangle can cross
 * the region with all three vertices outside it, which would reopen the gouge. The test is the
 * real overlap — a vertex strictly inside, a region vertex inside the triangle, or a proper edge
 * crossing — with touching the boundary only (the drafted-wall strip sharing the region's edge)
 * counting as OUTSIDE.
 */
const CLIP_EPS = 1e-6;
function cross2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
function segsProperlyCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = cross2(cx, cy, dx, dy, ax, ay);
  const d2 = cross2(cx, cy, dx, dy, bx, by);
  const d3 = cross2(ax, ay, bx, by, cx, cy);
  const d4 = cross2(ax, ay, bx, by, dx, dy);
  return ((d1 > CLIP_EPS && d2 < -CLIP_EPS) || (d1 < -CLIP_EPS && d2 > CLIP_EPS)) &&
    ((d3 > CLIP_EPS && d4 < -CLIP_EPS) || (d3 < -CLIP_EPS && d4 > CLIP_EPS));
}
function pointStrictlyInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = cross2(ax, ay, bx, by, px, py);
  const d2 = cross2(bx, by, cx, cy, px, py);
  const d3 = cross2(cx, cy, ax, ay, px, py);
  const hasNeg = d1 < -CLIP_EPS || d2 < -CLIP_EPS || d3 < -CLIP_EPS;
  const hasPos = d1 > CLIP_EPS || d2 > CLIP_EPS || d3 > CLIP_EPS;
  return !(hasNeg && hasPos);
}
function triangleOverlapsRegion(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, region: Polygons): boolean {
  if (pointInPolygons(region, ax, ay) || pointInPolygons(region, bx, by) || pointInPolygons(region, cx, cy)) return true;
  for (const ring of region) {
    for (let i = 0; i < ring.length; i++) {
      const [px, py] = ring[i]!;
      if (pointStrictlyInTriangle(px, py, ax, ay, bx, by, cx, cy)) return true;
      const [qx, qy] = ring[(i + 1) % ring.length]!;
      if (segsProperlyCross(ax, ay, bx, by, px, py, qx, qy)) return true;
      if (segsProperlyCross(bx, by, cx, cy, px, py, qx, qy)) return true;
      if (segsProperlyCross(cx, cy, ax, ay, px, py, qx, qy)) return true;
    }
  }
  return false;
}
/**
 * #1003 (6b's round-1 discriminator, applied PER CELL) — does the part of a triangle that lies
 * over a mask cell also lie INSIDE the node's region?
 *
 * The per-triangle overlap test above is only a prefilter: a triangle that overlaps the region
 * anywhere is admitted, and the exact plane bound then evaluates it over every cell its bbox
 * touches. On the organizer that closed the whole rim band of six pockets at every level: a big
 * mouth-level LAND triangle's sliver clipped 0.02 mm into each rim cell's square while lying
 * wholly OUTSIDE the pocket's region, and the sliver's plane (−0.8, the mouth) outranked the
 * pocket floor everywhere below. Coverage fell 98.61 % → 96.99 %. The question that settles it is
 * the one the region-clip rule was always asking (`aboveMaterial`'s own doc): is the design that
 * closes this cell over the pocket's own region, or beside it?
 *
 * `polygonOverlapsRegion` answers with POSITIVE AREA against the clipped polygon of one cell —
 * boundary contact (a sliver lying along the region's edge, the drafted-wall strip sharing it)
 * counts as OUTSIDE, the same convention `triangleOverlapsRegion` states above: a polygon vertex
 * strictly inside the region, a region ring vertex strictly inside the polygon, or a proper edge
 * crossing. The height the cell is then judged by stays the exact plane maximum over the whole
 * clipped polygon (never less than the in-region part's), so the test can only REMOVE a triangle
 * that contributes nothing over the pocket; it can never let one under-read the surface.
 */
const BOUNDARY_EPS = 1e-6;

/**
 * Does the triangle strictly cover the XY point? The same epsilon convention as the polygon test:
 * a point ON the triangle's edge is contact, not area, and does not count.
 */
function triangleStrictlyCovers(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  const d1 = cross2(ax, ay, bx, by, px, py);
  const d2 = cross2(bx, by, cx, cy, px, py);
  const d3 = cross2(cx, cy, ax, ay, px, py);
  return (
    (d1 < -BOUNDARY_EPS && d2 < -BOUNDARY_EPS && d3 < -BOUNDARY_EPS) ||
    (d1 > BOUNDARY_EPS && d2 > BOUNDARY_EPS && d3 > BOUNDARY_EPS)
  );
}

/**
 * #1020 (the second half) — A TOUCH IS NOT AN AREA, AGAINST THE REGION BOUNDARY TOO. The point and
 * crossing tests this replaces admitted a facet whose ONLY contact with the pocket was a single
 * vertex 65 nm inside the wall line (Float32 placement rounds 26.5 to 26.499935): the clipped
 * polygon is degenerate, the cell still closed, and the floor ring bowed 0.25 mm — twelve fins of
 * 0.6–2.3 mm on the organizer (149 cells) at the periodic slot-end ramps. The predicate answers
 * with the POSITIVE AREA of (clipped polygon ∩ region) > 1e-4 mm² — a 0.3 mm sliver 3e-4 wide,
 * nothing a cutter can see — never a point test.
 *
 * The area is exact and needs no boolean: each region ring is clipped to the cell polygon
 * (Sutherland–Hodgman against a CONVEX window, which `clippedTriangleToSquare` guarantees) and its
 * shoelace taken. A Clipper round-trip per cell was tried first and aborts inside manifold's wasm
 * on the tray's own region after a few thousand calls, so the hot loop keeps plain arithmetic.
 */
export const REGION_AREA_EPS_MM2 = 1e-4;

/** Signed double area of `ring` clipped to the convex window `poly`, in the RING's own winding. The
 *  subject may be non-convex: the pieces are rejoined along the window boundary, whose edges
 *  retrace, so the shoelace total is still the intersection's area. */
function clippedRingArea2(ring: readonly (readonly [number, number])[], poly: Float64Array): number {
  const n = poly.length / 2;
  if (n < 3 || ring.length < 3) return 0;
  let window2 = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    window2 += poly[2 * i]! * poly[2 * j + 1]! - poly[2 * j]! * poly[2 * i + 1]!;
  }
  if (window2 === 0) return 0;
  const s = window2 > 0 ? 1 : -1;
  let pts: [number, number][] = ring.map(([x, y]) => [x, y]);
  for (let e = 0; e < n && pts.length > 0; e++) {
    const ax = poly[2 * e]!, ay = poly[2 * e + 1]!;
    const bx = poly[2 * ((e + 1) % n)]!, by = poly[2 * ((e + 1) % n) + 1]!;
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const [px, py] = pts[i]!;
      const [qx, qy] = pts[(i + 1) % pts.length]!;
      const dp = s * ((bx - ax) * (py - ay) - (by - ay) * (px - ax));
      const dq = s * ((bx - ax) * (qy - ay) - (by - ay) * (qx - ax));
      if (dp >= 0) out.push([px, py]);
      if ((dp >= 0) !== (dq >= 0) && dp !== dq) {
        const t = dp / (dp - dq);
        out.push([px + (qx - px) * t, py + (qy - py) * t]);
      }
    }
    pts = out;
  }
  let area2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const [px, py] = pts[i]!;
    const [qx, qy] = pts[(i + 1) % pts.length]!;
    area2 += px * qy - qx * py;
  }
  return area2;
}

/** Does the cell's clipped polygon cover POSITIVE area of the node's region? Boundary contact —
 *  a sliver lying along the region's edge — is not area. Rings sum with their own winding sign
 *  (outers CCW, holes CW), the convention `Polygons` carries. */
export function polygonOverlapsRegion(poly: Float64Array, region: Polygons): boolean {
  if (poly.length < 6) return false;
  let area = 0;
  for (const ring of region) area += clippedRingArea2(ring, poly) / 2;
  return Math.abs(area) > REGION_AREA_EPS_MM2;
}
import { maskLoopsFromPredicate } from './rasterMask';

export interface PocketOpOptions {
  cutter: Tool;
  node: PocketNode;
  region: RegionRef;
  /** mm; the rings' own spacing within one level. */
  stepOverMm: number;
  /** mm; the Z distance between depth passes. The last pass is shorter when it does not divide evenly. */
  stepDownMm: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  /** The real Clipper2 offset, or a test fake — `pocketLoops`' own contract, unchanged. */
  offset: OffsetFn;
  safeZMm: number;
  hopZMm: number;
  toolNumber: number;
  spindleRpm: number;
  air: boolean;
  rapid: RapidEstimate;
  /** Where the tool starts, for the first ring's tour — the work origin by default. */
  startFrom?: readonly [number, number];
  /**
   * For an OPEN node only (A's review 6622610124, finding 3): the part's own outer outline
   * (`FeatureTree.contour.outline`) and a boolean pair to extend `node.region` across its open
   * edge before `pocketLoops` ever sees it — otherwise the open boundary is offset inward like a
   * real wall, this cutter's radius never reaches the true edge, and `pocketLoops` can throw on a
   * ledge narrower than the cutter. Absent on a non-open node; absent here on an open one leaves
   * the old (unextended) behaviour, stated by the caller, not silently assumed.
   */
  openOutline?: Polygons;
  /**
   * #1092 — THE REGION IS CUTTER-CENTRE SPACE. A coverage rest's admissible positions (the goal's
   * tip field at or below the pass level, within reach of what the previous cutter left standing)
   * are already centre positions, so the ring trace and the reachability field must NOT inset by
   * the cutter radius again. Absent on every real pocket: unchanged.
   */
  centreSpace?: boolean;
  boolean?: { union: BooleanFn; subtract: BooleanFn };
  /**
   * #966 — the real design mesh, ALREADY ROTATED into this setup's own frame (the SAME one
   * `recogniseFeatures` built `node` from — `plan.ts`'s own `curvedGeometry`/`rotatedGeometryFor`,
   * the same mesh `oppositeSurfaceSafeDepthMm`/`rough()`'s `clSurface` already read for the
   * identical reason: the ground truth for "what is really there," not a second source).
   *
   * `node.region` states "cleared area at `floorZ`" (its own doc on `features.ts`) ONLY — reused
   * UNMODIFIED at every Z level from `mouthZ` down to `floorZ`, it says nothing about a remainder
   * surface (an organic overhang with no floor patch of its own to register a sibling `PocketNode`
   * and correct `mouthZ` down for it) closing back over the SAME XY footprint at a higher Z. This
   * is #966's exact finding: a ⌀6 flat planned straight through ~22 mm of solid body between two
   * of the elephant's legs, because the belly closing the gap above `floorZ` was never checked —
   * `tree.ts`'s own parent-correction of `mouthZ` only ever fires for a SIBLING floor-patch node,
   * never for a curved/organic surface with no floor of its own.
   *
   * With this set, EVERY level this op steps (and the `open`/linking field below) is bounded by
   * the real per-cell surface height: the highest point of any design triangle over that cell's
   * own square, judged only where the triangle lies over the node's own region (`triangleBins`'
   * `clippedTriangleToSquare` + `planeMaxOverPolygon`, #1003 — never a triangle's highest vertex
   * anywhere, never a point sample). A vertical facet states no surface above a column and
   * contributes nothing, so a node's own walls — already handled by the 2D erosion every region
   * boundary gets — are never a false shadow. Never less safe than `node.region` alone, only ever
   * MORE restrictive. Absent → the pre-#966 behaviour, unchanged.
   */
  aboveMaterial?: {
    /**
     * #1018 — `mesh`'s triangles are stock-top-relative too, the SAME datum `node.floorZ`/
     * `mouthZ` already arrive in: every real caller (`plan.ts`'s own setup loop) shifts the
     * mesh at the door, before this op or anything else ever reads it, so no per-site offset
     * converts between two datums here any more.
     */
    mesh: DropCutterMesh;
    marginMm?: number;
  };
}

/** The Z passes from the node's mouth down to its floor, each `stepDownMm` apart (the last one shorter, never longer). */
function depthPasses(mouthZ: number, floorZ: number, stepDownMm: number): number[] {
  const total = mouthZ - floorZ;
  if (!(total > 0)) return [floorZ];
  const count = Math.ceil(total / stepDownMm);
  const levels: number[] = [];
  for (let i = 1; i <= count; i++) {
    levels.push(i === count ? floorZ : mouthZ - i * stepDownMm);
  }
  return levels;
}

/** One closed ring's own cutting moves, NOT including how the tool arrives at its start — the caller (`pocket`) decides that: a plunge for the first ring of a level, a plain feed from the previous ring's exit otherwise. */
function traceRing(ring: readonly [number, number][], z: number, feedMmPerMin: number): ToolpathIR['operations'][number]['moves'] {
  const start = ring[0]!;
  const moves: ToolpathIR['operations'][number]['moves'] = [];
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i]!;
    moves.push({ kind: 'feed', x: p[0], y: p[1], z, f: feedMmPerMin });
  }
  // Close the ring back to its own start.
  moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: feedMmPerMin });
  return moves;
}

/**
 * Rings in a deterministic, short-travel order (#487's tour) — WITHIN one offset step only. Tour
 * ordering ACROSS steps would interleave inner and outer rings and turn some of them into
 * full-width slots (ring i+1 is only safe to feed into directly when it is truly one step-over
 * inside ring i, which only holds within a single `pocketLoops` offset step).
 *
 * `from` is wherever the tool actually is before this step starts (the manager's own follow-up
 * to the per-ring rotation above) — `tourNearest`'s own default of `[0, 0]` ignored it, so a
 * multi-lobe step (several disconnected rings at the same offset, common on the organizer) could
 * visit its FARTHEST ring first and its nearest one last, however good the per-ring entry seam
 * then is.
 */
function orderedRings(loops: readonly [number, number][][], from: readonly [number, number]): [number, number][][] {
  if (loops.length <= 1) return loops as [number, number][][];
  const points = loops.map((r) => r[0]! as readonly [number, number]);
  return tourNearest(points, from).map((i) => loops[i]!);
}

/** Index of `ring`'s vertex nearest `target`; ties to the lower index — same rule `tour.ts`
 * itself uses, so the same input always rotates the same way. */
function nearestVertexIndex(ring: readonly [number, number][], target: readonly [number, number]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = ring[i]!;
    const distance = (x - target[0]) ** 2 + (y - target[1]) ** 2;
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * `ring`, rotated so its own vertex nearest `target` is first — same points, same winding, just a
 * different seam. The manager's own named lever toward Makera's 5.9 rapids/1,000: `ring[0]` used
 * to be whichever vertex Clipper happened to emit first, so a same-level or level-change link into
 * this ring often had most of its own perimeter to cross before `link()` even got a choice between
 * a short hop and a retract — the SAME pattern `engraveJob.ts`'s own `entryOn` already fixed for
 * engrave regions (no reversal here: a pocket ring's winding is already the cutting one).
 */
function rotatedToEntry(ring: readonly [number, number][], target: readonly [number, number]): [number, number][] {
  const start = nearestVertexIndex(ring, target);
  return start === 0 ? (ring as [number, number][]) : [...ring.slice(start), ...ring.slice(0, start)];
}

/**
 * What a round tool of radius `toolRadius`, centred ANYWHERE inside `node.region`'s valid
 * centre-space, can ever reach — `dilate(erode(region, r), r)`, the morphological OPENING (A's
 * review 6622610124, finding 5). `region \ erode(region, D)` (the old formula) overclaims a SHARP
 * convex corner: polygon erosion does not round a convex corner, so the "frame" between the true
 * boundary and ANY eroded copy fills the corner's full square wedge, when a round tool can only
 * ever reach the OPENING's rounded profile there, leaving `r² − πr²/4` per corner permanently
 * uncut, however many rings are cut. Computed once per op: it does not depend on progress.
 *
 * #1021 — exported: `plan.ts` reuses it, unchanged, to find a POCKET's own floor the PRIMARY
 * FLAT's ring cannot reach (`region \ fullyReachable(region, offset, flatRadius)`) — the same
 * opening, the same tool-shape-correct test, one caller earlier than the op itself.
 */
export function fullyReachable(region: Polygons, offset: OffsetFn, toolRadius: number): Polygons {
  return offset(offset(region, -toolRadius), toolRadius);
}

/**
 * The region cleared once the tool has traced out to `depthMm` from the true boundary — a
 * CONSERVATIVE account (never claims more cleared than is certain): `open` (the opening, finding
 * 5's fix) with whatever is still uncut at `depthMm` subtracted as a hole. `offset(region,
 * -depthMm)` returning nothing means `open` itself is fully reached; otherwise the hole is always
 * a subset of `open` (eroding further only shrinks it), so subtracting it is always consistent.
 */
function clearedToDepth(open: Polygons, region: Polygons, offset: OffsetFn, depthMm: number): Polygons {
  const uncut = offset(region, -depthMm);
  if (uncut.length === 0) return open;
  return [...open, ...uncut.map((ring) => [...ring].reverse())];
}

/**
 * How far in from the region's edge the pocket's first pass runs, mm. One posted step less than
 * the cutter's radius: the program rounds the centre to the machine's decimal grid, and a centre
 * rounded half a step away from the wall leaves a strip the checks read as standing material
 * (#1227). A region already in cutter-centre space is not inset at all.
 */
export function pocketRingInsetMm(toolRadiusMm: number, centreSpace: boolean): number {
  if (centreSpace) return 0;
  return toolRadiusMm - FACING_EDGE_CLEARANCE_MM;
}

export function pocket(opts: PocketOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/pocket: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const levels = depthPasses(opts.node.mouthZ, opts.node.floorZ, opts.stepDownMm);

  // A's review 6622610124, finding 3: an OPEN node's own boundary at its open edge is not a real
  // wall — `pocketLoops` must not stand this cutter off it. Extending the region across that edge,
  // with a real boolean (never a hand-rolled one), lets the inward offset reach exactly to the
  // true edge there, same as the contour will cut it; the overshoot past the true edge is air,
  // removed by the contour op regardless. The extension must be STRICTLY more than the tool
  // radius: eroding by exactly `r` the same amount it was extended leaves the fake outer boundary
  // at the true edge with zero margin (degenerate — a ledge exactly `r` wide swept barely at all);
  // `2r` leaves a real margin whatever the ledge's own width, so only the node's OTHER (real)
  // walls end up deciding what the cutter can reach. The raw band runs the WHOLE outline's open
  // edge, not just this node's own stretch of it (advisor's review on dd150a9b) — clipped to
  // `near` (the node's own footprint, grown by the same 2r) before it is unioned in, or every
  // OTHER open node on the part gets this one's band too.
  // The open-edge extension band alone (undefined when this node is not open) — reused below,
  // unchanged, both to build `region` and (#970 FOLLOW-UP 2's own doc further down) to keep the
  // shadow check's own wall erosion from eating into it: an OPEN edge is never a real wall, so
  // unlike `opts.node.region`'s own true walls there is nothing there to double-count.
  const openExtensionBand: Polygons | undefined =
    opts.node.open && opts.openOutline !== undefined && opts.boolean !== undefined
      ? (() => {
          const wholeBand = opts.boolean.subtract(opts.offset(opts.openOutline, 2 * toolRadius), opts.openOutline);
          const near = opts.offset(opts.node.region, 2 * toolRadius);
          // A ∩ B = A \ (A \ B) — the only intersection `union`/`subtract` alone can express.
          return opts.boolean.subtract(wholeBand, opts.boolean.subtract(wholeBand, near));
        })()
      : undefined;
  const region = openExtensionBand === undefined ? opts.node.region : opts.boolean!.union(opts.node.region, openExtensionBand);

  // #966/#970 — THE SHADOW CHECK (`PocketOpOptions.aboveMaterial`'s own doc above): a column's
  // real "ceiling" is Z-INDEPENDENT — one bound per cell, computed ONCE here, never re-queried per
  // level, exactly `rough()`'s own `clSurface` reuse (that op's header: the CL surface does not
  // depend on the current level either). `ceilingMaskAt` then stitches THIS level's own "nothing
  // solid above here" rectilinear mask from that one bound, cheaply, same geometry `rough()`'s
  // `maskLoops` already proved — only the inside rule differs (`rasterMask.ts`'s own header).
  //
  // #970, the maintainer's 2026-11-05 ruling (via the manager, on the elephant gouge a
  // DISTANCE-based fix let through — 3.91 % adjudicated cut-into, 13 mm max, in the flank bands
  // where the body overhangs the legs near the open outline): a real ceiling is identified by
  // GEOMETRY, never by distance to an edge or to this node's own wall. Three earlier attempts all
  // tried to carve a "safe to sample" DOMAIN out of `region` by distance (an opening, a plain
  // erosion, an erosion plus a ring restored near the true open outline) — every one of them had
  // to choose, near SOME edge, between re-excluding the node's own wall (losing real tray/
  // organizer coverage) and re-admitting a genuine overhang that happens to sit near that same
  // edge (the elephant's own gouge). No distance threshold can tell those two apart, because
  // nothing about "how far from the boundary" distinguishes them — only the SURFACE ITSELF does.
  //
  // #1003 round 3 (6b's rule, the manager's ruling): the cell's bound is THE SURFACE ITSELF over
  // the cell's own square — `triangleBins`' `clippedTriangleToSquare` + `planeMaxOverPolygon`, the
  // triangle's plane evaluated over the triangle clipped to the square, and only where that
  // clipped part lies INSIDE the node's region (the per-cell check above; without it the
  // organizer's mouth-level land closed every pocket's rim band — see `polygonOverlapsRegion`).
  // Two earlier bounds were wrong in ways that cost real coverage, and the confirming print on the
  // sloped seed showed both at ten unreached cells (`cellBound` 0.000 against the exact plane
  // −3.000, a 3 mm leftover):
  //
  //   - a triangle's `maxZ` is its highest VERTEX anywhere, not its height in this cell. One large
  //     facet (a sloped pocket floor, the top land) therefore closed every cell its bbox touched
  //     up to a height belonging to another part of the facet. The previous bound's square was
  //     also the drawn cell UNION a half-pitch the old point samples reached into, so a triangle
  //     that does not touch the cell at all still closed it — every one of the 703 cells the
  //     print found was this case (the driver's intersection with the cell's own square was
  //     EMPTY);
  //   - point samples (the old five-per-cell gate) miss a rise between them — the elephant's
  //     eleven rim cells (#970's flank fix), which the maxZ bound had been covering for.
  //
  // With the exact bound both fall out: clipping the triangle to the DRAWN square excludes
  // everything that is not over the cell, and the plane makes the height exact where it is. A
  // vertical facet states no surface above a column and is skipped (`planeA` NaN); a cell with no
  // triangle over it reads `-Infinity`, the identity of the max reduction, and is open all the way
  // down. The five-sample grid and the gate term go with them: the old gate only asked whether ANY
  // non-vertical surface existed near the column (`ceiling[k]`'s finiteness), never compared its
  // height to the level — which is why the sloped seed's own floor (topmost at −3.000, far below
  // the pass) never rescued the cells the maxZ bound had closed.
  let ceilingMaskAt: ((levelZ: number) => Polygons) | null = null;
  if (opts.aboveMaterial !== undefined) {
    const marginMm = opts.aboveMaterial.marginMm ?? ARC_CHORD_TOLERANCE_MM;
    const mesh = opts.aboveMaterial.mesh;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of region) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (Number.isFinite(minX) && maxX > minX && maxY > minY) {
      const pitch = Math.min(0.5, Math.max(0.1, Math.min(opts.stepOverMm, toolRadius) / 4));
      const nx = Math.max(2, Math.floor((maxX - minX) / pitch + 1e-9) + 1);
      const ny = Math.max(2, Math.floor((maxY - minY) / pitch + 1e-9) + 1);
      // #970, B's link audit follow-up (the elephant's 11 rim cells, review session's fix 2): a
      // rise between point samples must never open a cell — both bound forms answer the whole
      // DRAWN square the mask opens, so a flank narrower than the pitch, anywhere inside the
      // cell, is in the bound by construction.
      const bins = triangleBinsFor(mesh);
      const cellBound = new Float64Array(nx * ny).fill(Number.NEGATIVE_INFINITY);
      // #1003 — THE BOUND COUNTS ONLY DESIGN THAT OVERLAPS THE NODE'S REGION (see the helpers).
      const meshPos = mesh.positions;
      const meshIdx = mesh.indices;
      const overlapCache = new Map<number, boolean>();
      const overlapsRegion = (t: number): boolean => {
        const cached = overlapCache.get(t);
        if (cached !== undefined) return cached;
        const ia = meshIdx[3 * t]! * 3;
        const ib = meshIdx[3 * t + 1]! * 3;
        const ic = meshIdx[3 * t + 2]! * 3;
        const result = triangleOverlapsRegion(
          meshPos[ia]!, meshPos[ia + 1]!, meshPos[ib]!, meshPos[ib + 1]!, meshPos[ic]!, meshPos[ic + 1]!, opts.node.region,
        );
        overlapCache.set(t, result);
        return result;
      };
      // #1018 — `cellBound` and `levelZ` are both stock-top-relative now (`aboveMaterial.mesh`'s
      // own doc above): the door shift makes them the same datum, no per-site offset either way.
      const reach = Math.hypot(pitch, pitch) / 2 + bins.cellMm;
      // The cell's FOUR CORNERS, judged once on the shared grid nodes: a cell whose whole square
      // is strictly inside the region needs no per-triangle overlap test — anything over the
      // square is over the pocket. A boundary cell is settled by the cheap corner proof when the
      // triangle covers an inside corner, and only otherwise runs the exact `polygonOverlapsRegion`.
      const nx1 = nx + 1;
      const cornerIn = new Uint8Array(nx1 * (ny + 1));
      // Even-odd parity along each node ROW (the same rule `pointInPolygons` applies), so the
      // grid costs O(rows × ring + nodes) instead of a full ring scan per node — the organizer's
      // 270 × 270 masks spent ~1.9 s in the per-node version.
      const xs: number[] = [];
      for (let j = 0; j <= ny; j++) {
        const y = minY + j * pitch;
        xs.length = 0;
        for (const ring of opts.node.region) {
          for (let i = 0; i < ring.length; i++) {
            const [ax, ay] = ring[i]!;
            const [bx, by] = ring[(i + 1) % ring.length]!;
            if (ay > y !== by > y) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
          }
        }
        if (xs.length === 0) continue;
        xs.sort((a, b) => a - b);
        let k = 0;
        for (let i = 0; i <= nx; i++) {
          const x = minX + i * pitch;
          while (k < xs.length && xs[k]! <= x) k++;
          if ((k & 1) === 1) cornerIn[j * nx1 + i] = 1;
        }
      }
      // A node on (or within a grid step of) a ring edge is NOT strictly inside: walk every ring
      // edge through the grid and clear a 5 × 5 node neighbourhood around each sample, so every
      // cell the edge crosses loses at least one corner. Clearing wider than the epsilon only
      // pushes the cells beside a boundary onto the per-cell overlap test below, never the other
      // way round.
      for (const ring of opts.node.region) {
        for (let i = 0; i < ring.length; i++) {
          const [ax, ay] = ring[i]!;
          const [bx, by] = ring[(i + 1) % ring.length]!;
          const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (pitch / 2)));
          for (let s = 0; s <= steps; s++) {
            const px = ax + ((bx - ax) * s) / steps;
            const py = ay + ((by - ay) * s) / steps;
            const ci = Math.round((px - minX) / pitch);
            const cj = Math.round((py - minY) / pitch);
            for (let dj = -2; dj <= 2; dj++) {
              for (let di = -2; di <= 2; di++) {
                const ii = ci + di;
                const jj = cj + dj;
                if (ii >= 0 && jj >= 0 && ii <= nx && jj <= ny) cornerIn[jj * nx1 + ii] = 0;
              }
            }
          }
        }
      }
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          // The cell `maskLoopsFromPredicate` opens, exactly: [i·pitch, (i+1)·pitch] in each axis
          // from the grid's own origin (`rasterMask.ts`'s `push`). No inflation — the old extra
          // half-pitch existed only to cover the removed point samples' own footprint.
          const x0 = minX + i * pitch;
          const y0 = minY + j * pitch;
          const x1 = x0 + pitch;
          const y1 = y0 + pitch;
          // Corner bit order: (x0,y0), (x1,y0), (x1,y1), (x0,y1).
          const c00 = cornerIn[j * nx1 + i]!, c10 = cornerIn[j * nx1 + i + 1]!;
          const c11 = cornerIn[(j + 1) * nx1 + i + 1]!, c01 = cornerIn[(j + 1) * nx1 + i]!;
          const insideMask = c00 | (c10 << 1) | (c11 << 2) | (c01 << 3);
          const fullyInside = insideMask === 15;
          const anyInside = insideMask !== 0;
          let m = Number.NEGATIVE_INFINITY;
          for (const t of binnedReachableTriangles(bins, (x0 + x1) / 2, (y0 + y1) / 2, reach)) {
            if (!overlapsRegion(t)) continue;
            // #1020 (C's review) — a near-vertical facet (within ~3° of vertical) is "no real
            // ceiling here" for THIS bound specifically — never folded into the shared `planeA`
            // classification (`isNearVertical`'s own doc: that would drop a real facet contact
            // from every op's CL, a possible gouge on a drafted wall touched in its interior).
            if (isNearVertical(bins, t)) continue;
            let covered = fullyInside;
            if (!covered && anyInside) {
              // A cell on the pocket's edge: the cheap positive-overlap proof. If the triangle
              // strictly covers a grid node that is strictly inside the region, it covers some
              // area inside the pocket, and the exact square bound needs no region clipping.
              // (Most boundary triangles — the floor, a real ceiling — cover the whole cell.)
              const ia = meshIdx[3 * t]! * 3;
              const ib = meshIdx[3 * t + 1]! * 3;
              const ic = meshIdx[3 * t + 2]! * 3;
              covered =
                ((insideMask & 1) !== 0 && triangleStrictlyCovers(meshPos[ia]!, meshPos[ia + 1]!, meshPos[ib]!, meshPos[ib + 1]!, meshPos[ic]!, meshPos[ic + 1]!, x0, y0)) ||
                ((insideMask & 2) !== 0 && triangleStrictlyCovers(meshPos[ia]!, meshPos[ia + 1]!, meshPos[ib]!, meshPos[ib + 1]!, meshPos[ic]!, meshPos[ic + 1]!, x1, y0)) ||
                ((insideMask & 4) !== 0 && triangleStrictlyCovers(meshPos[ia]!, meshPos[ia + 1]!, meshPos[ib]!, meshPos[ib + 1]!, meshPos[ic]!, meshPos[ic + 1]!, x1, y1)) ||
                ((insideMask & 8) !== 0 && triangleStrictlyCovers(meshPos[ia]!, meshPos[ia + 1]!, meshPos[ib]!, meshPos[ib + 1]!, meshPos[ic]!, meshPos[ic + 1]!, x0, y1));
            }
            if (covered) {
              // The whole square (or a proven in-region part of it) is over the pocket, and the
              // exact bound over the square is the allocation-free form.
              const z = planeMaxOverSquare(bins, t, x0, y0, x1, y1);
              if (z > m) m = z;
              continue;
            }
            const poly = clippedTriangleToSquare(bins, t, x0, y0, x1, y1);
            if (poly === null) continue;
            if (!polygonOverlapsRegion(poly, opts.node.region)) continue;
            const z = planeMaxOverPolygon(bins, t, poly);
            if (z > m) m = z;
          }
          cellBound[j * nx + i] = m;
        }
      }
      ceilingMaskAt = (levelZ: number): Polygons =>
        maskLoopsFromPredicate(
          nx,
          ny,
          minX,
          minY,
          pitch,
          (i, j) => {
            if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
            // #1018 — `cellBound` is sampled on `mesh`, which is now the SAME stock-top-relative
            // datum `levelZ` already is (the door shift, `plan.ts`'s own setup loop); compared
            // directly, no per-site offset.
            return cellBound[j * nx + i]! - marginMm < levelZ;
          },
        );
    }
  }

  /** `region ∩ mask` — the same `A \ (A \ B)` trick the open-node extension above already uses;
   * requires a real boolean, same contract as that extension (stated by the caller, never assumed). */
  const intersectWithRegion = (mask: Polygons): Polygons => {
    if (opts.boolean === undefined) {
      throw new Error('cam/model/ops/pocket: aboveMaterial needs a real boolean (union/subtract) to apply the #966 shadow mask');
    }
    return opts.boolean.subtract(region, opts.boolean.subtract(region, mask));
  };

  // The GLOBALLY safe region — reachable all the way to `floorZ`, the most restrictive of every
  // level's own mask (the masks are NESTED: as `z` drops, fewer columns still satisfy "ceiling
  // below z", never more) — is what `open`/the linking field below are built from, so neither ever
  // claims a column is cleared to `floorZ` when a shadow stopped it short.
  const floorSafeRegion = ceilingMaskAt === null ? region : intersectWithRegion(ceilingMaskAt(opts.node.floorZ));

  // #1092 — a centre-space region is already the set of positions the cutter's disc may occupy, so
  // neither the ring trace nor this reachability erosion may inset it again.
  const loopInset = opts.centreSpace === true ? 0 : toolRadius;
  const open = loopInset > 0 ? fullyReachable(floorSafeRegion, opts.offset, loopInset) : floorSafeRegion;

  // A's review 6622610124, finding 1: the free space EVERY same-level or level-to-level link must
  // stay inside is `open` (finding 5's own reachable area), NOT a second erosion of `region` —
  // `linkIsClear` already tests the whole cutter disc against this field, and a disc centred at
  // `region` eroded once more only fits when its CENTRE is eroded a second time (advisor's review
  // on dd150a9b): `erode(open, r) = erode(region, r)` (opening is idempotent), so testing the disc
  // against `open` is exactly A's own centre-line criterion, not a stricter one that forces a
  // retract on nearly every transition. A point outside `open` (an island, the wall between two
  // lobes, open air outside the node) is reported as never cut, so `link()` retracts around it.
  const material: MaterialField = {
    topAt: (x, y) => (pointInPolygons(open, x, y) ? opts.node.floorZ : Number.POSITIVE_INFINITY),
  };
  const linkOptions: LinkOptions = {
    material,
    // The REGION's own clearance plane (already above every obstacle IN this region), not the
    // program-wide `safeZMm` — `RegionRef.regionClearanceZ`'s own doc in `plan.ts` draws this
    // line; advisor's review on dd150a9b caught the two being swapped here.
    clearanceZ: opts.region.regionClearanceZ,
    tool: { radiusMm: toolRadius },
    feeds: { feed: opts.feeds.feedMmPerMin, plungeFeed: opts.feeds.plungeFeedMmPerMin },
    hopClearanceMm: opts.hopZMm,
  };

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];

  // #1002 — THE LANDING PROOF. A retract's down leg may rapid back toward the landing's own level
  // only as far as the ground under the landing has actually been cut: the DEEPEST FINISHED level
  // whose recorded cleared area contains it (`cleared`, pushed when a level's last ring ends). The
  // per-ring `passes[].cleared` band is not a proof — it is the step's whole planned band, so a
  // same-level landing on a lobe this level has not reached yet would rapid below the stock
  // standing on the previous level's floor (measured: stepDown 2 > hop 1 → rapid 1 mm into stock).
  // Without a finished level under the landing the down leg stops at the stock top and feeds.
  const landingClearedZ = (x: number, y: number, _z: number): number | null => clearedGroundZ(x, y, cleared);

  // Tracks where the tool actually is, so a link is only asked for from the SECOND ring/level
  // onward — the very first ring of the whole op has no "from" position, just its own plunge.
  let prevExit: [number, number, number] | null = null;

  // Wherever the tool actually is right now — `opts.startFrom` (the work origin by default)
  // before the very first ring of the whole op, the previous ring's own exit (always its own
  // entry — it closes on itself) after that. Shared by the step tour (which ring to visit next)
  // and the per-ring entry rotation (where in that ring to start) below.
  const comingFrom = (): readonly [number, number] => (prevExit === null ? (opts.startFrom ?? [0, 0]) : [prevExit[0], prevExit[1]]);

  for (const z of levels) {
    // #966 — THIS level's own true cuttable area: `region`, further restricted to wherever the
    // real ceiling (sampled once, above) is below `z` — the masks are nested (a shallower level's
    // mask is a SUPERSET of every deeper one's), so a column whose own ceiling sits between
    // `floorZ` and `mouthZ` is still correctly cut down to it, then excluded from every level past
    // that, never cut deeper than its own real obstruction allows.
    const levelRegion = ceilingMaskAt === null ? region : intersectWithRegion(ceilingMaskAt(z));
    const steps = pocketLoops(levelRegion, toolRadius, opts.stepOverMm, opts.offset, undefined, pocketRingInsetMm(toolRadius, opts.centreSpace === true));
    for (const [stepIndex, step] of steps.entries()) {
      const loops = orderedRings(step, comingFrom());
      for (const loop of loops) {
        // This is the lever toward Makera's own rapids/1,000: `ring[0]` used to be whichever
        // vertex Clipper happened to emit first, so the link into this ring often had most of its
        // own perimeter to cross before `link()` ever got a choice between a short hop and a
        // retract.
        const ring = rotatedToEntry(loop, comingFrom());
        const start = ring[0]!;
        if (prevExit === null) {
          // The very first ring of the whole op: rapid up, then plunge down.
          moves.push({ kind: 'rapid', x: start[0], y: start[1], z: opts.hopZMm });
          moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.plungeFeedMmPerMin });
        } else if (prevExit[2] === z) {
          // Same level: `open`'s own field is accurate everywhere on it (the whole op's footprint
          // is the same at every Z), so `link()` alone decides feed vs. retract.
          const from: LinkPoint = { x: prevExit[0], y: prevExit[1], z: prevExit[2] };
          const to: LinkPoint = { x: start[0], y: start[1], z };
          moves.push(...link(from, to, { ...linkOptions, landingClearedZMm: landingClearedZ }));
        } else {
          // A level change (advisor's review on 9e976f0b): `open` reports every point in the
          // node's footprint as reachable, with no notion of "not yet, at THIS depth" — handing
          // `link()` the full 3D jump lets its short-hop branch read a same-XY descent as a clear
          // feed at the CUTTING rate, a plunge/ramp with no plunge feed at all. The horizontal
          // part of the move is linked at the level JUST FINISHED, where `open` is honestly
          // accurate (everything in it has actually been swept by now); the vertical part is
          // always a plain feed at plungeFeed, never left to `link()`'s own feed rate.
          const from: LinkPoint = { x: prevExit[0], y: prevExit[1], z: prevExit[2] };
          const landing: LinkPoint = { x: start[0], y: start[1], z: prevExit[2] };
          moves.push(...link(from, landing, { ...linkOptions, landingClearedZMm: landingClearedZ }));
          moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: opts.feeds.plungeFeedMmPerMin });
        }
        moves.push(...traceRing(ring, z, opts.feeds.feedMmPerMin));
        const entry: [number, number, number] = [start[0], start[1], z];
        prevExit = entry; // the ring closes back to its own start
        // `toolRadius + stepIndex * stepOverMm` is this step's own offset from the true boundary
        // (pocketLoops' own convention); clearedToDepth adds the tool's own radius again, since
        // that is how far out the tool has actually swept once its centre reaches this step's path.
        const depthMm = toolRadius + stepIndex * opts.stepOverMm + toolRadius;
        passes.push({ z, boundary: [ring as [number, number][]], cleared: { z, boundary: clearedToDepth(open, region, opts.offset, depthMm) }, entry, exit: entry });
      }
    }
    const finalDepthMm = toolRadius + Math.max(0, steps.length - 1) * opts.stepOverMm + toolRadius;
    // The record is derived from `region`, though the level cuts only `levelRegion` — and that
    // broader base is CONSERVATIVE, which is why it is safe as a landing proof:
    //  - the claimed set is a subset of `open`, and `open` is the opening of the FLOOR-safe
    //    region; the ceiling masks are nested (mask(floorZ) ⊆ mask(z) for every level), so the
    //    record can never reach a cell this level does not cut;
    //  - the hole is `region` eroded by the depth, and eroding a SUPERSET gives a superset, so
    //    the broad base subtracts at least as much as the level region's own core would — the
    //    near-mask cells a tighter `levelRegion` hole would add back are left UNCLAIMED (their
    //    landings fall back to the stock-top rule), never over-claimed.
    cleared.push({ z, boundary: clearedToDepth(open, region, opts.offset, finalDepthMm) });
  }

  // Every op leaves the tool at a safe height when it ends: a straight retract at the LAST XY
  // (no lateral travel below the safe plane), matching `generateProfile`'s own final move — the
  // next op, concatenated onto this one (`concatToolpathIR`), starts from a safe state, not depth.
  const lastMove = moves[moves.length - 1];
  if (lastMove) moves.push({ kind: 'rapid', x: lastMove.x, y: lastMove.y, z: opts.safeZMm });

  const ir: ToolpathIR = {
    frame: 'flat',
    tool: opts.cutter,
    toolNumber: opts.toolNumber,
    spindleRpm: opts.spindleRpm,
    air: opts.air,
    safeZ: opts.safeZMm,
    hopZ: opts.hopZMm,
    operations: [
      {
        number: 1,
        name: `[T${opts.toolNumber}] Pocket "${opts.node.id}"`,
        labelId: opts.node.id,
        depth: opts.node.mouthZ - opts.node.floorZ,
        depthPasses: levels.length,
        passStepMm: opts.stepDownMm,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, opts.rapid),
      },
    ],
  };

  return { ir, cutter: cutterKeyOf(opts.cutter), passes, cleared };
}
