/**
 * #1216 (planner v3, slice 3) — THE SHADOW ESTIMATOR, pinned exactly.
 *
 * `estimateChain` prices a cutter chain from reach areas and feed rows: what each cutter ADDS over
 * the one before it, at the row it really runs, plus the bit changes between cutters. These are
 * the issue's tests A–I, with its own arithmetic.
 */
import { describe, expect, it } from 'vitest';

import {
  estimateChain,
  type CutterRates,
  type EstimateStep,
  type PocketArea,
} from '@/engine/cnc/cam/fields/chainEstimate';

const P1: PocketArea = {
  id: 'p1', depthMm: 6, areaMm2: 100,
  reach: [
    { diameterMm: 6, reach: [], areaMm2: 80, addedAreaMm2: 80 },
    { diameterMm: 3, reach: [], areaMm2: 95, addedAreaMm2: 15 },
    { diameterMm: 1, reach: [], areaMm2: 99, addedAreaMm2: 4 },
  ],
};
const R6: CutterRates = { feed: 600, plungeFeed: 300, stepDown: 3, stepOver: 3 };
const R3: CutterRates = { feed: 600, plungeFeed: 300, stepDown: 1.5, stepOver: 1.5 };
const step = (kind: string, cutterKey: string, diameterMm: number, rates: CutterRates | null): EstimateStep =>
  ({ kind, cutterKey, diameterMm, regionIds: ['p1'], rates });
const CHANGE = (): number => 100;

const est = (
  steps: EstimateStep[],
  pockets: readonly PocketArea[] = [P1],
  changePrice: (precedingSeconds: number) => number = CHANGE,
) => estimateChain(steps, pockets, changePrice);

describe('#1216 estimateChain', () => {
  it('one cutter', () => {
    const e = est([step('pocket', 't6', 6, R6)]);
    expect(e.cutSeconds).toBeCloseTo(6.533333, 5);
    expect(e.changes).toBe(0);
    expect(e.changeSeconds).toBeCloseTo(0, 5);
    expect(e.totalSeconds).toBeCloseTo(6.533333, 5);
    expect(e.leftoverMm2).toBeCloseTo(20, 5);
    expect(e.unpriced).toBe(0);
  });

  it('a rest cutter pays only for what it adds', () => {
    const e = est([step('pocket', 't6', 6, R6), step('rest', 't3', 3, R3)]);
    expect(e.cutSeconds).toBeCloseTo(11.733333, 5);
    expect(e.changes).toBe(1);
    expect(e.changeSeconds).toBeCloseTo(100, 5);
    expect(e.totalSeconds).toBeCloseTo(111.733333, 5);
    expect(e.leftoverMm2).toBeCloseTo(5, 5);
  });

  it('the small cutter alone', () => {
    const e = est([step('pocket', 't3', 3, R3)]);
    expect(e.cutSeconds).toBeCloseTo(26.533333, 5);
    expect(e.leftoverMm2).toBeCloseTo(5, 5);
    expect(e.changes).toBe(0);
  });

  it('a step it cannot price still counts its bit change', () => {
    const e = est([step('pocket', 't6', 6, R6), step('finish', 'b6', 6, R6)]);
    expect(e.unpriced).toBe(1);
    expect(e.changes).toBe(1);
    expect(e.cutSeconds).toBeCloseTo(6.533333, 5);
  });

  it('no feed row', () => {
    const e = est([step('pocket', 't6', 6, null)]);
    expect(e.unpriced).toBe(1);
    expect(e.cutSeconds).toBeCloseTo(0, 5);
    expect(e.leftoverMm2).toBeCloseTo(100, 5);
  });

  it('same cutter twice is no bit change', () => {
    const e = est([step('pocket', 't6', 6, R6), step('rest', 't6', 6, R6)]);
    expect(e.changes).toBe(0);
    expect(e.cutSeconds).toBeCloseTo(6.533333, 5);
  });

  it('the change price sees the time before it', () => {
    const steps = [step('pocket', 't6', 6, R6), step('rest', 't3', 3, R3)];
    const e = est(steps, [P1], (s) => s * 2);
    expect(e.changeSeconds).toBeCloseTo(13.066667, 5);
  });

  it('a diameter with no reach entry clears nothing', () => {
    const e = est([step('pocket', 't2', 2, R3)]);
    expect(e.cutSeconds).toBeCloseTo(0, 5);
    expect(e.leftoverMm2).toBeCloseTo(100, 5);
    expect(e.unpriced).toBe(0);
  });

  it('no pockets', () => {
    const e = est([step('pocket', 't6', 6, R6)], []);
    expect(e.cutSeconds).toBeCloseTo(0, 5);
    expect(e.leftoverMm2).toBeCloseTo(0, 5);
    expect(e.changes).toBe(0);
  });
});

