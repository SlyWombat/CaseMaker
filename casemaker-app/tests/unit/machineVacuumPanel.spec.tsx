// @vitest-environment jsdom
// #390 — the vacuum switch on the machine card in Manage → Machines.
//
// THE SEAM IS THE CLIENT. `setMachineConsoleLoader` swaps the socket half for a fake, so the panel's
// real ask `?` → read the state → send `M331`/`M332` path runs in every test. What this pins is what
// the browser QA cannot see: the switch is absent where it could not work, it claims only what it
// last sent and `unknown` before that, a press on a running machine is refused without a code, and a
// press that lost the link goes back to `unknown`.
//
// THE CAPABILITY IS A GETTER (the `manageMode.spec.tsx` seam), so the desktop half can be turned on
// for one test without rebuilding for the other target.

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MachinesScope } from '@/components/manage/MachinesScope';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleSession } from '@/platform/machineConsole';

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

/** A controller that answered once — what the card draws its controls under. */
const Z1_RECORD = {
  name: 'Z1',
  host: '192.168.10.43',
  port: 2222,
  busy: false,
  ip: '192.168.10.43',
  mac: 'AA:BB:CC:DD:EE:FF',
  status: '<Idle|MPos:0.000,0.000,0.000|Bf:14,128>',
  profileId: 'Z1',
  observedAt: '2026-10-09T06:00:00.000Z',
  notes: [],
};

const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';

/** Install a console client that answers as scripted, and count what reached it. */
function fakeConsole(answer: (line: string) => ConsoleSend) {
  let loads = 0;
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
  setMachineConsoleLoader(async () => {
    loads += 1;
    return {
      async open() {
        counters.opens += 1;
        return session;
      },
    };
  });
  return {
    sent,
    loads: () => loads,
    get closes() {
      return counters.closes;
    },
    get opens() {
      return counters.opens;
    },
  };
}

const idleMachine: (line: string) => ConsoleSend = (line) =>
  line === '?'
    ? { ok: true, line, text: IDLE, frames: 1, elapsedMs: 30 }
    : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 };

const runningMachine: (line: string) => ConsoleSend = (line) =>
  line === '?'
    ? { ok: true, line, text: '<Run|MPos:0,0,0|P:34,42,17>', frames: 1, elapsedMs: 30 }
    : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 };

function withMachine(): void {
  useMachineStore.setState({
    machine: Z1_RECORD,
    outcome: 'found',
    reason: null,
    checkedAt: '2026-10-09T06:00:00.000Z',
  });
}

beforeEach(() => {
  cleanup();
  caps.drive = false;
  resetMachineStore();
  useSettingsStore.setState({ machineCalibration: undefined });
});

afterEach(() => setMachineConsoleLoader(null));

const q = (id: string) => screen.queryByTestId(id);
const state = () => screen.getByTestId('manage-vacuum-state') as HTMLElement;
const on = () => screen.getByTestId('manage-vacuum-on') as HTMLButtonElement;
const off = () => screen.getByTestId('manage-vacuum-off') as HTMLButtonElement;

