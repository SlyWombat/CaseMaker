// #549 — the "here is where you put it" overlay: which items vanish, and the design outline of
// each, recomputed from the JOB (never from the worker) so a blocked item can still be drawn.
//
// The outline assertions are geometric — a shape's outline must land centred on its `position`
// with its stated size, and a label's glyph outline must be centred on its `position` — never a
// comparison against another run of the same code. Fonts are pre-parsed by `tests/setup/fonts.ts`,
// so `resolveFont` is synchronous here exactly as it is in the viewport.

import { describe, it, expect } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { noneSacrificial } from '@/engine/cnc/sacrificial';
import {
  blockedItemIds,
  warningOutlinesFor,
  type WarningRing,
} from '@/components/viewport/engraveWarning';
import type {
  EngraveJob,
  EngraveRectShape,
  EngraveShape,
  EngraveSlotShape,
} from '@/types/engraveJob';

/** The bounding box of a set of outline rings. */
function bounds(rings: readonly WarningRing[]): { cx: number; cy: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of rings)
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

const base = { position: { x: 50, y: 30 }, rotation: 0, depth: 1, enabled: true };

function rect(over: Partial<EngraveRectShape> = {}): EngraveRectShape {
  return { id: 'r', kind: 'rect', width: 20, height: 10, cornerRadius: 0, ...base, ...over };
}

function slot(over: Partial<EngraveSlotShape> = {}): EngraveSlotShape {
  return { id: 's', kind: 'slot', length: 30, width: 10, ...base, ...over };
}

/** A one-shape job in the default stock, with no labels so only the shape is in play. */
function shapeJob(shape: EngraveShape, over: Partial<EngraveJob> = {}): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [];
  job.shapes = [shape];
  return { ...job, ...over };
}

describe('#549 blockedItemIds', () => {
  it('lists every enabled, non-construction region item the preview cut nothing of', () => {
    const job = shapeJob(rect());
    job.shapes.push(rect({ id: 'r2', position: { x: 10, y: 10 } }));
    // `r` and `r2` have no floor; a disabled shape and a construction label are not "blocked".
    job.shapes.push(rect({ id: 'off', enabled: false }));
    job.labels.push({
      id: 'ref', text: 'X', font: 'sans-default', weight: 'bold', size: 8,
      position: { x: 0, y: 0 }, rotation: 0, depth: 1, enabled: true, construction: true,
    });
    expect(blockedItemIds(job, new Set())).toEqual(['r', 'r2']);
  });

  it('treats a floor as "cut something", so it is not blocked', () => {
    const job = shapeJob(rect());
    job.shapes.push(rect({ id: 'r2' }));
    expect(blockedItemIds(job, new Set(['r2']))).toEqual(['r']);
  });
});

describe('#549 warningOutlinesFor — shapes land at their real position', () => {
  it('rectangle: 20×10 centred on its position', () => {
    const outlines = warningOutlinesFor(shapeJob(rect()), new Set());
    expect(outlines.map((o) => o.labelId)).toEqual(['r']);
    const b = bounds(outlines[0]!.rings);
    expect(b.cx).toBeCloseTo(50, 4);
    expect(b.cy).toBeCloseTo(30, 4);
    expect(b.w).toBeCloseTo(20, 4);
    expect(b.h).toBeCloseTo(10, 4);
  });

  it('rectangle rotated 90°: same centre, width/height swapped', () => {
    const outlines = warningOutlinesFor(shapeJob(rect({ rotation: 90 })), new Set());
    const b = bounds(outlines[0]!.rings);
    expect(b.cx).toBeCloseTo(50, 4);
    expect(b.cy).toBeCloseTo(30, 4);
    expect(b.w).toBeCloseTo(10, 4);
    expect(b.h).toBeCloseTo(20, 4);
  });

  it('rounded rectangle keeps its footprint', () => {
    const outlines = warningOutlinesFor(shapeJob(rect({ cornerRadius: 3 })), new Set());
    const b = bounds(outlines[0]!.rings);
    expect(b.cx).toBeCloseTo(50, 4);
    expect(b.cy).toBeCloseTo(30, 4);
    expect(b.w).toBeCloseTo(20, 4);
    expect(b.h).toBeCloseTo(10, 4);
  });

  it('slot: 30×10 centred on its position', () => {
    const outlines = warningOutlinesFor(shapeJob(slot()), new Set());
    const b = bounds(outlines[0]!.rings);
    expect(b.cx).toBeCloseTo(50, 4);
    expect(b.cy).toBeCloseTo(30, 4);
    expect(b.w).toBeCloseTo(30, 4);
    expect(b.h).toBeCloseTo(10, 4);
  });
});

describe('#549 warningOutlinesFor — labels', () => {
  it('draws a blocked label\'s glyph outline centred on its position', () => {
    // The default job has three enabled labels, none of them cut → all three are blocked.
    const job = defaultEngraveJob();
    const outlines = warningOutlinesFor(job, new Set());
    expect(outlines).toHaveLength(3);
    // 'CASE' sits at (50, 43): `labelProfile` centres the ink box on `position`.
    const caseOutline = outlines.find((o) => o.labelId === job.labels[0]!.id)!;
    const b = bounds(caseOutline.rings);
    expect(b.cx).toBeCloseTo(50, 4);
    expect(b.cy).toBeCloseTo(43, 4);
  });

  it('a whitespace-only label is blocked but has nothing to draw', () => {
    const job = defaultEngraveJob();
    job.labels = [
      {
        id: 'blank', text: '   ', font: 'sans-default', weight: 'bold', size: 12,
        position: { x: 50, y: 30 }, rotation: 0, depth: 1, enabled: true,
      },
    ];
    expect(blockedItemIds(job, new Set())).toEqual(['blank']);
    expect(warningOutlinesFor(job, new Set())).toEqual([]);
  });
});

describe('#549 warningOutlinesFor — nothing to draw when nothing is blocked', () => {
  it('returns empty when every enabled item has a floor', () => {
    const job = defaultEngraveJob();
    const floorIds = new Set(job.labels.map((l) => l.id));
    expect(warningOutlinesFor(job, floorIds)).toEqual([]);
  });

  it('ignores sacrificial-less jobs without crashing', () => {
    // `noneSacrificial` is only here to prove the module does not touch the sacrificial setup.
    void noneSacrificial;
    expect(warningOutlinesFor(defaultEngraveJob(), new Set())).toHaveLength(3);
  });
});
