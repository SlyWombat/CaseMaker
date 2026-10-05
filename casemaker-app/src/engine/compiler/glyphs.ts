import type { Font } from 'opentype.js';
import type { Vec2 } from '@/types';
import { flattenCubic, flattenQuadratic } from './curveFlatten';
import type { Profile } from './profile';

/** A parsed OpenType/TrueType font (opentype.js). */
export type ParsedFont = Font;

export interface GlyphOptions {
  /** Apply the font's kerning pairs (default true). */
  kerning?: boolean;
  /** Extra tracking in em (opentype.js `letterSpacing`), 0 by default. */
  letterSpacing?: number;
}

/** Chord error budget for flattening curves, in mm. Plenty at badge scale. */
export const GLYPH_CHORD_TOLERANCE_MM = 0.02;

/**
 * Cap height of `font` as a fraction of the em: OS/2.sCapHeight where the font
 * records one, else the measured top of 'H'.
 */
export function capHeightEm(font: ParsedFont): number {
  const upm = font.unitsPerEm || 1000;
  const declared = font.tables.os2?.sCapHeight;
  if (typeof declared === 'number' && declared > 0) return declared / upm;
  const h = font.getPath('H', 0, 0, upm); // 1 unit == 1 font unit
  let top = 0;
  for (const c of h.commands) {
    for (const y of [c.y, c.y1, c.y2]) if (y !== undefined && -y > top) top = -y;
  }
  return top > 0 ? top / upm : 0.7;
}

/**
 * Typeset `text` in `font` as a single `Profile`: one `p-poly` whose contours
 * are the flattened glyph outlines, baseline on v = 0, pen start on u = 0, in
 * millimetres, v up.
 *
 * - Scaled by CAP height (`capHeightMm`), matching `TextLabel.size`, not by em.
 * - opentype.js paths are y-down; v is flipped here so text is upright.
 * - `fillRule: 'NonZero'`: fonts wind their outer and inner contours in
 *   opposite directions, so holes (o, B) still cut, but glyphs built from
 *   OVERLAPPING same-direction contours read as solid instead of even-odd holes.
 * - Whitespace-only text yields an empty `p-poly` (no contours).
 */
export function glyphProfile(
  text: string,
  font: ParsedFont,
  capHeightMm: number,
  opts: GlyphOptions = {},
): Profile {
  const cap = capHeightEm(font);
  // em size such that the cap height comes out at capHeightMm.
  const emMm = cap > 0 ? capHeightMm / cap : capHeightMm;
  const path = font.getPath(text, 0, 0, emMm, {
    kerning: opts.kerning ?? true,
    letterSpacing: opts.letterSpacing ?? 0,
  });

  const contours: Vec2[][] = [];
  let ring: Vec2[] = [];
  let cur: Vec2 = [0, 0];
  const flush = () => {
    // A ring needs three distinct points to enclose area.
    if (ring.length >= 3) contours.push(ring);
    ring = [];
  };
  const push = (x: number, y: number) => {
    const pt: Vec2 = [x, -y]; // y-down -> v-up
    const last = ring[ring.length - 1];
    if (!last || last[0] !== pt[0] || last[1] !== pt[1]) ring.push(pt);
    cur = [x, y];
  };

  for (const c of path.commands) {
    switch (c.type) {
      case 'M':
        flush();
        push(c.x!, c.y!);
        break;
      case 'L':
        push(c.x!, c.y!);
        break;
      case 'Q': {
        const pts = flattenQuadratic(cur, [c.x1!, c.y1!], [c.x!, c.y!], GLYPH_CHORD_TOLERANCE_MM);
        for (const [x, y] of pts) push(x, y);
        break;
      }
      case 'C': {
        const pts = flattenCubic(
          cur,
          [c.x1!, c.y1!],
          [c.x2!, c.y2!],
          [c.x!, c.y!],
          GLYPH_CHORD_TOLERANCE_MM,
        );
        for (const [x, y] of pts) push(x, y);
        break;
      }
      case 'Z':
        flush();
        break;
    }
  }
  flush();

  // Drop a closing point that repeats the first (explicit L back to start).
  for (const r of contours) {
    const f = r[0]!;
    const l = r[r.length - 1]!;
    if (r.length > 3 && f[0] === l[0] && f[1] === l[1]) r.pop();
  }

  return { kind: 'p-poly', contours, fillRule: 'NonZero' };
}
