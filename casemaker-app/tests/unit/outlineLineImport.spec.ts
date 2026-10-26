/**
 * #664/#678 — an accepted outline's paths as `line` items: open strokes stay open, a stroke-only
 * shape's ring stays a RING, and a ring longer than one document line's cap is still the ring
 * (open chunks sharing seams, the last returning to the first point).
 */

import { describe, it, expect } from 'vitest';

import { toLineTraces } from '@/engine/import/outlineImport';
import { MAX_LINE_POINTS } from '@/types/engraveJob';
import type { OutlineImport, OutlinePath } from '@/engine/import/outlineTypes';

const fields = {
  position: { x: 50, y: 30 },
  depth: 1,
  name: 'ring.svg',
  idFor: (i: number) => `line-${i}`,
};

function outline(paths: OutlinePath[]): OutlineImport {
  return {
    format: 'svg',
    sourceName: 'ring.svg',
    contours: [],
    paths,
    fillRule: 'NonZero',
    width: 10,
    height: 10,
    notes: [],
  };
}

/** A square ring of `n` distinct points, no repeated closing point (the flag carries it). */
function ring(n: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) pts.push([Math.cos((i / n) * 2 * Math.PI) * 5, Math.sin((i / n) * 2 * Math.PI) * 5]);
  return pts;
}

describe('toLineTraces — a closed path is a closed line (#678)', () => {
  it('keeps a ring under the cap as ONE closed line, points untouched', () => {
    const points = ring(60);
    const lines = toLineTraces(outline([{ points, closed: true }]), fields);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closed).toBe(true);
    expect(lines[0]!.points).toEqual(points);
    expect(lines[0]!.name).toBe('ring.svg');
  });

  it('keeps an open stroke open', () => {
    const lines = toLineTraces(outline([{ points: [[-5, 0], [5, 0]], closed: false }]), fields);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.closed).toBe(false);
  });

  it('splits a ring past the cap into OPEN chunks whose last point returns to the first', () => {
    const points = ring(MAX_LINE_POINTS + 1);
    const lines = toLineTraces(outline([{ points, closed: true }]), fields);
    expect(lines.length).toBeGreaterThan(1);
    // Every chunk is loadable and OPEN: a closed chunk would cut a chord back to its own start.
    for (const line of lines) {
      expect(line.closed).toBe(false);
      expect(line.points.length).toBeLessThanOrEqual(MAX_LINE_POINTS);
    }
    // The chunks join at their seams…
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1]!.points;
      expect(lines[i]!.points[0]).toEqual(prev[prev.length - 1]);
    }
    // …and the union IS the ring: the last chunk ends on the ring's first point.
    const last = lines[lines.length - 1]!.points;
    expect(last[last.length - 1]).toEqual(points[0]);
    // Named per item so the rows can be told apart.
    expect(lines[0]!.name).toBe('ring.svg — line 1');
    expect(lines[1]!.name).toBe('ring.svg — line 2');
  });

  it('leaves a file with no paths empty', () => {
    expect(toLineTraces(outline([]), fields)).toEqual([]);
  });
});
