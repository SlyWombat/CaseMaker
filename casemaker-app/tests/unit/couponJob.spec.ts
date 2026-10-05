/**
 * Coupon jobs (#248): `buildCouponPrograms` is pure, so the whole sweep layout is checked here
 * without wasm — what each program contains, which field carries the swept value, and where the
 * cells land. The end-to-end run (generate → .nc → sheet) is `scripts/engrave-job.ts`'s job.
 */

import { describe, it, expect } from 'vitest';

import {
  buildCouponPrograms,
  couponValueLabel,
  type CouponSpec,
} from '@/engine/cnc/engrave/couponJob';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import type { EngraveJob } from '@/types/engraveJob';

/** A base job with a label, so the coupon can be shown to inherit font/weight and drop items. */
function baseJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.name = 'Coupon base';
  job.labels = [{ ...job.labels[0]!, text: 'ORIGINAL', font: DEFAULT_FONT_ID, weight: 'bold' }];
  return job;
}

function spec(over: Partial<CouponSpec> = {}): CouponSpec {
  return {
    id: 'depth-ladder',
    title: 'Depth ladder',
    parameter: 'depth',
    values: [0.6, 0.8, 1.0],
    base: baseJob(),
    text: { size: 6, pitch: 15 },
    origin: { x: 10, y: 20 },
    depth: 1.2,
    ...over,
  };
}

describe('couponJob (#248)', () => {
  it('formats each value with its unit', () => {
    expect(couponValueLabel('depth', 0.6)).toBe('0.6mm');
    expect(couponValueLabel('stepOver', 1.5)).toBe('1.5mm');
    expect(couponValueLabel('feed', 500)).toBe('F500');
    expect(couponValueLabel('rpm', 12000)).toBe('S12000');
  });

  it('makes a depth sweep ONE program, one cell per depth, each at its own depth', () => {
    const programs = buildCouponPrograms(spec());
    expect(programs).toHaveLength(1);
    const p = programs[0]!;
    expect(p.id).toBe('depth-ladder');
    expect(p.values).toEqual([0.6, 0.8, 1.0]);
    expect(p.labels).toEqual(['0.6mm', '0.8mm', '1mm']);

    const job = p.job;
    expect(job.labels).toHaveLength(3);
    // Depth is per item, so each cell carries the value it tests.
    expect(job.labels.map((l) => l.depth)).toEqual([0.6, 0.8, 1.0]);
    // Cells run in +X from the origin, one pitch apart, all on the origin's Y.
    expect(job.labels.map((l) => l.position)).toEqual([
      { x: 10, y: 20 },
      { x: 25, y: 20 },
      { x: 40, y: 20 },
    ]);
    expect(job.labels.map((l) => l.text)).toEqual(['0.6mm', '0.8mm', '1mm']);
    expect(job.labels.map((l) => l.size)).toEqual([6, 6, 6]);
    // Deterministic ids, so the committed .nc is reproducible.
    expect(job.labels.map((l) => l.id)).toEqual(['depth-ladder-lbl-0', 'depth-ladder-lbl-1', 'depth-ladder-lbl-2']);
  });

  it('makes a feed sweep one program per value, carrying it in cutOverride', () => {
    const programs = buildCouponPrograms(spec({ id: 'feed-sweep', title: 'Feed sweep', parameter: 'feed', values: [300, 500] }));
    expect(programs.map((p) => p.id)).toEqual(['feed-sweep-f300', 'feed-sweep-f500']);
    for (const [i, value] of [300, 500].entries()) {
      const job = programs[i]!.job;
      // The value is a whole-program override, NOT a per-cell depth...
      expect(job.cutOverride).toEqual({ feed: value });
      // ...and the one cell is cut at the spec's common depth.
      expect(job.labels.map((l) => l.depth)).toEqual([1.2]);
      expect(job.labels.map((l) => l.text)).toEqual([couponValueLabel('feed', value)]);
      expect(programs[i]!.description).toContain(String(value));
    }
  });

  it('merges a sweep override over the base cutOverride, and leaves depth sweeps untouched', () => {
    const base = baseJob();
    base.cutOverride = { rpm: 9000, plungeFeed: 120 };
    const feed = buildCouponPrograms(spec({ parameter: 'feed', values: [400], base }))[0]!.job;
    expect(feed.cutOverride).toEqual({ rpm: 9000, plungeFeed: 120, feed: 400 });

    const depth = buildCouponPrograms(spec({ base }))[0]!.job;
    expect(depth.cutOverride).toEqual({ rpm: 9000, plungeFeed: 120 });
  });

  it('discards the base job\'s own items and carries the stock, tool and workholding', () => {
    const base = baseJob();
    const programs = buildCouponPrograms(spec({ base }));
    const job = programs[0]!.job;
    expect(job.labels.some((l) => l.text === 'ORIGINAL')).toBe(false);
    expect(job.shapes).toEqual([]);
    expect(job.combined).toEqual([]);
    expect(job.stock).toEqual(base.stock);
    expect(job.toolKey).toBe(base.toolKey);
    expect(job.workholding).toEqual(base.workholding);
    expect(job.sacrificial).toEqual(base.sacrificial);
  });

  it('inherits the cell font and weight from the base\'s first label', () => {
    const job = buildCouponPrograms(spec())[0]!.job;
    expect(job.labels[0]!.font).toBe(DEFAULT_FONT_ID);
    expect(job.labels[0]!.weight).toBe('bold');
  });

  it('rejects a coupon with no values or a non-positive cell size', () => {
    expect(() => buildCouponPrograms(spec({ values: [] }))).toThrow(/no values/);
    expect(() => buildCouponPrograms(spec({ text: { size: 0, pitch: 15 } }))).toThrow(/positive text size/);
    expect(() => buildCouponPrograms(spec({ text: { size: 6, pitch: 0 } }))).toThrow(/positive text size/);
  });
});
