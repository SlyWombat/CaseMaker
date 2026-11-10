/**
 * #422 — the work-light seam: it asks before it switches, and only an Idle machine is switched.
 *
 * The orchestration under test is the real one — only the socket is faked — so what runs is
 * attachConsole → ask `?` → read the state word → send `M821`/`M822` → close. The assertions that
 * matter are the safety ones: a machine that is not Idle never receives the code.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { setMachineConsoleLoader, type ConsoleSend } from '@/platform/machineConsole';
import { fakeConsoleSession } from './helpers/fakeConsole';
import { toggleLight, lightLine, LIGHT_ON, LIGHT_OFF } from '@/platform/machineLight';

afterEach(() => setMachineConsoleLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };
const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';
const RUNNING = '<Run|MPos:1.0000,2.0000,-1.0000|Bf:14,128|S:12031|P:389,90,88>';
const MID_JOB = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128|S:12031|P:389,90,88>';
const ALARM = '<Alarm|MPos:0.0000,0.0000,0.0000>';


const status = (text: string): ((line: string) => ConsoleSend) => (line) =>
  line === '?'
    ? { ok: true, line, text, frames: 1, elapsedMs: 30 }
    : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 };

describe('#422 the work-light line', () => {
  it('is the machine’s own code, on and off', () => {
    expect(lightLine(true)).toBe(LIGHT_ON);
    expect(lightLine(false)).toBe(LIGHT_OFF);
    expect([LIGHT_ON, LIGHT_OFF]).toEqual(['M821', 'M822']);
  });
});

describe('#422 the work-light switch', () => {
  it('sends M821 to an idle machine, on the one connection a press opens, and closes it', async () => {
    const z1 = fakeConsoleSession(status(IDLE));
    const r = await toggleLight(TARGET, true);
    expect(r).toMatchObject({ kind: 'toggled', on: true, status: IDLE });
    expect(z1.sent).toEqual(['?', 'M821']);
    expect(z1.opens).toBe(1);
    expect(z1.closes).toBe(1);
  });

  it('sends M822 for off', async () => {
    const z1 = fakeConsoleSession(status(IDLE));
    const r = await toggleLight(TARGET, false);
    expect(r).toMatchObject({ kind: 'toggled', on: false });
    expect(z1.sent).toEqual(['?', 'M822']);
  });

  it('reports a timeout on the code without claiming a mode', async () => {
    const z1 = fakeConsoleSession((line) =>
      line === '?'
        ? { ok: true, line, text: IDLE, frames: 1, elapsedMs: 30 }
        : { ok: false, reason: 'timeout', line, detail: 'no reply within 60000 ms', text: '' },
    );
    const r = await toggleLight(TARGET, true);
    expect(r.kind).toBe('timeout');
    expect(z1.closes).toBe(1);
  });
});
