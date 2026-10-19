/**
 * #549 — the "here is where you put it" overlay for engrave items that clip to empty.
 *
 * An enabled region item (a label, one of the four simple shapes, or an imported vector) that the
 * cutter cannot cut AT ALL — it sits out of the stock, inside the jaw-clearance margin, or is
 * refused with an error finding — produces NO floor in the worker's preview: `engravePreview.ts`
 * leaves errored items out of the cuts and skips them in the lost layer too, so `EngravePreview.tsx`
 * draws nothing for them. That is exactly the case where the operator most needs to SEE where the
 * item actually sits relative to the stock edge and the jaws.
 *
 * This module recomputes each such item's DESIGN outline — the glyphs or the shape the user placed,
 * at its REAL position — as plain point rings, from the JOB (never from the worker), so the viewport
 * can draw it as a dashed warning outline OVER the clipped preview. The clipped "what will actually
 * cut" preview stays exactly as it was; this is an additional overlay, not a replacement.
 *
 * Pure and testable (no React, no three.js): the rings are `[number, number][][]` in the stock
 * frame, the same shape `EngravePreview.tsx`'s `voidGeometry` already turns into line segments.
 *
 * Labels reuse the SAME typesetting as `labelProfile` (`partPlan.ts`): `glyphProfile` for the
 * flattened glyph contours, centred on the ink box, rotated about that centre, then translated to
 * `label.position` — `labelProfile`'s own three moves, in its own order. Simple shapes and vectors
 * reuse the SAME geometry as `shapeProfile` (`partPlan.ts`): centred on the origin (rect / circle /
 * slot) or stated relative to `position` (polygon / vector), rotated about `position`, then
 * translated to it.
 *
 * Combined shapes (border / frame / cutaway) are deliberately NOT drawn here: their outlines come
 * from Clipper2 offsets and differences (`pOffset` / `pDifference`), which only the worker's wasm
 * can evaluate, and a border follows the stock so it cannot be out of bounds by construction. The
 * issue names labels and shapes; that is what this covers.
 */

import type {
  EngraveJob,
  EngraveLabel,
  EngraveShape,
  EngraveVectorShape,
} from '@/types/engraveJob';
import type { CustomFont } from '@/types/textLabel';
import { glyphProfile } from '@/engine/compiler/glyphs';
import { resolveFont } from '@/engine/fonts/registry';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';

/** One closed point ring, in the stock frame. */
export type WarningRing = [number, number][];

/** One blocked item and its design outline, at its real position. */
export interface WarningOutline {
  labelId: string;
  rings: WarningRing[];
}

const DEG = Math.PI / 180;

/** Rotate a point counter-clockwise by `deg` about the origin — `pRotate`'s own convention. */
function rotate([x, y]: [number, number], deg: number): [number, number] {
  const a = deg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [x * c - y * s, x * s + y * c];
}

/** `shapeProfile`'s placement for a centred/relative ring: rotate about the origin, then place. */
function place(
  ring: WarningRing,
  rotation: number,
  position: { x: number; y: number },
): WarningRing {
  return ring.map((p) => {
    const [rx, ry] = rotate(p, rotation);
    return [rx + position.x, ry + position.y] as [number, number];
  });
}

/** `place` over several rings at once (a vector's contours). */
function placeEach(
  rings: readonly WarningRing[],
  rotation: number,
  position: { x: number; y: number },
): WarningRing[] {
  return rings.map((ring) => place(ring, rotation, position));
}

/** A full-circle outline, `segments` points, counter-clockwise from angle 0. */
function circleRing(radius: number, segments: number): WarningRing {
  const ring: WarningRing = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    ring.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  return ring;
}

/**
 * `n` points along a circular arc from `a0` to `a1` degrees (counter-clockwise, endpoints included).
 * Angles may pass 360 (a right half-circle is 270 → 450); `cos`/`sin` take that in their stride.
 */
