import { glyphProfile } from '@/engine/compiler/glyphs';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import {
  aabbOfProfile,
  circleProfile,
  pDifference,
  pHull,
  pOffset,
  pRotate,
  pTranslate,
  pUnion,
  poly,
  rectProfile,
  roundedRect,
  type Profile,
} from '@/engine/compiler/profile';
import { resolveFont } from '@/engine/fonts/registry';
import { strokeGlyphPaths } from '@/engine/fonts/stroke/strokeFont';
import type {
  EngraveAnyItem,
  EngraveCombinedShape,
  EngraveJob,
  EngraveLabel,
  EngraveShape,
  EngraveTraceItem,
  EngraveVectorShape,
} from '@/types/engraveJob';
import type { CustomFont } from '@/types/textLabel';
import type { Mm } from '@/types/units';

/**
 * `PartPlan` is the seam #172 specified (`/Fabrication.md` §5.2): profiles and a target Z,
 * never a mesh. The compiler knows the region and the depth; a mesh discards both and forces
 * CAM to re-infer them.
 *
 * Two differences from the §5.2 sketch (#200):
 *  - `split` is omitted: wood has no colour layers. The badge adds it back in CNC-3.
 *  - `keepOuts` is `[]` for a solid block — no magnet pocket to reserve.
 */
export interface PartPlan {
  stock: {
    outline: Profile;
    thickness: Mm;
    keepOuts: { footprint: Profile; zCeiling: Mm }[];
  };
  engraves: { id: string; name: string; profile: Profile; depth: Mm }[];
  /**
   * SINGLE-LINE traces (#219), a SIBLING of `engraves` rather than more entries in it. A trace
   * is not a region — the cutter's centre follows the path, so the cut is one cutter wide and
   * the region pipeline (#201's opening, offsetting, pocketing) would erase it. CAM turns each
   * entry into a plunge/feed/retract operation; the preview and oracle read the swept region
   * `traceSweptProfile` derives from it.
   *
   * `paths` are in the STOCK frame, one polyline per path (a line item has one; a stroke label
   * one per pen stroke); `closed[i]` says whether `paths[i]` returns to its first point.
   */
  traces: { id: string; name: string; paths: [Mm, Mm][][]; closed: boolean[]; depth: Mm }[];
}

/**
 * The text of one label as a `Profile` in the STOCK frame (front-left at the origin):
 * typeset with its cap height at the origin, centred on its bounding box, rotated about
 * that centre, then translated to `label.position`.
 *
 * `glyphProfile` returns the text with its baseline at the origin, so the placement is three
 * moves in this order (the order matters — rotating after centring keeps the rotation about
 * the text's own centre, not the stock origin).
 *
 * An empty or whitespace-only label yields an empty `p-poly`; it is kept in the plan so
 * #201 can report it rather than the job silently losing a row.
 */
export function labelProfile(label: EngraveLabel, customFonts: readonly CustomFont[]): Profile {
  const glyphs = glyphProfile(label.text, resolveFont(label.font, label.weight, customFonts), label.size);
  const box = aabbOfProfile(glyphs);
  if (!box) return glyphs; // whitespace-only: nothing to centre or place
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const centred = pTranslate([-cx, -cy], glyphs);
  const rotated = pRotate(label.rotation, centred);
  return pTranslate([label.position.x, label.position.y], rotated);
}

/** The region item kinds: the simple shapes (#214), the combined kinds (#215) and vectors (#217). */
type EngraveRegionItem = EngraveShape | EngraveCombinedShape | EngraveVectorShape;

/** Is this item one of the shape kinds (#214/#215/#217) rather than a text label? */
function isShape(item: EngraveAnyItem): item is EngraveRegionItem {
  return 'kind' in item;
}

/**
 * The item ids an item references (#215). A `frame` names one outline to follow; a `cutaway`
 * names the outline to clear plus the islands to leave standing. Everything else references
 * nothing.
 */
