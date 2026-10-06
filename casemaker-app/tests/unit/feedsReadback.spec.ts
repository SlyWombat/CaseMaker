// The coupon readback (#248 item 3): a filled coupon record becomes a `FeedsMeasurement`
// (`measurementFromRecord`), and `applyMeasurements` folds it into the table so the row carries
// its date and the coupon behind it. Pure — no machine, no wasm. The script (`feeds-readback.ts`)
// is the CLI around exactly these two calls; it is not imported here because it runs top-level
// arg parsing on import.

import { describe, it, expect } from 'vitest';

import {
  measurementFromRecord,
  type CouponRecord,
  type CouponRecordRow,
} from '@/engine/cnc/engrave/couponJob';
import {
  applyMeasurements,
  UNMEASURED_FEEDS_TABLE,
  type FeedsMeasurement,
} from '@/engine/cnc/feeds';

function program(over: Partial<CouponRecordRow> = {}): CouponRecordRow {
  return {
    program: 'feed-sweep-f500',
    values: [500],
    ncFile: 'feed-sweep-f500.nc',
    sheetFile: 'feed-sweep-f500-run-sheet.md',
    hash: 'abc123',
    verdict: 'ok',
    chosen: false,
    note: '',
    ...over,
  };
}

function record(over: Partial<CouponRecord> = {}): CouponRecord {
  return {
    coupon: 'feed-sweep',
    title: 'Feed sweep',
    parameter: 'feed',
    material: 'softwood',
    toolKey: 'flat-1.0',
    cuttingDiameter: 1.0,
    generatedOn: '2026-10-01',
    cutOn: '2026-10-05',
    baseOverride: {},
    note: '',
    programs: [program()],
    ...over,
  };
}

function measurement(over: Partial<FeedsMeasurement> = {}): FeedsMeasurement {
  return {
    material: 'softwood',
    diameter: 1.0,
    parameter: 'feed',
    value: 600,
    on: '2026-10-05',
    coupon: 'feed-sweep',
    ...over,
  };
}

