/**
 * Profile cutting — cutting a part OUT of the blank (#218).
 *
 * A pocket is a cleared REGION: rings inside a boundary. A cut-out is the opposite: ONE closed
 * path, the cutter's centre following the outline, removing a kerf one cutter wide and cutting
 * all the way into the under-board. The pocket core cannot express it (`pocketLoops` is rings by
 * construction), so it is its own CAM strategy in the same module family, with the SAME injected
 * `OffsetFn`. No geometry kernel appears here: `crossSection.offset` is built once by the caller.
 *
 * CONVENTIONAL MILLING, like `engraveJob` (#172/#218). The spindle turns clockwise, so:
 *   - an OUTSIDE profile keeps the offset result's CCW outer winding;
 *   - an INSIDE profile is reversed to CW.
 * `CrossSection.toPolygons()` returns outers CCW and holes CW, so the outside case is the
 * untouched result and the inside case is `reverseWindings`.
 *
 * HOLDING TABS. A tab is material the bottom of the blank keeps, so a pass that would cut below
 * the tab's top is interrupted: the cutter retracts VERTICALLY at the span's start, feeds across
 * at the tab top, and plunges VERTICALLY at the span's end. Never a ramp — the 2.5D sweep buckets
 * constant-Z moves and extrudes each from that Z upward, while a non-constant-Z move is swept
 * from its LOWEST Z and therefore over-removes; a ramped tab would be simulated as cut through.
 *
 * The span on the CENTRE path is `tabs.width + 2 × toolRadius`: the tab is `width` wide in
 * material, and the cutter centre must stop a radius short on each side. Tabs are placed on
 * one straight edge each, so no span contains a corner.
 */

import type { CutParams } from '../feeds';
import type { Tool } from '../tool';
import { cuttingForTrace } from '../tool';
import {
  estimateCycleSeconds,
  HOP_Z,
  SAFE_Z,
  type CamMove,
  type CamOperation,
  type RapidEstimate,
  type ToolpathIR,
  toolNumberFor,
} from './ir';
import type { OffsetFn, Polygons } from './pocket';
import { zPasses } from './engraveJob';

/** One profile cut, with the centre path the caller has already offset. */
export interface ProfileCut {
  /** The cut-out item's id; becomes the operation's `labelId`. */
  id: string;
  /** The operation's display name, without the `[T#]` prefix or depth suffix. */
  name: string;
  /** The centre path, in the work frame — `profilePath`'s answer. One contour per ring. */
  path: Polygons;
  /** Total cutting depth below the top face, positive mm (`thickness + breakthrough`). */
  depth: number;
  /** The blank's thickness, mm. The tab top is `-(thickness - tabs.height)`. */
  thickness: number;
  /** The cut-out's tab spec. `count: 0` cuts the part free. */
  tabs: { count: number; width: number; height: number };
}

/** A tab span on one contour, by work XY and by arc length along the contour. */
export interface ProfileSpan {
  /** Arc length from the contour's first vertex to the span's start, mm. */
  startArc: number;
  /** Arc length to the span's end, mm. */
  endArc: number;
  start: [number, number];
  end: [number, number];
}

/** What tab placement did on one contour: spans placed and requested tabs it could not place. */
export interface TabPlacement {
  spans: ProfileSpan[];
  /** Tabs requested but not placed: no straight edge could hold one. */
  unplaceable: number;
}

/** One cut's tab facts, for the run sheet and the `tab-unplaceable` finding. */
export interface ProfileTabReport {
  id: string;
  name: string;
  /** Spans actually placed, across every contour. */
  spans: number;
  /** Tabs requested but not placed. */
  unplaceable: number;
}

export interface ProfileResult {
  ir: ToolpathIR;
  tabs: ProfileTabReport[];
}

/**
 * The centre path for a cut-out: the referenced outline offset by the cutter radius (and the
 * row's `inset`) on the side asked for.
 *
 * `inset` is the PATH's extra distance from the outline, mm (the answered Q1 on #218), so an
 * outside path lies `toolRadius + inset` from the outline and leaves the outline as the kerf's
 * inner edge. `'stock-inset'` is the caller's job: it passes the blank rectangle and an inset
 * from the EDGE, with `delta = -inset` — the path is the inset line, and the material left at
 * the edge is `inset - toolRadius`.
 *
 * Only OUTER rings of the result are cut: a profile is one side of one boundary, and following
 * a hole left by the offset would be a second, unrelated cut.
 */
export function profilePath(
  outline: Polygons,
  side: 'outside' | 'inside',
  toolRadius: number,
  inset: number,
  offset: OffsetFn,
): Polygons {
  const delta = side === 'outside' ? toolRadius + inset : -(toolRadius + inset);
  const result = offset(outline, delta).filter((contour) => contour.length >= 3 && signedArea(contour) > 1e-9);
  return side === 'inside' ? result.map(reverseWinding) : result;
}

