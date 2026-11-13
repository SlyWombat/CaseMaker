/**
 * #1233 follow-up — A VENDOR PROGRAM ON OUR CLOCK (tools/baseline/vendorClock.ts).
 *
 * Makera Studio's `;@MKR|TIME` header is its own estimate and not our clock; the comparison puts the
 * vendor's posted NC through our estimator (the Z1 rapid model, the trapezoid, the 10° corner rule)
 * and prices its tool changes with the #1114 curve, so every ratio is taken on one clock.
 */
import { describe, expect, it } from 'vitest';
import { vendorClock } from '../../tools/baseline/vendorClock';
import { referenceRows, type RefFacts } from '../../tools/baseline/compareTables';

const NC = (body: string): string => `;@MKR|TIME|seconds=99\n;@MKR|TOOL|number=1|id=1|name=a|type=Flat End|diameter=3\n;@MKR|TOOL|number=2|id=2|name=b|type=Flat End|diameter=6\n${body}`;

describe('#1233 vendor clock', () => {
  it('times one 100 mm feed at F1000 through the trapezoid: 6.111 s, and reads the header beside it', () => {
    const c = vendorClock(NC('T1 M6\nG0 X0 Y0 Z0\nG1 X100 F1000\n'));
    // v = 1000/60 mm/s, a = 150 mm/s²: 100/v + v/a = 6 + 0.1111
    expect(c.moveSeconds).toBeCloseTo(6.111, 2);
    expect(c.changes).toBe(0);
    expect(c.header).toBe(99);
    expect(c.totalSeconds).toBeCloseTo(6.111, 2);
  });

  it('prices a second tool by the program before it: a short program is attended, 120 s', () => {
    const c = vendorClock(NC('T1 M6\nG0 X0 Y0 Z0\nG1 X100 F1000\nT2 M6\nG0 X0 Y0 Z0\nG1 X100 F1000\n'));
    expect(c.changes).toBe(1);
    expect(c.changeSeconds).toBe(120);
    expect(c.totalSeconds).toBeCloseTo(c.moveSeconds + 120, 6);
  });

  it('a rapid is timed on the rapid model (1200 mm/min XY): 100 mm is 5 s plus the ramps', () => {
    const c = vendorClock(NC('T1 M6\nG0 X0 Y0 Z0\nG0 X100\n'));
    expect(c.moveSeconds).toBeCloseTo(100 / 20 + 20 / 150, 2);
  });

  it('every ratio in the reference table is taken on our clock, never against the header', () => {
    const before: RefFacts[] = [{ part: 'sample-part', verdict: 'match', makeraCycle: '10.0 min', makeraHeaderS: 600, makeraClockS: 1000, oursTotalS: 2000, wall: 100 }];
    const after: RefFacts[] = [{ part: 'sample-part', verdict: 'match', makeraCycle: '10.0 min', makeraHeaderS: 600, makeraClockS: 1000, oursTotalS: 1500, wall: 90 }];
    const t = referenceRows(before, after);
    const header = t.headers;
    const row = t.rows[0]!;
    const at = (h: string): string => row[header.indexOf(h)]!;
    expect(at('Makera header (s)')).toBe('600');
    expect(at('Makera on our clock (s)')).toBe('1000');
    expect(at('ratio before (ours ÷ Makera, our clock)')).toBe('2.00×');
    expect(at('ratio after (ours ÷ Makera, our clock)')).toBe('1.50×');
    // no header-based ratio anywhere in the row
    expect(header.some((h) => /header/.test(h) && /ratio/.test(h))).toBe(false);
  });

  it('a part with no vendor-clock figure prints "not recorded", never a ratio against the header', () => {
    const t = referenceRows([{ part: 'x', verdict: 'match', makeraHeaderS: 100, oursTotalS: 500 }], [{ part: 'x', verdict: 'match', makeraHeaderS: 100, oursTotalS: 400 }]);
    const row = t.rows[0]!;
    expect(row[t.headers.indexOf('ratio before (ours ÷ Makera, our clock)')]).toBe('not recorded');
  });
});
