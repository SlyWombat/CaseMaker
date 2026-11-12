// #1235 stage 2 — CUT-OUTSIDE-FOOTPRINT. A cutting feed whose centre lies further outside the
// blank's rectangle than the cutter's own radius plus the facing edge clearance is a planning
// fault: one allowance admits today's legitimate overruns (a freeing contour round the blank, a
// finishing pass's deliberate overrun) and nothing further. An operator-drawn item that hangs off
// the blank keeps its warning — Generate cuts it as drawn.
//
// The context and moves are built the way `cncVerify.spec.ts` builds them: a prism stock whose
// work origin is the top-front-left corner, the post's own opening lift, then the spindle.
import { describe, expect, it } from 'vitest';

import { stockDepthLimit, verifyProgram, type VerifyContext, type VerifyFinding } from '@/engine/cnc/verify';
import type { FootprintShape } from '@/engine/cnc/footprint';
import { stubSetup } from '@/engine/cnc/setup';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { rectProfile } from '@/engine/compiler/profile';

const STOCK = { length: 100, width: 60, thickness: 10 };
/** ⌀3.175: the cutting radius the limit is built from. + the facing's 0.001 mm = 1.5885. */
const TOOL = flatEndMill(3.175);
/** The blank as one rectangle, the shape every pre-#1235-ruling case states. */
const BLANK_FOOTPRINT: FootprintShape[] = [{ kind: 'rect', x: 0, y: 0, length: STOCK.length, width: STOCK.width }];

function ctxFor(over: Partial<VerifyContext> = {}): VerifyContext {
  const setup = stubSetup(
    { kind: 'prism', outline: rectProfile(STOCK.length, STOCK.width), thickness: STOCK.thickness },
    { kind: 'tape-down', contact: rectProfile(STOCK.length, STOCK.width) },
    { startingTool: 1 },
    Z1,
  );
  return {
    setup,
    machine: Z1,
    tool: TOOL,
    depthLimit: stockDepthLimit(STOCK, 1),
    minRapidZ: 1,
    footprint: BLANK_FOOTPRINT,
    ...over,
  };
}

const HEAD = ['G90 G21', 'T1 M6', 'M331', 'G53 G0 Z-3', 'S12000 M3'];
const program = (body: string[]): string => [...HEAD, ...body, 'M5', 'M02'].join('\n');
/** A program whose moves are attributable to numbered operations, as the post's markers make them. */
const programWithToolpaths = (toolpaths: { number: number; body: string[] }[]): string =>
  [
    ...HEAD,
    ...toolpaths.flatMap((t) => [`;@MKR|TOOLPATH_START|toolpath_number=${t.number}`, ...t.body]),
    'M5',
    'M02',
  ].join('\n');

const footprints = (body: string[], over: Partial<VerifyContext> = {}): VerifyFinding[] =>
  verifyProgram(program(body), ctxFor(over)).findings.filter((f) => f.code === 'cut-outside-footprint');

const footprintsIn = (text: string, over: Partial<VerifyContext> = {}): VerifyFinding[] =>
  verifyProgram(text, ctxFor(over)).findings.filter((f) => f.code === 'cut-outside-footprint');

/** The 1-based source line of the first program line containing `needle`. */
function lineOf(body: string[], needle: string): number {
  return program(body).split('\n').findIndex((l) => l.includes(needle)) + 1;
}

/** A 50 % feed to a point outside the blank: the plunge lands inside, then the feed leaves. */
const to = (line: string): string[] => ['G0 X50 Y0', 'G1 Z-2 F100', line];

