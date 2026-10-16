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
