// @vitest-environment jsdom
// #775 — the USB serial pane in Manage → Machines.
//
// WHERE IT DRAWS is the feature's desktop-only rule: nothing in a build without a machine bridge,
// and nothing in a LAN browser served by the desktop build (its HTTP transport has no serial
// calls). The check's own orchestration is `machineSerial`'s, tested there; this file pins the
// pane's presence, the port it offers, and that what comes back is shown without inventing a model.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MachinesScope } from '@/components/manage/MachinesScope';
import { resetMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setMachineSerialLoader,
  type MachineSerialClient,
  type SerialPortChoice,
} from '@/platform/machineSerial';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const caps = vi.hoisted(() => ({ drive: false }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canDriveMachine() {
      return caps.drive;
    },
  };
});

const PORTS: SerialPortChoice[] = [
  { portName: 'COM4', label: 'USB-SERIAL CH340', usb: true },
  { portName: 'COM7', label: '', usb: false },
];

function fakeSerial(over: Partial<MachineSerialClient> = {}): MachineSerialClient {
  return {
    available: over.available ?? (async () => true),
    ports: over.ports ?? (async () => PORTS),
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

beforeEach(() => {
  cleanup();
  caps.drive = false;
  resetMachineStore();
  useSettingsStore.setState({ machineCalibration: undefined });
  setMachineSerialLoader(null);
});

describe('#775 the USB serial pane — where it is', () => {
  it('a build that cannot drive a machine draws no serial pane', async () => {
    caps.drive = false;
    use(fakeSerial());
    render(<MachinesScope />);
    await waitFor(() => expect(screen.queryByTestId('manage-serial')).toBeNull());
  });

  it('a page with no serial transport (a LAN browser) is not offered one', async () => {
    caps.drive = true;
    use(fakeSerial({ available: async () => false }));
    render(<MachinesScope />);
    await waitFor(() => expect(screen.queryByTestId('manage-serial')).toBeNull());
  });

  it('the desktop webview lists the ports it can open', async () => {
    caps.drive = true;
    use(fakeSerial());
    render(<MachinesScope />);
    const pane = await screen.findByTestId('manage-serial');
    expect(pane.textContent).toContain('USB serial');
    const select = screen.getByTestId('manage-serial-port') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['COM4', 'COM7']);
    expect(select.options[0]!.textContent).toContain('USB-SERIAL CH340');
  });
});

describe('#775 the USB serial pane — the check', () => {
  beforeEach(() => {
    caps.drive = true;
  });

  it('opens the chosen port and shows what answered, with the model not claimed', async () => {
    const opened: Array<{ serialPort: string; baud?: number }> = [];
    use(
      fakeSerial({
        check: async (target) => {
          opened.push(target);
          return {
            identity: { ip: '192.168.10.43', mac: 'aa:bb:cc:dd:ee:ff' },
            status: { ok: true, text: '<Idle|MPos:0.000,0.000,0.000>' },
          };
        },
      }),
    );
    render(<MachinesScope />);
    await screen.findByTestId('manage-serial');

    fireEvent.change(screen.getByTestId('manage-serial-port'), { target: { value: 'COM7' } });
    fireEvent.click(screen.getByTestId('manage-serial-connect'));

    const result = await screen.findByTestId('manage-serial-result');
    expect(opened).toEqual([{ serialPort: 'COM7', baud: 115_200 }]);
    expect(result.textContent).toContain('COM7');
    expect(result.textContent).toContain('192.168.10.43');
    expect(screen.getByTestId('manage-serial-notes').textContent).toMatch(/envelope/i);
    // The one thing the pane must not leave a reader to assume: jobs are still network-only.
    expect(screen.getByTestId('manage-serial-upload-note').textContent).toMatch(/not wired/i);
  });

  it('a port that did not open says so, in the port layer’s words', async () => {
    use(
      fakeSerial({
        check: async () => {
          throw new Error('could not open COM4: Access is denied');
        },
      }),
    );
    render(<MachinesScope />);
    await screen.findByTestId('manage-serial');
    // COM4 is the first port, so it is the one selected and the one the fake refuses.
    fireEvent.click(screen.getByTestId('manage-serial-connect'));

    const error = await screen.findByTestId('manage-serial-error');
    expect(error.textContent).toContain('Access is denied');
  });
});
