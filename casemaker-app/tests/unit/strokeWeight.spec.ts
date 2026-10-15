// Bold, condensed, legible V-bit text (#409): the three job fields on a `stroke-label` trace and
// the geometry they drive.
//
// The assertions are geometric and CLOSED-FORM where they can be: a bold stroke's cut width is
// MEASURED off a lateral column grid (the union of the passes' groove intervals), not asserted
// from the pass count; the spacing invariant is measured off the ink gaps the typesetter actually
// laid out; the condense is checked against the same text at widthScale = 1. Nothing here needs
// the wasm harness.

import { describe, it, expect } from 'vitest';

import {
  boldStrokePasses,
  offsetPolyline,
  strokeGlyphPaths,
  type StrokeTypesetOptions,
} from '@/engine/fonts/stroke/strokeFont';
import { tracePaths } from '@/engine/cnc/engrave/partPlan';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { grooveWidthAt, vCone } from '@/engine/cnc/vProfile';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveStrokeLabelItem } from '@/types/engraveJob';

type Pt = [number, number];

/** The bench job's cutter: the 30° × 0.3 mm engraving bit from `docs/bench/single-barrel.job.json`. */
const BIT30: Tool = flatEndMill(0.3, {
  name: 'Single Flute Engraving Bit 30 x 0.3',
  typeText: 'Engraving',
  shape: 'engraving',
  handleDiameter: 3.175,
  diameter: 3.175,
  tipDiameter: 0.3,
  angle: 30,
  halfAngle: 15,
});

/** The one groove width every number below is about: the cone's opening 1.0 mm below the tip. */
const GROOVE = grooveWidthAt(vCone(BIT30)!, 1.0); // 0.3 + 2·tan15° = 0.8359 mm
const DEPTH = 1.0;

function bbox(paths: readonly (readonly Pt[])[]): { w: number; h: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of paths) {
    for (const [x, y] of p) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { w: maxX - minX, h: maxY - minY };
}

/**
 * The ink gaps between the adjacent INKED glyphs of `text`, mm, measured from the typeset paths.
 *
 * Each glyph is isolated by typesetting the growing PREFIX and taking the strokes the next
 * character added: the layout is built left to right, and an inserted gap depends only on the
 * glyph before it, so a prefix places its glyphs exactly where the full string does. Whitespace
 * contributes no strokes, so it drops out of the run — which is right, since a space neither eats
 * into a gap nor needs one kept clear of it.
 */
function glyphInkGaps(text: string, size: number, options: StrokeTypesetOptions): number[] {
  const runs: { min: number; max: number }[] = [];
  let seen = 0;
  for (let k = 1; k <= text.length; k++) {
    const paths = strokeGlyphPaths(text.slice(0, k), 'hershey-simplex', size, options);
    if (paths.length === seen) continue; // this character added no stroke (whitespace, or an empty glyph)
    let min = Infinity;
    let max = -Infinity;
    for (let i = seen; i < paths.length; i++) {
      for (const [x] of paths[i]!) {
        if (x < min) min = x;
        if (x > max) max = x;
      }
    }
    runs.push({ min, max });
    seen = paths.length;
  }
  const gaps: number[] = [];
  for (let i = 1; i < runs.length; i++) gaps.push(runs[i]!.min - runs[i - 1]!.max);
  return gaps;
}

