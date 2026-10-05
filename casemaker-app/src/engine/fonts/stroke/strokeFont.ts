import type { Mm } from '@/types/units';
import type { StrokeFontId } from '@/types/engraveJob';
import { HERSHEY_SIMPLEX, type HersheyGlyph } from './hersheySimplex';

/**
 * The bundled SINGLE-STROKE fonts (issue #219). Ordinary fonts are outlines: tracing them
 * engraves the OUTLINE of each letter, which is rarely wanted. A stroke font is a set of open
 * polylines — the pen path — so tracing it engraves the letter itself, exactly one cutter wide.
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
 * Typeset `text` in a single-stroke font as open polylines, in millimetres, with the BASELINE on
 * y = 0 and y increasing up (the job frame's convention). `size` is the cap height in mm, the same
 * meaning as `EngraveLabel.size` and `TextLabel.size`.
 *
 * The font data is y-DOWN (the Hershey convention, the 'H' spans y = -12..9); this flips it. Each
 * glyph is placed at the running pen X and advanced by its own `right - left` side bearings, so
 * spacing is the font's, not a constant. A character with no glyph (a hand-edited file, a
 * non-ASCII symbol) typesets as '?'. Whitespace advances with no strokes.
 *
 * The placement to a centre (`labelProfile`'s centring) is the caller's, so this stays the pure
 * baseline-at-origin layout the two item kinds share.
 */
export function strokeGlyphPaths(text: string, fontId: StrokeFontId, size: Mm): [Mm, Mm][][] {
  const font = strokeFontById(fontId);
  const scale = size / CAP_HEIGHT_UNITS;
  const paths: [Mm, Mm][][] = [];
  let penX = 0;
  for (const char of text) {
    const glyph = font.glyphs[char] ?? font.glyphs[FALLBACK_CHAR];
    if (!glyph) continue;
    const [left, right, strokes] = glyph;
    for (const stroke of strokes) {
      if (stroke.length < 2) continue; // a single point is not a line to cut
      paths.push(stroke.map(([x, y]): [Mm, Mm] => [penX + x * scale, -y * scale]));
    }
    penX += (right - left) * scale;
  }
  return paths;
}