/**
 * The REGION enclosed by a profile centre path, wound the way a polygon SET is read for filling:
 * outer contours CCW. `profilePath` reverses an INSIDE path to CW (the milling convention above),
 * so the raw path cannot be handed to `CrossSection.ofPolygons` as a solid — a CW outer reads as
 * nothing there. The loose-piece analysis (#218) asks exactly this question of a released part.
 */
export function enclosedPath(path: Polygons): Polygons {
  return path.map((contour) => (signedArea(contour) >= 0 ? contour : reverseWinding(contour)));
}

/**
 * The KERF a profile cut removes: everything within `toolRadius` of the centre path. That is the
 * path offset OUT by the radius minus the path offset IN by it, as one even-odd polygon set
 * (outers CCW, the inner contours reversed). The oracle needs it at a cut-out's tab-keeper depth
 * and the through mask's kerf band uses the same geometry (#218).
 *
 * `path` may wind either way (an inside profile is CW by the milling convention), so it is put
 * back to CCW before offsetting: Clipper2 reads a positive delta as "grow", which is only true of
 * a CCW contour. When the path is narrower than the cutter the inner offset is empty and the kerf
 * is the filled outer contour — the tool does remove the whole disc.
 */
export function kerfPolygons(path: Polygons, toolRadius: number, offset: OffsetFn): Polygons {
  const ccw = enclosedPath(path);
  const outer = offset(ccw, toolRadius).filter((contour) => contour.length >= 3);
  const inner = offset(ccw, -toolRadius).filter((contour) => contour.length >= 3);
  return [...outer, ...inner.map(reverseWinding)];
}

/**
 * The KEPT material of every tab on this contour, as a rectangle `width` long along the path and
 * `2 × toolRadius` across the kerf. The centre-path span is `width + 2r`, so the rectangle starts
 * one radius in from each span end. Used only for the oracle's `T + breakthrough` level: the
 * through region there is the kerf with these rectangles XORed out.
 */
export function tabRectangles(spans: readonly ProfileSpan[], toolRadius: number): Polygons {
  const rectangles: Polygons = [];
  for (const span of spans) {
    const dx = span.end[0] - span.start[0];
    const dy = span.end[1] - span.start[1];
    const length = Math.hypot(dx, dy);
    if (!(length > 2 * toolRadius)) continue;
    const ux = dx / length;
    const uy = dy / length;
    const px = -uy * toolRadius;
    const py = ux * toolRadius;
    const ax = span.start[0] + ux * toolRadius;
    const ay = span.start[1] + uy * toolRadius;
    const bx = span.end[0] - ux * toolRadius;
    const by = span.end[1] - uy * toolRadius;
    rectangles.push([
      [ax + px, ay + py],
      [bx + px, by + py],
      [bx - px, by - py],
      [ax - px, ay - py],
    ]);
  }
  return rectangles;
}

/** Signed area of a closed contour; positive is CCW. */
export function signedArea(contour: readonly (readonly [number, number])[]): number {
  let sum = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** The contour walked the other way round. */
function reverseWinding(contour: Polygons[number]): Polygons[number] {
  return [...contour].reverse();
}

/** One segment of a contour with its cumulative arc-length start. */
interface Segment {
  a: [number, number];
  b: [number, number];
  length: number;
  start: number;
}

/** The contour's segments, closing back on the first vertex, with cumulative lengths. */
function segmentsOf(contour: readonly (readonly [number, number])[]): { segments: Segment[]; perimeter: number } {
  const segments: Segment[] = [];
  let at = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]! as [number, number];
    const b = contour[(i + 1) % contour.length]! as [number, number];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segments.push({ a, b, length, start: at });
    at += length;
  }
  return { segments, perimeter: at };
}

/** The XY point at an arc length along the contour (arc wraps at the perimeter). */
function pointAt(segments: readonly Segment[], perimeter: number, arc: number): [number, number] {
  if (perimeter <= 0) return [0, 0];
  let s = arc % perimeter;
  if (s < 0) s += perimeter;
  for (const segment of segments) {
    if (s <= segment.start + segment.length + 1e-12) {
      const t = segment.length > 0 ? Math.min(1, Math.max(0, (s - segment.start) / segment.length)) : 0;
      return [segment.a[0] + t * (segment.b[0] - segment.a[0]), segment.a[1] + t * (segment.b[1] - segment.a[1])];
    }
  }
  return segments[segments.length - 1]!.b;
}

/**
 * Place `count` tabs at equal arc-length intervals, each on ONE straight edge so no span contains
 * a corner (#218 §2). A span is `width + 2 × toolRadius` long on the centre path.
 *
 * A requested tab with no edge long enough is not placed and is counted in `unplaceable`; the
 * CAM reports it as `tab-unplaceable` rather than silently cutting the part free. Overlapping
 * placements are also counted unplaceable: two tabs in one place are one tab, not two.
 */
