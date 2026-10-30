// #289 — the machine's other accessory modes: spindle fan, power fan, external output and the
// wireless-probe charge. The codes are the Z1 firmware's own (`configZ1.default`'s switch
// instances), and the orchestration under test is the real one — only the socket is faked — so what
// runs is the same ask `?` → Idle check → code → close the work light has. The assertions that
// matter are the safety ones: a machine that is not Idle receives NO accessory code.

import { describe, it, expect, afterEach } from 'vitest';

import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleSession } from '@/platform/machineConsole';
import {
  ACCESSORIES,
  AIR_SENTENCE,
  accessory,
  accessoryLine,
  toggleAccessory,
  type AccessoryId,
} from '@/platform/machineAccessory';

afterEach(() => setMachineConsoleLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };
const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';
const RUNNING = '<Run|MPos:1.0000,2.0000,-1.0000|Bf:14,128|S:12031|P:389,90,88>';
const MID_JOB = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128|S:12031|P:389,90,88>';
const ALARM = '<Alarm|MPos:0.0000,0.0000,0.0000>';

function fakeSession(answer: (line: string) => ConsoleSend) {
  const sent: string[] = [];
  const counters = { closes: 0, opens: 0 };
  const session: MachineConsoleSession = {
    async send(line) {
      sent.push(line);
      return answer(line);
    },
    async close() {
      counters.closes += 1;
    },
  };
  setMachineConsoleLoader(async () => ({
    async open() {
      counters.opens += 1;
      return session;
    },
  }));
  return {
    sent,
    get closes() {
      return counters.closes;
    },
    get opens() {
      return counters.opens;
    },
  };
}

const status = (text: string): ((line: string) => ConsoleSend) => (line) =>
  line === '?'
    ? { ok: true, line, text, frames: 1, elapsedMs: 30 }
    : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 };

describe('#289 the Z1’s accessory codes', () => {
  it('are the firmware’s own switch instances, on and off', () => {
    // configZ1.default: switch.<name>.input_on_command / input_off_command.
    expect(ACCESSORIES.map((a) => [a.id, a.vendorKey, a.on, a.off])).toEqual([
      ['spindle-fan', 'switch.spindlefan', 'M811', 'M812'],
      ['power-fan', 'switch.powerfan', 'M801', 'M802'],
      ['external-output', 'switch.extendout', 'M851', 'M852'],
      ['wp-charge', 'switch.probecharger', 'M841', 'M842'],
    ]);
  });

  it('states a line per state, from one table', () => {
    for (const spec of ACCESSORIES) {
      expect(accessoryLine(spec.id, true)).toBe(spec.on);
      expect(accessoryLine(spec.id, false)).toBe(spec.off);
      expect(accessory(spec.id).name).toBe(spec.name);
    }
  });

  it('offers no air switch, and says why: M7/M9 blow nothing, switch.air is commented out', () => {
    expect(AIR_SENTENCE).toContain('No air switch');
    expect(AIR_SENTENCE).toContain('M7/M9');
    expect(AIR_SENTENCE).toContain('switch.air');
    expect(AIR_SENTENCE).toContain('M331.1');
    expect(ACCESSORIES.map((a) => a.id)).not.toContain('air');
  });

  it('names the temperature control in both fans’ hints — a press is not a latch', () => {
    expect(accessory('spindle-fan').meaning).toContain('temperature control');
    expect(accessory('power-fan').meaning).toContain('temperature control');
    // The configured on values, from configZ1.default's default_on_value.
    expect(accessory('spindle-fan').meaning).toContain('50 %');
    expect(accessory('power-fan').meaning).toContain('30 %');
  });
});

describe('#289 the accessory press', () => {
  it('switches each accessory on an idle machine on one connection, and closes it', async () => {
    for (const spec of ACCESSORIES as readonly { id: AccessoryId; on: string; off: string }[]) {
      const z1 = fakeSession(status(IDLE));
      const r = await toggleAccessory(TARGET, spec.id, true);
      expect(r).toMatchObject({ kind: 'toggled', id: spec.id, on: true });
      expect(z1.sent).toEqual(['?', spec.on]);
      expect(z1.opens).toBe(1);
      expect(z1.closes).toBe(1);
    }
  });

  it('sends the off code for the off half', async () => {
    const z1 = fakeSession(status(IDLE));
    const r = await toggleAccessory(TARGET, 'wp-charge', false);
    expect(r).toMatchObject({ kind: 'toggled', id: 'wp-charge', on: false });
    expect(z1.sent).toEqual(['?', 'M842']);
  });

  it('refuses a running machine without sending any accessory code', async () => {
    const z1 = fakeSession(status(RUNNING));
    const r = await toggleAccessory(TARGET, 'spindle-fan', true);
    expect(r.kind).toBe('busy');
    expect(r.kind === 'busy' && r.detail).toContain('Run');
    expect(z1.sent).toEqual(['?']);
    expect(z1.closes).toBe(1);
  });

  it('refuses an idle machine whose program has not finished', async () => {
    const z1 = fakeSession(status(MID_JOB));
    const r = await toggleAccessory(TARGET, 'power-fan', true);
    expect(r.kind).toBe('busy');
    expect(r.kind === 'busy' && r.detail).toContain('90%');
    expect(z1.sent).toEqual(['?']);
  });

  it('refuses an alarm without sending anything', async () => {
    const z1 = fakeSession(status(ALARM));
    const r = await toggleAccessory(TARGET, 'external-output', true);
    expect(r.kind).toBe('busy');
    expect(r.kind === 'busy' && r.detail).toContain('alarm');
    expect(z1.sent).toEqual(['?']);
  });

  it('refuses an unreadable status line before switching', async () => {
    const z1 = fakeSession(status('not a status line'));
    const r = await toggleAccessory(TARGET, 'wp-charge', true);
    expect(r.kind).toBe('error');
    expect(z1.sent).toEqual(['?']);
  });
});
