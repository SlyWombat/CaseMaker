import { describe, it, expect, afterEach } from 'vitest';

import {
  DEFAULT_COMMAND_PORT,
  probeMachine,
  profileForDiscoveredName,
  setMachineProbeLoader,
  type ConfigReadSummary,
  type MachineProbeClient,
} from '@/platform/machineProbe';
import { COMMAND_TCP_PORT } from '@/platform/desktop/protocol';
import { CALIBRATION_KEYS } from '@/engine/cnc/calibration';
import { Z1_FRAME_REPLIES } from './fixtures/z1Frame';

/**
 * Issue #280 — the machine check.
 *
 * The orchestration under test is the real one: only the socket is faked (the same seam shape
 * `setRasterDecodeLoader` uses), so what runs here is the search → identify → status → resolve path
 * the app runs. The two assertions that matter most are the honest ones: an unknown machine gets
 * no numbers, and "no machine" is an outcome rather than an error.
 */

afterEach(() => setMachineProbeLoader(null));

/**
 * A client that answers exactly as scripted, so each outcome can be reached deliberately.
 *
 * The defaults are what a Z1 on a bench does when nothing is scripted: it announces itself, answers
 * the identify and status asks, and — since #279 — answers its own configuration with the frame it
 * actually carries ({@link Z1_FRAME_REPLIES}, read off the bench machine 2026-10-06). A fake that
 * could not answer a config read would put a note on every `found` this file produces, which is a
 * machine behaving worse than every real one.
 */
function fakeClient(over: Partial<MachineProbeClient> = {}): MachineProbeClient {
  return {
    discover: over.discover ?? (async () => []),
    identify: over.identify ?? (async () => ({ ip: '192.168.10.43', mac: 'aa:bb:cc:dd:ee:ff' })),
    status: over.status ?? (async () => ({ ok: true, text: 'Idle' })),
    readConfig: over.readConfig ?? (async (_target, keys) => answersFor(keys)),
  };
}

/** The bench machine's answers for `keys`; anything the transcript does not carry is a refusal. */
function answersFor(keys: readonly string[]): ConfigReadSummary {
  const values = new Map<string, string>();
  const failures: ConfigReadSummary['failures'] = [];
  for (const key of keys) {
    const value = Z1_FRAME_REPLIES[key];
    if (value !== undefined) values.set(key, value);
    else failures.push({ key, reason: 'not-in-config', detail: 'no answer for this key' });
  }
  return { values, failures };
}

function use(client: MachineProbeClient): void {
  setMachineProbeLoader(async () => client);
}

describe('#280 — profileForDiscoveredName', () => {
  it('resolves the name a Z1 actually broadcasts', () => {
    // Observed on hardware 2026-10-06 (`Z1-Bridge-Protocol.md` §1) — NOT the `Makera Z1` of
    // Makera's own `.fcm` template, which is why the table keys on the wire name.
    expect(profileForDiscoveredName('Makera_Z1_010290')).toBe('Z1');
    expect(profileForDiscoveredName('makera_z1_2222')).toBe('Z1');
  });

  it('resolves anything it does not know to NULL, never to the Z1', () => {
    expect(profileForDiscoveredName('Carvera_Air_0001')).toBeNull();
    expect(profileForDiscoveredName('makera_carvera_1')).toBeNull();
    expect(profileForDiscoveredName('')).toBeNull();
    expect(profileForDiscoveredName('   ')).toBeNull();
  });
});

describe('#280 — DEFAULT_COMMAND_PORT cannot drift from the protocol', () => {
  it('matches COMMAND_TCP_PORT', () => {
    // Restated in the probe rather than imported (protocol.ts is desktop-only and would leak into
    // the web bundle), so this is the check that keeps the restatement honest.
    expect(DEFAULT_COMMAND_PORT).toBe(COMMAND_TCP_PORT);
  });
});

