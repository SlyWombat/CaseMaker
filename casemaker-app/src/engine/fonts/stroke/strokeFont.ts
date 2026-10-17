import type { Mm } from '@/types/units';
import type { StrokeFontId } from '@/types/engraveJob';
import { HERSHEY_SIMPLEX, type HersheyGlyph } from './hersheySimplex';

/**
 * The bundled SINGLE-STROKE fonts (issue #219). Ordinary fonts are outlines: tracing them
 * engraves the OUTLINE of each letter, which is rarely wanted. A stroke font is a set of
 * polylines — the pen path — so tracing it engraves the letter itself, exactly one cutter wide.
 * Most are open, but a closed loop (an 'O' bowl, a dot) is written the way the Hershey data
 * writes one: its last point REPEATS its first. `offsetPolyline` reads that repeated point as a
 * ring, so a bold pass joins its seam instead of leaving a notch there (#409).
 *
 * Only one face is bundled, the public-domain Hershey Roman Simplex. The registry is shaped like
 * `engine/fonts/registry.ts` (an id plus a label) so a second face is a one-line addition, and so
 * the panel can list the fonts without knowing which dataset backs them. Data and licence:
 * `./hersheySimplex.ts` and `engine/fonts/licenses/Hershey-PublicDomain.txt`.
 *
 * Pure and synchronous — the data is a checked-in module, not a fetched asset, so the CAM and
 * the schema never need to await a load (unlike the TTF registry, #180).
 */

export interface StrokeFontDef {
  id: StrokeFontId;
  /** Human label for a font picker. */
  label: string;
  /** Single-character glyphs, in font units. */
  glyphs: Readonly<Record<string, HersheyGlyph>>;
}

export const STROKE_FONTS: readonly StrokeFontDef[] = [
  {
    id: 'hershey-simplex',
    label: 'Hershey Roman Simplex (single-stroke)',
    glyphs: HERSHEY_SIMPLEX,
  },
];

export const DEFAULT_STROKE_FONT_ID: StrokeFontId = 'hershey-simplex';

/** The stroke font ids, for a picker and for schema bounds. */
export const STROKE_FONT_IDS: readonly string[] = STROKE_FONTS.map((f) => f.id);

/** Resolve a stroke font id, falling back to the default when it is unknown (a deleted face). */
export function strokeFontById(id: StrokeFontId): StrokeFontDef {
  return STROKE_FONTS.find((f) => f.id === id) ?? STROKE_FONTS[0]!;
}

/**
 * Cap height of the bundled face in FONT UNITS, measured from the 'H' so it is a property of the
 * data rather than a magic number. Fallback 21 (the rowmans 'H' spans y = -12..9) if the glyph is
 * ever absent, so a broken dataset degrades to a plausible scale instead of dividing by zero.
 */
const CAP_HEIGHT_UNITS: number = (() => {
  const h = HERSHEY_SIMPLEX['H'];
  if (!h) return 21;
  let min = Infinity;
  let max = -Infinity;
  for (const stroke of h[2]) {
    for (const [, y] of stroke) {
      if (y < min) min = y;
      if (y > max) max = y;
    }
  }
  return max > min ? max - min : 21;
})();

/** The glyph a character with no data typesets as — a visible fallback, never a silent drop. */
const FALLBACK_CHAR = '?';

/**
 * Options for {@link strokeGlyphPaths} (#409). Both default to the font's own layout, so a caller
 * that passes nothing gets exactly the pre-#409 output — the two job fields that feed them are
 * optional, and the panel and specs that typeset in the pure font keep working unchanged.
 */
