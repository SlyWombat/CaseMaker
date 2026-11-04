// @vitest-environment jsdom
// #968 — AN SVG STROKE WITH A WIDTH IS A REGION (the painted band), not a centre line.
//
// Studio's coasters program raster-clears the strokes' painted bands; our importer read the same
// strokes as lines. These tests pin the band import: the stroke's own width (SVG default 1 user
// unit), cap and join decide a REGION the pocket/area ops cut; only zero/hairline strokes stay
// lines. The coasters SVG itself (a local reference, not committed — CC BY) is the second half:
// 50 strokes become 50 regions, and their total area is the centreline length x the 1 mm band.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { parseSvgOutline, parseSvgPath } from '@/engine/import/svgOutline';

type Ring = [number, number][];

/** Shoelace area of one closed ring, mm². */
function ringArea(ring: Ring): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return Math.abs(a) / 2;
}

function svg(body: string, attrs = ''): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
}

function ok(r: ReturnType<typeof parseSvgOutline>) {
  if (!r.ok) throw new Error(r.error);
  return r.outline;
}

const MM100 = 'width="100mm" height="100mm" viewBox="0 0 100 100"';

describe('#968 a stroked path is a band region', () => {
  it('an open line with a width is one region, area = length x width (butt caps)', () => {
    const o = ok(parseSvgOutline(svg('<path d="M0 0 L100 0" fill="none" stroke="#000" stroke-width="2"/>', MM100)));
    expect(o.contours).toHaveLength(1);
    expect(ringArea(o.contours[0]!)).toBeCloseTo(200, 0);
    expect(o.paths ?? []).toHaveLength(0);
  });

  it('round caps add a half-disc at each end', () => {
    const o = ok(
      parseSvgOutline(
        svg('<path d="M0 0 L100 0" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round"/>', MM100),
      ),
    );
    expect(ringArea(o.contours[0]!)).toBeCloseTo(200 + Math.PI, 0);
  });

  it('square caps extend the band by half a width at each end', () => {
    const o = ok(
      parseSvgOutline(
        svg('<path d="M0 0 L100 0" fill="none" stroke="#000" stroke-width="2" stroke-linecap="square"/>', MM100),
      ),
    );
    expect(ringArea(o.contours[0]!)).toBeCloseTo(204, 0);
  });

  it('a closed stroke is one annulus: area = centreline length x width', () => {
    const o = ok(
      parseSvgOutline(
        svg('<path d="M0 0 H40 V20 H0 Z" fill="none" stroke="#000" stroke-width="2"/>', 'width="40mm" height="20mm" viewBox="0 0 40 20"'),
      ),
    );
    expect(o.contours).toHaveLength(1);
    expect(ringArea(o.contours[0]!)).toBeCloseTo(2 * 2 * (40 + 20), 0); // w x perimeter
  });

  it('a stroked <rect> is an annulus too, the headline #678 case', () => {
    const o = ok(
      parseSvgOutline(
        svg('<rect x="0" y="0" width="40" height="20" fill="none" stroke="#000" stroke-width="2"/>', 'width="40mm" height="20mm" viewBox="0 0 40 20"'),
      ),
    );
    expect(o.contours).toHaveLength(1);
    expect(ringArea(o.contours[0]!)).toBeCloseTo(2 * 2 * (40 + 20), 0);
  });

  it('zero width stays a centre line, and says so', () => {
    const o = ok(parseSvgOutline(svg('<path d="M0 0 L10 10" fill="none" stroke="#000" stroke-width="0"/>', 'width="10mm" viewBox="0 0 10 10"')));
    expect(o.contours).toHaveLength(0);
    expect(o.paths ?? []).toHaveLength(1);
    expect(o.notes.some((n) => /hairline|line/i.test(n))).toBe(true);
  });

  it('a stroked polyline is a band, not a line (#664 superseded by #968)', () => {
    const o = ok(parseSvgOutline(svg('<polyline points="0,0 10,0 10,10" fill="none" stroke="#000" stroke-width="2"/>', 'width="10mm" height="10mm" viewBox="0 0 10 10"')));
    expect(o.contours).toHaveLength(1);
    expect(o.paths ?? []).toHaveLength(0);
    // Two 10 mm segments, 2 mm wide, with a 90° miter join at the corner.
    expect(ringArea(o.contours[0]!)).toBeGreaterThan(35);
  });

  it('honours non-scaling-stroke: the width is the viewport width, not the local transform', () => {
    const body =
      '<g transform="scale(0.5)"><path d="M0 0 L200 0" fill="none" stroke="#000" stroke-width="2" vector-effect="non-scaling-stroke"/></g>';
    const o = ok(parseSvgOutline(svg(body, MM100)));
    expect(ringArea(o.contours[0]!)).toBeCloseTo(200, 0); // 100 mm long x 2 mm wide
  });

  it('without non-scaling-stroke the transform scales the width too', () => {
    const body = '<g transform="scale(0.5)"><path d="M0 0 L200 0" fill="none" stroke="#000" stroke-width="2"/></g>';
    const o = ok(parseSvgOutline(svg(body, MM100)));
    expect(ringArea(o.contours[0]!)).toBeCloseTo(100, 0); // 100 mm long x 1 mm wide
  });
});

