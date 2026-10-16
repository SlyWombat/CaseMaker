/** #431 — the laser frame: lift first, laser on, corners, laser off, home; the laser never left on. */

import { describe, it, expect, afterEach } from 'vitest';

import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleSession } from '@/platform/machineConsole';
import { laserFrameLines, runLaserFrame } from '@/platform/machineLaser';

afterEach(() => setMachineConsoleLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };
const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';
const B = { minX: 0, minY: 0, maxX: 36.5, maxY: 74.25 };

function fake(answer: (line: string) => ConsoleSend) {
  const sent: string[] = [];
  const session: MachineConsoleSession = {
    async send(line) {
      sent.push(line);
      return answer(line);
    },
    async close() {},
  };
  setMachineConsoleLoader(async () => ({ open: async () => session }));
  return sent;
}
const ok = (line: string, text = 'ok'): ConsoleSend => ({ ok: true, line, text, frames: 1, elapsedMs: 5 });

describe('#431 laserFrameLines', () => {
  it('lifts in machine coordinates, then visits the four corners and closes the loop', () => {
    expect(laserFrameLines(B)).toEqual([
      'G53 G0 Z-3',
      'G90',
      'G0 X0 Y0',
      'G0 X36.5 Y0',
      'G0 X36.5 Y74.25',
      'G0 X0 Y74.25',
      'G0 X0 Y0',
    ]);
  });
});

describe('#431 runLaserFrame', () => {
  it('runs lift, laser on, the corners, laser off, then homes', async () => {
    const sent = fake((l) => (l === '?' ? ok(l, IDLE) : ok(l)));
    const r = await runLaserFrame(TARGET, B);
    expect(r).toEqual({ kind: 'framed', homed: true });
    expect(sent[0]).toBe('?');
    expect(sent[1]).toBe('G53 G0 Z-3');
    expect(sent[2]).toBe('M831');
    expect(sent.slice(-2)).toEqual(['M832', '$H']);
  });

  it('refuses a running machine and sends nothing else', async () => {
    const sent = fake((l) => ok(l, '<Run|P:10,20,30>'));
    expect((await runLaserFrame(TARGET, B)).kind).toBe('busy');
    expect(sent).toEqual(['?']);
  });

  it('switches the laser off when a move fails mid-frame', async () => {
    const sent = fake((l) =>
      l === '?' ? ok(l, IDLE) : l === 'G0 X36.5 Y0' ? { ok: false, line: l, reason: 'timeout', detail: 'no reply', text: '' } : ok(l),
    );
    const r = await runLaserFrame(TARGET, B);
    expect(r).toMatchObject({ kind: 'failed', laserOff: true });
    expect(sent.at(-1)).toBe('M832');
    expect(sent).not.toContain('$H');
  });
});

describe('#431 the options default off, and the frame reads the program extent', () => {
  it('ships both laser options off', async () => {
    const { SETTINGS_DEFAULTS } = await import('@/store/settingsStore');
    expect(SETTINGS_DEFAULTS.laserOptions).toEqual({ frame: false, pointToOrigin: false });
  });

  it('frameBounds takes XY from the verify bbox and refuses an empty one', async () => {
    const { frameBounds } = await import('@/platform/machineLaser');
    expect(frameBounds({ min: [1, 2, -1], max: [30, 40, 5] })).toEqual({ minX: 1, minY: 2, maxX: 30, maxY: 40 });
    expect(frameBounds({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] })).toBeNull();
  });
});

