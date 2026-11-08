/**
 * #1073 — THE FLIP DRAWING'S BLANK OUTLINE IS A RECTANGLE.
 *
 * The panel maps work XY with y UP: the work origin lands at the panel's bottom-left and the far
 * corner at its top-right, so `a.x < b.x` and `a.y > b.y`. Building the outline rect from
 * `(b.x, b.y)` with a width of `a.x - b.x` made the width NEGATIVE — -98 px on a 160 mm blank —
 * and Chrome drops a negative-width rect, so the blank had no outline at all in either panel
 * (A's rehearsal, 2026-11-08; docs/bench/img/2026-11-08-flip-dryrun/rect-probe-setup2.png).
 *
 * RED at main a9d22b505: the width is negative on both panels.
 */
import { describe, expect, it } from 'vitest';

import { FLIP_DIAGRAM_PANEL_W, flipDiagramSvg } from '@/engine/cnc/engrave/flipDiagram';

const LENGTH_MM = 160;
const WIDTH_MM = 126;
const PAD = 26;
/** The drawing's one scale: the longer axis fills the panel less the padding, both axes share it. */
const SCALE = (FLIP_DIAGRAM_PANEL_W - 2 * PAD) / Math.max(LENGTH_MM, WIDTH_MM);

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The blank's outline rect in one panel: the only `fill="none"` rect in the outline ink. */
function blankOutline(panel: string): Rect {
  const rects = [...panel.matchAll(/<rect\b[^>]*>/g)].map((m) => m[0]);
  const rect = rects.find((r) => r.includes('fill="none"') && r.includes('stroke="#d1d5db"'));
  if (rect === undefined) throw new Error('the panel draws no blank outline rect');
  const num = (name: string): number => {
    const m = new RegExp(`${name}="(-?[0-9.]+)"`).exec(rect);
    if (m === null) throw new Error(`the blank outline states no ${name}: ${rect}`);
    return Number(m[1]);
  };
  return { x: num('x'), y: num('y'), width: num('width'), height: num('height') };
}

/** The two panel groups of the drawing. */
function panel(svg: string, side: 'before' | 'after'): string {
  const start = svg.indexOf(`data-testid="flip-panel-${side}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = svg.indexOf('</g>', start);
  expect(end).toBeGreaterThan(start);
  return svg.slice(start, end);
}

describe('#1073 the flip drawing’s blank outline', () => {
  const svg = flipDiagramSvg({
    lengthMm: LENGTH_MM,
    widthMm: WIDTH_MM,
    flip: { method: 'tabs-in-blank', axis: 'left-right' },
  });

  for (const side of ['before', 'after'] as const) {
    it(`the ${side} panel draws the blank as a positive rect of its own size`, () => {
      const r = blankOutline(panel(svg, side));
      const ox = side === 'before' ? 0 : FLIP_DIAGRAM_PANEL_W;
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
      // The blank's own extent, at the drawing's single scale — not the arm's, not the panel's.
      expect(r.width).toBeCloseTo(LENGTH_MM * SCALE, 3);
      expect(r.height).toBeCloseTo(WIDTH_MM * SCALE, 3);
      // The rect sits inside its own panel: left edge at the padding, right edge inside the box.
      expect(r.x).toBeCloseTo(ox + PAD, 3);
      expect(r.x + r.width).toBeLessThanOrEqual(ox + PAD + LENGTH_MM * SCALE + 1e-9);
    });
  }
});
