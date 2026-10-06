// Raster tracing (#252). Pure: the spec hands `traceRaster` pixels and asserts against closed
// forms — the traced square's width in mm, the corner count, the two rings of a donut — never
// against another run of the tracer. Decoding a PNG is the browser's job (`imageDecode.ts`) and
// is not exercised here.

import { describe, it, expect } from 'vitest';

import {
  traceRaster,
  MM_PER_PX,
  TRACE_SIZE_NOTE,
  type RasterImage,
} from '@/engine/import/rasterOutline';
import { toVectorShape } from '@/engine/import/outlineImport';
import type { OutlineImport } from '@/engine/import/outlineTypes';

/** An RGBA bitmap from a per-pixel luminance, so a fixture reads as the picture it stands for. */
function image(w: number, h: number, lum: (x: number, y: number) => number): RasterImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = lum(x, y);
      const p = (y * w + x) * 4;
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Assert the trace succeeded and hand back the outline, so each test reads as its claim. */
function traced(r: ReturnType<typeof traceRaster>): OutlineImport {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r.outline;
}

const inRect = (x: number, y: number, x0: number, x1: number, y0: number, y1: number): boolean =>
  x >= x0 && x < x1 && y >= y0 && y < y1;

/** The mean of a ring's points; for a rectangle's four corners that is its centre. */
const meanY = (ring: readonly [number, number][]): number =>
  ring.reduce((s, p) => s + p[1], 0) / ring.length;

const widthOf = (ring: readonly [number, number][]): number =>
  Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0]));