describe('#431 slice 2 — laser point-to-origin', () => {
  const AT = '<Idle|MPos:-120.5000,-130.2500,-3.0000|Bf:14,128>';
  const sessionWith = async (answer: (l: string) => ConsoleSend = (l) => (l === '?' ? ok(l, AT) : ok(l))) => {
    const { LaserPointSession } = await import('@/platform/machineLaser');
    const sent = fake(answer);
    return { s: new LaserPointSession(TARGET), sent };
  };

  it('starts only on an idle machine: status, then the lift, then the laser', async () => {
    const { s, sent } = await sessionWith();
    expect(await s.begin()).toMatchObject({ ok: true });
    expect(sent).toEqual(['?', 'G53 G0 Z-3', 'M831']);
    for (const status of ['<Run|P:10,20,30>', '<Alarm|MPos:0,0,0>\nALARM: Hard limit']) {
      const b = await sessionWith((l) => ok(l, status));
      expect((await b.s.begin()).ok).toBe(false);
      expect(b.sent).toEqual(['?']); // nothing moved, no laser, no home
    }
  });

  it('a lift that fails never switches the laser on', async () => {
    const { s, sent } = await sessionWith((l) => (l === '?' ? ok(l, AT) : l.startsWith('G53') ? { ok: false, line: l, reason: 'timeout', detail: 'no reply', text: '' } : ok(l)));
    expect((await s.begin()).ok).toBe(false);
    expect(sent).not.toContain('M831');
  });

  it('jogs X or Y one relative line at a time, straight back to absolute; never Z, only the offered steps, only after the lift', async () => {
    const { s, sent } = await sessionWith();
    expect((await s.jog('X', 1)).ok).toBe(false); // before begin
    expect(sent).toEqual([]);
    await s.begin();
    expect((await s.jog('X', 10)).ok).toBe(true);
    expect((await s.jog('Y', -0.1)).ok).toBe(true);
    expect((await s.jog('X', 5)).ok).toBe(false);
    expect(sent.slice(3)).toEqual(['G91', 'G0 X10', 'G90', 'G91', 'G0 Y-0.1', 'G90']);
    expect(sent.filter((l) => /^G0 .*Z/.test(l))).toEqual([]);
  });

  it('a jog that fails switches the laser off and moves nothing — the home is owed, not sent', async () => {
    const { s, sent } = await sessionWith((l) => (l === '?' ? ok(l, AT) : l === 'G0 X1' ? { ok: false, line: l, reason: 'timeout', detail: 'no reply', text: '' } : ok(l)));
    await s.begin();
    const r = await s.jog('X', 1);
    expect(r).toMatchObject({ ok: false, homeOwed: true, detail: expect.stringContaining('The laser is off. Home the machine before the next step') });
    expect(sent.slice(-2)).toEqual(['G90', 'M832']);
    expect(sent).not.toContain('$H');
    expect(s.active).toBe(false);
  });

  it('writes X and Y — never Z — from the machine position, only after confirmation and only when Idle', async () => {
    const { s, sent } = await sessionWith();
    await s.begin();
    expect(await s.set(false)).toMatchObject({ ok: false });
    expect(sent.some((l) => l.startsWith('G10'))).toBe(false);
    const r = await s.set(true);
    expect(r).toMatchObject({ ok: true, x: -120.5, y: -130.25 });
    expect(sent.at(-1)).toBe('G10 L2 P1 X-120.500 Y-130.250');
    const busy = await sessionWith((l) => (l === '?' && busyCount++ > 0 ? ok(l, '<Run|MPos:1,2,3>') : l === '?' ? ok(l, AT) : ok(l)));
    let busyCount = 0;
    await busy.s.begin();
    expect(await busy.s.set(true)).toMatchObject({ ok: false, detail: expect.stringContaining('not Idle') });
    expect(busy.sent.some((l) => l.startsWith('G10'))).toBe(false);
  });

  it('ends with the laser off; it homes only when asked (Finish, Set) — once, however often it is called', async () => {
    const { s, sent } = await sessionWith();
    await s.begin();
    expect(await s.end({ home: true })).toEqual({ laserOff: true, homed: true, lifted: true });
    await s.end({ home: true });
    expect(sent.slice(3)).toEqual(['M832', '$H']);
    const quiet = await sessionWith();
    await quiet.s.begin();
    expect(await quiet.s.end({ home: false })).toEqual({ laserOff: true, homed: false, lifted: true });
    expect(quiet.sent.slice(3)).toEqual(['M832']);
  });

  it('is refused for a job whose margin is tighter than the dot', async () => {
    const { pointToOriginAllowed, machinePosition } = await import('@/platform/machineLaser');
    expect(pointToOriginAllowed(0.5, 1)).toMatchObject({ ok: false, reason: expect.stringContaining('tighter than the laser dot') });
    expect(pointToOriginAllowed(1, 1)).toEqual({ ok: true });
    expect(machinePosition(AT)).toEqual({ x: -120.5, y: -130.25, z: -3 });
    expect(machinePosition('<Idle>')).toBeNull();
  });
});