export interface StrokeTypesetOptions {
  /**
   * Horizontal CONDENSE (#409): x is multiplied by this, y is NOT, so the cap height still equals
   * `size` — the line gets shorter without its letters getting shorter, which is what lets a line
   * bound by its LENGTH gain height. 1 (the default) is the face's own widths.
   */
  widthScale?: number;
  /**
   * The width the cutter removes on the cut at the item's depth, mm (#409). The layout keeps at
   * least this much CLEAR, uncut surface between two adjacent glyphs' ink. A groove reaches
   * `cutWidth / 2` to either side of the centre line it is cut on, so the two neighbours each eat
   * `cutWidth / 2` from the gap between them and the rule

   *     inkGap − cutWidth ≥ cutWidth   ⟺   inkGap ≥ 2·cutWidth

   * is what this enforces: wherever the font's own advance leaves a tighter ink gap, an extra
   * advance is inserted to make it up. 0 (the default) inserts nothing — the font's own spacing.
   * The caller computes the number (it needs the job's tool and the item's depth, neither of which
   * this pure module sees).
   */
  minGapCutWidth?: number;
}

/** The x-extent of a glyph's ink at x-scale `gx`, in the layout frame, or `null` for no strokes. */
function glyphInkX(strokes: readonly (readonly [number, number][])[], gx: number): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const stroke of strokes) {
    for (const [x] of stroke) {
      const xs = x * gx;
      if (xs < min) min = xs;
      if (xs > max) max = xs;
    }
  }
  return max > -Infinity ? { min, max } : null;
}

/**
 * Typeset `text` in a single-stroke font as polylines, in millimetres, with the BASELINE on
 * y = 0 and y increasing up (the job frame's convention). `size` is the cap height in mm, the same
 * meaning as `EngraveLabel.size` and `TextLabel.size`. A closed loop keeps the font's repeated
 * first point (see {@link isClosedRing}), so the ring survives the y-flip and the layout intact.
 *
 * The font data is y-DOWN (the Hershey convention, the 'H' spans y = -12..9); this flips it. Each
 * glyph is placed at the running pen X and advanced by its own `right - left` side bearings, so
 * spacing is the font's, not a constant. A character with no glyph (a hand-edited file, a
 * non-ASCII symbol) typesets as '?'. Whitespace advances with no strokes.
 *
 * `options` (#409) is the only thing that moves a glyph off the face's own placement: `widthScale`
 * condenses the line, and `minGapCutWidth` opens up any gap the font leaves tighter than the cut
 * needs (see {@link StrokeTypesetOptions}). With neither, this is the face's own layout, unchanged.
 *
 * The placement to a centre (`labelProfile`'s centring) is the caller's, so this stays the pure
 * baseline-at-origin layout the two item kinds share.
 */
export function strokeGlyphPaths(
  text: string,
  fontId: StrokeFontId,
  size: Mm,
  options: StrokeTypesetOptions = {},
): [Mm, Mm][][] {
  const font = strokeFontById(fontId);
  const scale = size / CAP_HEIGHT_UNITS;
  const gx = scale * (options.widthScale ?? 1); // condense applies to x only; y stays `scale`
  const requiredInkGap = 2 * (options.minGapCutWidth ?? 0);
  const paths: [Mm, Mm][][] = [];
  let penX = 0;
  // The layout-frame x of the previous INKED glyph's right-most ink, or null before the first ink.
  let prevInkMax: number | null = null;
  for (const char of text) {
    const glyph = font.glyphs[char] ?? font.glyphs[FALLBACK_CHAR];
    if (!glyph) continue;
    const [left, right, strokes] = glyph;
    const ink = glyphInkX(strokes, gx);
    // The clear-surface rule: bump this glyph right until the ink gap to the previous inked glyph
    // is at least `2 * cutWidth`. Only when a cut width was given, and only between two glyphs
    // that both carry ink (whitespace neither eats nor must be kept clear of).
    if (requiredInkGap > 0 && ink !== null && prevInkMax !== null) {
      const naturalGap = penX + ink.min - prevInkMax;
      if (naturalGap < requiredInkGap) penX += requiredInkGap - naturalGap;
    }
    for (const stroke of strokes) {
      if (stroke.length < 2) continue; // a single point is not a line to cut
      paths.push(stroke.map(([x, y]): [Mm, Mm] => [penX + x * gx, -y * scale]));
    }
    if (ink !== null) prevInkMax = penX + ink.max;
    penX += (right - left) * gx;
  }
  return paths;
}

