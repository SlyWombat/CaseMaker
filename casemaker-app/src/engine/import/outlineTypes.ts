import type { Mm } from '@/types';

/**
 * Shared shape of an imported vector outline (#217), used by both parsers
 * (`svgOutline.ts`, `dxfOutline.ts`) and the dispatch module (`outlineImport.ts`).
 *
 * Kept in its own file rather than in `outlineImport.ts` so the two parsers can import these
 * runtime constants WITHOUT importing the module that imports them (a real ES cycle, not just a
 * type-only one).
 */

/**
 * Where an outline came from. `svg`/`dxf` are the vector parsers (#217); `raster` is a traced
 * bitmap (#252) — the same rings by the time anyone downstream sees them.
 */
export type OutlineFormat = 'svg' | 'dxf' | 'raster';

/** The winding rule an imported outline is read with — the two `Profile` fill rules SVG uses. */
export type OutlineFillRule = 'NonZero' | 'EvenOdd';

export interface OutlineImport {
  format: OutlineFormat;
  /** The source file's name, for `EngraveVectorShape.sourceName`. */
  sourceName: string;
  /** Rings in mm, bounding-box centre at the origin — the item's contour frame. */
  contours: [Mm, Mm][][];
  /** How to read the rings' winding. */
  fillRule: OutlineFillRule;
  /** Size from the source's own units/geometry, mm. The panel shows and can rescale it. */
  width: Mm;
  height: Mm;
  /** Non-fatal notes for the dialog (defaulted units, skipped strokes, open paths, …). */
  notes: string[];
}

export type OutlineParseResult =
  | { ok: true; outline: OutlineImport }
  | { ok: false; error: string };

/**
 * Refuse a file this large BEFORE parsing (#217). Measured in UTF-16 code units, which equals
 * bytes for the ASCII markup both formats are: a 6 MB SVG is refused without a DOMParser pass.
 * The picker's own 64 MB ceiling (`MAX_TEXT_FILE_BYTES`) is the outer guard; this is the
 * format-specific one the issue names.
 */
export const MAX_OUTLINE_FILE_BYTES = 6 * 1024 * 1024;

/** Cap on contours in one imported outline (#217). */
export const MAX_OUTLINE_CONTOURS = 2000;

/**
 * Cap on total points across an imported outline's contours (#217). A complex logo flattens to
 * tens of thousands; 200 000 is the issue's refusal threshold, a parser/memory guard, not a
 * physical limit.
 */
export const MAX_OUTLINE_POINTS = 200000;

/** Total points across every ring. */
export function countOutlinePoints(contours: readonly (readonly [Mm, Mm][])[]): number {
  let n = 0;
  for (const ring of contours) n += ring.length;
  return n;
}

/** The bounding box of a set of rings, or null when they hold no point. */
export function outlineBounds(
  contours: readonly (readonly [Mm, Mm][])[],
): { min: [Mm, Mm]; max: [Mm, Mm] } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of contours) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return null;
  return { min: [minX, minY], max: [maxX, maxY] };
}

/** Shift every ring so the whole outline's bounding-box centre is at the origin. */
export function recentreOutline(contours: readonly (readonly [Mm, Mm][])[]): [Mm, Mm][][] {
  const b = outlineBounds(contours);
  if (!b) return contours.map((ring) => ring.map(([x, y]): [Mm, Mm] => [x, y]));
  const cx = (b.min[0] + b.max[0]) / 2;
  const cy = (b.min[1] + b.max[1]) / 2;
  return contours.map((ring) => ring.map(([x, y]): [Mm, Mm] => [x - cx, y - cy]));
}

/**
 * Uniformly rescale an outline to a target width in mm, keeping its aspect ratio (#217). The
 * panel's size control: an outline imported at 3 mm or 3 m is corrected here. A non-positive
 * target is a no-op so a half-typed input cannot blank the preview.
 */
export function scaleOutlineToWidth(outline: OutlineImport, targetWidthMm: Mm): OutlineImport {
  if (!(targetWidthMm > 0) || !(outline.width > 0)) return outline;
  const factor = targetWidthMm / outline.width;
  return {
    ...outline,
    contours: outline.contours.map((ring) =>
      ring.map(([x, y]): [Mm, Mm] => [x * factor, y * factor]),
    ),
    width: targetWidthMm,
    height: outline.height * factor,
  };
}

/**
 * The one exit every parser uses: enforce the caps, centre the rings on the origin, and measure
 * the size. Exceeding a cap is a refusal (a job cannot hold it); an empty result is NOT an error
 * — a strokes-only file imports as zero shapes with a note naming strokes, and the dialog
 * decides whether that is addable.
 */
export function finalizeOutline(args: {
  format: OutlineFormat;
  sourceName: string;
  contours: [Mm, Mm][][];
  fillRule: OutlineFillRule;
  notes: string[];
}): OutlineParseResult {
  const { format, sourceName, contours, fillRule, notes } = args;
  if (contours.length > MAX_OUTLINE_CONTOURS) {
    return {
      ok: false,
      error: `The outline has ${contours.length} contours; the limit is ${MAX_OUTLINE_CONTOURS}.`,
    };
  }
  const points = countOutlinePoints(contours);
  if (points > MAX_OUTLINE_POINTS) {
    return {
      ok: false,
      error: `The outline has ${points} points; the limit is ${MAX_OUTLINE_POINTS}.`,
    };
  }
  const centred = recentreOutline(contours);
  const b = outlineBounds(centred);
  return {
    ok: true,
    outline: {
      format,
      sourceName,
      contours: centred,
      fillRule,
      width: b ? b.max[0] - b.min[0] : 0,
      height: b ? b.max[1] - b.min[1] : 0,
      notes,
    },
  };
}
