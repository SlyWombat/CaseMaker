// #775 — the USB serial check, UI side.
//
// The orchestration under test is the real one: only the port is faked, through the same loader
// seam `machineProbe.spec.ts` uses. What is pinned here is the honest shape the Manage pane draws:
// the model is never inferred from a link that does not announce it, a port that never opened is
// an error rather than a machine, and a page with no serial transport is not offered one.

import { describe, it, expect, afterEach } from 'vitest';

import {
  checkSerialPort,
  DEFAULT_SERIAL_BAUD,
  listSerialPorts,
  serialAvailable,
  setMachineSerialLoader,
  type MachineSerialClient,
} from '@/platform/machineSerial';

afterEach(() => {
  setMachineSerialLoader(null);
});

/** The defaults are a controller on a cable answering both asks, as a real one did in Studio's UI. */
function fakeClient(over: Partial<MachineSerialClient> = {}): MachineSerialClient {
  return {
    available: over.available ?? (async () => true),
    ports: over.ports ?? (async () => []),
    check:
      over.check ??
      (async () => ({
        identity: { ip: '192.168.10.43', mac: 'aa:bb:cc:dd:ee:ff' },
        status: { ok: true, text: '<Idle|MPos:0.000,0.000,0.000>' },
      })),
  };
}

function use(client: MachineSerialClient): void {
  setMachineSerialLoader(async () => client);
}

describe('#775 machine serial — the check', () => {
  it('asks the port with the chosen baud and reports what answered', async () => {
    const asked: Array<{ serialPort: string; baud?: number }> = [];
    use(
      fakeClient({
        check: async (target) => {
          asked.push(target);
          return {
            identity: { ip: '192.168.10.43', mac: 'aa:bb:cc:dd:ee:ff' },
            status: { ok: true, text: '<Idle|MPos:0.000,0.000,0.000>' },
          };
        },
      }),
    );

    const result = await checkSerialPort('  COM4  ');

    expect(asked).toEqual([{ serialPort: 'COM4', baud: DEFAULT_SERIAL_BAUD }]);
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.reach.portName).toBe('COM4');
    expect(result.reach.baud).toBe(DEFAULT_SERIAL_BAUD);
    expect(result.reach.ip).toBe('192.168.10.43');
    expect(result.reach.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(result.reach.status).toContain('Idle');
    expect(result.reach.statusLine?.state).toBe('Idle');
  });

  it('never claims a model: the link announces none, so the envelope stays unknown', async () => {
    use(fakeClient());
    const result = await checkSerialPort('COM4');
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.reach.notes.join(' ')).toMatch(/does not announce|announces/i);
    expect(result.reach.notes.join(' ')).toMatch(/envelope/i);
  });

  it('a status that did not answer is a note, not a failed check', async () => {
    use(fakeClient({ check: async () => ({ identity: { ip: null, mac: null }, status: null }) }));
    const result = await checkSerialPort('COM4');
    expect(result.kind).toBe('found');
    if (result.kind !== 'found') return;
    expect(result.reach.status).toBeNull();
    expect(result.reach.statusLine).toBeNull();
    expect(result.reach.notes.join(' ')).toMatch(/did not answer a status/i);
  });

  it('a port that did not open is an error with the port layer’s own reason', async () => {
    use(
      fakeClient({
        check: async () => {
          throw new Error('could not open COM9: Access is denied');
        },
      }),
    );
    const result = await checkSerialPort('COM9');
    expect(result).toEqual({ kind: 'error', detail: 'could not open COM9: Access is denied' });
  });

  it('no port chosen is refused before any loader is touched', async () => {
    let loads = 0;
    setMachineSerialLoader(async () => {
      loads += 1;
      return fakeClient();
    });
    const result = await checkSerialPort('   ');
    expect(result.kind).toBe('error');
    expect(loads).toBe(0);
  });

  it('a build with no bridge answers unavailable with the guard’s sentence', async () => {
    setMachineSerialLoader(async () => {
      throw new Error('Driving the machine requires the desktop build (BUILD_TARGET=desktop).');
    });
    const result = await checkSerialPort('COM4');
    expect(result.kind).toBe('unavailable');
    if (result.kind !== 'unavailable') return;
    expect(result.reason).toContain('desktop build');
  });
});

describe('#775 machine serial — what this page offers', () => {
  it('serialAvailable follows the client: false in a LAN browser, true in the webview', async () => {
    use(fakeClient({ available: async () => false }));
    expect(await serialAvailable()).toBe(false);

    use(fakeClient({ available: async () => true }));
    expect(await serialAvailable()).toBe(true);
  });

  it('an unloadable bridge is "no serial here", not an error to render', async () => {
    setMachineSerialLoader(async () => {
      throw new Error('web build');
    });
    expect(await serialAvailable()).toBe(false);
    expect(await listSerialPorts()).toEqual([]);
  });

  it('lists the ports the shell offers', async () => {
    use(fakeClient({ ports: async () => [{ portName: 'COM4', label: 'USB-SERIAL CH340', usb: true }] }));
    expect(await listSerialPorts()).toEqual([{ portName: 'COM4', label: 'USB-SERIAL CH340', usb: true }]);
  });
});
