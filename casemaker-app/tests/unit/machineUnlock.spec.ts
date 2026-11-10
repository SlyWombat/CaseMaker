/**
 * #644 — the alarm unlock: `$X` goes out ONLY to a machine whose status line reads Alarm, and the
 * answer reported is what the machine says AFTERWARDS, not that the code was accepted.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { setMachineConsoleLoader, type ConsoleSend } from '@/platform/machineConsole';
import { fakeConsoleSession } from './helpers/fakeConsole';
import { readsAlarm, unlockMachine, UNLOCK } from '@/platform/machineUnlock';

afterEach(() => setMachineConsoleLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };
const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';
const ALARM = '<Alarm|MPos:0.0000,0.0000,0.0000>';


const reply = (text: string): ConsoleSend => ({ ok: true, line: '', text, frames: 1, elapsedMs: 10 });

/** `?` answers `first` the first time and `after` the second; everything else is `ok`. */
const alarmedThen = (after: string) => (line: string, n: number): ConsoleSend => {
  if (line !== '?') return reply('ok');
  const first = sentOnce(n);
  return reply(first ? ALARM : after);
};
// The first `?` of the press is sent[0], the second is sent[2] (the `$X` between them).
const sentOnce = (n: number): boolean => n <= 1;

describe('#644 readsAlarm', () => {
  it('is the state word or an alarm line anywhere in the reply', () => {
    expect(readsAlarm(ALARM)).toBe(true);
    expect(readsAlarm(IDLE)).toBe(false);
    expect(readsAlarm('ALARM: Probe fail')).toBe(true);
    expect(readsAlarm(null)).toBe(false);
  });
});

describe('#644 the alarm unlock', () => {
  it('sends $X to an alarmed machine and reports it cleared when the state word is no longer Alarm', async () => {
    const z1 = fakeConsoleSession(alarmedThen(IDLE));
    const r = await unlockMachine(TARGET);
    expect(r).toMatchObject({ kind: 'cleared' });
    expect(z1.sent).toEqual(['?', UNLOCK, '?']);
    expect(z1.opens).toBe(1);
    expect(z1.closes).toBe(1);
  });

  it('says it is STILL alarmed when $X is accepted but the machine re-arms', async () => {
    const z1 = fakeConsoleSession(alarmedThen(ALARM));
    const r = await unlockMachine(TARGET);
    expect(r.kind).toBe('still-alarmed');
    expect(z1.sent).toEqual(['?', UNLOCK, '?']);
  });

  it('sends nothing to a machine that is not alarmed', async () => {
    const z1 = fakeConsoleSession((line) => reply(line === '?' ? IDLE : 'ok'));
    const r = await unlockMachine(TARGET);
    expect(r.kind).toBe('not-alarmed');
    expect(z1.sent).toEqual(['?']);
    expect(z1.closes).toBe(1);
  });

  it('sends nothing to an unreadable status line', async () => {
    const z1 = fakeConsoleSession((line) => reply(line === '?' ? '???' : 'ok'));
    const r = await unlockMachine(TARGET);
    expect(r.kind).toBe('not-alarmed');
    expect(z1.sent).toEqual(['?']);
  });

  it('reports a socket failure on the unlock rather than claiming a cleared alarm', async () => {
    const z1 = fakeConsoleSession((line, n) =>
      line === '?'
        ? reply(ALARM)
        : n === 2
          ? { ok: false, reason: 'timeout', line, detail: 'no reply within 60000 ms', text: '' }
          : reply(IDLE),
    );
    const r = await unlockMachine(TARGET);
    expect(r.kind).toBe('timeout');
    expect(z1.closes).toBe(1);
  });
});