/**
 * Does `path` describe a RING — the Hershey data's way of writing a closed loop, as a path whose
 * last point repeats its first? The repetition is bit-identical in the data (and stays so through
 * `strokeGlyphPaths`, which applies the same pen x and scale to both), so an exact compare is the
 * test; a 2-point path is degenerate rather than a ring.
 */
function isClosedRing(path: readonly [Mm, Mm][]): boolean {
  if (path.length < 3) return false;
  const a = path[0]!;
  const b = path[path.length - 1]!;
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Offset a polyline laterally by `distance`, mm — positive to the LEFT of travel, negative right
 * (#409). An interior vertex gets a MITER join up to `MITER_LIMIT`, and is CHAMFERED above it: the
 * two offset lines stop on their own segment's normal, so a sharp apex (the "A", "K", "W", "<")
 * cannot throw a spike past the width the spacing rule budgeted. The two ends of an OPEN path move
 * on their own segment's normal (a flat cap), so the offset copy does not grow past the stroke's
 * ends. A zero-length segment is skipped and the neighbouring vertex absorbs it.
 *
 * A CLOSED loop — the font's repeated-first-point convention, see {@link isClosedRing} — has no
 * ends: its first and last vertices are the same point and get the same MITER/CHAMFER join an
 * interior vertex gets, and the result closes back on that joined point. Treating it as an open
 * path instead put two flat caps at the seam, leaving a small gap there that the pass's own
 * groove did not reliably cover (#409 low item).
 *
 * An INWARD offset of a loop smaller than the offset (a Hershey dot) passes each miter through
 * the loop's centre, so the copy reappears on the far side of it — still wound the same way, but
 * no longer around the ink. That copy is deliberately kept: its groove is what cuts the loop's
 * interior, and dropping it would leave that uncut.
 *
 * Pure, so the bold passes that use it are testable without a cutter or a job.
 */
export function offsetPolyline(path: readonly [Mm, Mm][], distance: number): [Mm, Mm][] {
  const copy = (): [Mm, Mm][] => path.map(([x, y]): [Mm, Mm] => [x, y]);
  if (distance === 0 || path.length < 2) return copy();

  // Unit LEFT normal of each segment (null for a zero-length segment).
  const normals: ([number, number] | null)[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const [x0, y0] = path[i]!;
    const [x1, y1] = path[i + 1]!;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    normals.push(len < 1e-12 ? null : [-dy / len, dx / len]);
  }
  // The nearest usable normal for an endpoint, scanning inward to skip zero-length segments.
  const endNormal = (fromStart: boolean): [number, number] | null => {
    if (fromStart) {
      for (let i = 0; i < normals.length; i++) if (normals[i]) return normals[i]!;
    } else {
      for (let i = normals.length - 1; i >= 0; i--) if (normals[i]) return normals[i]!;
    }
    return null;
  };

  // A miter reaches `|distance| / cos(θ/2)` from the vertex. Past `MITER_LIMIT` that is a spike: at
  // a 40° apex it is 2.9·|distance|, so the outer bold pass's groove edge lands ~1.39 mm from the
  // vertex against the ~0.75 mm the spacing rule budgeted. Above the limit the join is CHAMFERED —
  // both offset lines stop at `|distance|`, exactly the budget — instead of spiking.
  const MITER_LIMIT = 1.5;
  /** The offset point(s) at a vertex between an incoming and an outgoing segment normal. */
  const join = (
    x: number,
    y: number,
    n1: [number, number] | null,
    n2: [number, number] | null,
  ): [Mm, Mm][] => {
    if (!n1 && !n2) return [[x, y]];
    if (!n1 || !n2) {
      const nm = (n1 ?? n2)!;
      return [[x + nm[0] * distance, y + nm[1] * distance]];
    }
    let mx = n1[0] + n2[0];
    let my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) {
      // A 180° reversal: the offset lines are parallel and never meet; use this segment's normal.
      return [[x + n1[0] * distance, y + n1[1] * distance]];
    }
    mx /= ml;
    my /= ml;
    // miter length = |distance| / cos(θ/2); cos(θ/2) is the miter direction's projection on n1.
    const cos = mx * n1[0] + my * n1[1];
    const ratio = 1 / Math.max(cos, 1e-6);
    if (ratio > MITER_LIMIT) {
      // Chamfer: each offset line ends on its own segment's normal, `|distance|` from the vertex.
      return [
        [x + n1[0] * distance, y + n1[1] * distance],
        [x + n2[0] * distance, y + n2[1] * distance],
      ];
    }
    return [[x + mx * distance * ratio, y + my * distance * ratio]];
  };

  const out: [Mm, Mm][] = [];
  if (isClosedRing(path)) {
    const n = path.length;
    // The seam is vertex 0 == vertex n−1: its incoming segment is the LAST normal and its outgoing
    // segment the first, so it joins exactly as an interior vertex does. A chamfer returns two
    // points — the arrival on the last segment, then the departure on the first — which are kept in
    // that ring order.
    const seam = join(path[0]![0], path[0]![1], normals[n - 2] ?? null, normals[0] ?? null);
    out.push(...seam);
    for (let i = 1; i <= n - 2; i++) {
      const [x, y] = path[i]!;
      out.push(...join(x, y, normals[i - 1]!, normals[i]!));
    }
    // Close the ring on the joined seam, keeping the first == last convention of the input.
    out.push([seam[0]![0], seam[0]![1]]);
    return out;
  }

  for (let i = 0; i < path.length; i++) {
    const [x, y] = path[i]!;
    if (i === 0 || i === path.length - 1) {
      const nm = endNormal(i === 0);
      out.push(nm ? [x + nm[0] * distance, y + nm[1] * distance] : [x, y]);
      continue;
    }
    out.push(...join(x, y, normals[i - 1]!, normals[i]!));
  }
  return out;
}

/**
 * Expand each stroke of a typeset label into the parallel passes a BOLD cut needs (#409), so the
 * UNION of the passes' grooves reaches `weight` mm wide. `cutWidth` is the width ONE pass removes
 * at the item's depth (a V groove's top opening, or a flat cutter's diameter).
 *
 * The passes are placed symmetrically from `−(weight − cutWidth)/2` to `+(weight − cutWidth)/2` at
 * a step no larger than `cutWidth`, so the neighbouring grooves always overlap and no uncut spine
 * is left between them (#191's rule). They share the stroke's depth, so a re-cut cannot gouge the
 * floor below it (#409: depth is unchanged), and the end offset is a flat cap, so the pass does not
 * run past the stroke's end. When `weight` is not wider than a single pass — or no cut width is
 * known — the strokes come back untouched: bold was not asked for, or nothing changed it.
 */
export function boldStrokePasses(
  paths: readonly (readonly [Mm, Mm][])[],
  cutWidth: number,
  weight: number,
): [Mm, Mm][][] {
  const clone = (): [Mm, Mm][][] => paths.map((p) => p.map(([x, y]): [Mm, Mm] => [x, y]));
  if (!(cutWidth > 0) || !(weight > cutWidth)) return clone();

  const span = weight - cutWidth; // the distance the outer pass centres must cover, total
  const steps = Math.max(1, Math.ceil(span / cutWidth));
  const step = span / steps;
  const offsets: number[] = [];
  for (let i = 0; i <= steps; i++) offsets.push(-span / 2 + i * step);

  const out: [Mm, Mm][][] = [];
  for (const path of paths) for (const offset of offsets) out.push(offsetPolyline(path, offset));
  return out;
}