// planner v3 C1 — the contour is priced, and the estimate reports per cutter.
describe('#1225 the contour and per-cutter seconds', () => {
  const CONTOUR = { kind: 'contour', cutterKey: 't6', diameterMm: 6, regionIds: ['contour'], rates: R6 };

  it('K: a contour is priced from its length and depth', () => {
    const e = est([{ ...CONTOUR, contour: { perimeterMm: 200, depthMm: 6 } }]);
    expect(e.cutSeconds).toBeCloseTo(41.2, 5);
    expect(e.unpriced).toBe(0);
  });

  it('L: a contour with no outline is unpriced', () => {
    const e = est([{ ...CONTOUR }]);
    expect(e.cutSeconds).toBeCloseTo(0, 5);
    expect(e.unpriced).toBe(1);
  });

  it('M: per cutter', () => {
    const e = est([
      step('pocket', 't6', 6, R6),
      step('rest', 't3', 3, R3),
      { ...CONTOUR, contour: { perimeterMm: 200, depthMm: 6 } },
    ]);
    expect(e.perCutter).toHaveLength(2);
    expect(e.perCutter[0]!.cutterKey).toBe('t6');
    expect(e.perCutter[0]!.cutSeconds).toBeCloseTo(47.733333, 5);
    expect(e.perCutter[1]!.cutterKey).toBe('t3');
    expect(e.perCutter[1]!.cutSeconds).toBeCloseTo(5.2, 5);
    expect(e.changes).toBe(2);
  });

  it('N: every cutter appears, even unpriced', () => {
    const e = est([step('pocket', 't6', 6, R6), step('finish', 'b6', 6, R6)]);
    expect(e.perCutter).toHaveLength(2);
    expect(e.perCutter[1]).toEqual({ cutterKey: 'b6', cutSeconds: 0 });
  });
});

