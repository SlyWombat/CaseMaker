// The bundled single-stroke font (#219): the registry, the typesetter's placement, and the
// y-flip from the Hershey (y-DOWN, +y = descender) convention to the job frame (+y = up).
//
// Assertions are against the FONT DATA's own numbers (the 'H' spans 21 font units, so its cap
// height equals `size`; its advance is `right − left`), not against another run of the typesetter.

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_STROKE_FONT_ID,
  STROKE_FONTS,
  STROKE_FONT_IDS,
  strokeFontById,
  strokeGlyphPaths,
} from '@/engine/fonts/stroke/strokeFont';

type Pt = [number, number];

function bbox(paths: readonly Pt[][]): { minX: number; minY: number; maxX: number; maxY: number } {
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
  return { minX, minY, maxX, maxY };
}

describe('stroke font registry (#219)', () => {
  it('ships the Hershey simplex face and resolves it', () => {
    expect(STROKE_FONT_IDS).toContain('hershey-simplex');
    expect(DEFAULT_STROKE_FONT_ID).toBe('hershey-simplex');
    expect(strokeFontById('hershey-simplex').id).toBe('hershey-simplex');
  });

  it('falls back to the default face for an unknown id', () => {
    expect(strokeFontById('no-such-face').id).toBe(STROKE_FONTS[0]!.id);
  });
});

describe('strokeGlyphPaths (#219)', () => {
  it('returns no paths for empty or whitespace-only text', () => {
    expect(strokeGlyphPaths('', 'hershey-simplex', 10)).toEqual([]);
    expect(strokeGlyphPaths('   ', 'hershey-simplex', 10)).toEqual([]);
  });

  it("typesets 'H' as its three strokes, with the cap height equal to `size`", () => {
    const size = 10;
    const paths = strokeGlyphPaths('H', 'hershey-simplex', size);
    expect(paths).toHaveLength(3);
    for (const p of paths) expect(p).toHaveLength(2);

    const box = bbox(paths);
    // rowmans 'H' spans y = -12..9 (21 font units), so the scaled height IS the cap height.
    expect(box.maxY - box.minY).toBeCloseTo(size, 9);
    // y increases UP: the crossbar sits above the bottom of the two verticals.
    const bar = paths.find((p) => Math.abs(p[0]![1] - p[1]![1]) < 1e-9)!;
    expect(bar[0]![1]).toBeGreaterThan(box.minY);
  });

  it('advances by the glyph side bearings, not a constant', () => {
    const size = 8.4;
    const scale = size / 21;
    const one = bbox(strokeGlyphPaths('H', 'hershey-simplex', size));
    const two = bbox(strokeGlyphPaths('HH', 'hershey-simplex', size));
    // Each 'H' has the same width; the second starts one advance to the right.
    expect(two.maxX - two.minX - (one.maxX - one.minX)).toBeCloseTo(22 * scale, 9);
    expect(one.maxX - one.minX).toBeCloseTo(14 * scale, 9);
  });

  it('scales linearly with size', () => {
    const a = bbox(strokeGlyphPaths('H', 'hershey-simplex', 10));
    const b = bbox(strokeGlyphPaths('H', 'hershey-simplex', 20));
    expect(b.maxY - b.minY).toBeCloseTo(2 * (a.maxY - a.minY), 9);
  });

  it('typesets an unknown character as the visible fallback', () => {
    const fallback = strokeGlyphPaths('?', 'hershey-simplex', 10);
    const missing = strokeGlyphPaths('é', 'hershey-simplex', 10);
    expect(missing).toEqual(fallback);
  });
});