describe('#280 — probeMachine', () => {
  it('reports a machine and everything it said about itself', async () => {
    use(
      fakeClient({
        discover: async () => [{ name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false }],
      }),
    );
    const result = await probeMachine();
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    const o = result.observation;
    expect(o.name).toBe('Makera_Z1_010290');
    expect(o.host).toBe('192.168.10.43');
    expect(o.port).toBe(2222);
    expect(o.busy).toBe(false);
    expect(o.ip).toBe('192.168.10.43');
    expect(o.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(o.status).toBe('Idle');
    expect(o.profileId).toBe('Z1');
    expect(o.notes).toEqual([]);
    expect(Number.isNaN(Date.parse(o.observedAt))).toBe(false);
  });

  it('reports an unrecognised machine with NO profile and says so', async () => {
    use(
      fakeClient({
        discover: async () => [{ name: 'SomeLaser_9000', host: '10.0.0.5', port: 2222, busy: true }],
      }),
    );
    const result = await probeMachine();
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.observation.profileId).toBeNull();
    expect(result.observation.busy).toBe(true);
    // Nothing failed, so there is nothing to note: it is simply a machine nothing here can
    // describe. The sentence saying so is the panel's (see the wizard spec, which pins that it
    // appears once) — a note here printed it a second time in different words.
    expect(result.observation.notes).toEqual([]);
  });

  it('is not-found when nothing answers the search', async () => {
    use(fakeClient({}));
    expect((await probeMachine()).kind).toBe('not-found');
  });

  it('is error when the search itself throws, and keeps the detail', async () => {
    use(
      fakeClient({
        discover: async () => {
          throw new Error('udp: bind failed');
        },
      }),
    );
    const result = await probeMachine();
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.detail).toContain('udp: bind failed');
  });

  it('is unavailable, with the guard’s own reason, when this build has no bridge', async () => {
    // Exactly what the web build does: `loadMachineBridge()` throws inside the guard.
    setMachineProbeLoader(async () => {
      throw new Error('Driving the machine requires the desktop build (BUILD_TARGET=desktop).');
    });
    const result = await probeMachine();
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toContain('desktop build');
  });

  it('a machine that answered its broadcast but not the socket is still found', async () => {
    use(
      fakeClient({
        discover: async () => [{ name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false }],
        identify: async () => {
          throw new Error('connect timeout');
        },
        status: async () => {
          throw new Error('connect timeout');
        },
      }),
    );
    const result = await probeMachine();
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.observation.ip).toBeNull();
    expect(result.observation.status).toBeNull();
    expect(result.observation.profileId).toBe('Z1');
    expect(result.observation.notes.length).toBe(2);
  });

  it('a typed address skips the search and admits it knows no model', async () => {
    let discovered = false;
    use(
      fakeClient({
        discover: async () => {
          discovered = true;
          return [];
        },
      }),
    );
    const result = await probeMachine({ host: ' 10.0.0.7 ' });
    expect(discovered, 'the search is skipped for a typed address').toBe(false);
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.observation.host).toBe('10.0.0.7');
    expect(result.observation.port).toBe(DEFAULT_COMMAND_PORT);
    expect(result.observation.name).toBeNull();
    expect(result.observation.busy).toBeNull();
    expect(result.observation.profileId).toBeNull();
    expect(result.observation.notes.join(' ')).toMatch(/typed rather than announced/i);
  });

  it('an empty typed address is refused rather than searched', async () => {
    use(fakeClient({}));
    const result = await probeMachine({ host: '   ' });
    expect(result.kind).toBe('error');
  });
});

describe('#279 — the machine is asked what its own frame is set to', () => {
  it('reads the frame off a machine we know, and keeps the numbers it gave', async () => {
    use(
      fakeClient({
        discover: async () => [{ name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false }],
      }),
    );
    const result = await probeMachine();
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    // The frame the BENCH machine carries, not the vendor's `configZ1.default`: anchor1 is 1.51 mm
    // away from the shipped profile on X, which is the entire reason #279 exists.
    expect(result.calibration?.machineId).toBe('Z1');
    expect(result.calibration?.frame.anchor1).toEqual([-190.89, -193.83]);
    expect(result.calibration?.source).toBe('config-get sd on 192.168.10.43');
    expect(result.calibration?.measuredAt).toBe(result.observation.observedAt);
    // A read that completed is not a thing that could not be established, so it is not a note.
    expect(result.observation.notes).toEqual([]);
  });

  it('does NOT ask a machine it does not know, and hands back no frame', async () => {
    let asked = false;
    use(
      fakeClient({
        discover: async () => [{ name: 'SomeLaser_9000', host: '10.0.0.5', port: 2222, busy: true }],
        readConfig: async () => {
          asked = true;
          return { values: new Map(), failures: [] };
        },
      }),
    );
    const result = await probeMachine();
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    // `coordinate.anchor1_x` is a Z1's key. Asking a second vendor's controller for it would be the
    // "assume it is a Z1" guess `profileForDiscoveredName` exists to refuse.
    expect(asked, 'an unknown machine is never asked for a Z1 frame').toBe(false);
    expect(result.calibration).toBeNull();
    expect(result.observation.notes).toEqual([]);
  });

  it('applies nothing when the read came back incomplete, and names the keys', async () => {
    use(
      fakeClient({
        discover: async () => [{ name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false }],
        // The controller said it does not carry `toolrack_z` — one key short of a whole frame.
        readConfig: async (_target, keys) => {
          const answers = answersFor(keys);
          answers.values.delete(CALIBRATION_KEYS.toolrackZ);
          answers.failures.push({ key: CALIBRATION_KEYS.toolrackZ, reason: 'not-in-config', detail: '' });
          return answers;
        },
      }),
    );
    const result = await probeMachine();
    if (result.kind !== 'found') throw new Error('the machine answered its broadcast');
    expect(result.calibration).toBeNull();
    const note = result.observation.notes.join(' ');
    expect(note).toContain(CALIBRATION_KEYS.toolrackZ);
    expect(note).toMatch(/nothing was applied/i);
  });

  it('a read that threw is a note, not a failed check', async () => {
    use(
      fakeClient({
        discover: async () => [{ name: 'Makera_Z1_010290', host: '192.168.10.43', port: 2222, busy: false }],
        readConfig: async () => {
          throw new Error('connect timeout');
        },
      }),
    );
    const result = await probeMachine();
    if (result.kind !== 'found') throw new Error('the machine answered its broadcast');
    expect(result.calibration).toBeNull();
    expect(result.observation.notes.join(' ')).toMatch(/coordinate frame could not be read/i);
  });
});
