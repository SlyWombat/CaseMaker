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
 * material, and the cutter centre must stop a radius short on each side. A span is placed along
 * one EDGE of the cut path — a straight run (including a traced side flattened into many short
 * collinear segments) or a smooth arc (including a polygonised circle) — at equal arc-length
 * intervals around the path (#736). It may cross the joints inside that edge, but never a corner,
 * so a tab on a round cut-out is a curved bridge of stock, not a chord across the air.
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
  /** Arc length to the span's end, mm. `startArc + width + 2 × toolRadius`; may exceed the
   * perimeter when the span crosses the contour's first vertex. */
  endArc: number;
  /** The first and last path point; `points[0]` and `points[points.length - 1]`. */
  start: [number, number];
  end: [number, number];
  /**
   * The centre path's own points from `start` to `end` inclusive, in order (#736). A straight span
   * has two; a span on an arc (or across a traced side's short segments) has every intermediate
   * vertex, so the kept material and the cutter's crossing follow the path instead of its chord.
   */
  points: [number, number][];
}

/** What tab placement did on one contour: spans placed and requested tabs it could not place. */
export interface TabPlacement {
  spans: ProfileSpan[];
  /** Tabs requested but not placed: no edge (straight run or smooth arc) could hold one. */
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
 * How far a tab BRIDGE reaches past the kerf's inner and outer edges, mm (#750).
 *
 * The bridge must join the part and the waste by AREA. A rectangle that ends exactly on the
 * band's edges leaves the decision to coincident edges: an axis-aligned edge rounds the same way
 * on both sides, but an imported outline's off-axis edge rounds a hair away, and the loose-piece
 * analysis then read the 145.2 mm SVG hexagon's tab as a free 38 mm² piece. A fraction of a
 * millimetre crosses any such rounding and is far too small to matter to the cut. It must stay
 * small in the other direction too: a tab may not reach a NEIGHBOURING contour's kerf, or the
 * bridge would hold material that contour's own pass removes (the two-part bounce of #750).
 */
export const TAB_BRIDGE_OVERSHOOT_MM = 0.05;

/**
 * The material a tab keeps, as a BRIDGE for the loose-piece analysis (#750).
 *
 * `width` of material along the path, the kerf's own width, and `TAB_BRIDGE_OVERSHOOT_MM` either
 * side of it. Only material the kerf never removed is added (the part beyond the inner edge and
 * the waste beyond the outer one), so the removed band is unchanged; the tab joins both sides by
 * AREA rather than by a shared edge. Following the span's own points (#736), the bridge curves
 * with the path.
 */
export function tabBridgeRectangles(spans: readonly ProfileSpan[], toolRadius: number): Polygons {
  return tabBars(spans, toolRadius, toolRadius + TAB_BRIDGE_OVERSHOOT_MM);
}

/**
 * One band per span: `inset` in from each span end along the path, `halfWidth` either side of it.
 * The band is built from the span's points, never its chord (#736), and follows each vertex with a
 * mitred offset. The two sides are wound back to front, so the result is CW (`signedArea < 0`) —
 * the winding a positive-fill kerf subtraction wants for a kept region. The one owner of tab-band
 * geometry: `tabBridgeRectangles` and the oracle's `tabKeptRegions` both read it; the kept region
 * (the oracle's swept band) is this band at zero inset.
 */
export function tabBars(spans: readonly ProfileSpan[], inset: number, halfWidth: number): Polygons {
  const bands: Polygons = [];
  for (const span of spans) {
    const path = trimPolyline(span.points, inset, inset);
    if (path === null || path.length < 2 || !(halfWidth > 0)) continue;
    const band = bandOf(path, halfWidth);
    if (band !== null) bands.push(band);
  }
  return bands;
}

/** The part of a polyline between `fromStart` and `fromEnd` mm in from its ends; null if empty. */
function trimPolyline(
  points: readonly (readonly [number, number])[],
  fromStart: number,
  fromEnd: number,
): [number, number][] | null {
  if (points.length < 2) return null;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  const from = Math.max(0, fromStart);
  const to = total - fromEnd;
  if (!(from < to) || !(total > 0)) return null;
  const out: [number, number][] = [];
  let at = 0;
  let started = false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const segStart = at;
    const segEnd = at + length;
    at = segEnd;
    if (!(length > 0) || segEnd <= from + 1e-12) continue;
    const atDistance = (d: number): [number, number] => [
      a[0] + ((d - segStart) / length) * (b[0] - a[0]),
      a[1] + ((d - segStart) / length) * (b[1] - a[1]),
    ];
    if (!started) {
      out.push(atDistance(Math.max(from, segStart)));
      started = true;
    }
    if (segEnd < to - 1e-12) {
      out.push([b[0], b[1]]);
    } else {
      out.push(atDistance(to));
      break;
    }
  }
  return out.length >= 2 ? out : null;
}

