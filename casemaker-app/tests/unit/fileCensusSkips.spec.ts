// The census judge: every skipped file is a STATED decision (census-expected.json "skipped").
import { describe, expect, it } from 'vitest';

import { judge, render, type Census } from '../../tools/gate/fileCensus.mts';

const A = 'tests/unit/a.spec.ts';
const B = 'tests/unit/b.spec.ts';

function census(over: Partial<Census> = {}): Census {
  return { runner: 'vitest', onDisk: [A, B], ran: [B], skipped: [A], noLoad: [], unaccounted: [], extra: [], ...over };
}

describe('file census — skipped files carry a stated reason', () => {
  it('a skipped file with no entry is RED', () => {
    const v = judge(census(), 2, [], {});
    expect(v.red).toBe(true);
    expect(v.reasons.join(' ')).toContain('skipped without a stated reason');
    expect(v.reasons.join(' ')).toContain(A);
  });

  it('a blank reason counts as no reason', () => {
    expect(judge(census(), 2, [], { [A]: '  ' }).red).toBe(true);
  });

  it('a stated skip is green and the report prints its reason', () => {
    const stated = { [A]: 'needs FIXTURE_X' };
    const v = judge(census(), 2, [], stated);
    expect(v.red).toBe(false);
    expect(v.notes).toEqual([]);
    expect(render(census(), v, 2, null, stated).join('\n')).toContain('a.spec.ts: needs FIXTURE_X');
  });

  it('an entry whose file did not skip is a note, not red', () => {
    const v = judge(census({ skipped: [], ran: [A, B] }), 2, [], { [A]: 'needs FIXTURE_X' });
    expect(v.red).toBe(false);
    expect(v.notes).toEqual([`${A} has a stated skip reason but did not skip in this run`]);
  });

  it('an unstated skip is flagged in the report', () => {
    const c = census();
    expect(render(c, judge(c, 2, [], {}), 2, null, {}).join('\n')).toContain('NO STATED REASON');
  });

  it('other reds are unchanged', () => {
    expect(judge(census({ skipped: [], ran: [A, B] }), 3, [], {}).red).toBe(true);
  });
});
