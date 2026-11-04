/**
 * #963 — a fixture `GoalCutIntoReport` in the shape `designCheck.ts` publishes after #964: the
 * judged (adjudicated) reading and the raw one differ by exactly the unadjudicable cells, which is
 * what the sheet's two lines exist to say.
 */
import type { GoalCutIntoReport } from '@/engine/cnc/engrave/designCheck';

export function fixtureGoalReport(overrides: Partial<GoalCutIntoReport> = {}): GoalCutIntoReport {
  return {
    ok: false,
    ran: true,
    reason: null,
    goalCells: 10000,
    pitchMm: 0.1,
    cutIntoFloorMm: 0.01,
    // raw: 2 % of cells cut into, deepest 0.42 at (41.2, 25.3)
    cutIntoFraction: 0.02,
    cutIntoAreaMm2: 20,
    cutIntoVolumeMm3: 8.4,
    maxCutIntoMm: 0.42,
    maxCutIntoAt: { x: 41.2, y: 25.3 },
    // adjudicated: one cell, 0.24 deep, at another place (the raw worst was excluded)
    adjudicatedFraction: 0.0001,
    adjudicatedMaxMm: 0.24,
    adjudicatedMaxAt: { x: 18.7, y: 60.1 },
    edgeBreakFraction: 0.005,
    wallNotScoredFraction: 0.014,
    shadowNotScoredFraction: 0.0009,
    leftoverFractions: [0.012, 0.1, 0.3],
    leftoverVolumeMm3: 5,
    maxLeftoverMm: 0.6,
    coverageFraction: 0.88,
    passCoverage: 0.95,
    medianDeltaMm: 0.01,
    sentence: 'The sweep cuts into the goal.',
    ...overrides,
  };
}

/** A passing report, for the sheet's "matches" line. */
export const fixtureGoalReportPassing: GoalCutIntoReport = fixtureGoalReport({
  ok: true,
  cutIntoFraction: 0,
  maxCutIntoMm: 0,
  maxCutIntoAt: null,
  adjudicatedFraction: 0,
  adjudicatedMaxMm: 0,
  adjudicatedMaxAt: null,
  leftoverFractions: [0.004, 0.05, 0.2],
  sentence: 'The sweep matches the goal.',
});