describe("a bold stroke's cut width (#409)", () => {
  /**
   * Measure the cut a set of bold passes makes, on a lateral column grid: a column (a position
   * across the stroke) is COVERED when it lies within `cutWidth / 2` of some pass's centre, and the
   * stroke's cut width is the extent of the covered columns. The passes are along +x, so a pass's
   * centre is its y — the perpendicular offset of the copy from the source.
   */
  function measuredCutWidth(passes: readonly (readonly Pt[])[], cutWidth: number): number {
    const offsets = passes.map((p) => p[0]![1]);
    const lo = Math.min(...offsets) - cutWidth;
    const hi = Math.max(...offsets) + cutWidth;
    const steps = 4000;
    const step = (hi - lo) / steps;
    let min = Infinity;
    let max = -Infinity;
    let covered = 0;
    for (let i = 0; i <= steps; i++) {
      const y = lo + i * step;
      const hit = offsets.some((o) => Math.abs(y - o) <= cutWidth / 2 + 1e-12);
      if (!hit) continue;
      covered++;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    // Contiguity: how many sample columns sit inside the extremes but were NOT covered (a spine).
    const inner = Math.round((max - min) / step) + 1;
    expect(covered).toBeGreaterThanOrEqual(inner - 1); // at most one rounding column
    return max - min;
  }

  const straight = (): Pt[] => [[0, 0], [10, 0]];

  it('reaches the target width, with no uncut spine between the passes', () => {
    const weight = 1.5;
    const passes = boldStrokePasses([straight()], GROOVE, weight);
    expect(passes.length).toBeGreaterThan(1); // a wider-than-one-pass stroke is several passes
    // The union of the passes' grooves spans the target, measured on the grid — to within a column.
    expect(measuredCutWidth(passes, GROOVE)).toBeCloseTo(weight, 2);
  });

  it('spaces the passes no further apart than one cut width (#191: no uncut spine)', () => {
    for (const weight of [1.0, 1.2, 1.5, 2.0]) {
      const passes = boldStrokePasses([straight()], GROOVE, weight);
      const offsets = passes.map((p) => p[0]![1]).sort((a, b) => a - b);
      for (let i = 1; i < offsets.length; i++) {
        expect(offsets[i]! - offsets[i - 1]!).toBeLessThanOrEqual(GROOVE + 1e-9);
      }
      // Symmetric about the source line, so the stroke does not shift.
      expect(Math.min(...offsets)).toBeCloseTo(-Math.max(...offsets), 9);
    }
  });

  it('keeps the passes inside the stroke along its own direction (flat caps)', () => {
    const passes = boldStrokePasses([straight()], GROOVE, 1.5);
    for (const p of passes) {
      const xs = p.map(([x]) => x);
      expect(Math.min(...xs)).toBeCloseTo(0, 9);
      expect(Math.max(...xs)).toBeCloseTo(10, 9);
    }
  });

  it('leaves the strokes alone when the weight is no wider than one pass', () => {
    const one = strokeGlyphPaths('H', 'hershey-simplex', 8);
    expect(boldStrokePasses(one, GROOVE, GROOVE)).toEqual(one);
    expect(boldStrokePasses(one, GROOVE, 0.5)).toEqual(one);
    // With no known cut width there is nothing to widen, so bold is a no-op too.
    expect(boldStrokePasses(one, 0, 1.5)).toEqual(one);
  });
});

describe('offsetPolyline (#409)', () => {
  it('offsets a straight segment by the distance, on the left of travel', () => {
    const out = offsetPolyline([[0, 0], [10, 0]], 0.5);
    expect(out).toEqual([[0, 0.5], [10, 0.5]]);
    const right = offsetPolyline([[0, 0], [10, 0]], -0.5);
    expect(right).toEqual([[0, -0.5], [10, -0.5]]);
  });

  it('miters an interior corner (a right angle gives the diagonal corner, not a gap)', () => {
    // Along +x then +y: the left normal turns from +y to −x, and the miter point is (+d, +d).
    const out = offsetPolyline([[0, 0], [10, 0], [10, 10]], 1);
    expect(out[1]![0]).toBeCloseTo(9, 9);
    expect(out[1]![1]).toBeCloseTo(1, 9);
  });

  it('chamfers a sharp apex so the outer bold pass cannot spike (#409 review)', () => {
    // A 40° apex, the "A". A miter reaches `d / sin(20°) = 2.92·d` from the vertex, putting the
    // outermost pass's groove edge 1.39 mm out against the ~0.75 mm the spacing rule budgeted.
    const d = (1.5 - GROOVE) / 2; // the outer pass's offset for a 1.5 mm bold stroke — 0.332 mm
    const half = (20 * Math.PI) / 180;
    const L = 12;
    const chevron: Pt[] = [
      [-Math.sin(half) * L, -Math.cos(half) * L],
      [0, 0],
      [Math.sin(half) * L, -Math.cos(half) * L],
    ];

    // Chamfered: the outer pass's corner is TWO points, each exactly `d` from the vertex — so the
    // groove edge is `d + cut / 2`, the budget — not the single spike the miter produced.
    const outer = offsetPolyline(chevron, d);
    const corner = outer.filter(([x, y]) => Math.hypot(x, y) < 1); // the apex points, not the arms
    expect(corner.length).toBe(2);
    const reach = Math.max(...corner.map(([x, y]) => Math.hypot(x, y)));
    expect(reach).toBeCloseTo(d, 9); // measured off the produced pass, not asserted from the rule
    expect(reach + GROOVE / 2).toBeCloseTo(0.75, 3);

    // …and the miter it replaced really was the spike the review measured.
    const miterReach = d / Math.sin(half);
    expect(miterReach + GROOVE / 2).toBeCloseTo(1.39, 2);
    expect(reach).toBeLessThan(miterReach / 2);
  });

  it('is a copy at distance 0 or on a degenerate path', () => {
    const path: Pt[] = [[1, 2], [3, 4]];
    expect(offsetPolyline(path, 0)).toEqual(path);
    expect(offsetPolyline([[5, 5]], 2)).toEqual([[5, 5]]);
  });
});

describe('condense (#409)', () => {
  it("scales the line's length by widthScale and leaves its height untouched", () => {
    const text = 'Single Barrel';
    const size = 8;
    const full = bbox(strokeGlyphPaths(text, 'hershey-simplex', size));
    for (const ws of [0.9, 0.78, 0.6]) {
      const condensed = bbox(strokeGlyphPaths(text, 'hershey-simplex', size, { widthScale: ws }));
      expect(condensed.w).toBeCloseTo(ws * full.w, 9); // shorter, in proportion
      expect(condensed.h).toBeCloseTo(full.h, 9); // the cap height is unchanged
    }
  });

  it('is the font’s own layout when no options are given', () => {
    const text = '(Like the Whiskey)';
    expect(strokeGlyphPaths(text, 'hershey-simplex', 5.4, {})).toEqual(strokeGlyphPaths(text, 'hershey-simplex', 5.4));
  });
});

describe("spacing leaves a groove's width of clear surface (#409)", () => {
  // The maintainer's own fused pairs (#409: "is" in Whiskey, "ik" in Like, "in" in Single).
  const CASES: [string, number][] = [
    ['Single Barrel', 8.6],
    ['(Like the Whiskey)', 5.4],
    ['is', 5.4],
    ['ik', 5.4],
    ['in', 5.4],
  ];

  it('holds inkGap ≥ 2 × cutWidth after layout, at the bench sizes', () => {
    for (const [text, size] of CASES) {
      const gaps = glyphInkGaps(text, size, { minGapCutWidth: GROOVE });
      expect(gaps.length).toBeGreaterThan(0);
      for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(2 * GROOVE - 1e-9);
    }
  });

  it('FAILS at one cutWidth of clear surface — the font’s own spacing is too tight', () => {
    // The invariant is `inkGap ≥ 2·cutWidth`. Asking the layout for only one cutWidth of CLEAR
    // surface (so `inkGap ≥ cutWidth`) still leaves gaps under `2·cutWidth`, and the untouched
    // font leaves them under `cutWidth` — which is exactly the fusion #409 is about.
    for (const [text, size] of CASES) {
      const natural = glyphInkGaps(text, size, {});
      expect(Math.min(...natural)).toBeLessThan(GROOVE); // the raw font fuses at this cutter
      const oneCut = glyphInkGaps(text, size, { minGapCutWidth: GROOVE / 2 });
      expect(Math.min(...oneCut)).toBeGreaterThanOrEqual(GROOVE - 1e-9); // the smaller rule is met…
      expect(Math.min(...oneCut)).toBeLessThan(2 * GROOVE - 1e-9); // …but the real one is not
    }
  });

  it('does nothing when no cut width is given — the default is today’s layout', () => {
    for (const [text, size] of CASES) {
      expect(glyphInkGaps(text, size, { minGapCutWidth: 0 })).toEqual(glyphInkGaps(text, size, {}));
    }
  });
});

describe('tracePaths lays out and widens a stroke label (#409)', () => {
  // Rotation 0, so the line runs along +x and a bbox width IS the line's length. (The bench job
  // turns the line to +y; the rotation is a rigid move and orthogonal to all of this.)
  const item = (over: Partial<EngraveStrokeLabelItem>): EngraveStrokeLabelItem => ({
    kind: 'stroke-label',
    id: 's',
    text: 'Single Barrel',
    font: 'hershey-simplex',
    size: 8.6,
    position: { x: 13.69, y: 38.1 },
    rotation: 0,
    depth: DEPTH,
    enabled: true,
    ...over,
  });

  it('opens the glyph gaps only when `spacing` asks for it (#409 review)', () => {
    const fontLayout = tracePaths(item({}), null); // no tool: the font's own metrics
    // A cone alone does NOT space: the field is absent, so the layout is the font's own and every
    // stored V-bit job (the committed bench job included) regenerates byte-for-byte.
    const coneDefault = tracePaths(item({}), BIT30);
    expect(coneDefault.paths).toEqual(fontLayout.paths);
    // The opt-in field is what opens the gaps — the same strokes, moved apart.
    const spaced = tracePaths(item({ spacing: 'cut-width' }), BIT30);
    expect(bbox(spaced.paths).w).toBeGreaterThan(bbox(coneDefault.paths).w);
    expect(spaced.paths.length).toBe(coneDefault.paths.length);
  });

  it('widens a bold stroke into passes, and groups them as one stroke', () => {
    const one = tracePaths(item({}), BIT30);
    const bold = tracePaths(item({ weight: 1.5 }), BIT30);
    // Two passes per stroke at 1.5 mm over a 0.836 mm pass, and every pass of a stroke shares a
    // group, so the stroke-merge check does not report a stroke against itself.
    const perStroke = bold.paths.length / one.paths.length;
    expect(Number.isInteger(perStroke)).toBe(true);
    expect(perStroke).toBeGreaterThan(1);
    expect(bold.groups.length).toBe(bold.paths.length);
    const groups = new Set(bold.groups);
    expect(groups.size).toBe(one.paths.length);
  });

  it('leaves a bold weight alone when the job names no cutter', () => {
    const withTool = tracePaths(item({}), BIT30);
    const boldNoTool = tracePaths(item({ weight: 1.5 }), null);
    expect(boldNoTool.paths).toEqual(tracePaths(item({}), null).paths);
    // …and the tool-less layout is narrower than the bold one, because bold really did widen it.
    expect(bbox(boldNoTool.paths).w).toBeLessThan(bbox(tracePaths(item({ weight: 1.5 }), BIT30).paths).w);
    expect(withTool.paths.length).toBeLessThan(tracePaths(item({ weight: 1.5 }), BIT30).paths.length);
  });
});

describe('the three fields are on the document (#409)', () => {
  const payload = (trace: Record<string, unknown>) => {
    const base = JSON.parse(JSON.stringify(defaultEngraveJob())) as Record<string, unknown>;
    return { ...base, traces: [{ kind: 'stroke-label', id: 't', text: 'Hi', font: 'hershey-simplex', size: 8, position: { x: 5, y: 5 }, rotation: 0, depth: 1, enabled: true, ...trace }] };
  };

  it('keeps widthScale, weight and spacing through the schema (unknown keys are stripped, these are not)', () => {
    const parsed = parseEngraveJob(payload({ widthScale: 0.8, weight: 1.5, spacing: 'cut-width' }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const trace = parsed.job.traces![0]!;
    expect(trace.kind).toBe('stroke-label');
    if (trace.kind !== 'stroke-label') throw new Error('not a stroke label');
    expect(trace.widthScale).toBe(0.8);
    expect(trace.weight).toBe(1.5);
    expect(trace.spacing).toBe('cut-width');
  });

  it('leaves the fields absent when the document states none (a pre-#409 job round-trips)', () => {
    const parsed = parseEngraveJob(payload({}));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    const trace = parsed.job.traces![0]!;
    expect('widthScale' in trace).toBe(false);
    expect('weight' in trace).toBe(false);
    expect('spacing' in trace).toBe(false);
  });

  it('refuses a widthScale or weight outside its bound, and any other spacing value', () => {
    expect(parseEngraveJob(payload({ widthScale: 0.4 })).ok).toBe(false);
    expect(parseEngraveJob(payload({ widthScale: 2.5 })).ok).toBe(false);
    expect(parseEngraveJob(payload({ weight: 0 })).ok).toBe(false);
    expect(parseEngraveJob(payload({ weight: 25 })).ok).toBe(false);
    // `'cut-width'` is the only spacing there is (so far); a typo is refused, not silently ignored.
    expect(parseEngraveJob(payload({ spacing: 'wide' })).ok).toBe(false);
  });
});