export function itemReferences(item: EngraveAnyItem): string[] {
  if (!isShape(item)) return [];
  switch (item.kind) {
    case 'frame':
      return [item.around];
    case 'cutaway':
      return [item.outer, ...item.islands];
    default:
      return [];
  }
}

/** Why an `item-reference` error fired (#215). */
export type ItemReferenceIssue = 'missing' | 'disabled' | 'self' | 'cycle';

/** A bad reference from one item to another (#215) — the data behind an `item-reference` finding. */
export interface ItemReferenceError {
  /** The item doing the referencing. */
  itemId: string;
  /** The id it names. */
  referencedId: string;
  reason: ItemReferenceIssue;
}

export interface ResolvedItems {
  /** Enabled, resolvable items in dependency order: every referenced item precedes its referrer. */
  order: EngraveAnyItem[];
  /** One entry per bad reference. An item with any error is absent from `order`. */
  errors: ItemReferenceError[];
}

/**
 * Topologically order a job's items and report every broken reference (#215).
 *
 * The three combined kinds name other items, so an item must be resolved before the item that
 * follows it. A reference that does not exist, points at a DISABLED item, points at itself, or
 * closes a cycle cannot produce a region: the referencing item is dropped from `order` (so
 * nothing is ever generated for it) and an error is recorded instead of throwing.
 *
 * Items with no references keep their document order, so a pre-#215 job's plan is unchanged.
 */
export function resolveItems(job: EngraveJob): ResolvedItems {
  const all: EngraveAnyItem[] = [
    ...job.labels,
    ...job.shapes,
    ...(job.combined ?? []),
    ...(job.vectors ?? []),
  ];
  const byId = new Map<string, EngraveAnyItem>();
  for (const item of all) if (!byId.has(item.id)) byId.set(item.id, item);

  const errors: ItemReferenceError[] = [];
  const order: EngraveAnyItem[] = [];
  // 0 = unvisited, 1 = on the stack, 2 = resolved, 3 = unresolvable.
  const state = new Map<string, number>();
  const cyclic = new Set<string>();
  const stack: string[] = [];

  const visit = (item: EngraveAnyItem): boolean => {
    const s = state.get(item.id) ?? 0;
    if (s === 2) return true;
    if (s === 3) return false;
    if (s === 1) {
      // A back edge: everything from `item` up the stack is part of a cycle, so none of it
      // can resolve. Mark them all and report.
      const from = stack.indexOf(item.id);
      for (let k = from; k < stack.length; k++) {
        cyclic.add(stack[k]!);
        state.set(stack[k]!, 3);
      }
      return false;
    }

    state.set(item.id, 1);
    stack.push(item.id);
    let ok = true;
    for (const ref of itemReferences(item)) {
      if (ref === item.id) {
        errors.push({ itemId: item.id, referencedId: ref, reason: 'self' });
        ok = false;
        continue;
      }
      const target = byId.get(ref);
      if (!target) {
        errors.push({ itemId: item.id, referencedId: ref, reason: 'missing' });
        ok = false;
        continue;
      }
      if (!target.enabled) {
        errors.push({ itemId: item.id, referencedId: ref, reason: 'disabled' });
        ok = false;
        continue;
      }
      if (!visit(target)) {
        // The target exists and is enabled but could not resolve: a cycle, or a chain that
        // runs into one (or into a missing/disabled item further along).
        errors.push({ itemId: item.id, referencedId: ref, reason: cyclic.has(ref) ? 'cycle' : 'missing' });
        ok = false;
      }
    }
    stack.pop();
    if (ok) {
      state.set(item.id, 2);
      order.push(item);
      return true;
    }
    state.set(item.id, 3);
    return false;
  };

  // Only ENABLED items can cut; a disabled item can never be a valid target (that is a
  // 'disabled' error above), and it produces no region of its own.
  for (const item of all) if (item.enabled) visit(item);

  return { order, errors };
}

