/**
 * #424 — the Stop seam: it aborts only a running program, waits for Idle, then switches the vacuum off.
 * Only the socket is faked (`setMachineConsoleLoader`), as in machineVacuum.spec.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleSession } from '@/platform/machineConsole';
import { programRunning, stopProgram, STOP_IDLE_POLLS } from '@/platform/machineStop';

afterEach(() => setMachineConsoleLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };
const RUNNING = '<Run|MPos:-10.0000,-10.0000,-50.0000|P:120,42,61>';
const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';
const noSleep = async () => {};

function fake(answer: (line: string, n: number) => ConsoleSend) {
  const sent: string[] = [];
  const c = { closes: 0 };
  const session: MachineConsoleSession = {
    async send(line) {
      sent.push(line);
      return answer(line, sent.length);
    },
    async close() {
      c.closes += 1;
    },
  };
  setMachineConsoleLoader(async () => ({ open: async () => session }));
  return { sent, c };
}
const ok = (line: string, text: string): ConsoleSend => ({ ok: true, line, text, frames: 1, elapsedMs: 10 });

describe('#424 programRunning', () => {
  it('reads a P percent below 100 as running', () => {
    expect(programRunning(RUNNING)).toBe(true);
    expect(programRunning('<Idle|P:389,90,88>')).toBe(true);
    expect(programRunning('<Idle|P:389,100,88>')).toBe(false);
    expect(programRunning(IDLE)).toBe(false);
  });
});

describe('#424 stopProgram', () => {
  it('sends nothing to a machine with no program running', async () => {
    const f = fake((l) => ok(l, IDLE));
    const r = await stopProgram(TARGET, noSleep);
    expect(r.kind).toBe('not-running');
    expect(f.sent).toEqual(['?']);
    expect(f.c.closes).toBe(1);
  });

  it('refuses in an alarm', async () => {
    const f = fake((l) => ok(l, '<Alarm|MPos:0,0,0>\nALARM: Probe fail'));
    const r = await stopProgram(TARGET, noSleep);
    expect(r.kind).toBe('alarm');
    expect(f.sent).toEqual(['?']);
  });

  it('aborts, waits for Idle, then sends M332', async () => {
    let polls = 0;
    const f = fake((l) => {
      if (l === '?') {
        polls++;
        return ok(l, polls === 1 ? RUNNING : polls === 2 ? '<Run|P:121,43,62>' : IDLE);
      }
      return ok(l, 'ok');
    });
    const r = await stopProgram(TARGET, noSleep);
    expect(r).toMatchObject({ kind: 'stopped', vacuumOff: true });
    expect(f.sent).toEqual(['?', 'abort', '?', '?', 'M332']);
    expect(f.c.closes).toBe(1);
  });

  it('does not send M332 when Idle never comes back, and says the vacuum is on', async () => {
    const f = fake((l) => (l === '?' ? ok(l, RUNNING) : ok(l, 'ok')));
    const r = await stopProgram(TARGET, noSleep);
    expect(r.kind).toBe('draining');
    expect(f.sent).not.toContain('M332');
    expect(f.sent.filter((l) => l === '?')).toHaveLength(1 + STOP_IDLE_POLLS);
    if (r.kind === 'draining') expect(r.detail).toMatch(/vacuum is still on/);
  });

  it('treats an unanswered abort as sent and keeps polling', async () => {
    let polls = 0;
    const f = fake((l) => {
      if (l === 'abort') return { ok: false, line: l, reason: 'timeout', detail: 'no reply', text: '' } as ConsoleSend;
      if (l === '?') return ok(l, ++polls === 1 ? RUNNING : IDLE);
      return ok(l, 'ok');
    });
    const r = await stopProgram(TARGET, noSleep);
    expect(r.kind).toBe('stopped');
    expect(f.sent).toEqual(['?', 'abort', '?', 'M332']);
  });
});
