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
import { readDefault } from '@/platform/defaultsClient';
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
  tabs: { count: number; width: number; height: number; /** #1206 — the shop's `tabs.maxSpanMm`, mm. */ maxSpanMm?: number; /** #1207 — the shop's `tabs.cornerDeg`. */ cornerDeg?: number; /** #1258 — what the operator chose for a stretch the margin leaves too long; absent = the pre-#1258 placement (a tight tab). */ tabChoice?: TabChoiceMode };
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

/**
 * #1206 — the longest stretch of the contour's outline with NO tab on it, mm — the span limit's
 * measure on the tabs AS PLACED (after any drop). A caller that states `tabs.maxSpanMm` refuses a
 * job whose placed tabs leave a longer run unsupported; the check is on the placed spans, never on
 * the plan before the drops.
 */
export function longestTabGap(spans: readonly ProfileSpan[], perimeter: number): number {
  if (spans.length === 0) return perimeter;
  let worst = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const next = spans[(i + 1) % spans.length]!;
    let gap: number;
    if (spans.length === 1) {
      gap = perimeter - (span.endArc - span.startArc);
    } else {
      gap = (next.startArc - span.endArc) % perimeter;
      if (gap < 0) gap += perimeter;
    }
    if (gap > worst) worst = gap;
  }
  return worst;
}

/** What tab placement did on one contour: spans placed and requested tabs it could not place. */
export interface TabPlacement {
  spans: ProfileSpan[];
  /** Tabs requested but not placed: no edge (straight run or smooth arc) could hold one. */
  unplaceable: number;
  /**
   * #1206 — tabs placed BEYOND the requested count, because no stretch of the outline may be
   * longer than `tabs.maxSpanMm`. The requested count is a minimum, not a cap: the planner divides
   * the long edges evenly and the run sheet says how many it added.
   */
  added: number;
  /**
   * #1206 (the analyst's step 2) — TIGHT TABS: when a stretch between tabs is still longer than
   * `tabs.maxSpanMm` after every margin-respecting place, ONE centred tab is placed on the longest
   * edge inside that stretch even where the corner margin would have refused it, provided the
   * tab's width fits centred. Only when the operator chose it (#1258); each entry names the tab's
   * centre and the distances the sheet states.
   */
  tight: readonly TightTab[];
  /**
   * #1258 — the stretches full-margin tabs could not bring under the limit, each with its candidate.
   * Present only when the caller stated a {@link TabChoiceMode}; empty when nothing is too long.
   */
  stretches?: readonly TabStretch[];
}

/** #1206 — one step-2 tab: where it sits and what it closes. */
export interface TightTab {
  /** The tab's centre in work XY. */
  at: [number, number];
  /** The unsupported stretch this tab closes, mm (measured before it was placed). */
  stretchMm: number;
  /** The centre's distance to the nearer end of its edge, mm — inside the usual corner margin. */
  cornerMm: number;
  /** #1258 — the corner margin of the edge this tab sits on, mm (the one it is closer to a corner than). */
  marginMm: number;
  /** How many joins of the outline the tab's span crosses (the sheet states the count). */
  joins: number;
  /** How many of those joins turn sharper than the placement's smooth-arc limit. */
  sharpJoins: number;
}

/**
 * #1258 — WHAT THE PLACEMENT DOES WITH A STRETCH THE CORNER MARGIN LEAVES TOO LONG. `ask` places
 * nothing for it and reports it (`TabPlacement.stretches`); `insideMargin` places #1206's step-2 tab;
 * `longerStretch` leaves it and states it. Absent: the pre-#1258 behaviour (the step-2 tab is
 * placed, nothing is reported) — callers outside the model plan keep their bytes.
 */
export type TabChoiceMode = 'ask' | 'insideMargin' | 'longerStretch';

/**
 * #1258 — ONE STRETCH tabs at full margins cannot bring under `tabs.maxSpanMm`, with the tab
 * #1206's step 2 would place in it (called and reported, not placed). All lengths mm, positions in
 * work XY. `candidate: null` — no tab fits in the stretch at all.
 */