/**
 * The operation's display name for an item (#214, work item 4) — the DESCRIPTOR only, without
 * the `[T#]` prefix or the depth suffix. `generateEngrave` composes those, so the name on the
 * `;@MKR|TOOLPATH` line reads `[T1]Pocket rect 20×10 1.0mm`, `[T1]Pocket circle ⌀6 2.0mm`, ….
 *
 * It lives HERE, next to `itemProfile`, because the kind and size it words live on the item;
 * the CAM layer receives the finished string on `EngraveRegion.name` and stays free of the
 * document's shape fields. It deliberately parallels `itemLabel` (`jobSetup.ts`) but does not
 * share its wording: a FINDING reads `Rectangle 20×10`, an OPERATION reads `Pocket rect 20×10`.
 */
export function itemOperationName(item: EngraveAnyItem): string {
  if (!isShape(item)) return `Engrave "${item.text}"`;
  const named = item.name ? ` "${item.name}"` : '';
  switch (item.kind) {
    case 'rect':
      return `Pocket rect${named} ${item.width}×${item.height}`;
    case 'circle':
      return `Pocket circle${named} ⌀${item.diameter}`;
    case 'slot':
      return `Pocket slot${named} ${item.length}×${item.width}`;
    case 'polygon':
      return `Pocket polygon${named} (${item.points.length} points)`;
    case 'border':
      return `Pocket border${named} ${item.width} wide, ${item.inset} in`;
    case 'frame':
      return `Pocket frame${named} ${item.width} wide, ${item.gap} gap`;
    case 'cutaway':
      return `Pocket cutaway${named} (${item.islands.length} island${item.islands.length === 1 ? '' : 's'})`;
    case 'vector': {
      const n = item.contours.length;
      return `Pocket outline${named} (${n} contour${n === 1 ? '' : 's'}, ${item.width}×${item.height}mm)`;
    }
  }
}

/**
 * A shape pocket (#214) or imported outline (#217) as a `Profile`, centred on the ORIGIN and
 * unrotated: the caller places it. Every round primitive gets an EXPLICIT segment count from
 * `segmentsForRadius` (#190), because Manifold's default at a small radius is 4 segments and a
 * "round" shape would land as a square.
 *
 * - rect: `rectProfile` (already centred) or a shifted `roundedRect` (its bbox-min is at 0,0).
 * - circle: centred on the origin by construction.
 * - slot: the hull of two end discs at ±(L/2 − r) — straight sides, round ends.
 * - polygon: the points as given, relative to `position` (so the origin IS `position`).
 * - vector: the imported rings as given (already mm, already centred), with their own fill rule —
 *   `NonZero` keeps an SVG's oppositely-wound holes, `EvenOdd` makes every enclosed ring a hole.
 */
function shapeProfile(shape: EngraveShape | EngraveVectorShape): Profile {
  switch (shape.kind) {
    case 'rect': {
      const { width, height, cornerRadius } = shape;
      if (cornerRadius <= 0) return rectProfile(width, height, true);
      return pTranslate([-width / 2, -height / 2], roundedRect(width, height, cornerRadius));
    }
    case 'circle': {
      const radius = shape.diameter / 2;
      return circleProfile(radius, segmentsForRadius(radius));
    }
    case 'slot': {
      const radius = shape.width / 2;
      const segments = segmentsForRadius(radius);
      const halfCentre = shape.length / 2 - radius;
      return pHull([
        pTranslate([-halfCentre, 0], circleProfile(radius, segments)),
        pTranslate([halfCentre, 0], circleProfile(radius, segments)),
      ]);
    }
    case 'polygon':
      return poly(shape.points.map(([x, y]) => [x, y] as [number, number]));
    case 'vector':
      return { kind: 'p-poly', contours: shape.contours, fillRule: shape.fillRule };
  }
}

/**
 * What a reference-following kind (#215) needs to resolve: the stock outline a `border` offsets
 * in from, and the PLACED profile of any item a `frame` or `cutaway` names. `toPartPlan` builds
 * it while walking the topologically ordered items, so every target is already resolved.
 */
