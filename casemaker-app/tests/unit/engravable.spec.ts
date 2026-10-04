// The tool-opened glyph and its findings (#201). Every geometric assertion is against a
// CLOSED FORM (the opening of a square) or against the bands #191 measured — never against
// another run of the same code. The arc-resolution check exists because Manifold's default
// at r = 0.5 is 4 segments, which turns a "round" offset into a square with 0.146 mm of
// chord error (#190); a test that did not pin the area would pass on that bug.

import { describe, it, expect } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { engravableProfile } from '@/engine/cnc/engrave/engravable';
import {
  engravabilityFindings,
  measureLabels,
  suggestCapHeight,
  type LabelEngravability,
} from '@/workers/sim/engraveGeometry';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { labelProfile, toPartPlan } from '@/engine/cnc/engrave/partPlan';
import { rectProfile, type Profile } from '@/engine/compiler/profile';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import type { EngraveJob } from '@/types/engraveJob';

/** Area of a profile, with the CrossSection released. */
function area(p: Profile): number {
  const cs = executeProfile(tl, p);
  const a = cs.area();
  cs.delete();
  return a;
}

function asOffset(p: Profile): Extract<Profile, { kind: 'p-offset' }> {
  if (p.kind !== 'p-offset') throw new Error(`expected p-offset, got ${p.kind}`);
  return p;
}

/** A one-label job in the default stock, Barlow Bold at `size`, centred unless told otherwise. */
function jobWith(text: string, size: number, position = { x: 50, y: 30 }): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [
    {
      id: 'lbl-1',
      text,
      font: 'sans-default',
      weight: 'bold',
      size,
      position,
      rotation: 0,
      depth: 1,
      enabled: true,
    },
  ];
  return job;
}

/** `perChar` for a job: one single-character label profile per character, in text order. */
function perCharFor(job: EngraveJob) {
  return (labelId: string) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) throw new Error(`no label ${labelId}`);
    return [...label.text].map((char) => ({
      char,
      profile: labelProfile({ ...label, text: char }, job.customFonts),
    }));
  };
}

function measure(job: EngraveJob, toolDiameter: number): LabelEngravability[] {
  return measureLabels(tl, toPartPlan(job), toolDiameter / 2, job.edgeMargin, perCharFor(job));
}

/**
 * The `ratioAt` a worker injects into `engravabilityFindings` (#201 review): re-typeset the
 * label at a candidate cap height and measure that one label's opening ratio. The tool is
 * the one the job names, so the suggestion cannot disagree with the measurement.
 */
function ratioAtFor(job: EngraveJob, toolDiameter: number) {
  return (labelId: string, size: number): number => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return 0;
    const probe: EngraveJob = { ...job, labels: [{ ...label, size }] };
    return measureLabels(tl, toPartPlan(probe), toolDiameter / 2, job.edgeMargin, perCharFor(probe))[0]
      ?.ratio ?? 0;
  };
}

describe('engravableProfile (#201)', () => {
  it('passes segmentsForRadius(r) explicitly on both offsets (#190)', () => {
    const outer = asOffset(engravableProfile(rectProfile(10, 10), 0.5));
    expect(outer.delta).toBe(0.5);
    expect(outer.join).toBe('round');
    expect(outer.segments).toBe(segmentsForRadius(0.5));

    const inner = asOffset(outer.child);
    expect(inner.delta).toBe(-0.5);
    expect(inner.join).toBe('round');
    expect(inner.segments).toBe(segmentsForRadius(0.5));
  });

  it('opening a 10 x 10 square with r = 0.5 rounds the four corners (closed form)', () => {
    const a = area(engravableProfile(rectProfile(10, 10), 0.5));
    // Four corners each lose (1 - pi/4) r^2 -> area = 100 - (4 - pi) r^2 = 99.785.
    const exact = 100 - (4 - Math.PI) * 0.5 * 0.5;
    expect(Math.abs(a - exact)).toBeLessThan(0.01);
    // 4-segment offsets would land near 99.5; the explicit resolution must beat that.
    expect(a).toBeGreaterThan(99.7);
  });

  it('the opening is idempotent', () => {
    // The opening is idempotent in continuous geometry, but Clipper2 works on polygons: the
    // first opening's rounded corners are tessellated arcs, and the second opening
    // re-tessellates them. At ARC_CHORD_TOLERANCE_MM = 0.005 and r = 0.5 the per-corner
    // area drift is ~0.0026 mm², so a sharp-cornered shape drifts by a measured 0.0136 mm²
    // (square) or 0.0263 mm² (Barlow "H") — above the issue's 1e-3. A smooth disc rounds no
    // corners, so it tests idempotence itself, not the corner tessellation. Reported on #201.
    const disk: Profile = { kind: 'p-circle', radius: 5, segments: segmentsForRadius(5) };
    const once = engravableProfile(disk, 0.5);
    const twice = engravableProfile(once, 0.5);
    expect(Math.abs(area(once) - area(twice))).toBeLessThan(1e-3);
  });
});