export function placeTabs(
  contour: readonly (readonly [number, number])[],
  count: number,
  widthMm: number,
  toolRadius: number,
): TabPlacement {
  const { segments, perimeter } = segmentsOf(contour);
  const spanLength = widthMm + 2 * toolRadius;
  if (count <= 0 || perimeter <= 0 || !(spanLength > 0) || segments.length === 0) {
    return { spans: [], unplaceable: count > 0 ? count : 0 };
  }
  const candidates = segments.filter((s) => s.length >= spanLength - 1e-9);
  if (candidates.length === 0) return { spans: [], unplaceable: count };

  const chosen: { start: number; end: number }[] = [];
  let unplaceable = 0;
  for (let k = 0; k < count; k++) {
    // Mid-interval targets, so the first tab is not forced onto the contour's start vertex.
    const target = ((k + 0.5) / count) * perimeter;
    let best: Segment | null = null;
    let bestDistance = Infinity;
    for (const segment of candidates) {
      const centre = segment.start + segment.length / 2;
      let distance = Math.abs(centre - target);
      distance = Math.min(distance, perimeter - distance);
      if (distance < bestDistance - 1e-9) {
        bestDistance = distance;
        best = segment;
      }
    }
    if (best === null) {
      unplaceable++;
      continue;
    }
    // Centre the span on the edge, so neither end can land on a corner.
    const start = best.start + (best.length - spanLength) / 2;
    const end = start + spanLength;
    if (chosen.some((s) => rangesOverlap(start, end, s.start, s.end))) {
      unplaceable++;
      continue;
    }
    chosen.push({ start, end });
  }
  chosen.sort((a, b) => a.start - b.start);
  return {
    spans: chosen.map((s) => ({
      startArc: s.start,
      endArc: s.end,
      start: pointAt(segments, perimeter, s.start),
      end: pointAt(segments, perimeter, s.end),
    })),
    unplaceable,
  };
}

/**
 * Do two circular arc ranges overlap? The ranges are CLOSED: two spans that touch, or that lie
 * exactly on top of one another, are one tab's worth of material, not two, so both count as an
 * overlap (the caller reports the second as unplaceable). The old exclusive test let an
 * identical placement through, cutting the same tab twice and reporting two tabs.
 */
function rangesOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  const inside = (s: number, lo: number, hi: number): boolean => {
    if (hi < lo) return s >= lo || s <= hi;
    return s >= lo && s <= hi;
  };
  return inside(a0, b0, b1) || inside(a1, b0, b1) || inside(b0, a0, a1) || inside(b1, a0, a1);
}

/** The points along the contour from arc `from`, travelling `length` mm (wrapping at the end). */
function runAlong(
  segments: readonly Segment[],
  perimeter: number,
  from: number,
  length: number,
): [number, number][] {
  const points: [number, number][] = [pointAt(segments, perimeter, from)];
  let s = from % perimeter;
  if (s < 0) s += perimeter;
  let remaining = length;
  let guard = 0;
  while (remaining > 1e-9 && guard++ < segments.length + 4) {
    const next = segments.find((segment) => segment.start > s + 1e-9)?.start ?? perimeter;
    const step = next - s;
    if (step <= remaining + 1e-9) {
      points.push(pointAt(segments, perimeter, next === perimeter ? 0 : next));
      remaining -= step;
      s = next >= perimeter - 1e-9 ? 0 : next;
    } else {
      s += remaining;
      remaining = 0;
      points.push(pointAt(segments, perimeter, s));
    }
  }
  return points;
}

/** The arc length from `from` to `to`, travelling forward and wrapping. */
function arcDistance(from: number, to: number, perimeter: number): number {
  const d = (to - from) % perimeter;
  return d < 0 ? d + perimeter : d;
}

