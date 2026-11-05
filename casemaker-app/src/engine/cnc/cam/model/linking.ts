/**
 * #962 — STAY-DOWN LINKING AND THE REGION TOUR.
 *
 * A link joins one pass's exit to the next pass's entry. It stays down at the cut depth only when
 * the cutter's swept link lies inside material ALREADY removed at that depth; otherwise it retracts
 * to the region's clearance plane, traverses, and plunges. The decision is made once, here, and is
 * shared by every op (rough, pocket, finish) so the price #961 computes and the moves the plan posts
 * cannot disagree about what a link costs.
 *
 * PRIOR ART, and what was taken from it (Kiri:Moto and FreeCAD Path are LOCAL REFERENCES only,
 * the same tier as OpenCamLib and PyCAM: the methods are re-implemented from their descriptions,
 * no code is copied or linked):
 *  - Kiri:Moto (`prepare.js`): a short planar move — 2 × the cutter's diameter — at the same Z is
 *    re-emitted as a cut, and a move that would cross the pocket's boundary goes up and over. This
 *    module keeps the SHORT HOP as a hard permission guard: nothing longer stays down, even in open
 *    material.
 *  - FreeCAD Path (`Path/Base/Generator/linking.py`, `Adaptive.py`): links are collision-tested
 *    against the model and the lowest clear height is chosen; `KeepToolDownRatio` (default 3.0)
 *    caps a stay-down detour at that multiple of the direct distance, and a link below the safe
 *    height is FED, not rapided. This module keeps the ratio guard and feeds every vertical leg.
 *  - The material test is ours: the caller supplies `MaterialField.topAt(x, y)` — the stock top
 *    after every preceding op — and a link is clear only where that is at or below the link's own
 *    Z across the whole cutter disc, sampled along the segment. If the field cannot prove it, the
 *    linker retracts: a retract is always safe, a hopeful link is not.
 *
 * VERTICAL LEGS (the manager's ruling refining #956 §5, Review B's F8, after C measured ~8,800 s of
 * feed time this cost the rough skim's own joins): the horizontal traverse at the clearance plane is
 * always a rapid, and so now is the UP leg — retracting out of material the op just finished cutting
 * at `from` is never hopeful, it is a known-clear G0 like Makera's own NC. The DOWN leg still earns
 * its caution, but only down to where it is owed: it rapids from the clearance plane to the material
 * field's own report at the LANDING (x, y) plus the hop clearance, then feeds (at `plungeFeed`) the
 * rest of the way into unproven territory. When the field cannot prove anything there (not finite —
 * off the footprint, or no field at all, as in `chamfer.ts`'s own V-bit transitions), the whole down
 * leg stays a feed, exactly as before: a hopeful rapid is still not a retract.
 *
 * `tour.ts` (#487) is the region-order primitive: nearest-neighbour + 2-opt, deterministic. This
 * module lifts it from loops to passes.
 */

import type { CamMove } from '../ir';
import { tourNearest } from '../tour';

/** FreeCAD Path's `KeepToolDownRatio` default: a stay-down detour may be 3× the direct distance. */
export const DEFAULT_KEEP_TOOL_DOWN_RATIO = 3;

/** Kiri:Moto's short hop, in cutter diameters: past this, retract even in open material. */
export const DEFAULT_SHORT_HOP_DIAMETERS = 2;

/** The down leg's rapid floor above the material field's own report, mm, when the caller states
 * no op-specific hop height of its own; matches `ir.ts`'s `HOP_Z`, the intra-operation hop height. */
export const DEFAULT_HOP_CLEARANCE_MM = 1;

export interface LinkPoint {
  x: number;
  y: number;
  z: number;
}

/**
 * The material state after every preceding op: the stock top at (x, y), mm. 0 is untouched stock;
 * a cell cut to the pass floor reports that floor. The caller owns the field (the plan updates it
 * as each op posts); the linker never assumes a cut that the field does not state.
 */
export interface MaterialField {
  topAt(x: number, y: number): number;
}

export interface LinkTool {
  /** The cutter's cutting radius, mm. */
  radiusMm: number;
}

export interface LinkFeeds {
  /** The cutting feed the stay-down link runs at, mm/min. */
  feed: number;
  /** The plunge feed every vertical leg runs at, mm/min. */
  plungeFeed: number;
}

