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
  poly,
  rectProfile,
  roundedRect,
  type Profile,
} from '@/engine/compiler/profile';
import { resolveFont } from '@/engine/fonts/registry';
import type {
  EngraveAnyItem,
  EngraveCombinedShape,
  EngraveJob,
  EngraveLabel,
  EngraveShape,
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

/** Is this item one of the shape kinds (#214/#215) rather than a text label? */
function isShape(item: EngraveAnyItem): item is EngraveShape | EngraveCombinedShape {
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
  const all: EngraveAnyItem[] = [...job.labels, ...job.shapes, ...(job.combined ?? [])];
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
  }
}

/**
 * A shape pocket (#214) as a `Profile`, centred on the ORIGIN and unrotated: the caller places
 * it. Every round primitive gets an EXPLICIT segment count from `segmentsForRadius` (#190),
 * because Manifold's default at a small radius is 4 segments and a "round" shape would land as
 * a square.
 *
 * - rect: `rectProfile` (already centred) or a shifted `roundedRect` (its bbox-min is at 0,0).
 * - circle: centred on the origin by construction.
 * - slot: the hull of two end discs at ±(L/2 − r) — straight sides, round ends.
 * - polygon: the points as given, relative to `position` (so the origin IS `position`).
 */
function shapeProfile(shape: EngraveShape): Profile {
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

  return {
    stock: {
      outline: stockOutline,
      thickness: job.stock.thickness,
      keepOuts: [],
    },
    engraves,
  };
}