/**
 * The band `halfWidth` to either side of an open polyline, following its vertices. The left side
 * is walked forward and the right side backward, giving a closed CW ring for a CCW-walked path.
 * Mitres are capped at five half-widths so a hairpin vertex cannot throw the offset to infinity.
 * Returns null for a degenerate ring.
 */
function bandOf(path: readonly (readonly [number, number])[], halfWidth: number): [number, number][] | null {
  const dirs: [number, number][] = [];
  for (let i = 1; i < path.length; i++) {
    const dx = path[i]![0] - path[i - 1]![0];
    const dy = path[i]![1] - path[i - 1]![1];
    const length = Math.hypot(dx, dy);
    if (!(length > 0)) return null;
    dirs.push([dx / length, dy / length]);
  }
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    let nx: number;
    let ny: number;
    let reach = halfWidth;
    if (i === 0) {
      nx = -dirs[0]![1];
      ny = dirs[0]![0];
    } else if (i === path.length - 1) {
      nx = -dirs[dirs.length - 1]![1];
      ny = dirs[dirs.length - 1]![0];
    } else {
      const ax = -dirs[i - 1]![1];
      const ay = dirs[i - 1]![0];
      const bx = -dirs[i]![1];
      const by = dirs[i]![0];
      let mx = ax + bx;
      let my = ay + by;
      const length = Math.hypot(mx, my);
      // A hairpin has no bisector; fall back to the incoming normal, capped like any mitre.
      if (length < 1e-9) {
        nx = ax;
        ny = ay;
        reach = Math.min(halfWidth, 5 * halfWidth);
      } else {
        mx /= length;
        my /= length;
        nx = mx;
        ny = my;
        // 1 / cos(half the joint's turn): how far out the two offset lines meet.
        const cosHalf = mx * bx + my * by;
        reach = Math.min(halfWidth / Math.max(cosHalf, 0.2), 5 * halfWidth);
      }
    }
    left.push([p[0] + nx * reach, p[1] + ny * reach]);
    right.push([p[0] - nx * reach, p[1] - ny * reach]);
  }
  const ring: [number, number][] = [...left, ...right.reverse()];
  if (ring.length < 3 || Math.abs(signedArea(ring)) < 1e-9) return null;
  return signedArea(ring) > 0 ? ring.reverse() : ring;
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

/** A maximal run of the contour a tab may sit on, by arc length along the contour, mm. */
interface Edge {
  start: number;
  end: number;
}

/** A turn sharper than this is a corner, and a tab span must not cross it. */
const TAB_CORNER_RAD = (20 * Math.PI) / 180;
/** Directions within this of each other form one straight (traced or flattened) edge. */
const TAB_COLLINEAR_RAD = (0.5 * Math.PI) / 180;

