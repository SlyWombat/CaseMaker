/**
 * #1252 (review 3) — THE ADJUDICATION SEAM'S GUARDS. The plan's `input.goal` is a structural subset
 * of the sampled heightfield; the seam trusts it only when every field the goal check reads is
 * present and finite, and a cell count that is not a number is "the check did not run", never
 * `NaN` on the sheet.
 */
import { describe, expect, it } from 'vitest';

import { adjudicatedCellCount, asGoalHeightfield } from '@/workers/sim/goalChainCutInto';

const full = () => ({
  nx: 4,
  ny: 3,
  x0: 0,
  y0: 0,
  pitch: 0.1,
  topZ: 0,
  minZ: -1,
  z: new Float32Array(12),
  covered: new Uint8Array(12).fill(1),
  coveredCount: 12,
  resolutionNote: 'test',
});

describe('#1252 asGoalHeightfield', () => {
  it('a full sampled heightfield comes back as it is', () => {
    const goal = full();
    expect(asGoalHeightfield(goal)).toBe(goal);
  });

  it('the structural subset the plan carries (no topZ / minZ / coveredCount) is NOT the heightfield: null', () => {
    const { topZ: _t, minZ: _m, coveredCount: _c, resolutionNote: _r, ...subset } = full();
    expect(asGoalHeightfield(subset)).toBeNull();
  });

  it('every field the check reads is required, finite and consistent', () => {
    for (const bad of [
      { ...full(), coveredCount: Number.NaN },
      { ...full(), pitch: 0 },
      { ...full(), nx: Number.POSITIVE_INFINITY },
      { ...full(), x0: undefined },
      { ...full(), z: new Float32Array(5) },
      { ...full(), covered: new Uint8Array(3) },
      { ...full(), coveredCount: -1 },
    ]) {
      expect(asGoalHeightfield(bad)).toBeNull();
    }
    expect(asGoalHeightfield(null)).toBeNull();
    expect(asGoalHeightfield(undefined)).toBeNull();
    expect(asGoalHeightfield(7)).toBeNull();
  });
});

describe('#1252 adjudicatedCellCount', () => {
  it('rounds the fraction over the covered cells to the check’s own integer', () => {
    expect(adjudicatedCellCount(0, 120701)).toBe(0);
    expect(adjudicatedCellCount(4 / 120701, 120701)).toBe(4);
  });

  it('a non-finite fraction or covered count is not an answer: null', () => {
    expect(adjudicatedCellCount(Number.NaN, 100)).toBeNull();
    expect(adjudicatedCellCount(0.1, Number.NaN)).toBeNull();
    expect(adjudicatedCellCount(Number.POSITIVE_INFINITY, 100)).toBeNull();
  });
});