describe('measurementFromRecord (#248 item 3)', () => {
  it('turns a single ok program into a measurement with its date and coupon', () => {
    const res = measurementFromRecord(record(), 'docs/bench/feed-sweep-coupon-record.json');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.measurement).toEqual({
      material: 'softwood',
      diameter: 1.0,
      parameter: 'feed',
      value: 500,
      on: '2026-10-05',
      coupon: 'feed-sweep',
      record: 'docs/bench/feed-sweep-coupon-record.json',
    });
  });

  it('picks the marked program when several cut ok, and refuses the ambiguity without a mark', () => {
    const programs = [
      program({ program: 'feed-sweep-f300', values: [300], chosen: true }),
      program({ program: 'feed-sweep-f500', values: [500] }),
    ];
    const res = measurementFromRecord(record({ programs }));
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.measurement.value).toBe(300);

    const ambiguous = measurementFromRecord(record({ programs: programs.map((p) => ({ ...p, chosen: false })) }));
    expect(ambiguous.ok).toBe(false);
    if (ambiguous.ok) throw new Error('expected a refusal');
    expect(ambiguous.reason).toContain('mark the one to adopt');
  });

  it('refuses a depth coupon: depth is not a feeds-table field', () => {
    const res = measurementFromRecord(record({ parameter: 'depth', programs: [program({ values: [0.6, 0.8] })] }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('§7.2');
  });

  it('requires a cut date — a measured row must carry its date', () => {
    const res = measurementFromRecord(record({ cutOn: null }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('cutOn');
  });

  it('refuses when nothing cut ok, when a failed program is chosen, and without a diameter', () => {
    const none = measurementFromRecord(record({ programs: [program({ verdict: 'poor' })] }));
    expect(none.ok).toBe(false);

    const failedChosen = measurementFromRecord(record({ programs: [program({ verdict: 'broke', chosen: true })] }));
    expect(failedChosen.ok).toBe(false);
    if (failedChosen.ok) throw new Error('expected a refusal');
    expect(failedChosen.reason).toContain('chosen');

    const noDia = measurementFromRecord(record({ cuttingDiameter: 0 }));
    expect(noDia.ok).toBe(false);
  });

  it('refuses when the base job overrode a field other than the swept one', () => {
    const res = measurementFromRecord(record({ baseOverride: { rpm: 9000 } }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('rpm');
    // An override of the swept field itself is fine — that is what a coupon does.
    expect(measurementFromRecord(record({ parameter: 'rpm', baseOverride: {} })).ok).toBe(true);
  });

  it('converts a step-over measurement in mm and refuses one past the cutter radius (#191)', () => {
    const ok = measurementFromRecord(record({ parameter: 'stepOver', programs: [program({ values: [0.5] })] }));
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error(ok.reason);
    expect(ok.measurement.value).toBe(0.5); // still mm; the fraction is applied in feeds.ts

    const past = measurementFromRecord(record({ parameter: 'stepOver', programs: [program({ values: [0.7] })] }));
    expect(past.ok).toBe(false);
    if (past.ok) throw new Error('expected a refusal');
    expect(past.reason).toContain('#191');
  });

  it('refuses a multi-value program — a feeds row takes one value', () => {
    const res = measurementFromRecord(record({ programs: [program({ values: [0.6, 0.8] })] }));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('takes one');
  });
});

describe('applyMeasurements (#248 item 3)', () => {
  it('flips the matching row to measured, writes the value, and carries date + coupon', () => {
    const { table, applied, unmatched } = applyMeasurements(UNMEASURED_FEEDS_TABLE, [measurement()]);
    expect(unmatched).toEqual([]);
    expect(applied).toHaveLength(1);

    const row = table.find((e) => e.material === 'softwood' && e.minDiameter === 0.8)!;
    expect(row.status).toBe('measured');
    expect(row.params.feed).toBe(600);
    expect(row.measured).toHaveLength(1);
    expect(row.provenance).toContain('coupon "feed-sweep"');
    expect(row.provenance).toContain('2026-10-05');
    // The other fields are still flagged as starting values in the provenance.
    expect(row.provenance).toContain('Still starting values');

    // Every row that was not measured is untouched.
    const others = table.filter((e) => e !== row);
    expect(others.every((e) => e.status === 'unmeasured' && e.measured === undefined)).toBe(true);
  });

  it('stores a step-over as a fraction of the cutter diameter', () => {
    const m = measurement({ parameter: 'stepOver', value: 0.5, diameter: 1.0 });
    const { table } = applyMeasurements(UNMEASURED_FEEDS_TABLE, [m]);
    const row = table.find((e) => e.material === 'softwood' && e.minDiameter === 0.8)!;
    expect(row.params.stepOverFraction).toBe(0.5); // 0.5 mm / 1.0 mm
  });

  it('accumulates several coupons on one row and names each field', () => {
    const ms = [
      measurement({ parameter: 'feed', value: 600 }),
      measurement({ parameter: 'stepDown', value: 0.7, coupon: 'stepdown-sweep', on: '2026-10-06' }),
    ];
    const { table } = applyMeasurements(UNMEASURED_FEEDS_TABLE, ms);
    const row = table.find((e) => e.material === 'softwood' && e.minDiameter === 0.8)!;
    expect(row.measured).toHaveLength(2);
    expect(row.params.feed).toBe(600);
    expect(row.params.stepDown).toBe(0.7);
    expect(row.provenance).toContain('feed-sweep');
    expect(row.provenance).toContain('stepdown-sweep');
    // spindle and step-over remain starting values.
    expect(row.provenance).toContain('spindle speed');
    expect(row.provenance).toContain('step-over');
  });

  it('reports a measurement that matches no row rather than dropping it, and never mutates the base', () => {
    const before = JSON.stringify(UNMEASURED_FEEDS_TABLE);
    const ghost = measurement({ material: 'softwood', diameter: 5 });
    const { applied, unmatched, table } = applyMeasurements(UNMEASURED_FEEDS_TABLE, [ghost]);
    expect(applied).toEqual([]);
    expect(unmatched).toEqual([ghost]);
    expect(table).toEqual(UNMEASURED_FEEDS_TABLE);
    expect(JSON.stringify(UNMEASURED_FEEDS_TABLE)).toBe(before);
  });

  it('ships with no measurements: the committed table is still all starting values', () => {
    // A guard: the shipped FeedsEntry literal must stay unmeasured until a real coupon lands.
    expect(UNMEASURED_FEEDS_TABLE.every((e) => e.status === 'unmeasured' && e.measured === undefined)).toBe(true);
  });
});
