import type { Font } from 'opentype.js';
import type { Vec2 } from '@/types';
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

/** Subdivisions needed so a quadratic stays within `tol` of its chord polyline. */
function quadSegments(p0: Vec2, p1: Vec2, p2: Vec2, tol: number): number {
  // Max deviation of a quadratic from its chord = |p0 - 2p1 + p2| / 4; the
  // polyline error scales as 1/n^2.
  const dev = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]) / 4;
  return Math.max(1, Math.ceil(Math.sqrt(dev / tol)));
}

/** Same idea for a cubic: |B''| <= 6 * max(|p0-2p1+p2|, |p1-2p2+p3|), error <= max|B''| / (8 n^2). */
function cubicSegments(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tol: number): number {
  const d1 = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]);
  const d2 = Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]);
  const dev = (3 / 4) * Math.max(d1, d2);
  return Math.max(1, Math.ceil(Math.sqrt(dev / tol)));
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
        const p0 = cur;
        const p1: Vec2 = [c.x1!, c.y1!];
        const p2: Vec2 = [c.x!, c.y!];
        const n = quadSegments(p0, p1, p2, GLYPH_CHORD_TOLERANCE_MM);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const a = (1 - t) * (1 - t);
          const b = 2 * (1 - t) * t;
          const d = t * t;
          push(a * p0[0] + b * p1[0] + d * p2[0], a * p0[1] + b * p1[1] + d * p2[1]);
        }
        break;
      }
      case 'C': {
        const p0 = cur;
        const p1: Vec2 = [c.x1!, c.y1!];
        const p2: Vec2 = [c.x2!, c.y2!];
        const p3: Vec2 = [c.x!, c.y!];
        const n = cubicSegments(p0, p1, p2, p3, GLYPH_CHORD_TOLERANCE_MM);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const d = 3 * u * t * t;
          const e = t * t * t;
          push(
            a * p0[0] + b * p1[0] + d * p2[0] + e * p3[0],
            a * p0[1] + b * p1[1] + d * p2[1] + e * p3[1],
          );
        }
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