describe('#390 the vacuum switch — where it is', () => {
  it('a build that cannot open a socket draws no switch at all', () => {
    caps.drive = false;
    withMachine();
    render(<MachinesScope />);
    expect(q('manage-machine-card')).not.toBeNull();
    expect(q('manage-vacuum')).toBeNull();
  });

  it('the desktop build draws it on the machine card, above the console', () => {
    caps.drive = true;
    withMachine();
    render(<MachinesScope />);
    const panel = screen.getByTestId('manage-vacuum');
    expect(screen.getByTestId('manage-machine-card').contains(panel)).toBe(true);
    // Beside the console: it precedes it in the card, and it is not itself collapsed.
    const console = screen.getByTestId('manage-console');
    expect(panel.compareDocumentPosition(console) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws nothing where there is no machine to talk to', () => {
    caps.drive = true;
    render(<MachinesScope />);
    expect(q('manage-machine-none')).not.toBeNull();
    expect(q('manage-vacuum')).toBeNull();
  });
});

describe('#390 the vacuum switch — it claims only what it sent', () => {
  beforeEach(() => {
    caps.drive = true;
    withMachine();
  });

  it('starts unknown, opens no socket, and neither half is lit', () => {
    const wire = fakeConsole(idleMachine);
    render(<MachinesScope />);

    expect(state().textContent).toBe('unknown');
    expect(state().getAttribute('data-mode')).toBe('unknown');
    expect(on().getAttribute('aria-pressed')).toBe('false');
    expect(off().getAttribute('aria-pressed')).toBe('false');
    // Drawing the card connects to nothing: a socket appears with a press, not with a render.
    expect(wire.loads()).toBe(0);
    expect(wire.sent).toEqual([]);
  });

  it('a press on an idle machine switches it on, shows it, and lit the On half', async () => {
    const wire = fakeConsole(idleMachine);
    render(<MachinesScope />);
    fireEvent.click(on());

    await waitFor(() => expect(state().textContent).toBe('on'));
    expect(state().getAttribute('data-mode')).toBe('on');
    expect(on().getAttribute('aria-pressed')).toBe('true');
    expect(off().getAttribute('aria-pressed')).toBe('false');
    expect(wire.sent).toEqual(['?', 'M331']);
    expect(screen.getByTestId('manage-vacuum-note').textContent).toContain('the vacuum is on now');
  });

  it('the Off half sends M332 and lit Off, off the same unknown start', async () => {
    const wire = fakeConsole(idleMachine);
    render(<MachinesScope />);
    fireEvent.click(off());

    await waitFor(() => expect(state().textContent).toBe('off'));
    expect(off().getAttribute('aria-pressed')).toBe('true');
    expect(wire.sent).toEqual(['?', 'M332']);
    expect(screen.getByTestId('manage-vacuum-note').textContent).toContain('the vacuum is off now');
  });

  it('a press on a running machine is refused, sends no code, and says why', async () => {
    const wire = fakeConsole(runningMachine);
    render(<MachinesScope />);
    fireEvent.click(on());

    await waitFor(() => expect(q('manage-vacuum-note')).not.toBeNull());
    expect(screen.getByTestId('manage-vacuum-note').textContent).toContain('a program owns the vacuum');
    // Nothing was sent but the ask, and the state this panel remembers is still unknown.
    expect(wire.sent).toEqual(['?']);
    expect(state().textContent).toBe('unknown');
  });

  it('a press that lost the link goes back to unknown, because the code may or may not have arrived', async () => {
    const wire = fakeConsole((line) =>
      line === '?'
        ? { ok: true, line, text: IDLE, frames: 1, elapsedMs: 30 }
        : { ok: false, reason: 'timeout', line, detail: 'no reply within 60000 ms', text: '' },
    );
    render(<MachinesScope />);
    fireEvent.click(on());

    await waitFor(() => expect(q('manage-vacuum-note')).not.toBeNull());
    expect(screen.getByTestId('manage-vacuum-note').textContent).toContain('no reply within');
    expect(state().textContent).toBe('unknown');
    expect(wire.sent).toEqual(['?', 'M331']);
  });

  it('an error on the ask leaves the switch unknown and sends no code', async () => {
    const wire = fakeConsole(() => {
      throw new Error('tcpRead: connection reset by peer');
    });
    render(<MachinesScope />);
    fireEvent.click(on());

    await waitFor(() => expect(q('manage-vacuum-note')).not.toBeNull());
    expect(screen.getByTestId('manage-vacuum-note').textContent).toContain('connection reset');
    expect(state().textContent).toBe('unknown');
    // Only the ask was attempted; the code was never reached.
    expect(wire.sent).toEqual(['?']);
  });
});