describe('#1235 cut-outside-footprint', () => {
  it('1 — a feed 1.5 mm outside the blank is admitted (inside the cutter’s radius)', () => {
    expect(footprints(to('G1 Y-1.5'))).toEqual([]);
  });

  it('2 — a feed exactly at the limit is admitted', () => {
    expect(footprints(to('G1 Y-1.5885'))).toEqual([]);
  });

  it('3 — past the limit it is an error, carrying the count, the largest d and the furthest line', () => {
    const body = to('G1 Y-1.6');
    const found = footprints(body);
    expect(found).toHaveLength(1);
    const f = found[0]!;
    expect(f.severity).toBe('error');
    expect(f.line).toBe(lineOf(body, 'G1 Y-1.6'));
    expect(f.aggregate?.count).toBe(1);
    expect(f.aggregate?.largestMm).toBeCloseTo(1.6, 6);
    expect(f.aggregate?.x).toBeCloseTo(50, 6);
    expect(f.aggregate?.y).toBeCloseTo(-1.6, 6);
    expect(f.message).toBe(
      `The cutter travels 1.60 mm outside the blank while cutting, on line ${lineOf(body, 'G1 Y-1.6')}. ` +
        "A pass may run past the blank's edge by the cutter's own radius (1.59 mm) and no further. " +
        'This is a planning fault, not something to fix on the machine: report it with this file.',
    );
  });

  it('4 — beyond a corner the distance is the straight line to it', () => {
    const body = to('G1 X-1.2 Y-1.2');
    const found = footprints(body);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(lineOf(body, 'G1 X-1.2 Y-1.2'));
    expect(found[0]!.aggregate?.largestMm).toBeCloseTo(Math.sqrt(1.2 * 1.2 + 1.2 * 1.2), 6);
    expect(found[0]!.aggregate?.x).toBeCloseTo(-1.2, 6);
    expect(found[0]!.aggregate?.y).toBeCloseTo(-1.2, 6);
  });

  it('5 — the same point above the stock, or as a rapid, is not judged by this rule', () => {
    expect(footprints(to('G1 Y-1.6 Z1'))).toEqual([]);
    expect(footprints(to('G0 Y-1.6'))).toEqual([]);
  });

  it('6 — three offending feeds are ONE diagnostic: count 3, the furthest one’s line', () => {
    const body = ['G0 X50 Y0', 'G1 Z-2 F100', 'G1 Y-1.6', 'G1 Y-1.7', 'G1 Y-1.8'];
    const found = footprints(body);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(lineOf(body, 'G1 Y-1.8'));
    expect(found[0]!.aggregate?.count).toBe(3);
    expect(found[0]!.aggregate?.largestMm).toBeCloseTo(1.8, 6);
    expect(found[0]!.message).toContain('travels 1.80 mm');
  });

  it('7 — a context with no footprint does not run the rule', () => {
    expect(footprints(to('G1 Y-1.6'), { footprint: undefined })).toEqual([]);
  });

  it('8 — an operator-placed item program gets the same code at warning severity', () => {
    const found = footprints(to('G1 Y-1.6'), { itemProgram: true });
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('warning');
    expect(found[0]!.aggregate?.count).toBe(1);
  });

  // ---- #1235's ruling (the stage-2 stop): the footprint is a LIST OF SHAPES, and the verifier
  // measures the distance outside their UNION. The limit above is unchanged.

  it('9 — a sacrificial strip on the left extends the footprint: 5 mm out is clean, 12 mm out is the error', () => {
    const withStrip: FootprintShape[] = [
      ...BLANK_FOOTPRINT,
      { kind: 'rect', x: -10, y: 0, length: 10, width: STOCK.width },
    ];
    expect(footprints(to('G1 X-5 Y30'), { footprint: withStrip })).toEqual([]);
    const found = footprints(to('G1 X-12 Y30'), { footprint: withStrip });
    expect(found).toHaveLength(1);
    expect(found[0]!.aggregate?.largestMm).toBeCloseTo(2, 6);
    expect(found[0]!.aggregate?.x).toBeCloseTo(-12, 6);
  });

  it('10 — two rectangles that touch meet with distance 0 over the seam', () => {
    const two: FootprintShape[] = [
      ...BLANK_FOOTPRINT,
      { kind: 'rect', x: 100, y: 0, length: 10, width: STOCK.width },
    ];
    expect(footprints(to('G1 X100 Y30'), { footprint: two })).toEqual([]);
    expect(footprints(to('G1 X105 Y30'), { footprint: two })).toEqual([]);
  });

  it('11 — a circle of radius 20 at (20, 20): 1.5 mm outside is clean, 1.7 mm is the error', () => {
    const circle: FootprintShape[] = [{ kind: 'circle', cx: 20, cy: 20, radius: 20 }];
    // Plunge at the circle's centre, then feed radially to the test point (the shared `to` helper
    // plunges at (50, 0), which is outside this circle).
    const radial = (x: string): string[] => ['G0 X20 Y20', 'G1 Z-2 F100', `G1 ${x} Y20`];
    expect(footprints(radial('X41.5'), { footprint: circle })).toEqual([]);
    const found = footprints(radial('X41.7'), { footprint: circle });
    expect(found).toHaveLength(1);
    expect(found[0]!.aggregate?.largestMm).toBeCloseTo(1.7, 6);
  });

  it('12 — a second setup is judged against 60 × 40 in its own frame, not setup 1’s 100 × 60', () => {
    const secondSetup: FootprintShape[] = [{ kind: 'rect', x: 0, y: 0, length: 60, width: 40 }];
    // The same point is inside setup 1's rectangle, but 10 mm outside setup 2's.
    expect(footprints(to('G1 X70 Y20'))).toEqual([]);
    const found = footprints(to('G1 X70 Y20'), { footprint: secondSetup });
    expect(found).toHaveLength(1);
    expect(found[0]!.aggregate?.largestMm).toBeCloseTo(10, 6);
  });

  // ---- #1235's SECOND ruling: each OPERATION states how far outside it means to go, and that
  // allowance covers only its own toolpath. Limit = cutter radius + the op's allowance + one
  // posted step.

  it('13 — an operation’s stated allowance joins only that operation’s moves', () => {
    // d = 1.5935 = radius 1.5875 + allowance 0.005 + one step 0.001: clean under toolpath 1,
    // the error under toolpath 2 (which states nothing — no blanket cover).
    const text = programWithToolpaths([
      { number: 1, body: ['G0 X50 Y0', 'G1 Z-2 F100', 'G1 Y-1.5935'] },
      { number: 2, body: ['G1 Y0', 'G1 Y-1.5935'] },
    ]);
    const found = footprintsIn(text, { outsideAllowancesMm: new Map([[1, 0.005]]) });
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(text.split('\n').lastIndexOf('G1 Y-1.5935') + 1);
    expect(found[0]!.aggregate?.largestMm).toBeCloseTo(1.5935, 6);
  });

  it('14 — a contour 0.1 mm beyond its stated guard is still the error', () => {
    const text = programWithToolpaths([
      { number: 1, body: to('G1 Y-1.6925') }, // radius 1.5875 + guard 0.005 + 0.1
    ]);
    const found = footprintsIn(text, { outsideAllowancesMm: new Map([[1, 0.005]]) });
    expect(found).toHaveLength(1);
    expect(found[0]!.aggregate?.largestMm).toBeCloseTo(1.6925, 6);
  });

  it('15 — a thread 1.0 mm beyond the rod is still the error; its 0.5 clearance is not', () => {
    const circle: FootprintShape[] = [{ kind: 'circle', cx: 20, cy: 20, radius: 20 }];
    const radial = (x: string): string[] => ['G0 X20 Y20', 'G1 Z-2 F100', `G1 ${x} Y20`];
    // The circle is the rod, radius 20 at (20, 20); the cutter is 1.5875 mm, the op states 0.5.
    const clean = programWithToolpaths([{ number: 1, body: radial('X42.0885') }]); // 20 + 1.5875 + 0.5 + step
    expect(footprintsIn(clean, { footprint: circle, outsideAllowancesMm: new Map([[1, 0.5]]) })).toEqual([]);
    const beyond = programWithToolpaths([{ number: 1, body: radial('X43.0875') }]); // ... + 1.0 mm
    const found = footprintsIn(beyond, { footprint: circle, outsideAllowancesMm: new Map([[1, 0.5]]) });
    expect(found).toHaveLength(1);
    expect(found[0]!.aggregate?.largestMm).toBeCloseTo(3.0875, 6);
  });

});
