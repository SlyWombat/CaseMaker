// #1176 part 1 — THE FIXED ROW'S FULL WORDS. The artboard's row reads
// `Generating · planning the contour, side 1 · stage 3 of 7`, then `40 % · about 6 min left`; the
// landed row had the stage words and the sweep's time-left but neither the counter nor the percent.
// Both are derived from the run record's own progress (`EngraveProgress`), never from a new engine
// field: `stage` gives the counter over the pipeline's seven stages (plan is the third, as the
// artboard draws it), and `done`/`total` give the percent where a phase reports them.
import { describe, expect, it } from 'vitest';

import { percentWords, stageCounterWords } from '@/components/panels/RunProgressLine';

describe('#1176 — the progress row’s stage counter and percent', () => {
  it('counts the pipeline’s stages, plan third of seven, matching the artboard', () => {
    expect(stageCounterWords({ stage: 'prepare' })).toBe('stage 1 of 7');
    expect(stageCounterWords({ stage: 'items' })).toBe('stage 2 of 7');
    expect(stageCounterWords({ stage: 'plan' })).toBe('stage 3 of 7');
    expect(stageCounterWords({ stage: 'verify' })).toBe('stage 7 of 7');
  });

  it('says nothing outside the pipeline (idle, a finished run, an unknown stage)', () => {
    expect(stageCounterWords(null)).toBeNull();
    expect(stageCounterWords({ stage: 'done' })).toBeNull();
    expect(stageCounterWords({ stage: 'findings' })).toBeNull();
  });

  it('states the percent when the phase reports done/total, and only then', () => {
    expect(percentWords({ done: 3, total: 8 })).toBe('38 %');
    expect(percentWords({ done: 41, total: 112 })).toBe('37 %');
    expect(percentWords({ done: 0, total: 8 })).toBe('0 %');
    expect(percentWords({})).toBeNull();
    expect(percentWords({ done: 1, total: 0 })).toBeNull();
    expect(percentWords(null)).toBeNull();
  });
});