/**
 * The edges a tab may sit on (#736): maximal straight runs (a 70 mm side traced as many short
 * collinear segments is ONE edge) and maximal runs of smoothly jointed segments (a polygonised
 * circle or a rounded corner is one arc edge). Sharp turns end an edge, so no span crosses a
 * corner. The intervals are in arc length from the contour's first vertex and may run past the
 * perimeter when the walk starts away from vertex 0; placement shifts them back onto the circle.
 */
function edgesOf(segments: readonly Segment[], perimeter: number): Edge[] {
  const n = segments.length;
  if (n === 0 || !(perimeter > 0)) return [];
  const dirs = segments.map((segment) => unitDirection(segment.a, segment.b));
  // Joint i is the vertex where segment i - 1 meets segment i.
  const sharp = segments.map((_, i) => {
    const u = dirs[(i - 1 + n) % n]!;
    const v = dirs[i]!;
    if (u === null || v === null) return false;
    return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))) > TAB_CORNER_RAD;
  });
  // `straight[i]`: segment i continues segment i - 1 in the same direction, within a tight
  // tolerance, so the two belong to one straight edge.
  const straight = segments.map((_, i) => {
    const u = dirs[(i - 1 + n) % n]!;
    const v = dirs[i]!;
    return u !== null && v !== null && u[0] * v[0] + u[1] * v[1] > Math.cos(TAB_COLLINEAR_RAD);
  });
  // Start the walk at a corner when there is one, so no piece wraps; otherwise at a direction
  // change, so no straight run wraps either. No direction change at all is one straight edge.
  let start = 0;
  const firstSharp = sharp.indexOf(true);
  if (firstSharp >= 0) start = firstSharp;
  else {
    const bend = straight.findIndex((continues) => !continues);
    if (bend >= 0) start = bend;
    else return [{ start: 0, end: perimeter }];
  }
  const seq = Array.from({ length: n }, (_, k) => (start + k) % n);
  // Arc length at each walked segment's start. The walk runs continuously across the seam.
  const at = [segments[seq[0]!]!.start];
  for (let k = 1; k < n; k++) at.push(at[k - 1]! + segments[seq[k - 1]!]!.length);
  const edges: Edge[] = [];
  let pieceFrom = 0;
  for (let k = 0; k < n; k++) {
    // Pieces end at the walk's end or at the joint AFTER walked segment k.
    if (k !== n - 1 && !sharp[(seq[k]! + 1) % n]!) continue;
    // Inside a piece, maximal runs of at least TWO collinear segments are straight edges. Every
    // other segment belongs to an arc edge, and consecutive ones share an arc edge — this is what
    // turns a polygonised circle's many short segments into one placeable edge.
    const runOf = new Array<number>(n).fill(-1);
    let runId = 0;
    for (let p = pieceFrom; p <= k; ) {
      let q = p;
      while (q + 1 <= k && straight[seq[q + 1]!]!) q++;
      if (q > p) {
        for (let r = p; r <= q; r++) runOf[r] = runId;
        runId++;
      }
      p = q + 1;
    }
    for (let p = pieceFrom; p <= k; ) {
      const id = runOf[p]!;
      let q = p;
      while (q + 1 <= k && runOf[q + 1] === id) q++;
      edges.push({ start: at[p]!, end: at[q]! + segments[seq[q]!]!.length });
      p = q + 1;
    }
    pieceFrom = k + 1;
  }
  return edges;
}

/** The unit direction from `a` to `b`, or null for a zero-length step. */
function unitDirection(a: readonly [number, number], b: readonly [number, number]): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  return length > 1e-12 ? [dx / length, dy / length] : null;
}

/**
 * The copy of `target` (the target plus a whole number of perimeters) nearest the edge's middle.
 * A tab must be placed on the edge's OWN arc interval: shifting an edge by a perimeter would move
 * it to a different part of the contour. A target near arc 0 is instead compared with an edge
 * that crosses the seam (its interval already runs past the perimeter) by adding a perimeter to
 * the target. For a full-circle edge this only puts the target in the edge's range.
 */