export interface ItemReferenceContext {
  /** The stock outline in the stock frame (front-left at the origin); `border` offsets in from it. */
  stockOutline: Profile;
  /** The placed stock-frame profile of item `id`, or null when it is absent from the plan. */
  profileOf(id: string): Profile | null;
}

/** The empty region an unresolved reference yields — never a crash, and no cut (#215). */
function emptyProfile(): Profile {
  return poly([]);
}

/** A ring between two offsets of one outline: `outer − inner` (#215). */
function ringProfile(outer: Profile, inner: Profile): Profile {
  return pDifference([outer, inner]);
}

/**
 * One engrave ITEM (#214/#215) as a `Profile` in the STOCK frame — the single entry point. A
 * text label keeps its own `labelProfile` placement; a simple shape is centred on the origin,
 * rotated about that point, then translated to `position`.
 *
 * The three combined kinds (#215) are DERIVED, so their inherited `position`/`rotation` are
 * ignored and `ctx` is required:
 *  - `border` = `offset(stock, −inset) − offset(stock, −inset − width)`.
 *  - `frame`  = `offset(target, gap + width) − offset(target, gap)`.
 *  - `cutaway` = `profile(outer) − ⋃ profile(islands)`.
 * A missing/disabled/cyclic reference yields an empty profile; `resolveItems` is what reports
 * it and `toPartPlan` never even calls `itemProfile` for such an item.
 */
export function itemProfile(
  item: EngraveAnyItem,
  customFonts: readonly CustomFont[],
  ctx?: ItemReferenceContext,
): Profile {
  if (!isShape(item)) return labelProfile(item, customFonts);
  switch (item.kind) {
    case 'border': {
      if (!ctx) return emptyProfile();
      const { stockOutline } = ctx;
      return ringProfile(
        pOffset(stockOutline, -item.inset, 'round'),
        pOffset(stockOutline, -(item.inset + item.width), 'round'),
      );
    }
    case 'frame': {
      const target = ctx?.profileOf(item.around) ?? null;
      if (!target) return emptyProfile();
      return ringProfile(
        pOffset(target, item.gap + item.width, 'round'),
        pOffset(target, item.gap, 'round'),
      );
    }
    case 'cutaway': {
      const outer = ctx?.profileOf(item.outer) ?? null;
      if (!outer) return emptyProfile();
      const islands: Profile[] = [];
      for (const id of item.islands) {
        const island = ctx?.profileOf(id) ?? null;
        // A cutaway with a bad island reference does not resolve at all — `resolveItems` drops
        // it. Reaching here without a profile means an empty result rather than a half-cut panel.
        if (!island) return emptyProfile();
        islands.push(island);
      }
      return pDifference([outer, ...islands]);
    }
    default: {
      // A simple shape (#214): centred on the origin, rotated about that point, then placed.
      const placed = pRotate(item.rotation, shapeProfile(item));
      return pTranslate([item.position.x, item.position.y], placed);
    }
  }
}

/** Orientation sign of the turn p→q→r: +1 left, −1 right, 0 collinear. */
function orient(p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]): number {
  const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Is `r` within the bounding box of segment pq (collinear-touch test). */
function onSegment(
  p: readonly [number, number],
  q: readonly [number, number],
  r: readonly [number, number],
): boolean {
  return (
    Math.min(p[0], q[0]) <= r[0] &&
    r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] &&
    r[1] <= Math.max(p[1], q[1])
  );
}

