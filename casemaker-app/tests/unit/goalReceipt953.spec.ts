// #953 — THE RECEIPT'S GOAL BLOCK IS THE APP'S OWN REPORT. The mapping is field for field, and
// the two numbers that do not exist on every report (the whole-surface union and the conservative
// column read) are null when absent — never an invented value.
import { describe, expect, it } from 'vitest';

import type { GoalCutIntoReport } from '@/engine/cnc/engrave/designCheck';
import { goalBlockFromReport } from '@/platform/headless/receipt';

function report(over: Partial<GoalCutIntoReport> = {}): GoalCutIntoReport {
  return {
    ok: true,
    ran: true,
    reason: null,
    goalCells: 156996,
    pitchMm: 0.1,
    cutIntoFloorMm: 0.01,
    cutIntoFraction: 0.0123,
    cutIntoAreaMm2: 1.93,
    cutIntoVolumeMm3: 0.14,
    maxCutIntoMm: 0.21,
    maxCutIntoAt: { x: 4.5, y: -2 },
    adjudicatedFraction: 0.004,
    adjudicatedMaxMm: 0.165,
    adjudicatedMaxAt: { x: 4.5, y: -2 },
    edgeBreakFraction: 0.0366,
    wallNotScoredFraction: 0.002,
    shadowNotScoredFraction: 0.001,
    straddlingNotScoredCells: 0,
    straddlingMaxStepMm: 0,
    wallOverReliefCells: 0,
    shadowOverReliefCells: 0,
    borderOverReliefCells: 0,
    overReliefDeepest: null,
    silhouetteExcusedCells: 0,
    silhouetteDeepest: null,
    silhouetteUnavailableCells: 0,
    silhouetteByWitnessCells: 0,
    leftoverFractions: [0.162, 0.02, 0.001],
    leftoverVolumeMm3: 6.2,
    maxLeftoverMm: 1.4,
    coverageFraction: 0.98,
    passCoverage: 0.95,
    medianDeltaMm: 0.01,
    sentence: 'Cuts 0.21 mm into the design at 4.5, -2.',
    ...over,
  };
}

describe('#953 the receipt goal block', () => {
  it('maps every field of the app report', () => {
    const block = goalBlockFromReport(report());
    expect(block).toEqual({
      ran: true,
      reason: null,
      cutIntoFraction: 0.0123,
      maxCutIntoMm: 0.21,
      maxCutIntoAt: { x: 4.5, y: -2 },
      adjudicatedFraction: 0.004,
      adjudicatedMaxMm: 0.165,
      edgeBreakFraction: 0.0366,
      wallNotScoredFraction: 0.002,
      shadowNotScoredFraction: 0.001,
      // #1092 (gate v8) — the over-relief and silhouette fields the block carries.
      wallOverReliefCells: 0,
      shadowOverReliefCells: 0,
      borderOverReliefCells: 0,
      overReliefDeepest: null,
      silhouetteExcusedCells: 0,
      silhouetteDeepest: null,
      silhouetteUnavailableCells: 0,
      silhouetteByWitnessCells: 0,
      leftoverFractions: [0.162, 0.02, 0.001],
      passCoverage: 0.95,
      wholeSurface: null,
      columnCutInto: null,
      sentence: 'Cuts 0.21 mm into the design at 4.5, -2.',
    });
  });

  it('states an unchecked comparison as a gap, not a pass', () => {
    const block = goalBlockFromReport(report({ ran: false, reason: 'no flat top', ok: true, maxCutIntoAt: null }));
    expect(block.ran).toBe(false);
    expect(block.reason).toBe('no flat top');
    expect(block.maxCutIntoAt).toBeNull();
  });

  it('carries the whole-surface union and the column read when the report has them', () => {
    const wholeSurface = {
      fraction: 0.8386,
      reachedCells: 131641,
      cells: 156996,
      coveredCells: 156996,
      excludedCells: 0,
      excludedAreaMm2: 0,
      excludedFace: null,
      setups: 1,
    };
    const columnCutInto = { fraction: 0.02, maxMm: 0.3, at: { x: 1, y: 2 } };
    const block = goalBlockFromReport(
      report({ ...({ wholeSurface, columnCutInto } as Partial<GoalCutIntoReport>) }),
    );
    expect(block.wholeSurface).toEqual(wholeSurface);
    expect(block.columnCutInto).toEqual(columnCutInto);
  });
});
