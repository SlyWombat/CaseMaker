// #561 — the `?` status-frame parser, pinned. `readStatusLine` and `readJobProgress` are the one
// reader the status strip, the viewport and the registration runner all share, so their contract is
// a safety boundary: the homed-rest trap (MPos −1) and the "finished" rule live here so a refactor
// cannot quietly change either.

import { describe, expect, it } from 'vitest';
import { readJobProgress, readStatusLine } from '../../src/platform/desktop/protocol';

describe('#561 readJobProgress — the state word and the P: fields', () => {
  it('reads the state word verbatim from the leading word', () => {
    expect(readJobProgress('<Run|MPos:0,0,0|P:10,50,5>').state).toBe('Run');
    expect(readJobProgress('<Idle|MPos:0,0,0>').state).toBe('Idle');
    expect(readJobProgress('<Home|MPos:0,0,0>').state).toBe('Home');
    expect(readJobProgress('<Alarm|MPos:0,0,0>').state).toBe('Alarm');
  });

  it('parses line / percent / elapsed from P:', () => {
    expect(readJobProgress('<Run|P:412,22,108>')).toEqual({
      state: 'Run',
      line: 412,
      percent: 22,
      elapsedS: 108,
    });
  });

  it('leaves absent fields null — an idle line has no P:', () => {
    expect(readJobProgress('<Idle|MPos:0,0,0>')).toEqual({
      state: 'Idle',
      line: null,
      percent: null,
      elapsedS: null,
    });
  });

  it('ignores fields it does not know', () => {
    const p = readJobProgress('<Idle|Q:noise|P:1,2,3|Z:more>');
    expect(p).toEqual({ state: 'Idle', line: 1, percent: 2, elapsedS: 3 });
  });
});

describe('#561 readStatusLine — coordinates, and the homed-rest invariant', () => {
  it('reads MPos/WPos as plain coordinates', () => {
    const s = readStatusLine('<Idle|MPos:-1.000,-1.000,-1.000|WPos:180.2,183.1,55.2>');
    expect(s.mpos).toEqual({ x: -1, y: -1, z: -1, a: null, b: null });
    expect(s.wpos).toEqual({ x: 180.2, y: 183.1, z: 55.2, a: null, b: null });
  });

  // §B4 of the dialect: −1.0 is the Z1's POST-HOMING rest value, so `<Idle|MPos:-1,-1,-1|…>` is a
  // homed machine at rest — the parser must return the plain coordinates and no "unhomed" signal.
  // Homed-ness is derived from the $H action + the State word (as the run/laser/power stores do),
  // never from an MPos triple, and `MachineStatusLine` carries no homed flag at all.
  it('treats MPos −1 as a homed-at-rest coordinate, not an unhomed sentinel', () => {
    const s = readStatusLine('<Idle|MPos:-1.0,-1.0,-1.0>');
    expect(s.state).toBe('Idle');
    expect(s.mpos).toEqual({ x: -1, y: -1, z: -1, a: null, b: null });
    expect(s.mpos.z).toBe(-1); // −1, not null, not NaN — a reading, not a flag
  });

  it('leaves absent fields null — a probe poll has no T and no P', () => {
    const s = readStatusLine('<Run|MPos:0,0,0|WPos:0,0,0>');
    expect(s.tool).toBeNull();
    expect(s.feed).toEqual({ actual: null, set: null, override: null });
    expect(s.spindle).toEqual({ actual: null, set: null, override: null });
    expect(s.progress).toEqual({ state: 'Run', line: null, percent: null, elapsedS: null });
  });
});

describe('#561 the finished contract — percent 100 AND Idle', () => {
  // An `Idle` state word can appear mid-job (the M05 dwell); a job is finished only when BOTH the
  // percent is 100 and the state is Idle. There is no "finished" field — consumers combine the two —
  // so this pins the raw pair they must both read.
  it('is finished at percent 100 and Idle', () => {
    const s = readStatusLine('<Idle|MPos:-1,-1,-1|P:890,100,108>');
    expect(s.state).toBe('Idle');
    expect(s.progress.percent).toBe(100);
  });

  it('is NOT finished at Idle with a partial percent (the M05 dwell)', () => {
    const s = readStatusLine('<Idle|MPos:-1,-1,-1|P:412,50,108>');
    expect(s.state).toBe('Idle');
    expect(s.progress.percent).toBe(50);
  });

  it('is NOT finished at percent 100 while still Run', () => {
    const s = readStatusLine('<Run|MPos:-1,-1,-1|P:890,100,108>');
    expect(s.state).toBe('Run');
    expect(s.progress.percent).toBe(100);
  });
});