// #1249 stage 2b — the rest step is priced by the band it follows, not the area it could reach.
// The analyst's three hand-worked cases (#1249 comment, "Tests", 1–3) with zRapid 600 and
// xyRapid 1,200 mm/min, hopClearance 5 mm, stepDown 1, plungeFeed 200, feed 600, stepOver 0.5,
// levels 3, depth 3, regionArea 200.
describe('#1249 stage 2b — the rest term is the band', () => {
  const BAND_RATES: CutterRates = { feed: 600, plungeFeed: 200, stepDown: 1, stepOver: 0.5 };
  const P200: PocketArea = {
    id: 'p200', depthMm: 3, areaMm2: 200,
    reach: [
      { diameterMm: 6, reach: [], areaMm2: 80, addedAreaMm2: 80 },
      { diameterMm: 2, reach: [], areaMm2: 120, addedAreaMm2: 40 },
    ],
  };
  const POCKET: EstimateStep = { kind: 'pocket', cutterKey: 't6', diameterMm: 6, regionIds: ['p200'], rates: BAND_RATES };
  const REST = (band?: { areaMm2: number; contourLengthMm: number; patches: number }): EstimateStep => ({
    kind: 'rest', cutterKey: 't2', diameterMm: 2, regionIds: ['p200'], rates: BAND_RATES,
    ...(band === undefined ? {} : { band }),
  });
  const REST_PRICING = { rapid: { xyMmPerMin: 1200, zMmPerMin: 600 }, hopClearanceMm: 5 };
  const banded = (band?: { areaMm2: number; contourLengthMm: number; patches: number }) =>
    estimateChain([POCKET, REST(band)], [P200], () => 0, REST_PRICING);

  it('1: a thin band is followed along its line', () => {
    // path = max(40, 6/0.5) = 40; cut = 3·40/600·60 = 12 s; plunges = 4·3·1/200·60 = 3.6 s;
    // spacing = √(200/4) = 7.0711; hop = 2·8/600·60 + 7.0711/1200·60 = 1.6 + 0.353553 = 1.953553 s;
    // seconds = 12 + 3.6 + 5·1.953553 = 25.368 s.
    const e = banded({ areaMm2: 6, contourLengthMm: 40, patches: 4 });
    expect(e.stepEstimates[1]!.restSeconds).toBeCloseTo(25.368, 3);
    expect(e.stepEstimates[1]!.cutSeconds).toBeCloseTo(25.368, 3);
    expect(e.stepEstimates[0]!.restSeconds).toBe(0);
  });

  it('2: a fat band is cleared like a pocket', () => {
    // path = max(10, 100/0.5) = 200; cut = 3·200/600·60 = 60 s; plunges 3.6 s; hop as case 1;
    // seconds = 60 + 3.6 + 5·1.953553 = 73.368 s.
    const e = banded({ areaMm2: 100, contourLengthMm: 10, patches: 4 });
    expect(e.stepEstimates[1]!.restSeconds).toBeCloseTo(73.368, 3);
    expect(e.stepEstimates[1]!.cutSeconds).toBeCloseTo(73.368, 3);
  });

  it('3: one patch', () => {
    // cut 12 s; plunges = 1·3·1/200·60 = 0.9 s; spacing = √200 = 14.1421;
    // hop = 1.6 + 14.1421/1200·60 = 2.30711 s; seconds = 12 + 0.9 + 2·2.30711 = 17.514 s.
    const e = banded({ areaMm2: 6, contourLengthMm: 40, patches: 1 });
    expect(e.stepEstimates[1]!.restSeconds).toBeCloseTo(17.514, 3);
    expect(e.stepEstimates[1]!.cutSeconds).toBeCloseTo(17.514, 3);
  });

  it('4: no band keeps today’s term', () => {
    // added 40 mm², levels 3: per level = 40/0.5/600·60 + 1/200·60 = 8 + 0.3 s; 3 levels = 24.9 s.
    const e = banded(undefined);
    expect(e.stepEstimates[1]!.restSeconds).toBe(0);
    expect(e.stepEstimates[1]!.cutSeconds).toBeCloseTo(24.9, 9);
  });

  it('5: pocket and contour steps are untouched', () => {
    // The pocket is today's area term: 80/0.5/600·60 + 0.3 = 16.3 s per level, 3 levels = 48.9 s.
    expect(banded(undefined).stepEstimates[0]!.cutSeconds).toBeCloseTo(48.9, 9);
    const contour: EstimateStep = {
      kind: 'contour', cutterKey: 't6', diameterMm: 6, regionIds: ['contour'], rates: R6,
      contour: { perimeterMm: 200, depthMm: 6 },
    };
    const e = estimateChain([contour], [P200], () => 0, REST_PRICING);
    expect(e.cutSeconds).toBeCloseTo(41.2, 5); // the same number as K
    expect(e.stepEstimates[0]!.restSeconds).toBe(0);
  });

  it('6: no rapid rates given — the rest step keeps today’s term and nothing throws', () => {
    const e = estimateChain([POCKET, REST({ areaMm2: 6, contourLengthMm: 40, patches: 4 })], [P200], () => 0);
    expect(e.stepEstimates[1]!.restSeconds).toBe(0);
    expect(e.stepEstimates[1]!.cutSeconds).toBeCloseTo(24.9, 9);
  });

  it('7: the spacing is the pocket set’s whole area, not the step’s share of it', () => {
    // A second pocket of 100 mm² in the estimate's list, untouched by this chain: regionArea = 300,
    // spacing = √(300/4) = 8.6603; hop = 1.6 + 8.6603/1200·60 = 2.03301 s; seconds = 12 + 3.6 +
    // 5·2.03301 = 25.765 s. The rest step's own regionIds still name only p200.
    const P100: PocketArea = {
      id: 'p100', depthMm: 3, areaMm2: 100,
      reach: [{ diameterMm: 2, reach: [], areaMm2: 40, addedAreaMm2: 40 }],
    };
    const e = estimateChain(
      [POCKET, REST({ areaMm2: 6, contourLengthMm: 40, patches: 4 })],
      [P200, P100],
      () => 0,
      REST_PRICING,
    );
    expect(e.stepEstimates[1]!.restSeconds).toBeCloseTo(25.765, 3);
  });
});