// ---------------------------------------------------------------------------------------------
// The coasters reference (local inputs, like the figures; CC BY, never committed).
// ---------------------------------------------------------------------------------------------

const ROOT = path.resolve(process.cwd(), '..');
const COASTERS =
  process.env.CM_COASTERS_SVG ??
  path.join(ROOT, '.scratch/makerables/dl/traditional-mandala-pattern-wooden-coasters/321-mrxcrxhw.svg');
const maybe = existsSync(COASTERS) ? it : it.skip;

maybe('the coasters SVG: 50 strokes become 50 regions whose area is the 1 mm band', () => {
  const text = readFileSync(COASTERS, 'utf8');
  const o = ok(parseSvgOutline(text, 'coasters.svg'));

  // 49 open paths + 1 closed rounded rect, each with its stroke's width: one region per stroke.
  expect(o.contours).toHaveLength(50);

  // Total painted area = the centreline length x the stroke's 1 mm width. The paths carry a
  // 0.500311 uniform scale and `vector-effect="non-scaling-stroke"`, so their drawn length is the
  // local path length x that scale while the width stays 1 viewport unit = 1 mm. The rounded rect
  // (75 x 75, r = 8) is drawn at scale 1: perimeter = 4 x 59 + 2 pi x 8.
  let expected = 4 * (75 - 16) + 2 * Math.PI * 8;
  const pathTags = text.match(/<path[^>]*>/g) ?? [];
  for (const tag of pathTags) {
    const d = /d="([^"]*)"/.exec(tag)?.[1];
    const m = /matrix\(([^)]*)\)/.exec(tag)?.[1];
    if (!d || !m) continue;
    const [a = 1, b = 0, c = 0, dd = 1] = m.split(',').map(Number);
    const scale = Math.sqrt(Math.abs(a * dd - b * c));
    const subpaths = parseSvgPath(d, 0.01);
    for (const sub of subpaths) {
      for (let i = 1; i < sub.points.length; i++) {
        const p = sub.points[i - 1]!;
        const q = sub.points[i]!;
        expected += Math.hypot(q[0] - p[0], q[1] - p[1]) * scale;
      }
    }
  }
  const actual = o.contours.reduce((sum, ring) => sum + ringArea(ring), 0);
  expect(actual).toBeGreaterThan(expected * 0.98);
  expect(actual).toBeLessThan(expected * 1.02);

  // The bands reach the drawing's own footprint (75 mm) plus half a band on each side.
  let minX = Infinity;
  let maxX = -Infinity;
  for (const ring of o.contours) {
    for (const [x] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  expect(maxX - minX).toBeGreaterThan(75);
  expect(maxX - minX).toBeLessThan(77);
});