function segmentsIntersect(
  a1: readonly [number, number],
  a2: readonly [number, number],
  b1: readonly [number, number],
  b2: readonly [number, number],
): boolean {
  const o1 = orient(a1, a2, b1);
  const o2 = orient(a1, a2, b2);
  const o3 = orient(b1, b2, a1);
  const o4 = orient(b1, b2, a2);
  if (o1 !== o2 && o3 !== o4) return true;
  // Collinear touches: an endpoint lying on the other segment still self-intersects.
  if (o1 === 0 && onSegment(a1, a2, b1)) return true;
  if (o2 === 0 && onSegment(a1, a2, b2)) return true;
  if (o3 === 0 && onSegment(b1, b2, a1)) return true;
  if (o4 === 0 && onSegment(b1, b2, a2)) return true;
  return false;
}

/**
 * True when a closed point ring crosses itself, so it is not a simple region — the fill rule
 * would invent one from the crossing edges (#214). Adjacent edges share a vertex and are
 * ignored; any other pair touching (crossing, or a pinched vertex) counts.
 */
export function polygonSelfIntersects(points: readonly [number, number][]): boolean {
  const n = points.length;
  if (n < 3) return true;
  for (let i = 0; i < n; i++) {
    const a1 = points[i]!;
    const a2 = points[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      // Skip edge i's neighbours (they share a vertex by construction).
      if (j === (i + 1) % n) continue;
      if ((j + 1) % n === i) continue;
      const b1 = points[j]!;
      const b2 = points[(j + 1) % n]!;
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/* ---------------------------------------------------------------------------------------------
 * Single-line traces (#219)
 *
 * A trace is NOT a region, so nothing here funnels through `itemProfile`, `engraves` or the
 * region-item switches: the cutter's centre rides the path, cutting a groove one cutter wide.
 * These three functions are the whole engine model — the CAM (`cam/trace.ts`) turns the paths
 * into moves, the preview and oracle read the swept region, and the validator reads the
 * self-overlap list. All pure and synchronous, like `toPartPlan`.
 * -------------------------------------------------------------------------------------------*/

/** Rotate `p` counter-clockwise by `deg` about the origin — the placement convention every item uses. */
function rotateAboutOrigin(p: readonly [number, number], deg: number): [number, number] {
  if (deg === 0) return [p[0], p[1]];
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
}

/** The bounding box of a set of polylines, or null when they hold no point at all. */
function pathsBounds(
  paths: readonly (readonly [Mm, Mm][])[],
): { min: [number, number]; max: [number, number] } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const path of paths) {
    for (const [x, y] of path) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { min: [minX, minY], max: [maxX, maxY] };
}

/**
 * The open/closed polylines one trace item cuts, in the STOCK frame — the trace twin of
 * `itemProfile`.
 *
 * A `line`'s points are relative to `position`, so they are rotated about the origin and then
 * translated (the same order a simple shape uses). A `stroke-label` is typeset baseline-at-origin
 * (`strokeGlyphPaths`), centred on its bounding box, rotated about that centre and translated to
 * `position` — exactly `labelProfile`'s three moves, so the same text in a stroke font lands where
 * the outline-font label would.
 *
 * A blank stroke label yields no paths; `toPartPlan` then keeps it out of the plan rather than
 * emitting an empty operation.
 */
export function tracePaths(item: EngraveTraceItem): { paths: [Mm, Mm][][]; closed: boolean[] } {
  if (item.kind === 'line') {
    const path = item.points.map(([x, y]): [Mm, Mm] => {
      const [rx, ry] = rotateAboutOrigin([x, y], item.rotation);
      return [rx + item.position.x, ry + item.position.y];
    });
    return { paths: [path], closed: [item.closed] };
  }

  const raw = strokeGlyphPaths(item.text, item.font, item.size);
  if (raw.length === 0) return { paths: [], closed: [] };
  const box = pathsBounds(raw);
  const cx = box ? (box.min[0] + box.max[0]) / 2 : 0;
  const cy = box ? (box.min[1] + box.max[1]) / 2 : 0;
  const paths = raw.map((path) =>
    path.map(([x, y]): [Mm, Mm] => {
      const [rx, ry] = rotateAboutOrigin([x - cx, y - cy], item.rotation);
      return [rx + item.position.x, ry + item.position.y];
    }),
  );
  return { paths, closed: paths.map(() => false) };
}

/**
 * The operation's display name for a trace — the DESCRIPTOR only, without the `[T#]` prefix or
 * the depth suffix, exactly as `itemOperationName` contracts: `generateTrace` composes the rest,
 * so the `;@MKR|TOOLPATH` line reads `[T1]Trace line (5 points, closed) 1.0mm`.
 */
export function traceOperationName(item: EngraveTraceItem): string {
  const named = item.name ? ` "${item.name}"` : '';
  if (item.kind === 'line') {
    const n = item.points.length;
    return `Trace line${named} (${n} point${n === 1 ? '' : 's'}${item.closed ? ', closed' : ''})`;
  }
  return `Trace text "${item.text}"${named}`;
}

/**
 * The region a trace's cutter SWEEPS: the union of radius-`r` discs centred at every path point —
 * the capsules of its segments plus a cap at each free end. This is a trace's PREDICTED region for
 * the preview (#205) and the oracle (#206): a trace has no interior, so the usual region pipeline
 * (offset, pocket) would erase it, and the prediction has to be built from the path itself.
 *
 * Every disc carries an EXPLICIT segment count from `segmentsForRadius` (#190); Manifold's default
 * at a small radius is 4 segments and a "round" cap would land as a square. A one-point path (a
 * plunge dot) is a single disc.
 */
export function traceSweptProfile(
  paths: readonly (readonly [Mm, Mm][])[],
  closed: readonly boolean[],
  radius: Mm,
): Profile {
  if (radius <= 0) return poly([]);
  const segments = segmentsForRadius(radius);
  const disc = (p: readonly [Mm, Mm]): Profile =>
    pTranslate([p[0], p[1]], circleProfile(radius, segments));
  const parts: Profile[] = [];
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi]!;
    const n = path.length;
    if (n === 0) continue;
    if (n === 1) {
      parts.push(disc(path[0]!));
      continue;
    }
    const isClosed = closed[pi] ?? false;
    const last = isClosed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = path[i]!;
      const b = path[(i + 1) % n]!;
      if (a[0] === b[0] && a[1] === b[1]) {
        parts.push(disc(a));
        continue;
      }
      // The hull of two equal discs is the capsule of the segment between them; its round ends
      // are the caps the cutter leaves at each vertex.
      parts.push(pHull([disc(a), disc(b)]));
    }
  }
  if (parts.length === 0) return poly([]);
  return parts.length === 1 ? parts[0]! : pUnion(parts);
}