export interface LinkOptions {
  material: MaterialField;
  /** The region's clearance plane, mm (already above every obstacle in the region). */
  clearanceZ: number;
  tool: LinkTool;
  feeds: LinkFeeds;
  /** FreeCAD's stay-down ratio; absent → {@link DEFAULT_KEEP_TOOL_DOWN_RATIO}. */
  keepToolDownRatio?: number;
  /** Kiri's short hop, mm; absent → {@link DEFAULT_SHORT_HOP_DIAMETERS} × the cutting diameter. */
  shortHopMm?: number;
  /** Sample spacing for the material test, mm; absent → min(0.5, max(0.1, radius / 2)). */
  sampleStepMm?: number;
  /** The down leg's rapid floor above the material field's own report at the landing (x, y), mm;
   * absent → {@link DEFAULT_HOP_CLEARANCE_MM}. Callers that already carry their own hop height
   * (every op's `hopZMm`) pass that value here so the down leg rapids to the same height the op's
   * first plunge already uses. */
  hopClearanceMm?: number;
}

/** One pass, as the linker needs it: where the tool enters and leaves, and which region it is in. */
export interface PassLink {
  entry: LinkPoint;
  exit: LinkPoint;
  regionId: string;
}

/** A pass with the moves that join it to the pass before it. The first has no link. */
export interface LinkedPass<T extends PassLink> {
  pass: T;
  linkBefore: CamMove[];
}

const EPS = 1e-9;

function dist2(a: LinkPoint, b: LinkPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function dist3(a: LinkPoint, b: LinkPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function sampleStep(opts: LinkOptions): number {
  if (opts.sampleStepMm !== undefined && opts.sampleStepMm > 0) return opts.sampleStepMm;
  const radius = Math.max(0, opts.tool.radiusMm);
  return Math.min(0.5, Math.max(0.1, radius / 2));
}

/** The points of the cutter disc the material test samples: a grid inside the circle, plus the rim. */
function discOffsets(radius: number, spacing: number): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  if (!(radius > 0)) return out;
  const s = Math.max(0.05, Math.min(spacing, radius / 2));
  const n = Math.ceil(radius / s);
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      if (i === 0 && j === 0) continue;
      if (Math.hypot(i * s, j * s) <= radius + 1e-9) out.push([i * s, j * s]);
    }
  }
  return out;
}

/**
 * True when the cutter, travelling from `from` to `to`, stays inside material already cut to the
 * link's own Z. The segment is sampled at `sampleStep`; at each sample the whole cutter disc is
 * tested, so a wall or a ridge just inside the radius blocks the link even when the centreline is
 * clear. A link whose field says nothing (NaN) is blocked.
 */
export function linkIsClear(from: LinkPoint, to: LinkPoint, opts: LinkOptions): boolean {
  const length = dist3(from, to);
  if (length <= EPS) return true;
  const radius = Math.max(0, opts.tool.radiusMm);
  const step = sampleStep(opts);
  const steps = Math.max(1, Math.ceil(length / step));
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const disc = discOffsets(radius, step);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = from.x + dx * t;
    const cy = from.y + dy * t;
    const cz = from.z + dz * t;
    for (const [ox, oy] of disc) {
      const top = opts.material.topAt(cx + ox, cy + oy);
      if (!Number.isFinite(top)) return false;
      if (top > cz + 1e-6) return false;
    }
  }
  return true;
}

function feedMove(to: LinkPoint, f: number): CamMove {
  return { kind: 'feed', x: to.x, y: to.y, z: to.z, f };
}

function rapidMove(to: LinkPoint): CamMove {
  return { kind: 'rapid', x: to.x, y: to.y, z: to.z };
}

/**
 * A detour waypoint around standing material, or null when none is clear. The candidates are
 * perpendicular offsets of the midpoint at 2×, 3×, 4× and 6× the cutter radius, both sides; each
 * leg is tested with the same material rule. The caller applies FreeCAD's ratio guard to the
 * resulting path, so a long way round can still lose to a retract.
 */
function dogleg(from: LinkPoint, to: LinkPoint, opts: LinkOptions): LinkPoint | null {
  const flat = dist2(from, to);
  if (flat <= EPS) return null;
  const radius = Math.max(0, opts.tool.radiusMm);
  const nx = -(to.y - from.y) / flat;
  const ny = (to.x - from.x) / flat;
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const base = radius > 0 ? radius : 1;
  for (const factor of [2, 3, 4, 6]) {
    for (const side of [1, -1]) {
      const way: LinkPoint = {
        x: mx + nx * base * factor * side,
        y: my + ny * base * factor * side,
        z: from.z,
      };
      if (linkIsClear(from, way, opts) && linkIsClear(way, to, opts)) return way;
    }
  }
  return null;
}

