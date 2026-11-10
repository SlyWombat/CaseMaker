/**
 * #1154 — the run record keeps the app's own heartbeat `?` status lines.
 *
 * The maintainer's ruling (2026-11-10): the thinning rule is CODE, not a shop default — keep every
 * poll for the first 5 min of a program, then one line per 10 s, plus every line where the state
 * word changes; a hard cap of 5,000 lines per program with a stated "thinned" note. One line per
 * sample: ISO time, state, the P: fields raw, WPos. Export only (no on-screen viewer), and the
 * data is kept with the run-log entry — the house copy of the finished-program record.
 */
import { describe, expect, it } from 'vitest';

import {
  STATUS_LOG_MAX_LINES,
  createStatusLog,
  readStatusFields,
  statusLogFileName,
  type StatusSample,
} from '@/engine/cnc/engrave/runStatusLog';

const T0 = Date.UTC(2026, 10, 10, 8, 0, 0);
const sample = (ms: number, over: Partial<StatusSample> = {}): StatusSample => ({
  atMs: T0 + ms,
  state: 'Run',
  p: '120,45,30',
  wpos: '12.345,20.100,-0.500',
  ...over,
});

describe('#1154 — reading a status line', () => {
  it('pulls the state word, the P: fields and WPos as written', () => {
    const f = readStatusFields(
      '<Run|MPos:-3.000,-2.000,-1.000|WPos:12.345,20.100,-0.500|F:600.0,600.0|S:12000.0|P:120,45,30>',
    );
    expect(f).toEqual({ state: 'Run', p: '120,45,30', wpos: '12.345,20.100,-0.500' });
    // A reply that carries no such field says so with null, never a guess.
    expect(readStatusFields('<Idle|MPos:0,0,0>')).toEqual({ state: 'Idle', p: null, wpos: null });
    expect(readStatusFields('')).toEqual({ state: null, p: null, wpos: null });
  });
});

describe('#1154 — the thinning rule', () => {
  it('keeps every poll for the first 5 minutes of a program', () => {
    const log = createStatusLog(T0);
    for (let ms = 0; ms <= 300_000; ms += 2_000) log.push(sample(ms));
    expect(log.seen).toBe(151);
    expect(log.kept.length).toBe(151);
    expect(log.dropped).toBe(0);
    expect(log.capped).toBe(false);
  });

  it('then keeps one line per 10 s, plus every state change, and counts what it dropped', () => {
    const log = createStatusLog(T0);
    log.push(sample(0));
    log.push(sample(300_000));
    // 2 s after the last kept line: not due, same state — dropped.
    log.push(sample(302_000));
    // A state change is always kept, whatever the gap.
    log.push(sample(304_000, { state: 'Hold' }));
    log.push(sample(306_000, { state: 'Hold' }));
    // 10 s after the last kept line: due.
    log.push(sample(314_000, { state: 'Hold' }));
    expect(log.kept.map((s) => [s.atMs - T0, s.state])).toEqual([
      [0, 'Run'],
      [300_000, 'Run'],
      [304_000, 'Hold'],
      [314_000, 'Hold'],
    ]);
    expect(log.seen).toBe(6);
    expect(log.dropped).toBe(2);
  });

  it('stops at the 5,000-line cap and states it', () => {
    const log = createStatusLog(T0);
    // 11 s apart: every line is due, so the cap is what stops it.
    for (let i = 0; i < STATUS_LOG_MAX_LINES + 50; i += 1) log.push(sample(i * 11_000));
    expect(log.kept.length).toBe(STATUS_LOG_MAX_LINES);
    expect(log.capped).toBe(true);
    const text = log.text({ jobName: 'A job', programIndex: 1, programTotal: 1 });
    expect(text).toContain('thinned');
    expect(text).toContain('5,000');
  });
});

describe('#1154 — the file', () => {
  it('writes ISO time, state, P: fields raw and WPos, with a stated thinning note', () => {
    const log = createStatusLog(T0);
    log.push(sample(0));
    log.push(sample(2_000, { state: 'Hold' }));
    const text = log.text({ jobName: 'A job', programIndex: 2, programTotal: 5 });
    const lines = text.split('\n');
    // Two comment lines, then the samples, in order.
    expect(lines[0]).toBe('# A job — program 2 of 5; status lines from the run’s own ? polls');
    expect(lines[1]).toBe('# kept 2 of 2 polls — no thinning');
    expect(lines[2]).toBe('2026-11-10T08:00:00.000Z  Run  P:120,45,30  WPos:12.345,20.100,-0.500');
    expect(lines[3]).toBe('2026-11-10T08:00:02.000Z  Hold  P:120,45,30  WPos:12.345,20.100,-0.500');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('says which rule thinned the file when it did', () => {
    const log = createStatusLog(T0);
    log.push(sample(0));
    log.push(sample(300_000));
    log.push(sample(302_000));
    const lines = log.text({ jobName: 'A job', programIndex: 1, programTotal: 1 }).split('\n');
    expect(lines[1]).toContain('kept 2 of 3 polls');
    expect(lines[1]).toContain('thinned');
    expect(lines[1]).toContain('first 5 min');
    expect(lines[1]).toContain('10 s');
    expect(lines[1]).toContain('state change');
  });

  it('names the file after the program it belongs to', () => {
    expect(statusLogFileName('A-job.nc')).toBe('A-job-status.log');
    expect(statusLogFileName('A-job-p2.nc')).toBe('A-job-p2-status.log');
    expect(statusLogFileName('A-job-p02.nc')).toBe('A-job-p02-status.log');
    expect(statusLogFileName('A-job-face.nc')).toBe('A-job-face-status.log');
  });
});
