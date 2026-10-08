// DXF outline import (#217), phase two: closed LWPOLYLINEs, CIRCLEs and joined LINE/ARC chains,
// units from $INSUNITS. Pure Node — no DOMParser, no wasm.

import { describe, it, expect } from 'vitest';

import { parseDxfOutline } from '@/engine/import/dxfOutline';

/** Shoelace area of one ring. */
function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

/** Build a DXF: a HEADER (optionally with $INSUNITS) and an ENTITIES section of token pairs. */
function dxf(entities: (string | number)[], units?: number): string {
  const parts: (string | number)[] = [];
  const g = (code: number, value: string | number): void => {
    parts.push(code, value);
  };
  g(0, 'SECTION');
  g(2, 'HEADER');
  if (units !== undefined) {
    g(9, '$INSUNITS');
    g(70, units);
  }
  g(0, 'ENDSEC');
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  parts.push(...entities);
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return parts.join('\n');
}

function lwPolyline(verts: [number, number][], closed = true, bulges: number[] = []): (string | number)[] {
  const out: (string | number)[] = [0, 'LWPOLYLINE', 90, verts.length, 70, closed ? 1 : 0];
  verts.forEach(([x, y], i) => {
    out.push(10, x, 20, y);
    if (bulges[i]) out.push(42, bulges[i]!);
  });
  return out;
}

function line(x1: number, y1: number, x2: number, y2: number): (string | number)[] {
  return [0, 'LINE', 10, x1, 20, y1, 11, x2, 21, y2];
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): (string | number)[] {
  return [0, 'ARC', 10, cx, 20, cy, 40, r, 50, a0, 51, a1];
}

function circle(cx: number, cy: number, r: number): (string | number)[] {
  return [0, 'CIRCLE', 10, cx, 20, cy, 40, r];
}

const ok = (r: ReturnType<typeof parseDxfOutline>) => {
  if (!r.ok) throw new Error(r.error);
  return r.outline;
};

const square: [number, number][] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('parseDxfOutline (#217): geometry', () => {
  it('a closed 10 × 10 LWPOLYLINE imports as 100 mm²', () => {
    const r = ok(parseDxfOutline(dxf(lwPolyline(square), 4)));
    expect(r.contours).toHaveLength(1);
    expect(ringArea(r.contours[0]!)).toBeCloseTo(100, 6);
    expect(r.width).toBeCloseTo(10, 6);
    expect(r.height).toBeCloseTo(10, 6);
    expect(r.format).toBe('dxf');
  });

  it('a CIRCLE imports at its radius', () => {
    const r = ok(parseDxfOutline(dxf(circle(5, 5, 3), 4)));
    expect(r.width).toBeCloseTo(6, 6);
    expect(r.height).toBeCloseTo(6, 6);
    expect(ringArea(r.contours[0]!)).toBeGreaterThan(28);
    expect(ringArea(r.contours[0]!)).toBeLessThan(28.3); // π·9 ≈ 28.274
  });

  it('a closed chain of LINEs joins into a ring', () => {
    const entities = [
      ...line(0, 0, 10, 0),
      ...line(10, 0, 10, 10),
      ...line(10, 10, 0, 10),
      ...line(0, 10, 0, 0),
    ];
    const r = ok(parseDxfOutline(dxf(entities, 4)));
    expect(r.contours).toHaveLength(1);
    expect(ringArea(r.contours[0]!)).toBeCloseTo(100, 6);
  });

  // #294: a closed loop that CONTAINS AN ARC — every filleted outline a CAD package exports. The
  // joiner appended an arc's points in the wrong order when it extended the chain's end, so the
  // loop never closed and imported as nothing. A line-only chain cannot see the difference.
  describe('a 20 × 10 rounded rectangle (r = 2) of 4 LINEs and 4 ARCs (#294)', () => {
    const exact = 200 - (4 - Math.PI) * 4; // 196.566…

    const lines = {
      bottom: line(2, 0, 18, 0),
      right: line(20, 2, 20, 8),
      top: line(18, 10, 2, 10),
      left: line(0, 8, 0, 2),
    };

    it('closes into one ring when the end angles are written as 360 / 90 / 180 / 270', () => {
      const entities = [
        ...lines.bottom, ...arc(18, 2, 2, 270, 360),
        ...lines.right, ...arc(18, 8, 2, 0, 90),
        ...lines.top, ...arc(2, 8, 2, 90, 180),
        ...lines.left, ...arc(2, 2, 2, 180, 270),
      ];
      const r = ok(parseDxfOutline(dxf(entities, 4)));
      expect(r.contours).toHaveLength(1);
      expect(Math.abs(ringArea(r.contours[0]!) - exact)).toBeLessThan(0.5);
      expect(r.notes.some((n) => /open LINE\/ARC chain/i.test(n))).toBe(false);
    });

    it('closes when an arc wraps through 0° (270 → 0), as CAD packages write it', () => {
      const entities = [
        ...lines.bottom, ...arc(18, 2, 2, 270, 0),
        ...lines.right, ...arc(18, 8, 2, 0, 90),
        ...lines.top, ...arc(2, 8, 2, 90, 180),
        ...lines.left, ...arc(2, 2, 2, 180, 270),
      ];
      const r = ok(parseDxfOutline(dxf(entities, 4)));
      expect(r.contours).toHaveLength(1);
      expect(Math.abs(ringArea(r.contours[0]!) - exact)).toBeLessThan(0.5);
    });

    it('closes whatever order the entities are written in, so both ends of the chain get extended', () => {
      const parts = [
        arc(2, 2, 2, 180, 270), lines.top, arc(18, 8, 2, 0, 90), lines.bottom,
        arc(2, 8, 2, 90, 180), lines.right, arc(18, 2, 2, 270, 360), lines.left,
      ];
      // Every rotation of the list, so no single start segment is doing the work.
      for (let k = 0; k < parts.length; k++) {
        const rotated = [...parts.slice(k), ...parts.slice(0, k)].flat();
        const r = ok(parseDxfOutline(dxf(rotated, 4)));
        expect(r.contours, `rotation ${k}`).toHaveLength(1);
        expect(Math.abs(ringArea(r.contours[0]!) - exact), `rotation ${k}`).toBeLessThan(0.5);
      }
    });
  });

  it('a LWPOLYLINE bulge adds arc points', () => {
    const sharp = ok(parseDxfOutline(dxf(lwPolyline(square), 4)));
    // tan(π/8) ≈ 0.4142 rounds the first corner (a 90° bulge).
    const rounded = ok(parseDxfOutline(dxf(lwPolyline(square, true, [0.41421356]), 4)));
    expect(rounded.contours[0]!.length).toBeGreaterThan(sharp.contours[0]!.length);
  });
});

