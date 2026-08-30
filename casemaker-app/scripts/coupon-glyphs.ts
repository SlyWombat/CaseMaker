// Seven-segment digits for the test coupons, drawn as rectangular prisms and
// engraved into a face. Shared by pilot-coupon and thread-coupon: both label a
// row of holes with the two significant digits of the number under test, and a
// coupon you cannot read the labels on is a coupon you cannot report.
//
// All ten digits, not just the five the M5 pilot ladder happened to need — a
// coupon at another size or another fit uses whichever digits it uses.

import { cube, translate, type BuildOp } from '../src/engine/compiler/buildPlan';

export const GLYPH_H = 7; // digit height
export const GLYPH_W = 4.2; // digit width
const T = 1.0; // stroke thickness
const GAP = 1.4; // space between digits

type Seg = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';

const SEGMENTS: Record<string, Seg[]> = {
  '0': ['a', 'b', 'c', 'd', 'e', 'f'],
  '1': ['b', 'c'],
  '2': ['a', 'b', 'g', 'e', 'd'],
  '3': ['a', 'b', 'g', 'c', 'd'],
  '4': ['f', 'g', 'b', 'c'],
  '5': ['a', 'f', 'g', 'c', 'd'],
  '6': ['a', 'f', 'g', 'e', 'c', 'd'],
  '7': ['a', 'b', 'c'],
  '8': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  '9': ['a', 'b', 'c', 'd', 'f', 'g'],
};

/** Each segment as [x, y, w, h] in a GLYPH_W x GLYPH_H box, origin bottom-left. */
const SEG_RECT: Record<Seg, [number, number, number, number]> = {
  a: [T, GLYPH_H - T, GLYPH_W - 2 * T, T],
  g: [T, GLYPH_H / 2 - T / 2, GLYPH_W - 2 * T, T],
  d: [T, 0, GLYPH_W - 2 * T, T],
  f: [0, GLYPH_H / 2, T, GLYPH_H / 2 - T / 2],
  b: [GLYPH_W - T, GLYPH_H / 2, T, GLYPH_H / 2 - T / 2],
  e: [0, T, T, GLYPH_H / 2 - T / 2],
  c: [GLYPH_W - T, T, T, GLYPH_H / 2 - T / 2],
};

/** Width a string of digits will occupy. */
export function labelWidth(text: string): number {
  return text.length * GLYPH_W + (text.length - 1) * GAP;
}

/**
 * Cutting ops that engrave `text` into a face at z = `faceZ`, `depth` deep,
 * CENTRED on x = `cx` with its baseline at y = `y0`.
 */
export function engrave(
  text: string,
  cx: number,
  y0: number,
  faceZ: number,
  depth: number,
): BuildOp[] {
  const out: BuildOp[] = [];
  const x0 = cx - labelWidth(text) / 2;
  text.split('').forEach((ch, k) => {
    const segs = SEGMENTS[ch];
    if (!segs) return;
    const gx = x0 + k * (GLYPH_W + GAP);
    for (const s of segs) {
      const [sx, sy, sw, sh] = SEG_RECT[s];
      out.push(translate([gx + sx, y0 + sy, faceZ - depth], cube([sw, sh, depth + 1])));
    }
  });
  return out;
}
