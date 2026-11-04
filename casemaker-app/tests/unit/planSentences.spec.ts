// #963 — EVERY SENTENCE THE PLAN CAN EMIT HAS A GUIDE ROW. The plan's words are built once
// (`planWords.ts`, `planNotes.ts`, `goalCheckWords.ts`) and shown on the row, the Cut card and the
// run sheet; the operator guide must explain each one, or a person meets a sentence at the machine
// with nowhere to look it up. This test names a stable fragment of each family and fails when the
// guide stops carrying it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  featureSentence,
  linkingSentence,
  sequenceSentence,
  setupSentence,
} from '@/engine/cnc/engrave/planWords';
import { freeingSentence, unplannedSentences } from '@/engine/cnc/engrave/planNotes';
import {
  goalCoverageWords,
  goalRawWords,
  goalReachWords,
  goalVerdictWords,
} from '@/engine/cnc/engrave/goalCheckWords';
import { fixtureSetupPlan } from './fixtures/setupPlan';
import { fixtureGoalReport } from './fixtures/goalReport';

const guide = readFileSync(path.resolve(__dirname, '../../src/docs/cnc-guide.md'), 'utf8').toLowerCase();

/**
 * One stable fragment per sentence family — the part of each built sentence that does not depend
 * on a number, so the test pins the SHAPE the guide must explain, not a sample's digits.
 */
function fragments(): { what: string; fragment: string }[] {
  // Built once to prove the builders still produce these shapes (a rename breaks here first).
  const plan = fixtureSetupPlan();
  const report = fixtureGoalReport();
  expect(featureSentence(plan.features)).toContain('1 outer contour');
  expect(linkingSentence(plan.linking)).toContain('of the cycle in air');
  expect(setupSentence(plan, 'top', (key) => key)).toContain('Setup 1 (top):');
  expect(freeingSentence(null)).toBe('The part is not freed — no freeing cut is posted.');
  expect(goalVerdictWords(report).text).toContain('into the design at');
  return [
    { what: 'the features sentence', fragment: 'pockets, 1 outer contour' },
    { what: 'the sequence sentence', fragment: '→' },
    { what: 'the linking sentence', fragment: 'of the cycle in air' },
    { what: 'a setup line', fragment: 'Setup 1 (top):' },
    { what: 'an unplanned line', fragment: 'not cut — planning failed (' },
    { what: 'the not-freed line', fragment: 'The part is not freed — no freeing cut is posted.' },
    { what: 'the judged goal line', fragment: 'Matches the design (goal)' },
    { what: 'the judged cut line', fragment: 'into the design at' },
    { what: 'the raw goal line', fragment: 'raw, before exclusions:' },
    { what: 'the coverage line', fragment: 'Top-surface coverage:' },
    { what: 'the whole-surface line', fragment: 'Whole-surface reach:' },
    // The one sentence the guide states as a shape rather than a sample: the cutter-shortfall line.
    { what: 'the needs-a-cutter line', fragment: 'needs a cutter ≤ n mm' },
  ];
}

describe('#963 every plan sentence has a guide row', () => {
  it('states each sentence family in the operator guide', () => {
    const missing = fragments()
      .filter(({ fragment }) => fragment !== '' && !guide.includes(fragment.toLowerCase()))
      .map(({ what, fragment }) => `${what}: "${fragment}"`);
    expect(missing).toEqual([]);
  });
});