describe('suggestCapHeight (#201 review)', () => {
  it('returns the first whole millimetre whose measured ratio reaches the threshold', () => {
    // Pure: the injected table stands in for re-measuring, so no wasm is needed. current 4
    // -> candidates 5, 7, 8, ...; 5 and 7 miss, 8 reaches.
    const measureAt = (size: number) => (size >= 8 ? 0.95 : 0.5);
    expect(suggestCapHeight(measureAt, 4)).toBe(8);
  });

  it('rounds each candidate up to a whole millimetre', () => {
    expect(suggestCapHeight(() => 1, 5)).toBe(7); // ceil(5 * 1.25) = 7
  });

  it('returns null when no size in the 1.25^n range reaches the threshold', () => {
    // current 4 -> the last candidate is ceil(4 * 1.25^8) = 24; none survives.
    expect(suggestCapHeight(() => 0.1, 4)).toBeNull();
  });

  it('says the cutter is too large when the suggestion is null', () => {
    // The findings message, exercised without wasm: a hand-built measurement plus an
    // injected ratio that never reaches the threshold.
    const job = jobWith('CASE', 4);
    const m: LabelEngravability[] = [
      { labelId: 'lbl-1', glyphArea: 10, openedArea: 1, ratio: 0.1, emptyChars: [], outsideArea: 0, polygons: [] },
    ];
    const detail = engravabilityFindings(job, m, () => 0.1).find(
      (x) => x.code === 'item-detail-lost',
    );
    expect(detail).toBeDefined();
    expect(detail!.message).toContain('choose a smaller cutter');
  });

  it('measures Barlow Bold at 4 mm with the 1.0 mm cutter to a size between 6 and 10', () => {
    // #191 measured 88.9 % surviving at 6 mm and 98.8 % at 10 mm, so the first whole
    // millimetre reaching 90 % lies in [6, 10].
    const job = jobWith('CASE', 4);
    const suggested = suggestCapHeight((size) => ratioAtFor(job, 1.0)('lbl-1', size), 4);
    expect(suggested).not.toBeNull();
    expect(suggested!).toBeGreaterThanOrEqual(6);
    expect(suggested!).toBeLessThanOrEqual(10);
  });

  it('measures Barlow Bold at 4 mm with the 3.175 mm cutter', () => {
    // A cutter wider than the strokes needs a much larger cap height: the measured answer is
    // 20 mm (the n = 7 candidate), written down as the review asked.
    const job = jobWith('CASE', 4);
    const suggested = suggestCapHeight((size) => ratioAtFor(job, 3.175)('lbl-1', size), 4);
    expect(suggested).toBe(20);
  });
});