function nearestTargetCopy(edge: Edge, target: number, perimeter: number): number {
  const mid = (edge.start + edge.end) / 2;
  return target + Math.round((mid - target) / perimeter) * perimeter;
}

/** Do two closed arc ranges on the circle overlap? Touching counts: one tab, not two. */
function arcRangesOverlap(a0: number, a1: number, b0: number, b1: number, perimeter: number): boolean {
  const within = (s: number, start: number, length: number): boolean => {
    let d = (s - start) % perimeter;
    if (d < 0) d += perimeter;
    return d <= length + 1e-9;
  };
  return within(a0, b0, b1 - b0) || within(b0, a0, a1 - a0);
}

/**
 * Place `count` tabs at equal arc-length intervals around the contour (#736). Each span is
 * `width + 2 × toolRadius` long on the centre path and stays within ONE edge: a maximal straight
 * run (a traced side's short collinear segments are one edge) or a smooth arc between corners
 * (a polygonised circle is one edge). A span may cross the joints inside its edge — including
 * the small joints of an arc — so a round cut-out can hold tabs; it never crosses a corner.
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
  const edges = edgesOf(segments, perimeter);
  const chosen: { startArc: number; endArc: number; distance: number }[] = [];
  let unplaceable = 0;
  for (let k = 0; k < count; k++) {
    // Mid-interval targets, so the first tab is not forced onto the contour's start vertex.
    const target = ((k + 0.5) / count) * perimeter;
    let best: { startArc: number; endArc: number; distance: number } | null = null;
    for (const edge of edges) {
      if (edge.end - edge.start < spanLength - 1e-9) continue;
      const targetAt = nearestTargetCopy(edge, target, perimeter);
      const start = Math.min(Math.max(targetAt - spanLength / 2, edge.start), edge.end - spanLength);
      let startArc = start % perimeter;
      if (startArc < 0) startArc += perimeter;
      const endArc = startArc + spanLength;
      if (chosen.some((c) => arcRangesOverlap(startArc, endArc, c.startArc, c.endArc, perimeter))) continue;
      let distance = Math.abs(start + spanLength / 2 - target) % perimeter;
      distance = Math.min(distance, perimeter - distance);
      if (best === null || distance < best.distance - 1e-9) best = { startArc, endArc, distance };
    }
    if (best === null) {
      unplaceable++;
      continue;
    }
    chosen.push(best);
  }
  chosen.sort((a, b) => a.startArc - b.startArc);
  return {
    spans: chosen.map((chosenSpan) => {
      const points = runAlong(segments, perimeter, chosenSpan.startArc, spanLength);
      return {
        startArc: chosenSpan.startArc,
        endArc: chosenSpan.endArc,
        start: points[0]!,
        end: points[points.length - 1]!,
        points,
      };
    }),
    unplaceable,
  };
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
    // module header for why a ramp is not permitted. The cross follows the span's OWN path
    // points (#736), so a tab on an arc is cut over the arc, not across its chord.
    const span = interval.after;
    // The retract is VERTICAL: reuse the last cut point's own XY rather than recomputing the
    // span's start. The two are the same point geometrically, but their floats need not be the
    // same bits — and the post rounds each coordinate to 0.001 mm, so two readings of one point
    // can post as X26.412 and X26.413. That half-thousandth became a diagonal rapid at depth,
    // which the verifier rightly refuses (`rapid-too-low`).
    const at = moves[moves.length - 1]!;
    moves.push({ kind: 'rapid', x: at.x, y: at.y, z: tabTopZ });
    for (let i = 1; i < span.points.length; i++) {
      const p = span.points[i]!;
      moves.push({ kind: 'feed', x: p[0], y: p[1], z: tabTopZ, f: params.feed });
    }
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
      // #735 — one pass per `zPasses` level, at the feeds row's step-down.
      depthPasses: passes.length,
      passStepMm: params.stepDown,
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