function arc(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  n: number,
  out: WarningRing,
): void {
  for (let i = 0; i < n; i++) {
    const a = (a0 + ((a1 - a0) * i) / (n - 1)) * DEG;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
}

/** A rounded-rectangle outline, centred on the origin, traced counter-clockwise. */
function roundedRectRing(width: number, height: number, radius: number): WarningRing {
  const r = Math.min(Math.max(radius, 0), width / 2, height / 2);
  const hw = width / 2 - r;
  const hh = height / 2 - r;
  if (r <= 0) return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
  // One quarter-arc per corner. The arcs' endpoints lie exactly on the straight edges, so the
  // segments that connect one arc's last point to the next arc's first point ARE the straight
  // edges — nothing is inserted by hand.
  const seg = Math.max(2, Math.ceil(segmentsForRadius(r) / 4));
  const ring: WarningRing = [];
  arc(-hw, -hh, r, 180, 270, seg, ring); // bottom-left
  arc(hw, -hh, r, 270, 360, seg, ring); // bottom-right
  arc(hw, hh, r, 0, 90, seg, ring); // top-right
  arc(-hw, hh, r, 90, 180, seg, ring); // top-left
  return ring;
}

/** A stadium (slot) outline, centred on the origin: two half-circles joined by straight sides. */
function slotRing(length: number, width: number): WarningRing {
  const radius = width / 2;
  const half = length / 2 - radius;
  // An ODD count puts a vertex at each half-circle's cardinal midpoint (180°/360°), so the
  // outline's bounding box is exactly the slot's stated length — the same "cardinals are vertices"
  // rule `segmentsForRadius` rounds up to for a full circle.
  let seg = Math.max(2, Math.ceil(segmentsForRadius(radius) / 2));
  if (seg % 2 === 0) seg += 1;
  const ring: WarningRing = [];
  arc(-half, 0, radius, 90, 270, seg, ring); // left half-circle, top → bottom (midpoint 180°)
  arc(half, 0, radius, 270, 450, seg, ring); // right half-circle, bottom → top (midpoint 360°)
  return ring;
}

/** A simple shape or vector as placed outline rings, in the stock frame. */
function shapeRings(shape: EngraveShape | EngraveVectorShape): WarningRing[] {
  switch (shape.kind) {
    case 'rect':
      return [place(roundedRectRing(shape.width, shape.height, shape.cornerRadius), shape.rotation, shape.position)];
    case 'circle': {
      const radius = shape.diameter / 2;
      return [place(circleRing(radius, segmentsForRadius(radius)), shape.rotation, shape.position)];
    }
    case 'slot':
      return [place(slotRing(shape.length, shape.width), shape.rotation, shape.position)];
    case 'polygon':
      return [place(shape.points.map(([x, y]) => [x, y] as [number, number]), shape.rotation, shape.position)];
    case 'vector':
      return placeEach(shape.contours, shape.rotation, shape.position);
  }
}

/** A text label's glyph outline, typeset and placed exactly as `labelProfile` does it. */
function labelRings(label: EngraveLabel, customFonts: readonly CustomFont[]): WarningRing[] {
  const font = resolveFont(label.font, label.weight, customFonts); // throws on an unparsed face
  const glyphs = glyphProfile(label.text, font, label.size);
  if (glyphs.kind !== 'p-poly') return [];
  const box = aabbOfProfile(glyphs);
  if (!box) return []; // whitespace-only text: nothing to centre or place
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const rings: WarningRing[] = [];
  for (const contour of glyphs.contours) {
    const centred = contour.map(([x, y]) => [x - cx, y - cy] as [number, number]);
    rings.push(place(centred, label.rotation, label.position));
  }
  return rings;
}

/** One label, simple shape or vector — the kinds this overlay knows how to draw. */
type WarningItem = EngraveLabel | EngraveShape | EngraveVectorShape;

function itemRings(item: WarningItem, customFonts: readonly CustomFont[]): WarningRing[] {
  if ('kind' in item) return shapeRings(item);
  try {
    return labelRings(item, customFonts);
  } catch {
    // An unparsed font face draws nothing rather than taking the viewport down. In practice the
    // overlay is only reached once the worker has already typeset the same label, so fonts are up.
    return [];
  }
}

/**
 * The ids of enabled, non-construction region items the preview cut NOTHING of — the items that
 * currently vanish. `floorIds` is `preview.floors`' `labelId` set (a drill/trace/v-carve all leave
 * a floor too, so "no floor" is exactly "clipped to empty or refused").
 */
export function blockedItemIds(job: EngraveJob, floorIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const item of [...job.labels, ...job.shapes, ...(job.vectors ?? [])]) {
    if (!item.enabled || item.construction === true) continue;
    if (floorIds.has(item.id)) continue;
    out.push(item.id);
  }
  return out;
}

/** One warning outline per blocked item with non-empty design geometry, in job order. */
export function warningOutlinesFor(job: EngraveJob, floorIds: ReadonlySet<string>): WarningOutline[] {
  const outlines: WarningOutline[] = [];
  for (const item of [...job.labels, ...job.shapes, ...(job.vectors ?? [])]) {
    if (!item.enabled || item.construction === true) continue;
    if (floorIds.has(item.id)) continue;
    const rings = itemRings(item, job.customFonts);
    if (rings.length === 0) continue;
    outlines.push({ labelId: item.id, rings });
  }
  return outlines;
}