export interface TabStretch {
  /** The stretch's order along its contour, from 0 (the contour op renumbers across its rings). */
  index: number;
  /** #1258 — which ring of the cutter's centre path (which cut-out) the stretch is on; set by the contour op. */
  ring?: number;
  /** Its unsupported length before any step-2 tab. */
  spanMm: number;
  startXY: [number, number];
  endXY: [number, number];
  /**
   * EVERY tab `insideMargin` would place in this stretch, in order along it — the placement is
   * iterative, so a long stretch can take several. Empty: no tab fits in it at all.
   */
  candidates: {
    /** The tab's centre. */
    atXY: [number, number];
    /** The centre's distance to the nearer end of its edge. */
    fromCornerMm: number;
    /** That nearer end of the edge. */
    cornerXY: [number, number];
    /** The corner margin of the edge the tab sits on — the usual rule, which this tab is inside. */
    marginMm: number;
  }[];
  /** The unsupported lengths in this stretch once ALL the candidates stand (the whole stretch when there are none). */
  leavesSpansMm: number[];
  /** A length left is still past the limit even after every candidate. */
  stillOverLimit: boolean;
}

/** #1206 — how the default placement is shaped; the release pass (#1073) states its own targets. */
export interface TabPlacementOptions {
  /**
   * #1073 — EXPLICIT ARC POSITIONS for each tab's centre, instead of the placement rules. The flip
   * release's bridges must satisfy the corner/bore rules, and equal spacing can put a short side's
   * bridge too near a corner; the release computes each centre where the rules leave room and
   * hands them in.
   */
  targets?: readonly number[];
  /**
   * #1206 — the longest stretch of outline allowed between two tabs, mm (the shop's
   * `tabs.maxSpanMm`). When the requested count cannot meet it, tabs are added on the long edges'
   * own even division. Absent: no span rule (the requested count is placed and that is all).
   */
  maxSpanMm?: number;
  /** #1207 — `tabs.cornerDeg`: the turn sharper than this is a corner, not an arc joint. */
  cornerDeg?: number;
  /** #1258 — what to do with a stretch the margin leaves too long (see {@link TabChoiceMode}). */
  tabChoice?: TabChoiceMode;
}

