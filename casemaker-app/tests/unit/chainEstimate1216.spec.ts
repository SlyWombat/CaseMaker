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