function retract(from: LinkPoint, to: LinkPoint, opts: LinkOptions): CamMove[] {
  const transitZ = Math.max(opts.clearanceZ, from.z, to.z);
  const plunge = opts.feeds.plungeFeed;
  const moves: CamMove[] = [];

  // UP — retracting out of material the op just cut at `from`: always a rapid. The op finishing
  // there already proves that (x, y) is clear up to `from.z`; there is nothing hopeful about it.
  if (transitZ > from.z + EPS) {
    moves.push(rapidMove({ x: from.x, y: from.y, z: transitZ }));
  }
  if (dist2(from, to) > EPS) {
    moves.push(rapidMove({ x: to.x, y: to.y, z: transitZ }));
  }

  // DOWN — rapid to the material field's own report at the LANDING (x, y) plus the hop
  // clearance, then feed the rest of the way; a hopeful rapid past that point is not a retract.
  // When the field cannot prove anything there (not finite), the whole leg stays a feed, as before.
  if (transitZ > to.z + EPS) {
    const materialTop = opts.material.topAt(to.x, to.y);
    if (Number.isFinite(materialTop)) {
      const hopClearance = opts.hopClearanceMm ?? DEFAULT_HOP_CLEARANCE_MM;
      const floor = Math.max(materialTop + hopClearance, to.z);
      if (transitZ > floor + EPS) {
        moves.push(rapidMove({ x: to.x, y: to.y, z: floor }));
      }
      if (floor > to.z + EPS) {
        moves.push(feedMove({ x: to.x, y: to.y, z: to.z }, plunge));
      }
    } else {
      moves.push(feedMove({ x: to.x, y: to.y, z: to.z }, plunge));
    }
  }

  // A degenerate case (both ends already on the clearance plane and coincident in XY): a single
  // plunge at the target is still an honest link.
  if (moves.length === 0) moves.push(feedMove(to, plunge));
  return moves;
}

/**
 * The one linker every op calls (rough, pocket and finish alike).
 *
 *  1. A clear link within Kiri's short hop stays down: one feed at the cutting feed.
 *  2. A blocked short link may go around by a clear waypoint if FreeCAD's ratio pays for the
 *     detour; the two legs are cutting feeds.
 *  3. Otherwise retract to the region's clearance plane (a rapid up, a rapid traverse), then
 *     rapid back down to the material field's own report at the landing plus the hop clearance,
 *     and feed (at {@link LinkFeeds.plungeFeed}) only the part of the down leg below that.
 */
export function link(from: LinkPoint, to: LinkPoint, opts: LinkOptions): CamMove[] {
  if (dist3(from, to) <= EPS) return [];
  const direct = dist3(from, to);
  const ratio = opts.keepToolDownRatio ?? DEFAULT_KEEP_TOOL_DOWN_RATIO;
  const diameter = Math.max(0, opts.tool.radiusMm) * 2;
  const shortHop = opts.shortHopMm ?? DEFAULT_SHORT_HOP_DIAMETERS * diameter;

  if (direct <= shortHop + EPS) {
    if (linkIsClear(from, to, opts)) return [feedMove(to, opts.feeds.feed)];
    // A detour only makes sense in one plane: a sloped link's waypoint would need its own Z.
    if (Math.abs(to.z - from.z) <= EPS) {
      const way = dogleg(from, to, opts);
      if (way !== null) {
        const path = dist2(from, way) + dist2(way, to);
        if (path <= ratio * direct + EPS) {
          return [
            feedMove({ x: way.x, y: way.y, z: from.z }, opts.feeds.feed),
            feedMove(to, opts.feeds.feed),
          ];
        }
      }
    }
  }
  return retract(from, to, opts);
}

/**
 * The region tour (#487 lifted from loops to passes): nearest neighbour from `from`, refined by
 * 2-opt. Deterministic — the same passes always come back in the same order.
 */
export function orderPasses<T extends { entry: LinkPoint }>(
  passes: readonly T[],
  from: readonly [number, number] = [0, 0],
): T[] {
  if (passes.length <= 1) return [...passes];
  const points = passes.map((p) => [p.entry.x, p.entry.y] as const);
  return tourNearest(points, from).map((i) => passes[i]!);
}

/**
 * Order the passes and join each to the one before it. The first pass has no incoming link: the
 * program's entry is the op's own start, not a link between regions.
 */
export function linkPasses<T extends PassLink>(
  passes: readonly T[],
  opts: LinkOptions,
  from: readonly [number, number] = [0, 0],
): LinkedPass<T>[] {
  const ordered = orderPasses(passes, from);
  return ordered.map((pass, i) => ({
    pass,
    linkBefore: i === 0 ? [] : link(ordered[i - 1]!.exit, pass.entry, opts),
  }));
}