describe('parseDxfOutline (#217): units', () => {
  it('$INSUNITS = 1 (inches) scales a 1 × 1 drawing to 25.4 mm', () => {
    const inchSquare: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    const r = ok(parseDxfOutline(dxf(lwPolyline(inchSquare), 1)));
    expect(r.width).toBeCloseTo(25.4, 6);
    expect(r.height).toBeCloseTo(25.4, 6);
  });

  it('a missing $INSUNITS defaults to mm with a visible note', () => {
    const r = ok(parseDxfOutline(dxf(lwPolyline(square))));
    expect(r.width).toBeCloseTo(10, 6);
    expect(r.notes.some((n) => /millimetre/i.test(n))).toBe(true);
  });
});

describe('parseDxfOutline (#217): out-of-scope content is reported', () => {
  it('an open LINE chain is reported and dropped', () => {
    const entities = [...line(0, 0, 10, 0), ...line(10, 0, 10, 10), ...line(10, 10, 0, 10)];
    const r = ok(parseDxfOutline(dxf(entities, 4)));
    expect(r.contours).toEqual([]);
    expect(r.notes.some((n) => /open LINE\/ARC chain/i.test(n))).toBe(true);
  });

  it('an open LWPOLYLINE is reported and dropped', () => {
    const r = ok(parseDxfOutline(dxf(lwPolyline(square, false), 4)));
    expect(r.contours).toEqual([]);
    expect(r.notes.some((n) => /open LWPOLYLINE/i.test(n))).toBe(true);
  });

  it('an unsupported entity type is named', () => {
    const entities: (string | number)[] = [...lwPolyline(square), 0, 'SPLINE', 8, '0'];
    const r = ok(parseDxfOutline(dxf(entities, 4)));
    expect(r.contours).toHaveLength(1); // the closed polyline still imports
    expect(r.notes.some((n) => /SPLINE/.test(n))).toBe(true);
  });
});

describe('parseDxfOutline (#217): refusals', () => {
  it('refuses an oversized file before parsing', () => {
    const huge = '$ACADVER\n1\n' + ' '.repeat(6 * 1024 * 1024);
    const r = parseDxfOutline(huge);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/limit/i);
  });

  it('rejects a non-DXF document', () => {
    const r = parseDxfOutline('hello world\nnot a dxf');
    expect(r.ok).toBe(false);
  });
});
