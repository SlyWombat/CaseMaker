/**
 * #1158 — A SAMPLE'S CHECK IS ITS RUN'S FINAL GOAL CHECK.
 *
 * The Sample Bench harness judged EVERY program's goal check, so a multi-program run failed on its
 * own rough passes: heart-gear-b's five programs adjudicate 5.72 %, 25.22 %, 100 %, 100 %, 100 %
 * and the sample was recorded FAIL although the last three are perfect. The rule now: the FINAL
 * goal check is the coverage verdict; a cut-into at any stage is a never-miss; intermediate
 * coverages are stated, not judged.
 *
 * Red at the base: `sampleCheckRule.ts` does not exist (the import fails); the recorded
 * `results.json` at `269d58d76` is the behavioural witness — heart-gear-b reads `fail`.
 */
import { describe, expect, it } from 'vitest';

import { judgeSampleGoals } from '../../tools/samples/sampleCheckRule';

/** One program's goal block as the receipt carries it (`details.programs[i].goal`). */
function goal(overrides: { coverage?: number; adjudicated?: number; ran?: boolean; reason?: string } = {}): Record<string, unknown> {
  const coverage = overrides.coverage ?? 1;
  return {
    ran: overrides.ran ?? true,
    adjudicatedMaxMm: overrides.adjudicated ?? 0,
    passCoverage: 0.95,
    leftoverFractions: [1 - coverage, 0, 0],
    ...(overrides.reason === undefined ? {} : { reason: overrides.reason }),
  };
}

describe('#1158 the final goal check is the sample verdict', () => {
  it('heart-gear-b: two rough passes under the line, then three perfect programs — PASS', () => {
    const verdict = judgeSampleGoals([
      goal({ coverage: 0.0572 }),
      goal({ coverage: 0.2522 }),
      goal({ coverage: 1 }),
      goal({ coverage: 1 }),
      goal({ coverage: 1 }),
    ]);
    expect(verdict).not.toBeNull();
    expect(verdict!.status).toBe('pass');
    expect(verdict!.note).toContain("the run's final goal check (program 5 of 5) is the verdict");
    expect(verdict!.note).toContain('coverage 100.00 %');
    // The rough passes are stated, not judged.
    expect(verdict!.note).toContain('program 1 — adjudicated cut-into 0.0000 mm, coverage 5.72 %');
    expect(verdict!.note).toContain('program 2 — adjudicated cut-into 0.0000 mm, coverage 25.22 %');
    expect(verdict!.note).toContain('stated not judged');
  });

  it('multiboard-offset-snaps-tool: the last four at 86.52 % — still FAIL on the final state', () => {
    const verdict = judgeSampleGoals([
      goal({ coverage: 0.6998 }),
      goal({ coverage: 0.7404 }),
      goal({ coverage: 0.8652 }),
      goal({ coverage: 0.8652 }),
      goal({ coverage: 0.8652 }),
      goal({ coverage: 0.8652 }),
    ]);
    expect(verdict!.status).toBe('fail');
    expect(verdict!.note).toContain("the run's final goal check (program 6 of 6) is under the pass line");
    expect(verdict!.note).toContain('coverage 86.52 %');
  });

  it('a cut-into at ANY stage is a never-miss, named with its program', () => {
    const verdict = judgeSampleGoals([
      goal({ coverage: 0.3 }),
      goal({ coverage: 0.5, adjudicated: 0.2 }),
      goal({ coverage: 1 }),
    ]);
    expect(verdict!.status).toBe('fail');
    expect(verdict!.note).toContain("program 2's check adjudicated 0.2000 mm cut-into the goal");
  });

  it('the final program not compared is a FAIL with its reason; an intermediate is only stated', () => {
    const unranFinal = judgeSampleGoals([
      goal({ coverage: 0.4 }),
      goal({ coverage: 0.9, ran: false, reason: 'the live sweep produced no cut to stamp the goal with' }),
    ]);
    expect(unranFinal!.status).toBe('fail');
    expect(unranFinal!.note).toContain('did not run: the live sweep produced no cut to stamp the goal with');

    const unranMiddle = judgeSampleGoals([
      goal({ ran: false, reason: 'a refused sweep owns no material' }),
      goal({ coverage: 1 }),
    ]);
    expect(unranMiddle!.status).toBe('pass');
    expect(unranMiddle!.note).toContain('program 1 — not compared: a refused sweep owns no material');
  });

  it('no program carried a goal check is null (the harness records n/a)', () => {
    expect(judgeSampleGoals([])).toBeNull();
  });
});
