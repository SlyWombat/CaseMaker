// #963 — the goal check's words, shared by the Cut card and the run sheet. The fixture's raw and
// adjudicated readings differ on purpose: the card must name the cell the pass JUDGED, and the raw
// line must print beside it, never as the pass.

import { describe, expect, it } from 'vitest';
import {
  goalCoverageWords,
  goalRawWords,
  goalReachWords,
  goalVerdictWords,
} from '@/engine/cnc/engrave/goalCheckWords';
import { fixtureGoalReport, fixtureGoalReportPassing } from './fixtures/goalReport';

describe('#963 the goal check, in the operator’s words', () => {
  it('names the ADJUDICATED cut and where it is, not the raw worst', () => {
    expect(goalVerdictWords(fixtureGoalReport())).toEqual({
      text: 'Cuts 0.24 mm into the design at 18.7, 60.1',
      state: 'cut-into',
    });
  });

  it('prints a pass in the page’s own words', () => {
    expect(goalVerdictWords(fixtureGoalReportPassing)).toEqual({
      text: 'Matches the design (goal)',
      state: 'match',
    });
  });

  it('names a coverage failure against the pass line rather than a 0 mm cut', () => {
    const words = goalVerdictWords(fixtureGoalReport({ ok: false, adjudicatedMaxMm: 0, adjudicatedMaxAt: null }));
    expect(words.state).toBe('coverage');
    expect(words.text).toBe('Covers 98.8 % of the design’s top surface (the pass line is 95 %)');
  });

  it('states an unchecked goal with its reason, never a silent pass', () => {
    expect(goalVerdictWords(fixtureGoalReport({ ran: false, reason: 'the sweep gave no flat top' }))).toEqual({
      text: 'Goal not checked: the sweep gave no flat top',
      state: 'not-checked',
    });
  });

  it('prints the raw reading beside the judged one, in the page’s formats', () => {
    expect(goalRawWords(fixtureGoalReport())).toBe(
      'raw, before exclusions: 2 % cut-into, max 0.42 mm at 41.2, 25.3',
    );
    expect(goalRawWords(fixtureGoalReport({ ran: false }))).toBeNull();
  });

  it('states the top-surface coverage against the pass line', () => {
    expect(goalCoverageWords(fixtureGoalReport())).toBe('Top-surface coverage: 98.8 % (the pass line is 95 %)');
  });

  it('states the whole-surface reach only when the run carries one', () => {
    expect(goalReachWords(0.6234)).toBe(
      'Whole-surface reach: 62.3 % from this setup (the remainder: under-faces and undercuts)',
    );
    expect(goalReachWords(undefined)).toBeNull();
  });
});