describe('traceRaster (#252)', () => {
  it('traces a filled square to four corners, sized at 96 px/inch', () => {
    const outline = traced(
      traceRaster(image(16, 16, (x, y) => (inRect(x, y, 4, 12, 4, 12) ? 0 : 255)), undefined, 'logo.png'),
    );

    expect(outline.format).toBe('raster');
    expect(outline.sourceName).toBe('logo.png');
    // Even-odd, because a bitmap hole is a hole whatever the walk's winding was.
    expect(outline.fillRule).toBe('EvenOdd');
    expect(outline.contours).toHaveLength(1);
    // The crack walk follows 32 pixel edges around an 8×8 square; simplification leaves the four.
    expect(outline.contours[0]).toHaveLength(4);
    expect(outline.width).toBeCloseTo(8 * MM_PER_PX, 6);
    expect(outline.height).toBeCloseTo(8 * MM_PER_PX, 6);
    // The size the dialog shows as an assumption, and lets the user correct.
    expect(outline.notes).toContain(TRACE_SIZE_NOTE);
    expect(TRACE_SIZE_NOTE).toContain('assuming');
  });

  it('traces a hole as a second ring', () => {
    const outline = traced(
      traceRaster(
        image(16, 16, (x, y) => {
          const outer = inRect(x, y, 2, 14, 2, 14);
          const hole = inRect(x, y, 6, 10, 6, 10);
          return outer && !hole ? 0 : 255;
        }),
      ),
    );
    expect(outline.contours).toHaveLength(2);
    expect(outline.contours.map((c) => c.length)).toEqual([4, 4]);
    expect(outline.width).toBeCloseTo(12 * MM_PER_PX, 6);
  });

  it('reads a bitmap with no ink as zero shapes, not an error', () => {
    const outline = traced(traceRaster(image(8, 8, () => 255)));
    expect(outline.contours).toHaveLength(0);
    expect(outline.width).toBe(0);
    expect(outline.height).toBe(0);
  });

  it('takes the threshold', () => {
    // A mid-grey square on white. Darker-than cuts it in; a threshold below its luminance does not.
    const img = image(16, 16, (x, y) => (inRect(x, y, 4, 12, 4, 12) ? 200 : 255));
    expect(traced(traceRaster(img, { threshold: 128 })).contours).toHaveLength(0);
    expect(traced(traceRaster(img, { threshold: 220 })).contours).toHaveLength(1);
  });

  it('inverts: the switch traces the light pixels instead of the dark ones', () => {
    // White square on a black field. Normally the FIELD is the ink — so it traces its own border
    // AND the hole the square punches in it. Inverted, only the square is ink.
    const img = image(16, 16, (x, y) => (inRect(x, y, 5, 11, 5, 11) ? 255 : 0));
    const normal = traced(traceRaster(img));
    const inverted = traced(traceRaster(img, { invert: true }));
    expect(normal.contours).toHaveLength(2);
    expect(inverted.contours).toHaveLength(1);
    // Both read the same pixels, so the picture measures the same either way round.
    expect(normal.width).toBeCloseTo(16 * MM_PER_PX, 6);
    expect(inverted.width).toBeCloseTo(6 * MM_PER_PX, 6);
  });

  it('drops a lone speck at the default, says so, and keeps it when despeckle is off', () => {
    const img = image(16, 16, (x, y) => (x === 5 && y === 5 ? 0 : 255));
    const clean = traced(traceRaster(img));
    expect(clean.contours).toHaveLength(0);
    // What the control removed is reported: a despeckle that quietly ate a logo's dot would be
    // the surprise this dialog exists to prevent.
    expect(clean.notes.some((n) => n.includes('speck'))).toBe(true);
    const raw = traced(traceRaster(img, { despeckle: 0 }));
    expect(raw.contours).toHaveLength(1);
    expect(raw.notes.some((n) => n.includes('speck'))).toBe(false);
  });

  it('fills a pinhole at the default and keeps it when despeckle is off', () => {
    // One white pixel inside a solid square: a hole too small to cut, which is a speck the other
    // way round.
    const img = image(16, 16, (x, y) => {
      if (!inRect(x, y, 2, 14, 2, 14)) return 255;
      return x === 8 && y === 8 ? 255 : 0;
    });
    const clean = traced(traceRaster(img));
    expect(clean.contours).toHaveLength(1);
    expect(clean.notes.some((n) => n.includes('pinhole'))).toBe(true);
    expect(traced(traceRaster(img, { despeckle: 0 })).contours).toHaveLength(2);
  });

  it('simplifies the pixel staircase away, and simplify 0 leaves it', () => {
    const disc = image(64, 64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2 <= 20 * 20 ? 0 : 255));
    const rawPts = traced(traceRaster(disc, { simplify: 0 })).contours[0]!.length;
    const smoothPts = traced(traceRaster(disc, { simplify: 1 })).contours[0]!.length;
    // The staircase is a step per boundary pixel; the simplified ring is a chord per ~13 px.
    expect(rawPts).toBeGreaterThan(60);
    expect(smoothPts).toBeLessThan(rawPts);
    expect(smoothPts).toBeGreaterThanOrEqual(4);
    expect(smoothPts).toBeLessThan(40);
  });

  it('flips image rows into the job frame, so the top of the picture is up', () => {
    // Two rectangles of different widths, so width — not position — identifies which is which.
    const img = image(16, 16, (x, y) => (inRect(x, y, 2, 8, 1, 4) || inRect(x, y, 2, 5, 12, 15) ? 0 : 255));
    const contours = traced(traceRaster(img)).contours;
    expect(contours).toHaveLength(2);
    const wide = contours.find((c) => widthOf(c) > 4 * MM_PER_PX);
    const narrow = contours.find((c) => widthOf(c) < 4 * MM_PER_PX);
    // The wide one is the top rectangle in the picture; after the flip it is the higher ring.
    expect(wide).toBeDefined();
    expect(narrow).toBeDefined();
    expect(meanY(wide!)).toBeGreaterThan(0);
    expect(meanY(narrow!)).toBeLessThan(0);
  });

  it('hands the panel an ordinary vector shape, so nothing downstream knows it was a picture', () => {
    const outline = traced(
      traceRaster(image(16, 16, (x, y) => (inRect(x, y, 4, 12, 4, 12) ? 0 : 255)), undefined, 'logo.png'),
    );
    const shape = toVectorShape(outline, { id: 's1', position: { x: 10, y: 5 }, depth: 0.4 });
    expect(shape.kind).toBe('vector');
    expect(shape.sourceName).toBe('logo.png');
    expect(shape.fillRule).toBe('EvenOdd');
    expect(shape.contours).toHaveLength(1);
    expect(shape.depth).toBe(0.4);
  });

  it('refuses an oversized bitmap, and one whose data is short', () => {
    // 9 MP is past the cap — refused before its 36 MB of pixels are owed.
    const tooBig = traceRaster({ width: 3000, height: 3000, data: new Uint8ClampedArray(4) });
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toContain('3000');

    const short = traceRaster({ width: 4, height: 4, data: new Uint8ClampedArray(8) });
    expect(short.ok).toBe(false);
  });
});