/** The moves for one contour at one Z, crossing its tab spans above the tab top when needed. */
function contourMoves(
  contour: Polygons[number],
  z: number,
  tabTopZ: number,
  placement: TabPlacement,
  params: CutParams,
): { moves: CamMove[]; spans: number } {
  const { segments, perimeter } = segmentsOf(contour);
  const moves: CamMove[] = [];
  const crossing = placement.spans.length > 0 && z < tabTopZ - 1e-9;
  if (!crossing) {
    const start = pointAt(segments, perimeter, 0);
    moves.push({ kind: 'rapid', x: start[0], y: start[1], z: HOP_Z });
    moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: params.plungeFeed });
    for (const p of runAlong(segments, perimeter, 0, perimeter).slice(1)) {
      moves.push({ kind: 'feed', x: p[0], y: p[1], z, f: params.feed });
    }
    moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: params.feed });
    moves.push({ kind: 'rapid', x: start[0], y: start[1], z: HOP_Z });
    return { moves, spans: 0 };
  }

  // Circular cut intervals between successive tab spans. Start at the first span's END, so the
  // first move is a cut, not a crossing.
  const spans = placement.spans;
  const intervals: { from: number; to: number; after: ProfileSpan }[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const next = spans[(i + 1) % spans.length]!;
    intervals.push({ from: span.endArc, to: next.startArc, after: next });
  }
  const start = pointAt(segments, perimeter, intervals[0]!.from);
  moves.push({ kind: 'rapid', x: start[0], y: start[1], z: HOP_Z });
  moves.push({ kind: 'feed', x: start[0], y: start[1], z, f: params.plungeFeed });
  for (const interval of intervals) {
    const points = runAlong(segments, perimeter, interval.from, arcDistance(interval.from, interval.to, perimeter));
    for (let i = 1; i < points.length; i++) {
      const p = points[i]!;
      moves.push({ kind: 'feed', x: p[0], y: p[1], z, f: params.feed });
    }
    // The span that follows this cut interval: retract vertically to the tab top, cross, plunge
    // vertically back to the pass's Z. Constant Z, constant XY in the retract/plunge — see the
    // module header for why a ramp is not permitted. A span is placed on ONE straight edge, so
    // there is no intermediate vertex to visit.
    const span = interval.after;
    // The retract is VERTICAL: reuse the last cut point's own XY rather than recomputing the
    // span's start. The two are the same point geometrically, but their floats need not be the
    // same bits — and the post rounds each coordinate to 0.001 mm, so two readings of one point
    // can post as X26.412 and X26.413. That half-thousandth became a diagonal rapid at depth,
    // which the verifier rightly refuses (`rapid-too-low`).
    const at = moves[moves.length - 1]!;
    moves.push({ kind: 'rapid', x: at.x, y: at.y, z: tabTopZ });
    moves.push({ kind: 'feed', x: span.end[0], y: span.end[1], z: tabTopZ, f: params.feed });
    moves.push({ kind: 'feed', x: span.end[0], y: span.end[1], z, f: params.plungeFeed });
  }
  const last = moves[moves.length - 1]!;
  moves.push({ kind: 'rapid', x: last.x, y: last.y, z: HOP_Z });
  return { moves, spans: spans.length };
}

/**
 * The profile CAM: one operation per cut-out, all of its depth passes, tabs on every pass below
 * the tab top. Operations are emitted in the order given — the caller orders cut-outs
 * innermost-first (a nested part must not be released before the one outside it is cut).
 */
export function generateProfile(
  cuts: readonly ProfileCut[],
  tool: Tool,
  params: CutParams,
  rapid: RapidEstimate,
): ProfileResult {
  const usable = cuttingForTrace(tool);
  if (!usable.ok) throw new Error(`generateProfile: ${usable.reason}`);
  if (usable.tool.shape !== 'flat') {
    throw new Error(
      `generateProfile: a profile cut needs a flat end mill; ${tool.name} is a ${usable.tool.shape} cutter`,
    );
  }
  const toolRadius = usable.tool.radius;
  const toolNumber = toolNumberFor(tool);
  const operations: CamOperation[] = [];
  const tabs: ProfileTabReport[] = [];

  for (const cut of cuts) {
    const tabTopZ = -(cut.thickness - cut.tabs.height);
    const passes = zPasses(cut.depth, params.stepDown);
    const moves: CamMove[] = [];
    let placed = 0;
    let unplaceable = 0;
    for (const z of passes) {
      for (const contour of cut.path) {
        const placement = placeTabs(contour, cut.tabs.count, cut.tabs.width, toolRadius);
        // Count once per cut, not once per pass: the report is about the tabs, not the Z levels.
        if (z === passes[0]) {
          placed += placement.spans.length;
          unplaceable += placement.unplaceable;
        }
        const one = contourMoves(contour, z, tabTopZ, placement, params);
        moves.push(...one.moves);
      }
    }
    const last = moves[moves.length - 1];
    if (last) moves.push({ kind: 'rapid', x: last.x, y: last.y, z: SAFE_Z });
    operations.push({
      number: operations.length + 1,
      name: `[T${toolNumber}]${cut.name} ${cut.depth.toFixed(1)}mm`,
      labelId: cut.id,
      depth: cut.depth,
      moves,
      estimatedSeconds: estimateCycleSeconds(moves, rapid),
      passKind: 'through',
    });
    tabs.push({ id: cut.id, name: cut.name, spans: placed, unplaceable });
  }

  return {
    ir: {
      frame: 'flat',
      tool,
      toolNumber,
      spindleRpm: params.rpm,
      air: params.air,
      safeZ: SAFE_Z,
      hopZ: HOP_Z,
      operations,
    },
    tabs,
  };
}
