// @vitest-environment jsdom
// SVG outline import (#217): the path-data parser, units, Y flip, transforms and fill rule.
//
// jsdom for the DOMParser the module uses for the XML (the same environment the component specs
// use). No Manifold here — the donut/fill-rule behaviour is asserted in `engraveVector.spec.ts`
// where the CrossSection evaluator is already at hand.

import { describe, it, expect } from 'vitest';

import { parseSvgOutline, parseSvgPath, flattenArc } from '@/engine/import/svgOutline';
import { GLYPH_CHORD_TOLERANCE_MM } from '@/engine/compiler/glyphs';

/** Shoelace area of one closed ring, mm². */
function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function bounds(contours: [number, number][][]): { min: [number, number]; max: [number, number] } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of contours) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

function svg(body: string, attrs = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
}

const ok = (r: ReturnType<typeof parseSvgOutline>) => {
  if (!r.ok) throw new Error(r.error);
  return r.outline;
};

describe('parseSvgPath (#217): each command, absolute and relative', () => {
  it('M/L/Z: absolute lines and a close', () => {
    const [sub] = parseSvgPath('M0 0 L10 0 L10 10 Z');
    expect(sub!.closed).toBe(true);
    expect(sub!.points).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('m/l: relative moves and lines', () => {
    const [sub] = parseSvgPath('m5 5 l10 0 l0 10');
    expect(sub!.closed).toBe(false);
    expect(sub!.points).toEqual([
      [5, 5],
      [15, 5],
      [15, 15],
    ]);
  });

  it('H/V absolute and relative', () => {
    expect(parseSvgPath('M2 3 H10 V8')[0]!.points).toEqual([
      [2, 3],
      [10, 3],
      [10, 8],
    ]);
    expect(parseSvgPath('M2 3 h4 v5')[0]!.points).toEqual([
      [2, 3],
      [6, 3],
      [6, 8],
    ]);
  });

  it('implicit repeat: M then extra pairs are implicit L', () => {
    expect(parseSvgPath('M0 0 10 0 10 10')[0]!.points).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('Q/T: quadratic and smooth quadratic', () => {
    const q = parseSvgPath('M0 0 Q5 10 10 0')[0]!;
    expect(q.points[0]).toEqual([0, 0]);
    expect(q.points[q.points.length - 1]).toEqual([10, 0]);
    expect(q.points.some(([, y]) => y > 4)).toBe(true); // the apex is near y = 5

    const t = parseSvgPath('M0 0 Q5 10 10 0 T20 0')[0]!;
    expect(t.points[t.points.length - 1]).toEqual([20, 0]);
    // The reflected control is (15, -10), so the second hump goes the other way.
    expect(t.points.some(([, y]) => y < -4)).toBe(true);
  });

  it('C/S: cubic and smooth cubic', () => {
    const c = parseSvgPath('M0 0 C0 10 10 10 10 0')[0]!;
    expect(c.points[c.points.length - 1]).toEqual([10, 0]);
    const s = parseSvgPath('M0 0 C0 10 10 10 10 0 S20 -10 20 0')[0]!;
    expect(s.points[s.points.length - 1]).toEqual([20, 0]);
    expect(s.points.some(([, y]) => y < -4)).toBe(true);
  });

  it('A: an elliptical arc stays on its circle and lands on the endpoint', () => {
    const arc = parseSvgPath('M0 0 A5 5 0 0 1 10 0')[0]!;
    expect(arc.points[0]).toEqual([0, 0]);
    expect(arc.points[arc.points.length - 1]).toEqual([10, 0]);
    for (const [x, y] of arc.points) {
      expect(Math.abs(Math.hypot(x - 5, y) - 5)).toBeLessThan(0.02);
    }
  });

  it('relative arc and close', () => {
    const [sub] = parseSvgPath('M0 0 a5 5 0 0 1 10 0 z');
    expect(sub!.closed).toBe(true);
    expect(sub!.points.at(-1)![0]).toBeCloseTo(10, 6);
  });

  it('a cubic flattens within the chord tolerance of its true curve', () => {
    const p0: [number, number] = [0, 0];
    const p1: [number, number] = [0, 40];
    const p2: [number, number] = [40, 40];
    const p3: [number, number] = [40, 0];
    const sub = parseSvgPath(`M${p0[0]} ${p0[1]} C${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]} ${p3[0]} ${p3[1]}`)[0]!;
    const curve = (t: number): [number, number] => {
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const c = 3 * u * t * t;
      const d = t * t * t;
      return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
    };
    let worst = 0;
    for (let i = 0; i <= 500; i++) {
      const [cx, cy] = curve(i / 500);
      let best = Infinity;
      for (let j = 1; j < sub.points.length; j++) {
        const a = sub.points[j - 1]!;
        const b = sub.points[j]!;
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((cx - a[0]) * dx + (cy - a[1]) * dy) / len2));
        best = Math.min(best, Math.hypot(cx - (a[0] + t * dx), cy - (a[1] + t * dy)));
      }
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThanOrEqual(GLYPH_CHORD_TOLERANCE_MM + 1e-6);
  });

  it('flattenArc falls back to a line for a zero radius', () => {
    expect(flattenArc([0, 0], 0, 0, 0, false, true, [10, 0], 0.02)).toEqual([[10, 0]]);
  });
});

describe('parseSvgOutline (#217): units and size', () => {
  it('a 10 × 10 mm square with width="10mm" imports as 100 mm²', () => {
    const r = ok(parseSvgOutline(svg('<path d="M0 0 H10 V10 H0 Z"/>', 'width="10mm" height="10mm" viewBox="0 0 10 10"')));
    expect(r.contours).toHaveLength(1);
    expect(ringArea(r.contours[0]!)).toBeCloseTo(100, 6);
    expect(r.width).toBeCloseTo(10, 6);
    expect(r.height).toBeCloseTo(10, 6);
  });

  it('the same file with only a viewBox falls back to 96 px/inch', () => {
    const r = ok(parseSvgOutline(svg('<path d="M0 0 H10 V10 H0 Z"/>', 'viewBox="0 0 10 10"')));
    const mmPerPx = 25.4 / 96;
    expect(r.width).toBeCloseTo(10 * mmPerPx, 6);
    expect(ringArea(r.contours[0]!)).toBeCloseTo(100 * mmPerPx * mmPerPx, 6);
    expect(r.notes.some((n) => n.includes('96'))).toBe(true);
  });

  it('a physical height scales the viewBox too', () => {
    const r = ok(parseSvgOutline(svg('<path d="M0 0 H10 V5 H0 Z"/>', 'width="20mm" height="10mm" viewBox="0 0 10 5"')));
    expect(r.width).toBeCloseTo(20, 6);
    expect(r.height).toBeCloseTo(10, 6);
  });
});

describe('parseSvgOutline (#217): shapes and fill rule', () => {
  it('rect, circle, ellipse and polygon each import', () => {
    const body =
      '<rect x="0" y="0" width="10" height="4"/>' +
      '<circle cx="20" cy="2" r="2"/>' +
      '<ellipse cx="30" cy="2" rx="3" ry="1"/>' +
      '<polygon points="40,0 46,0 43,6"/>';
    const r = ok(parseSvgOutline(svg(body, 'width="50mm" height="10mm" viewBox="0 0 50 10"')));
    expect(r.contours).toHaveLength(4);
  });

  it('reads fill-rule, defaulting to NonZero', () => {
    const even = ok(parseSvgOutline(svg('<path fill-rule="evenodd" d="M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z"/>', 'width="10mm" viewBox="0 0 10 10"')));
    expect(even.fillRule).toBe('EvenOdd');
    const def = ok(parseSvgOutline(svg('<path d="M0 0 H10 V10 H0 Z"/>', 'width="10mm" viewBox="0 0 10 10"')));
    expect(def.fillRule).toBe('NonZero');
  });
});

describe('parseSvgOutline (#217): transforms', () => {
  const twoRects = (transform: string) =>
    `<rect x="0" y="0" width="5" height="5"/><rect x="0" y="0" width="5" height="5" transform="${transform}"/>`;

  it('translate moves the second copy', () => {
    const r = ok(parseSvgOutline(svg(twoRects('translate(10 0)'), 'width="100mm" height="100mm" viewBox="0 0 100 100"')));
    expect(bounds(r.contours).max[0] - bounds(r.contours).min[0]).toBeCloseTo(15, 6);
  });

  it('scale enlarges a single shape', () => {
    const r = ok(parseSvgOutline(svg('<rect width="5" height="5" transform="scale(2)"/>', 'width="100mm" height="100mm" viewBox="0 0 100 100"')));
    expect(r.width).toBeCloseTo(10, 6);
  });

  it('rotate swaps the bounding-box axes of a 10 × 2 rect', () => {
    const r = ok(parseSvgOutline(svg('<rect width="10" height="2" transform="rotate(90)"/>', 'width="100mm" height="100mm" viewBox="0 0 100 100"')));
    expect(r.width).toBeCloseTo(2, 6);
    expect(r.height).toBeCloseTo(10, 6);
  });

  it('matrix(1,0,0,1,10,0) is a translate', () => {
    const r = ok(parseSvgOutline(svg(twoRects('matrix(1 0 0 1 10 0)'), 'width="100mm" height="100mm" viewBox="0 0 100 100"')));
    expect(bounds(r.contours).max[0] - bounds(r.contours).min[0]).toBeCloseTo(15, 6);
  });

  it('nested <g> transforms compose in order', () => {
    // translate(10) OUTSIDE scale(2): a unit rect lands at x = 2·x + 10 ∈ [10, 12].
    const body =
      '<rect width="1" height="1"/>' +
      '<g transform="translate(10 0)"><g transform="scale(2)"><rect width="1" height="1"/></g></g>';
    const r = ok(parseSvgOutline(svg(body, 'width="100mm" height="100mm" viewBox="0 0 100 100"')));
    const b = bounds(r.contours);
    expect(b.max[0] - b.min[0]).toBeCloseTo(12, 6);
  });
});

describe('parseSvgOutline (#217): Y flip and orientation', () => {
  it('an asymmetric L is flipped in Y, not mirrored in X', () => {
    // SVG (y down): a full-width top bar (y 0..3) and a left leg (x 0..3) running down to y 10.
    // After the Y flip the leg is still on the LEFT: the row that becomes the BOTTOM (min y in
    // the job frame) is the leg's foot, and it sits on the left half. An X-mirror would put it
    // on the right.
    const r = ok(parseSvgOutline(svg('<path d="M0 0 H10 V3 H3 V10 H0 Z"/>', 'width="10mm" height="10mm" viewBox="0 0 10 10"')));
    const pts = r.contours[0]!;
    const minY = Math.min(...pts.map((p) => p[1]));
    const maxX = Math.max(...pts.map((p) => p[0]));
    const bottom = pts.filter((p) => Math.abs(p[1] - minY) < 1e-9).map((p) => p[0]);
    expect(bottom.length).toBeGreaterThan(1); // the leg's foot is an edge, not a point
    expect(Math.max(...bottom)).toBeLessThan(0); // left of centre (bbox centre is the origin)
    expect(Math.max(...bottom)).toBeLessThan(maxX); // the foot is not the wide top bar
  });
});

describe('parseSvgOutline (#217): out-of-scope content is reported', () => {
  it('a strokes-only file imports as zero contours and names strokes', () => {
    const r = ok(parseSvgOutline(svg('<path d="M0 0 H10 V10 H0 Z" fill="none" stroke="#000"/>', 'width="10mm" viewBox="0 0 10 10"')));
    expect(r.contours).toEqual([]);
    expect(r.notes.some((n) => /stroke/i.test(n))).toBe(true);
  });

  it('text and open paths are reported', () => {
    const r = ok(
      parseSvgOutline(
        svg('<text x="0" y="5">Hi</text><path d="M0 0 L10 10" stroke="#000"/>', 'width="10mm" viewBox="0 0 10 10"'),
      ),
    );
    expect(r.contours).toEqual([]);
    expect(r.notes.some((n) => /text/i.test(n))).toBe(true);
    expect(r.notes.some((n) => /open/i.test(n))).toBe(true);
  });
});

describe('parseSvgOutline (#217): refusals', () => {
  it('refuses a 6 MB file before parsing', () => {
    const huge = '<svg>' + ' '.repeat(6 * 1024 * 1024);
    const r = parseSvgOutline(huge);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/limit/i);
  });

  it('rejects malformed XML', () => {
    const r = parseSvgOutline('<svg><path d="M0 0"</svg>');
    expect(r.ok).toBe(false);
  });

  it('rejects a non-SVG document', () => {
    const r = parseSvgOutline('<?xml version="1.0"?><html/>');
    expect(r.ok).toBe(false);
  });
});
