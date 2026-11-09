/**
 * #1123 item 4 — THE RUN LOG, as data: every stage tick with a timestamp and a duration.
 *
 * The maintainer's bench note: Generate on the tray job runs 11–12 min behind one line
 * ("planning: rest — setup 1, 40 %…") and "Working…", with no way to see what it is doing or
 * where the time went. The fix is a folded log beside the progress line holding every stage tick
 * (plan: sequence / rest / ball rank per cutter; post per program; verify; simulate per program;
 * goal check), kept for the run and saved as `<job>-run.log` beside the run record.
 *
 * This spec pins the pure half: append with the previous tick's duration, dedupe the percentage
 * ticks of one stage (the same stage line is ONE entry), and the file's own naming and text.
 */
import { describe, expect, it } from 'vitest';

import { appendRunLog, formatRunLogDuration, formatRunLogEntry, runLogKey, serializeRunLog } from '@/engine/cnc/engrave/runLog';
import { runLogFileName, runRecordFileName } from '@/engine/cnc/engrave/runRecord';

const START = 1_000_000;

describe('#1123 item 4 — the run log: timestamps, durations, one entry per stage', () => {
  it('appends the first tick at zero and every later one with the time since the previous tick', () => {
    const one = appendRunLog([], 'starting the worker', START, START);
    expect(one).toEqual([{ at: START, ms: 0, label: 'starting the worker' }]);
    const two = appendRunLog(one, 'reading the job', START + 4_500, START);
    expect(two).toHaveLength(2);
    expect(two[1]).toEqual({ at: START + 4_500, ms: 4_500, label: 'reading the job' });
    // The duration is against the LAST tick, not the run's start.
    const three = appendRunLog(two, 'planning: sequence — setup 1, 35 %', START + 9_000, START);
    expect(three[2]!.ms).toBe(4_500);
  });

  it('dedupes a stage’s percentage ticks — one entry per stage line', () => {
    const log = appendRunLog([], 'planning: rest — setup 1, 10 %', START, START);
    const same = appendRunLog(log, 'planning: rest — setup 1, 40 %', START + 1_000, START);
    expect(same).toHaveLength(1);
    expect(same[0]!.label).toBe('planning: rest — setup 1, 10 %');
    // A different op is a different stage line and appends.
    const next = appendRunLog(same, 'planning: pocket — setup 1, 70 %', START + 2_000, START);
    expect(next).toHaveLength(2);
    expect(next[1]!.label).toBe('planning: pocket — setup 1, 70 %');
    // And returning to the same op after another op appends again (it is a new stage).
    const back = appendRunLog(next, 'planning: rest — setup 1, 10 %', START + 3_000, START);
    expect(back).toHaveLength(3);
  });

  it('runLogKey keeps the stage and drops only a trailing percentage', () => {
    expect(runLogKey('planning: rest — setup 1, 40 %')).toBe('planning: rest — setup 1');
    expect(runLogKey('posting setup 1 program 1/2 (flat-6)')).toBe('posting setup 1 program 1/2 (flat-6)');
  });

  it('formats a line with its clock time, duration and words', () => {
    const line = formatRunLogEntry({ at: START, ms: 12_345, label: 'posting setup 1 program 1/2 (flat-6)' });
    expect(line).toMatch(/^\d{2}:\d{2}:\d{2}/);
    expect(line).toContain('+12.3 s');
    expect(line).toContain('posting setup 1 program 1/2 (flat-6)');
    expect(formatRunLogDuration(65_000)).toBe('1 m 5 s');
  });

  it('serializes the log as text with a header, ISO times and durations', () => {
    const log = appendRunLog(appendRunLog([], 'starting the worker', START, START), 'reading the job', START + 4_500, START);
    const text = serializeRunLog(log, 'tray job — run log');
    expect(text.split('\n')[0]).toContain('tray job — run log');
    expect(text).toContain('starting the worker');
    expect(text).toContain('+4.5 s');
    expect(text).toContain('reading the job');
  });

  it('names the log beside the run record: <job>-run.log', () => {
    expect(runLogFileName('Tray job')).toBe(runRecordFileName('Tray job').replace(/-run\.json$/, '-run.log'));
    expect(runLogFileName('Tray job')).toMatch(/-run\.log$/);
  });
});