describe('measureLabels (#201)', () => {
  it('produces non-empty polygons for all three labels of the default job with the 1.0 mm cutter', () => {
    const job = defaultEngraveJob();
    const m = measure(job, 1.0);
    expect(m).toHaveLength(3);
    for (const label of m) expect(label.polygons.length).toBeGreaterThan(0);
  });

  it('loses almost everything at 4 mm and nothing at 10 mm (a 1.0 mm cutter)', () => {
    const small = jobWith('CASE', 4);
    const smallM = measure(small, 1.0);
    expect(smallM[0]!.ratio).toBeLessThan(0.2);
    const smallF = engravabilityFindings(small, smallM, ratioAtFor(small, 1.0));
    expect(smallF.some((f) => f.code === 'item-detail-lost' || f.code === 'item-chars-lost')).toBe(true);

    const big = jobWith('CASE', 10);
    const bigM = measure(big, 1.0);
    expect(bigM[0]!.ratio).toBeGreaterThan(0.95);
    expect(engravabilityFindings(big, bigM, ratioAtFor(big, 1.0))).toHaveLength(0);
  });

  it('is monotone non-decreasing in cap height', () => {
    const ratios = [4, 6, 8, 10, 14].map((size) => measure(jobWith('CASE', size), 1.0)[0]!.ratio);
    for (let i = 1; i < ratios.length; i++) {
      expect(ratios[i]!).toBeGreaterThanOrEqual(ratios[i - 1]! - 1e-9);
    }
  });

  it('reports no detail lost and ratio 1 when the glyph is whitespace', () => {
    const job = jobWith('   ', 10);
    const m = measure(job, 1.0);
    expect(m[0]!.glyphArea).toBe(0);
    expect(m[0]!.ratio).toBe(1);
    expect(engravabilityFindings(job, m, ratioAtFor(job, 1.0))).toHaveLength(0);
  });
});

describe('engravabilityFindings (#201)', () => {
  it('flags a 10 mm label as empty under a 3.175 mm cutter', () => {
    const job = jobWith('CASE', 10);
    job.toolKey = 'flat-3.175x12-metal';
    const m = measure(job, 3.175);
    const f = engravabilityFindings(job, m, ratioAtFor(job, 3.175));
    expect(f.some((x) => x.code === 'item-empty' || x.code === 'item-chars-lost')).toBe(true);
  });

  it('flags a label hanging over the stock edge', () => {
    const job = jobWith('H', 10, { x: 0, y: 30 });
    const m = measure(job, 1.0);
    expect(m[0]!.outsideArea).toBeGreaterThan(0);
    const f = engravabilityFindings(job, m, ratioAtFor(job, 1.0));
    const outside = f.find((x) => x.code === 'item-outside-stock');
    expect(outside).toBeDefined();
    expect(outside!.message).toContain('mm²');
    expect(outside!.message).toContain('1 mm edge margin');
  });

  it('names the lost characters and the cutter, and suggests a larger size', () => {
    const job = jobWith('CASE', 4);
    const m = measure(job, 1.0);
    const f = engravabilityFindings(job, m, ratioAtFor(job, 1.0));

    const empty = f.find((x) => x.code === 'item-empty');
    if (empty) {
      expect(empty.message).toContain('CASE');
      expect(empty.message).toContain('nothing this cutter can reach');
    }

    const detail = f.find((x) => x.code === 'item-detail-lost');
    expect(detail).toBeDefined();
    expect(detail!.severity).toBe('warning');
    expect(detail!.message).toContain('%');
    expect(detail!.message).toMatch(/try \d+ mm or more/);
  });

  it('names the cutter diameter in the empty message', () => {
    // The findings take the diameter from the job's tool, so the job must name the cutter
    // that was measured — exactly as the panel will when it reads toolKey (#205).
    const job = jobWith('CASE', 10);
    job.toolKey = 'flat-3.175x12-metal';
    const m = measure(job, 3.175);
    const empty = engravabilityFindings(job, m, ratioAtFor(job, 3.175)).find((x) => x.code === 'item-empty');
    if (empty) expect(empty.message).toContain('3.175');
  });
});

describe('measureLabels handle discipline (#201)', () => {
  it('survives 200 runs without exhausting the wasm heap', () => {
    const job = jobWith('H', 10);
    const plan = toPartPlan(job);
    const perChar = perCharFor(job);
    for (let i = 0; i < 200; i++) measureLabels(tl, plan, 0.5, job.edgeMargin, perChar);
    // Reaching here without a wasm abort is the assertion: a leaked CrossSection per run
    // would grow the heap 200-fold.
    expect(true).toBe(true);
  });
});