/** One segment of one trace path, addressed for reporting. */
interface TraceSegment {
  path: number;
  segment: number;
  a: [Mm, Mm];
  b: [Mm, Mm];
}

/** Every segment of every path, in path order; a one-point path has none. */
function traceSegments(
  paths: readonly (readonly [Mm, Mm][])[],
  closed: readonly boolean[],
): TraceSegment[] {
  const out: TraceSegment[] = [];
  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi]!;
    const n = path.length;
    if (n < 2) continue;
    const last = (closed[pi] ?? false) ? n : n - 1;
    for (let i = 0; i < last; i++) {
      out.push({ path: pi, segment: i, a: path[i]!, b: path[(i + 1) % n]! });
    }
  }
  return out;
}

/** Shortest distance from `p` to segment `ab` (0 when `p` lies on it). */
function pointSegmentDistance(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Shortest distance between two segments; 0 when they cross. */
function segmentDistance(
  a1: readonly [number, number],
  a2: readonly [number, number],
  b1: readonly [number, number],
  b2: readonly [number, number],
): number {
  if (segmentsIntersect(a1, a2, b1, b2)) return 0;
  return Math.min(
    pointSegmentDistance(a1, b1, b2),
    pointSegmentDistance(a2, b1, b2),
    pointSegmentDistance(b1, a1, a2),
    pointSegmentDistance(b2, a1, a2),
  );
}

/** Do two segments' bounding boxes, each inflated by `pad`, overlap? A cheap pre-reject. */
function boxesNear(s: TraceSegment, t: TraceSegment, pad: number): boolean {
  const sMinX = Math.min(s.a[0], s.b[0]) - pad;
  const sMaxX = Math.max(s.a[0], s.b[0]) + pad;
  const sMinY = Math.min(s.a[1], s.b[1]) - pad;
  const sMaxY = Math.max(s.a[1], s.b[1]) + pad;
  const tMinX = Math.min(t.a[0], t.b[0]);
  const tMaxX = Math.max(t.a[0], t.b[0]);
  const tMinY = Math.min(t.a[1], t.b[1]);
  const tMaxY = Math.max(t.a[1], t.b[1]);
  return !(tMaxX < sMinX || tMinX > sMaxX || tMaxY < sMinY || tMinY > sMaxY);
}

/** One pair of a trace's segments whose cutter sweeps overlap (#219). */
export interface TraceSelfOverlap {
  /** The two segments, by path index and position within the path. */
  a: { path: number; segment: number };
  b: { path: number; segment: number };
  /** Closest distance between the two segment centrelines, mm. */
  distance: Mm;
  /** How far the two capsules overlap, `2r − distance`, mm. Positive by construction. */
  overlap: Mm;
}

/**
 * Every pair of a trace's segments whose cutter sweeps overlap — their centrelines closer than
 * `2r`, so the two strokes merge into one wider groove and small letters fill in. Adjacent
 * segments of the same path share a vertex by construction and are ignored; an empty result means
 * the trace engraves as distinct lines.
 *
 * The test is between CAPSULES, not the drawn path: two parallel strokes 0.8 mm apart with a 1 mm
 * cutter (r = 0.5) come closer than 1.0 mm and are reported. `overlap` is the amount they merge
 * by.
 */
export function traceSelfOverlaps(
  paths: readonly (readonly [Mm, Mm][])[],
  closed: readonly boolean[],
  radius: Mm,
): TraceSelfOverlap[] {
  if (radius <= 0) return [];
  const threshold = 2 * radius;
  const segs = traceSegments(paths, closed);
  const countPerPath = paths.map((p, i) => (p.length < 2 ? 0 : (closed[i] ?? false) ? p.length : p.length - 1));
  const found: TraceSelfOverlap[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const sClosed = closed[s.path] ?? false;
    for (let j = i + 1; j < segs.length; j++) {
      const t = segs[j]!;
      if (t.path === s.path) {
        const count = countPerPath[s.path]!;
        const diff = (t.segment - s.segment + count) % count;
        // Same-path neighbours share a vertex, so their capsules always overlap by design.
        if (diff === 1 || (sClosed && diff === count - 1)) continue;
      }
      if (!boxesNear(s, t, threshold)) continue;
      const d = segmentDistance(s.a, s.b, t.a, t.b);
      if (d < threshold) {
        found.push({
          a: { path: s.path, segment: s.segment },
          b: { path: t.path, segment: t.segment },
          distance: d,
          overlap: threshold - d,
        });
      }
    }
  }
  return found;
}

/**
 * The finding codes a trace raises (#219). They are declared HERE, with the geometry that detects
 * them, because `JobFindingCode` (`jobSetup.ts`) is owned by another slot; when those two members
 * are added there, the objects below are already the right shape (`{ severity, code, labelId,
 * message }`).
 *
 * `trace-outside-stock` is NOT produced here: it needs the swept region intersected with the
 * stock, which is a CrossSection evaluation the worker does (#201), not this pure module.
 */
export type TraceFindingCode = 'trace-outside-stock' | 'trace-self-overlap';

/**
 * `trace-self-overlap` findings for every enabled, non-construction trace in the job. A warning,
 * not an error: the trace still cuts, it just fills in.
 */
export function traceSelfOverlapFindings(
  job: EngraveJob,
  radius: Mm,
): { severity: 'warning'; code: TraceFindingCode; labelId: string; message: string }[] {
  const out: { severity: 'warning'; code: TraceFindingCode; labelId: string; message: string }[] = [];
  for (const item of job.traces ?? []) {
    if (!item.enabled || item.construction) continue;
    const { paths, closed } = tracePaths(item);
    const overlaps = traceSelfOverlaps(paths, closed, radius);
    if (overlaps.length === 0) continue;
    const worst = overlaps.reduce((m, o) => Math.max(m, o.overlap), 0);
    out.push({
      severity: 'warning',
      code: 'trace-self-overlap',
      labelId: item.id,
      message:
        `Strokes merge: ${overlaps.length} pair${overlaps.length === 1 ? '' : 's'} of this trace's ` +
        `lines come closer than the cutter width (up to ${worst.toFixed(2)} mm overlap). The cut ` +
        `will fill in — space the lines apart, or use a smaller cutter.`,
    });
  }
  return out;
}

/**
 * The pure derivation every downstream consumer reads. The stock outline is
 * `rectProfile(length, width)` with its FRONT-LEFT corner at the origin — the job frame IS
 * the work frame (#200 decision 3), and it is never centred.
 *
 * Labels, shapes and combined shapes funnel through `itemProfile` into the ONE `engraves` list
 * (#214/#215): the document keeps three fields so old jobs and the label pipeline are untouched,
 * but nothing downstream can tell one from another except by its id.
 *
 * Items are walked in `resolveItems`' dependency order, so a `frame`/`cutaway` always finds the
 * profile of what it references. An item with a broken reference never appears in that order.
 * A `construction` item resolves (so it can be referenced) but produces no cut of its own.
 *
 * Traces (#219) are a SEPARATE list: they take no part in `resolveItems` (nothing references one),
 * never reach `engraves`, and are appended in document order after the region items.
 */
export function toPartPlan(job: EngraveJob): PartPlan {
  const stockOutline = rectProfile(job.stock.length, job.stock.width);
  const { order } = resolveItems(job);

  const profiles = new Map<string, Profile>();
  const engraves: PartPlan['engraves'] = [];
  const ctx: ItemReferenceContext = {
    stockOutline,
    profileOf: (id) => profiles.get(id) ?? null,
  };

  for (const item of order) {
    // A self-intersecting polygon is not a region — the fill rule would invent one (#214).
    // It is dropped here, at the one funnel every consumer reads, so no toolpath is ever
    // generated for it; `validateJob` reports the `polygon-self-intersecting` finding so the
    // user sees why it is missing rather than silently losing a cut.
    if (isShape(item) && item.kind === 'polygon' && polygonSelfIntersects(item.points)) continue;

    const profile = itemProfile(item, job.customFonts, ctx);
    profiles.set(item.id, profile);
    // A construction item is reference-only (#215): it resolves, but cuts nothing.
    if (item.construction) continue;
    engraves.push({
      id: item.id,
      // The ready-made operation name (#214/#215), carried on the one funnel so the region
      // builder can hand it to `generateEngrave` without re-deriving the shape.
      name: itemOperationName(item),
      profile,
      depth: item.depth,
    });
  }

  // Traces (#219) are their own list: no topological ordering (nothing references one), no
  // profile, no region pipeline. A disabled or construction trace is skipped, like a region item;
  // a blank stroke label (no paths) is dropped rather than emitted as an empty operation.
  const traces: PartPlan['traces'] = [];
  for (const item of job.traces ?? []) {
    if (!item.enabled || item.construction) continue;
    const { paths, closed } = tracePaths(item);
    if (paths.length === 0) continue;
    traces.push({ id: item.id, name: traceOperationName(item), paths, closed, depth: item.depth });
  }

  return {
    stock: {
      outline: stockOutline,
      thickness: job.stock.thickness,
      keepOuts: [],
    },
    engraves,
    traces,
  };
}