/** One cut's tab facts, for the run sheet and the `tab-unplaceable` finding. */
export interface ProfileTabReport {
  id: string;
  name: string;
  /** Spans actually placed, across every contour. */
  spans: number;
  /** Tabs requested but not placed. */
  unplaceable: number;
  /** #1206 — tabs the span limit added beyond the request, across every contour. */
  added: number;
  /** #1206 step 2 — the tight tabs placed inside the corner margin, across every contour. */
  tight: TightTab[];
  /** #1258 — the stretches the margin left too long, with their candidates (only when a mode was stated). */
  stretches?: TabStretch[];
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
/**
 * The material a tab keeps, as a BRIDGE for the loose-piece analysis (#750).
 *
 * `width` of material along the path, the kerf's own width, and `tabs.bridgeOvershootMm` either
 * side of it. Only material the kerf never removed is added (the part beyond the inner edge and
 * the waste beyond the outer one), so the removed band is unchanged; the tab joins both sides by
 * AREA rather than by a shared edge. Following the span's own points (#736), the bridge curves
 * with the path.
 */
export function tabBridgeRectangles(spans: readonly ProfileSpan[], toolRadius: number, overshootMm: number): Polygons {
  return tabBars(spans, toolRadius, toolRadius + overshootMm);
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
    // #1206 — a Clipper offset emits coincident vertices (~1e-8 mm steps) where a ROUND join
    // meets its neighbour. They carry no length and their direction is float noise, and a
    // directionless step broke the collinear run between them — so an offset traced side (a #736
    // straight run of 5 mm pieces) fragmented into 5–20 mm edges and the mid-side rule could not
    // see the side. A micrometre is below every posted resolution (0.001 mm); they are not
    // segments, and skipping them cannot move a coordinate the post writes.
    if (!(length > 1e-6)) continue;
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

/** Directions within this of each other form one straight (traced or flattened) edge. */
const TAB_COLLINEAR_RAD = (0.5 * Math.PI) / 180;

/**
 * The edges a tab may sit on (#736): maximal straight runs (a 70 mm side traced as many short
 * collinear segments is ONE edge) and maximal runs of smoothly jointed segments (a polygonised
 * circle or a rounded corner is one arc edge). Sharp turns end an edge, so no span crosses a
 * corner. The intervals are in arc length from the contour's first vertex and may run past the
 * perimeter when the walk starts away from vertex 0; placement shifts them back onto the circle.
 *
 * #1206 — A SINGLE STRAIGHT SEGMENT CAN BE AN EDGE. A parametric shape's side is ONE segment
 * between two tangent round joins (the offset of a rectangle is four single-segment sides joined
 * by quarter arcs), and the "two collinear segments" rule left it inside an arc edge: the whole
 * offset outline read as ONE smooth edge and every tab kept equal spacing. A lone segment this
 * long is a side, not an arc chord: a single segment is a straight edge when it is at least
 * `minStraightLengthMm` (the tab's centre-path span — shorter than that cannot hold a tab, and a
 * polygonised circle's chords are far below it).
 */
function edgesOf(segments: readonly Segment[], perimeter: number, minStraightLengthMm = 0, cornerRad = readDefault(null, 'tabs.cornerDeg').value * (Math.PI / 180)): Edge[] {
  const n = segments.length;
  if (n === 0 || !(perimeter > 0)) return [];
  const dirs = segments.map((segment) => unitDirection(segment.a, segment.b));
  // Joint i is the vertex where segment i - 1 meets segment i.
  const sharp = segments.map((_, i) => {
    const u = dirs[(i - 1 + n) % n]!;
    const v = dirs[i]!;
    if (u === null || v === null) return false;
    return Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1]))) > cornerRad;
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
    // Inside a piece, maximal runs of at least TWO collinear segments are straight edges — and so
    // is a lone segment at least `minStraightLengthMm` long (#1206). Every other segment belongs
    // to an arc edge, and consecutive ones share an arc edge — this is what turns a polygonised
    // circle's many short segments into one placeable edge.
    const runOf = new Array<number>(n).fill(-1);
    let runId = 0;
    for (let p = pieceFrom; p <= k; ) {
      let q = p;
      while (q + 1 <= k && straight[seq[q + 1]!]!) q++;
      if (q > p || segments[seq[p]!]!.length >= minStraightLengthMm - 1e-9) {
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
 * Place `count` tabs around the contour. Each span is `width + 2 × toolRadius` long on the centre
 * path and stays within ONE edge: a maximal straight run (a traced side's short collinear segments
 * are one edge) or a smooth arc between corners (a polygonised circle is one edge). A span may
 * cross the joints inside its edge — including the small joints of an arc — so a round cut-out can
 * hold tabs; it never crosses a corner.
 *
 * #1206 — MID-SIDE, NOT EQUAL INTERVALS. Tabs go to the longest edges first, one at each edge's
 * midpoint; on a rectangle the opposite sides are therefore paired (2 tabs = the two long sides,
 * 4 = the midpoint of every side). An edge gets a second tab only once every edge has one, and
 * then the edge is divided evenly (thirds, then quarters) — never pushed toward its ends. No tab's
 * span comes within `max(2 × tab width, 10 % of the edge)` of a corner; an edge too short for that
 * takes none. A ROUND outline (one edge around the whole contour) keeps equal spacing: there is no
 * side to centre on.
 *
 * #1206 — THE SPAN LIMIT. With `tabs.maxSpanMm` stated, no stretch of the outline is left longer
 * than it: the planner adds tabs on the same even division and reports how many in `added`. The
 * user's count is a minimum, not a cap.
 *
 * A requested tab with no edge long enough is not placed and is counted in `unplaceable`; the CAM
 * reports it as `tab-unplaceable` rather than silently cutting the part free. Overlapping
 * placements are also counted unplaceable: two tabs in one place are one tab, not two.
 *
 * #1073 — `targets` replaces the placement rules with one arc position per tab (the release pass
 * computes its own, because its corner/bore clearances are not evenly spaced). The edge choice,
 * the span-on-one-edge rule and the overlap rule are the SAME as before.
 */
export function placeTabs(
  contour: readonly (readonly [number, number])[],
  count: number,
  widthMm: number,
  toolRadius: number,
  options?: TabPlacementOptions,
): TabPlacement {
  const { segments, perimeter } = segmentsOf(contour);
  const spanLength = widthMm + 2 * toolRadius;
  if (count <= 0 || perimeter <= 0 || !(spanLength > 0) || segments.length === 0) {
    return { spans: [], unplaceable: count > 0 ? count : 0, added: 0, tight: [] };
  }
  const targets = options?.targets;
  // #1207 — the corner angle is the shop's `tabs.cornerDeg`; a caller that states none reads the
  // registry's recommendation here (never an ambient source — `readDefault(null, …)`).
  const cornerRad = (options?.cornerDeg ?? readDefault(null, 'tabs.cornerDeg').value) * (Math.PI / 180);
  // #1206's single-segment straight edge is for the DEFAULT placement: the release pass (#1073)
  // hands explicit targets and keeps the edge structure it was tuned against.
  const edges = edgesOf(segments, perimeter, targets === undefined ? spanLength : 0, cornerRad);
  if (targets !== undefined) {
    return placeOnEdges(segments, perimeter, edges, count, spanLength, (k) => targets[k] ?? ((k + 0.5) / count) * perimeter);
  }
  // A ROUND outline is one smooth edge around the whole contour: equal spacing is its own
  // symmetry, and there is no side midpoint to prefer.
  if (edges.length === 1 && edges[0]!.end - edges[0]!.start >= perimeter - 1e-6) {
    const placed = placeOnEdges(segments, perimeter, edges, count, spanLength, (k) => ((k + 0.5) / count) * perimeter);
    // #1258 — a round outline has no edge inside a stretch to tab, so a stretch past the limit is
    // reported with no candidate (the step-2 tab never applied to it; the contour used to refuse).
    const limit = options?.maxSpanMm;
    if (options?.tabChoice === undefined) return placed;
    const sorted = placed.spans.map((span) => ({ startArc: span.startArc, endArc: span.endArc })).sort((a, b) => a.startArc - b.startArc);
    const stretches =
      limit !== undefined && Number.isFinite(limit) && limit > 0
        ? stretchesOf(sorted, edges, segments, perimeter, widthMm, spanLength, limit, cornerRad)
        : [];
    return { ...placed, stretches };
  }
  return placeMidSide(segments, perimeter, edges, count, widthMm, spanLength, options?.maxSpanMm, cornerRad, options?.tabChoice);
}

/**
 * The equal-interval (and #1073 explicit-target) placement: each tab at `targetOf(k)`, clamped
 * into the edge nearest that target, never crossing an edge and never overlapping one placed.
 */
function placeOnEdges(
  segments: readonly Segment[],
  perimeter: number,
  edges: readonly Edge[],
  count: number,
  spanLength: number,
  targetOf: (k: number) => number,
): TabPlacement {
  const chosen: { startArc: number; endArc: number; distance: number }[] = [];
  let unplaceable = 0;
  for (let k = 0; k < count; k++) {
    const target = targetOf(k);
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
    added: 0,
    tight: [],
  };
}

/** #1206 — one placeable side: an edge, its corner margin, and how many evenly divided tabs fit. */
interface SideEdge {
  start: number;
  end: number;
  length: number;
  /** The TAB's material comes no closer than this to either end: `max(2 × tab width, 10 % of the edge)`. */
  margin: number;
  /** Most tabs the edge can hold at its own even division. */
  maxTabs: number;
}

/**
 * #1206 — the edges that can hold a tab at all, LONGEST FIRST. `n` tabs sit at the edge's own
 * `(i + 1)/(n + 1)` divisions; a tab is `width` of MATERIAL centred there, so its nearest kept
 * edge is `L/(n + 1) − width/2` from a corner: `n` tabs fit while
 * `L/(n + 1) ≥ margin + width/2`. (The cutter's centre-path span reaches a radius further, but
 * that part is the cutter lifted over the tab — it is air, not the corner-cantilever risk the
 * margin protects against.)
 *
 * THE MARGIN IS CAPPED SO IT CAN NEVER EMPTY AN EDGE THAT FITS A TAB. The rule's own sentence —
 * "an edge too short for that takes none" — is about an edge too short to hold a tab at all. A
 * real relief perimeter is made of 15–25 mm edges; `2 × tab width` (12 mm for the shop's 6 mm
 * tabs) at each end would leave no room on every one of them and the part would be cut free with
 * no tabs and no finding (the model plan's contour reports none). Capped at `(L − width)/2`, an
 * edge that is at least one centre-path span long always keeps its centred tab, as far from the
 * corners as the edge allows; long edges keep the full margin.
 */
/**
 * The corner margin of an edge of this length: the usual rule, `max(2 × tab width, 10 % of the
 * edge)`, capped so it never empties an edge that fits a tab. An edge shorter than one centre-path
 * span takes no tab at all under the rule, so its margin is the rule's own, uncapped.
 */
function edgeMargin(length: number, widthMm: number, spanLength?: number): number {
  const rule = Math.max(2 * widthMm, 0.1 * length);
  if (spanLength !== undefined && length < spanLength - 1e-9) return rule;
  return Math.min(rule, (length - widthMm) / 2);
}

function sideEdges(edges: readonly Edge[], widthMm: number, spanLength: number): SideEdge[] {
  const out: SideEdge[] = [];
  for (const edge of edges) {
    const length = edge.end - edge.start;
    if (!(length > 0)) continue;
    const margin = edgeMargin(length, widthMm);
    // `spanLength` still gates the edge: a span longer than the edge cannot sit on it at all.
    if (length < spanLength - 1e-9) continue;
    const maxTabs = Math.floor(length / (margin + widthMm / 2) + 1e-9) - 1;
    if (maxTabs >= 1) out.push({ start: edge.start, end: edge.end, length, margin, maxTabs });
  }
  return out.sort((a, b) => b.length - a.length || a.start - b.start);
}

/** The spans an allocation makes, in the edges' own lifted arc space, sorted along the contour. */
function spansOfSides(
  sides: readonly SideEdge[],
  counts: ReadonlyMap<SideEdge, number>,
  spanLength: number,
): { startArc: number; endArc: number }[] {
  const out: { startArc: number; endArc: number }[] = [];
  for (const side of sides) {
    const n = counts.get(side) ?? 0;
    for (let i = 1; i <= n; i++) {
      const centre = side.start + (side.length * i) / (n + 1);
      out.push({ startArc: centre - spanLength / 2, endArc: centre + spanLength / 2 });
    }
  }
  return out.sort((a, b) => a.startArc - b.startArc);
}

/** The arc distance from each span's end to the next span's start, mm (the gap the limit bounds). */
function spanGaps(spans: readonly { startArc: number; endArc: number }[], perimeter: number): number[] {
  const gaps: number[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const next = spans[(i + 1) % spans.length]!;
    if (spans.length === 1) {
      gaps.push(perimeter - (span.endArc - span.startArc));
      continue;
    }
    let gap = (next.startArc - span.endArc) % perimeter;
    if (gap < 0) gap += perimeter;
    gaps.push(gap);
  }
  return gaps;
}

/** The circular distance from an arc position to an edge's interval (0 when it lies on the edge). */
function arcDistanceToSide(side: SideEdge, at: number, perimeter: number): number {
  let off = (at - side.start) % perimeter;
  if (off < 0) off += perimeter;
  const lifted = side.start + off;
  if (lifted <= side.end + 1e-9) return 0;
  return Math.min(lifted - side.end, perimeter - off);
}

/**
 * #1206 — close the widest gap. One tab is added to the nearest edge that still has capacity, on
 * that edge's own even division; adding a tab re-divides the edge, so every round re-reads the
 * gaps. Stops when no gap is wider than the limit or no edge can take another tab.
 */
function meetSpanLimit(
  sides: readonly SideEdge[],
  counts: Map<SideEdge, number>,
  spanLength: number,
  perimeter: number,
  maxSpanMm: number,
): void {
  for (let guard = 0; guard < 4096; guard++) {
    const spans = spansOfSides(sides, counts, spanLength);
    if (spans.length === 0) return;
    const gaps = spanGaps(spans, perimeter);
    let worst = 0;
    for (let i = 1; i < gaps.length; i++) if (gaps[i]! > gaps[worst]!) worst = i;
    if (gaps[worst]! <= maxSpanMm + 1e-9) return;
    const from = spans[worst]!;
    const at = (((from.endArc + gaps[worst]! / 2) % perimeter) + perimeter) % perimeter;
    let pick: SideEdge | null = null;
    let pickDistance = Infinity;
    for (const side of sides) {
      if (counts.get(side)! >= side.maxTabs) continue;
      const distance = arcDistanceToSide(side, at, perimeter);
      if (distance < pickDistance - 1e-12) {
        pick = side;
        pickDistance = distance;
      }
    }
    if (pick === null) return;
    counts.set(pick, counts.get(pick)! + 1);
  }
}

/**
 * #1206 — mid-side placement. Allocation: every usable edge gets one tab before any gets a second
 * (longest first), then the remainder is dealt in further rounds, so an edge that holds two tabs is
 * divided into thirds, three into quarters. The span limit then adds tabs where the outline is
 * left unsupported.
 */
function placeMidSide(
  segments: readonly Segment[],
  perimeter: number,
  edges: readonly Edge[],
  count: number,
  widthMm: number,
  spanLength: number,
  maxSpanMm: number | undefined,
  cornerRad: number,
  tabChoice: TabChoiceMode | undefined,
): TabPlacement {
  const sides = sideEdges(edges, widthMm, spanLength);
  const counts = new Map<SideEdge, number>(sides.map((side) => [side, 0] as const));
  let remaining = count;
  let progress = sides.length > 0;
  while (remaining > 0 && progress) {
    progress = false;
    for (const side of sides) {
      if (remaining === 0) break;
      const n = counts.get(side)!;
      if (n < side.maxTabs) {
        counts.set(side, n + 1);
        remaining -= 1;
        progress = true;
      }
    }
  }
  if (maxSpanMm !== undefined && Number.isFinite(maxSpanMm) && maxSpanMm > 0) {
    meetSpanLimit(sides, counts, spanLength, perimeter, maxSpanMm);
  }
  const spans: { startArc: number; endArc: number }[] = [];
  for (const span of spansOfSides(sides, counts, spanLength)) {
    const startArc = ((span.startArc % perimeter) + perimeter) % perimeter;
    const endArc = startArc + spanLength;
    // A span beside the contour's seam is compared here, so a pathological contour still answers
    // one tab, not two.
    if (spans.some((placed) => arcRangesOverlap(startArc, endArc, placed.startArc, placed.endArc, perimeter))) continue;
    spans.push({ startArc, endArc });
  }
  // #1206 (the analyst's step 2) — A TAB INSIDE THE MARGIN (#1258: only on the operator's say-so). A stretch still longer than
  // the limit after every margin-respecting place gets ONE centred tab on the longest edge inside
  // it, even where the corner margin would have refused it, provided the tab's WIDTH fits centred.
  //
  // #1258 — …BUT ONLY WHEN THE OPERATOR SAID SO. With a mode stated, the stretches are first
  // REPORTED (each with the tab this step would place, called and not placed); `ask` and
  // `longerStretch` stop there, `insideMargin` goes on to place them as #1206 always did. With no
  // mode (a caller outside the model plan) the placement is exactly the pre-#1258 one.
  let tight: TightTab[] = [];
  const limited = maxSpanMm !== undefined && Number.isFinite(maxSpanMm) && maxSpanMm > 0;
  let stretches: TabStretch[] | undefined;
  if (limited && tabChoice !== undefined) {
    // REPORT FIRST, ON A COPY: the very function that places the tabs below runs here on a clone
    // of the spans, so what the question lists is what `insideMargin` then places — by
    // construction, not by a second implementation.
    spans.sort((x, y) => x.startArc - y.startArc);
    stretches = stretchesOf(spans, edges, segments, perimeter, widthMm, spanLength, maxSpanMm!, cornerRad);
  }
  if (limited && (tabChoice === undefined || tabChoice === 'insideMargin')) {
    // A mode stated: a gap no tab fits in is left (and reported) and the others are still
    // tabbed. Absent: the pre-#1258 loop, which stops at the first gap it cannot fix.
    tight = placeStepTwo(spans, edges, segments, perimeter, widthMm, spanLength, maxSpanMm!, cornerRad, tabChoice !== undefined).map((t) => t.tab);
  }
  spans.sort((a, b) => a.startArc - b.startArc);
  return {
    spans: spans.map((span) => {
      const points = runAlong(segments, perimeter, span.startArc, spanLength);
      return {
        startArc: span.startArc,
        endArc: span.endArc,
        start: points[0]!,
        end: points[points.length - 1]!,
        points,
      };
    }),
    unplaceable: Math.max(0, count - spans.length),
    added: Math.max(0, spans.length - count),
    tight,
    ...(tabChoice === undefined ? {} : { stretches: stretches ?? [] }),
  };
}

/**
 * The widest gap between consecutive spans (sorted by start), mm, and the span it follows. A gap
 * whose preceding span ends at an arc in `skip` is ignored (#1258: a gap no tab fits in).
 */
function worstGap(
  spans: readonly { startArc: number; endArc: number }[],
  perimeter: number,
  spanLength: number,
  skip?: ReadonlySet<number>,
): { gap: number; index: number } {
  let worst = 0;
  let worstIndex = -1;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    if (skip?.has(Math.round(span.endArc * 1e6)) === true) continue;
    const next = spans[(i + 1) % spans.length]!;
    let gap: number;
    if (spans.length === 1) {
      gap = perimeter - spanLength;
    } else {
      let gapEnd = next.startArc;
      if (next.startArc < span.endArc) gapEnd += perimeter;
      gap = gapEnd - span.endArc;
    }
    if (gap > worst) {
      worst = gap;
      worstIndex = i;
    }
  }
  return { gap: worst, index: worstIndex };
}

/**
 * #1206 step 2's pick, extracted so #1258 can call it without placing: the longest edge that lies
 * inside the stretch `[from, to]`. THE TAB'S WIDTH must fit centred within the STRETCH (the
 * material may cross the short edges' corners — that is the price of holding), and the tab must
 * not overlap one already placed. `null` — no edge qualifies.
 */
function pickTightEdge(
  spans: readonly { startArc: number; endArc: number }[],
  edges: readonly Edge[],
  from: number,
  to: number,
  widthMm: number,
  spanLength: number,
  perimeter: number,
): { start: number; end: number } | null {
  let pick: { start: number; end: number } | null = null;
  for (const edge of edges) {
    const length = edge.end - edge.start;
    if (!(length > 0)) continue;
    const candStart = edge.start + Math.round((from - edge.start) / perimeter) * perimeter;
    const candEnd = candStart + length;
    if (candStart < from - 1e-9 || candEnd > to + 1e-9) continue;
    const centre = candStart + length / 2;
    if (centre - widthMm / 2 < from - 1e-9 || centre + widthMm / 2 > to + 1e-9) continue;
    const startArc = (((centre - spanLength / 2) % perimeter) + perimeter) % perimeter;
    const endArc = startArc + spanLength;
    if (spans.some((placed) => arcRangesOverlap(startArc, endArc, placed.startArc, placed.endArc, perimeter))) continue;
    if (pick === null || length > pick.end - pick.start) pick = { start: candStart, end: candEnd };
  }
  return pick;
}

/** One step-2 tab as placed: its facts for the sheet, and where it sits (arc, nearer corner). */
interface PlacedTight {
  tab: TightTab;
  centreArc: number;
  cornerArc: number;
}

/**
 * #1206 step 2 — THE ITERATIVE PLACEMENT, one function for both uses. Tabs the worst gap, re-sorts
 * and goes round again while any gap is over the limit, MUTATING `spans`. `skipUnfixable` (#1258):
 * a gap no tab fits in is marked and passed over, so the other gaps are still tabbed; off, the
 * loop stops at the first such gap exactly as it always did. The question runs this on a copy
 * and `insideMargin` runs it on the real spans — the same code on the same input.
 */
function placeStepTwo(
  spans: { startArc: number; endArc: number }[],
  edges: readonly Edge[],
  segments: readonly Segment[],
  perimeter: number,
  widthMm: number,
  spanLength: number,
  maxSpanMm: number,
  cornerRad: number,
  skipUnfixable: boolean,
): PlacedTight[] {
  const placedTabs: PlacedTight[] = [];
  const unfixable = new Set<number>();
  for (let guard = 0; guard < 512; guard++) {
    spans.sort((a, b) => a.startArc - b.startArc);
    if (spans.length === 0) break;
    const gap = worstGap(spans, perimeter, spanLength, unfixable);
    const worst = gap.gap;
    const worstIndex = gap.index;
    if (worstIndex < 0 || worst <= maxSpanMm + 1e-9) break;
    const span = spans[worstIndex]!;
    const next = spans[(worstIndex + 1) % spans.length]!;
    const from = span.endArc;
    let to = spans.length === 1 ? span.startArc + perimeter : next.startArc;
    if (spans.length > 1 && next.startArc < span.endArc) to += perimeter;
    const pick = pickTightEdge(spans, edges, from, to, widthMm, spanLength, perimeter);
    if (pick === null) {
      if (!skipUnfixable) break;
      unfixable.add(Math.round(from * 1e6));
      continue;
    }
    const centre = pick.start + (pick.end - pick.start) / 2;
    const startArc = (((centre - spanLength / 2) % perimeter) + perimeter) % perimeter;
    const endArc = startArc + spanLength;
    if (spans.some((placed) => arcRangesOverlap(startArc, endArc, placed.startArc, placed.endArc, perimeter))) {
      if (!skipUnfixable) break;
      unfixable.add(Math.round(from * 1e6));
      continue;
    }
    spans.push({ startArc, endArc });
    // The joins the tab's span crosses, and how many of them turn sharper than the placement's
    // own smooth-arc limit (tabs.cornerDeg — a corner, not an arc joint).
    const spanStart = centre - spanLength / 2;
    let joins = 0;
    let sharpJoins = 0;
    for (let k = 0; k < segments.length; k++) {
      let d = (segments[k]!.start - spanStart) % perimeter;
      if (d < 0) d += perimeter;
      if (d <= 1e-9 || d >= spanLength - 1e-9) continue;
      joins += 1;
      const u = segments[(k - 1 + segments.length) % segments.length]!;
      const v = segments[k]!;
      const ud = unitDirection(u.a, u.b);
      const vd = unitDirection(v.a, v.b);
      if (ud !== null && vd !== null && Math.acos(Math.max(-1, Math.min(1, ud[0] * vd[0] + ud[1] * vd[1]))) > cornerRad) {
        sharpJoins += 1;
      }
    }
    placedTabs.push({
      tab: {
        at: pointAt(segments, perimeter, centre),
        stretchMm: worst,
        cornerMm: Math.min(centre - pick.start, pick.end - centre),
        marginMm: edgeMargin(pick.end - pick.start, widthMm, spanLength),
        joins,
        sharpJoins,
      },
      centreArc: centre,
      cornerArc: centre - pick.start <= pick.end - centre ? pick.start : pick.end,
    });
  }
  return placedTabs;
}

/**
 * #1258 — every stretch the placed spans leave longer than the limit, in contour order, with EVERY
 * tab `insideMargin` would place in it (`candidates`, in order along the stretch) and the spans
 * left AFTER all of them (`leavesSpansMm`; `stillOverLimit` when one is still past the limit). The
 * spans must be sorted by start. Nothing is placed here: {@link placeStepTwo} runs on a copy.
 */
function stretchesOf(
  spans: readonly { startArc: number; endArc: number }[],
  edges: readonly Edge[],
  segments: readonly Segment[],
  perimeter: number,
  widthMm: number,
  spanLength: number,
  maxSpanMm: number,
  cornerRad: number,
): TabStretch[] {
  const out: TabStretch[] = [];
  if (spans.length === 0) return out;
  // The stretches as they stand, in arc space.
  const intervals: { from: number; to: number; gap: number }[] = [];
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const next = spans[(i + 1) % spans.length]!;
    const from = span.endArc;
    let to: number;
    let gap: number;
    if (spans.length === 1) {
      to = span.startArc + perimeter;
      gap = perimeter - spanLength;
    } else {
      to = next.startArc;
      if (next.startArc < span.endArc) to += perimeter;
      gap = to - from;
    }
    if (gap > maxSpanMm + 1e-9) intervals.push({ from, to, gap });
  }
  if (intervals.length === 0) return out;
  // The placement, on a copy, then each placed tab filed under the stretch it falls in.
  const copy = spans.map((span) => ({ startArc: span.startArc, endArc: span.endArc }));
  const placed = placeStepTwo(copy, edges, segments, perimeter, widthMm, spanLength, maxSpanMm, cornerRad, true);
  const lift = (arc: number, from: number): number => from + ((((arc - from) % perimeter) + perimeter) % perimeter);
  for (const iv of intervals) {
    const mine = placed
      .map((p) => ({ p, at: lift(p.centreArc, iv.from) }))
      .filter((m) => m.at <= iv.to + 1e-9)
      .sort((x, y) => x.at - y.at);
    // The spans left in this stretch once those tabs stand: the gaps between from, each tab's span, to.
    const leaves: number[] = [];
    let cursor = iv.from;
    for (const m of mine) {
      leaves.push(m.at - spanLength / 2 - cursor);
      cursor = m.at + spanLength / 2;
    }
    leaves.push(mine.length === 0 ? iv.gap : iv.to - cursor);
    out.push({
      index: out.length,
      spanMm: iv.gap,
      startXY: pointAt(segments, perimeter, iv.from),
      endXY: pointAt(segments, perimeter, iv.to),
      candidates: mine.map((m) => ({
        atXY: m.p.tab.at,
        fromCornerMm: m.p.tab.cornerMm,
        cornerXY: pointAt(segments, perimeter, m.p.cornerArc),
        marginMm: m.p.tab.marginMm,
      })),
      leavesSpansMm: leaves,
      stillOverLimit: leaves.some((v) => v > maxSpanMm + 1e-9),
    });
  }
  return out;
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

/** The moves for one contour at one Z, crossing its tab spans above the tab top when needed.
 *  #1073 — exported for the flipped setup's tab release: it cuts a band, not a top-down depth, so
 *  it walks its own Z levels and reuses this contour/tab mechanism rather than a second one. */
export function contourMoves(
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
    let added = 0;
    const tight: TightTab[] = [];
    const stretches: TabStretch[] = [];
    for (const z of passes) {
      for (const contour of cut.path) {
        const placement = placeTabs(contour, cut.tabs.count, cut.tabs.width, toolRadius, {
          ...(cut.tabs.maxSpanMm === undefined ? {} : { maxSpanMm: cut.tabs.maxSpanMm }),
          ...(cut.tabs.cornerDeg === undefined ? {} : { cornerDeg: cut.tabs.cornerDeg }),
          ...(cut.tabs.tabChoice === undefined ? {} : { tabChoice: cut.tabs.tabChoice }),
        });
        // Count once per cut, not once per pass: the report is about the tabs, not the Z levels.
        if (z === passes[0]) {
          placed += placement.spans.length;
          unplaceable += placement.unplaceable;
          added += placement.added;
          tight.push(...placement.tight);
          if (placement.stretches !== undefined) stretches.push(...placement.stretches);
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
    tabs.push({ id: cut.id, name: cut.name, spans: placed, unplaceable, added, tight, ...(cut.tabs.tabChoice === undefined ? {} : { stretches }) });
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
