import { glyphProfile } from '@/engine/compiler/glyphs';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import {
  aabbOfProfile,
  circleProfile,
  pHull,
  pRotate,
  pTranslate,
  poly,
  rectProfile,
  roundedRect,
  type Profile,
} from '@/engine/compiler/profile';
import { resolveFont } from '@/engine/fonts/registry';
import type {
  EngraveItem,
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

/** Is this item one of the shape kinds (#214) rather than a text label? */
function isShape(item: EngraveItem): item is EngraveShape {
  return 'kind' in item;
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
export function itemOperationName(item: EngraveItem): string {
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
 * One engrave ITEM (#214) as a `Profile` in the STOCK frame — the single entry point the issue
 * asks for. A text label keeps its own `labelProfile` placement; a shape is centred on the
 * origin, rotated about that point, then translated to `position`. Either way the result is
 * what `PartPlan` and everything downstream ever sees: a closed 2D region and a depth.
 */
export function itemProfile(item: EngraveItem, customFonts: readonly CustomFont[]): Profile {
  if (!isShape(item)) return labelProfile(item, customFonts);
  const placed = pRotate(item.rotation, shapeProfile(item));
  return pTranslate([item.position.x, item.position.y], placed);
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
 * Labels and shapes both funnel through `itemProfile` into the ONE `engraves` list (#214): the
 * document keeps two fields so old jobs and the label pipeline are untouched, but nothing
 * downstream can tell a label from a shape except by its id.
 */
export function toPartPlan(job: EngraveJob): PartPlan {
  const toEngrave = (item: EngraveItem) => ({
    id: item.id,
    // The ready-made operation name (#214, work item 4), carried on the one funnel so the
    // region builder can hand it to `generateEngrave` without re-deriving the shape.
    name: itemOperationName(item),
    profile: itemProfile(item, job.customFonts),
    depth: item.depth,
  });
  return {
    stock: {
      outline: rectProfile(job.stock.length, job.stock.width),
      thickness: job.stock.thickness,
      keepOuts: [],
    },
    engraves: [
      ...job.labels.filter((label) => label.enabled).map(toEngrave),
      // A self-intersecting polygon is not a region — the fill rule would invent one (#214).
      // It is dropped here, at the one funnel every consumer reads, so no toolpath is ever
      // generated for it; `validateJob` reports the `polygon-self-intersecting` finding so the
      // user sees why it is missing rather than silently losing a cut.
      ...job.shapes
        .filter(
          (shape) =>
            shape.enabled && !(shape.kind === 'polygon' && polygonSelfIntersects(shape.points)),
        )
        .map(toEngrave),
    ],
  };
}
