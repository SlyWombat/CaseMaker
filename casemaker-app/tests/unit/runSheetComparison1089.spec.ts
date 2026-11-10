/**
 * #1089 — THE IDEAL-VS-OWNED LINE ON THE RUN SHEET. #975's ruling states the tradeoff in OUTCOME
 * terms, once, from ONE function (`comparePlanOutcomes`); the sheet must print that line and the
 * two cycle numbers beside "The cutter", agree with the card to the digit, and say so when the
 * comparison was deferred (the CLI's --defer-ideal) or is still running (the app's late ideal).
 * No comparison → no step, so every sheet without one stays byte-identical.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { buildRunSheet, type RunSheet, type RunSheetGenerated } from '@/engine/cnc/engrave/runSheet';
import { planComparisonStatement, type PlanTradeoff } from '@/engine/cnc/cam/model/tradeoff';

const NOW = new Date('2026-11-10T12:00:00Z');

const MATERIAL: PlanTradeoff = {
  material: true,
  line: 'owned plan vs catalogue ideal: cycle 54.3 → 41.2 min',
  differences: [
    { bound: 'cycleFraction', reading: 'cycle 54.3 → 41.2 min', owned: 3258, ideal: 2472, amount: 0.241, material: true },
  ],
};
const MINOR: PlanTradeoff = {
  material: false,
  line: null,
  differences: [
    { bound: 'cycleFraction', reading: 'cycle 54.3 → 53.1 min', owned: 3258, ideal: 3186, amount: 0.022, material: false },
  ],
};

function sheetWith(comparison: Parameters<typeof buildRunSheet>[5]['comparison']): RunSheet {
  const job = defaultEngraveJob();
  const generated: RunSheetGenerated = {
    findings: [],
    feeds: null,
    cam: null,
    nc: 'job.nc',
    verify: null,
    frameNc: null,
    programs: [{ kind: 'engrave', setupIndex: 1, toolKey: job.toolKey, nc: 'job.nc', frameNc: null, cam: null }],
  };
  return buildRunSheet(job, generated, { diagnostics: [] }, NOW, undefined, { comparison });
}

/** The comparison step §1 carries, or null. */
function comparisonStep(sheet: RunSheet): { text: string; value?: string } | null {
  const need = sheet.sections.find((s) => s.id === 'need');
  expect(need, 'the sheet has its need section').toBeTruthy();
  return need!.steps.find((s) => /ideal plan|comparison/i.test(s.text) && /cycle|comparison/i.test(s.text)) ?? null;
}

describe('#1089 the ideal-vs-owned line on the run sheet', () => {
  it('reads the one tradeoff line and both cycle numbers for a material difference', () => {
    const step = comparisonStep(sheetWith({ kind: 'material', line: MATERIAL.line!, ownedSeconds: 3258, idealSeconds: 2472 }));
    expect(step, '§1 states the comparison').toBeTruthy();
    expect(step!.text).toBe(
      'owned plan vs catalogue ideal: cycle 54.3 → 41.2 min. The ideal plan’s cycle is 2472 s against the owned plan’s 3258 s.',
    );
    expect(step!.value).toBe('ideal 2472 s · owned 3258 s');
  });

  it('says the difference is not material, and still gives both cycles', () => {
    const step = comparisonStep(sheetWith({ kind: 'minor', ownedSeconds: 3258, idealSeconds: 3186 }));
    expect(step!.text).toBe(
      'No material difference between the owned plan and the catalogue ideal. The ideal plan’s cycle is 3186 s against the owned plan’s 3258 s.',
    );
  });

  it('states a deferred comparison instead of omitting it silently', () => {
    const step = comparisonStep(sheetWith({ kind: 'deferred' }));
    expect(step!.text).toContain('deferred');
    expect(step!.text).toContain('--defer-ideal');
    expect(step!.value).toBe('comparison deferred');
  });

  it('states a comparison that is still running (the app’s late ideal)', () => {
    const step = comparisonStep(sheetWith({ kind: 'comparing' }));
    expect(step!.text).toContain('still running');
    expect(step!.value).toBe('comparison running');
  });

  it('adds no step when there is no comparison at all, so legacy sheets are byte-identical', () => {
    expect(comparisonStep(sheetWith(undefined))).toBeNull();
  });
});

describe('#1089 the statement maps the tradeoff it is given', () => {
  it('material → the line and the cycle row’s numbers; minor → the numbers alone', () => {
    expect(planComparisonStatement(MATERIAL)).toEqual({
      kind: 'material',
      line: 'owned plan vs catalogue ideal: cycle 54.3 → 41.2 min',
      ownedSeconds: 3258,
      idealSeconds: 2472,
    });
    expect(planComparisonStatement(MINOR)).toEqual({ kind: 'minor', ownedSeconds: 3258, idealSeconds: 3186 });
  });
});
