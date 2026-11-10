// @vitest-environment jsdom
// #1173A — the machine page's state card.
//
// THE SEAM IS THE STORE AND THE CONSOLE. The heartbeat is mocked so each test states exactly what
// the live poll last concluded (`machineStore.heartbeat`) and what the controller's last status line
// said; the console loader is the switch tests' own fake, so a press runs the real guard → send
// path. What this pins is the four-state reading and the enabled set it drives:
//
//   ready   → Stop disabled ("nothing running"), Unlock disabled ("no alarm")
//   cutting → Stop live, switches locked
//   alarm   → Unlock live and primary, Stop disabled
//   silent  → "Not answering since hh:mm", Check again, everything socket-bound disabled
//
// and the switch-row wording the manager ruled on 2026-11-10: what this app last sent, never a
// claim about the machine's own output state.

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MachinesScope } from '@/components/manage/MachinesScope';
import { clockWords } from '@/components/manage/switchWords';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import { setMachineConsoleLoader, type ConsoleSend } from '@/platform/machineConsole';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/platform/machineHeartbeat', () => ({
  startHeartbeat: vi.fn(),
  stopHeartbeat: vi.fn(),
}));

const caps = vi.hoisted(() => ({ drive: false }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return caps.drive;
    },
  };
});

const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';
const RUNNING = '<Run|MPos:-12.000,-8.000,-2.000|WPos:0,0,0|P:12,42,17>';
const ALARM = '<Alarm|MPos:0,0,0|WPos:0,0,0>\r\nALARM: Probe fail';

/** A controller that answered once — what the card draws its controls under. */
const Z1_RECORD = {
  name: 'Z1',
  host: '192.168.10.43',
  port: 2222,
  busy: false,
  ip: '192.168.10.43',
  mac: 'AA:BB:CC:DD:EE:FF',
  status: IDLE,
  profileId: 'Z1',
  observedAt: '2026-10-09T06:00:00.000Z',
  notes: [],
};

const LAST_SEEN = '2026-11-10T15:42:00.000Z';

function withMachine(opts: { status?: string; reachable?: boolean | null; lastSeenAt?: string | null } = {}): void {
  useMachineStore.setState({
    machine: { ...Z1_RECORD, status: opts.status ?? IDLE },
    outcome: 'found',
    reason: null,
    checkedAt: '2026-10-09T06:00:00.000Z',
    heartbeat: {
      reachable: opts.reachable === undefined ? true : opts.reachable,
      lastSeenAt: opts.lastSeenAt === undefined ? new Date(Date.now() - 2000).toISOString() : opts.lastSeenAt,
    },
  });
}

/** A console that answers `?` with `status` and every other line with `ok`. */
function fakeConsole(status: string = IDLE): { sent: string[] } {
  const sent: string[] = [];
  setMachineConsoleLoader(async () => ({
    async open() {
      return {
        async send(line: string): Promise<ConsoleSend> {
          sent.push(line);
          return line === '?'
            ? { ok: true, line, text: status, frames: 1, elapsedMs: 20 }
            : { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 };
        },
        async close() {},
      };
    },
  }));
  return { sent };
}

beforeEach(() => {
  cleanup();
  caps.drive = true;
  resetMachineStore();
  useSettingsStore.setState({ machineCalibration: undefined });
});

afterEach(() => setMachineConsoleLoader(null));

const card = () => screen.getByTestId('manage-state-card') as HTMLElement;
const headline = () => screen.getByTestId('manage-state-headline') as HTMLElement;
const stop = () => screen.getByTestId('manage-stop-button') as HTMLButtonElement;
const unlock = () => screen.getByTestId('manage-unlock-press') as HTMLButtonElement;
const foundTag = () => screen.getByTestId('manage-machine-found') as HTMLElement;
const vacuumOn = () => screen.getByTestId('manage-vacuum-on') as HTMLButtonElement;
const lightOn = () => screen.getByTestId('manage-light-on') as HTMLButtonElement;
const lightState = () => screen.getByTestId('manage-light-state') as HTMLElement;

describe('#1173A the state card — the four states', () => {
  it('ready: names the machine, its state, its age and its address; Stop and Unlock are off', () => {
    fakeConsole();
    withMachine();
    render(<MachinesScope />);

    expect(card().getAttribute('data-state')).toBe('ready');
    expect(headline().textContent).toContain('Z1 is ready — Idle');
    expect(headline().textContent).toContain('· homed');
    expect(headline().textContent).toContain('answered ');
    expect(headline().textContent).toContain('Makera Z1 at 192.168.10.43');
    expect(foundTag().textContent).toBe('found');

    expect(stop().disabled).toBe(true);
    expect(stop().textContent).toBe('■ Stop · nothing running');
    expect(unlock().disabled).toBe(true);
    expect(unlock().textContent).toBe('Unlock · no alarm');
    // Nothing running and the machine answering: the switches are live.
    expect(vacuumOn().disabled).toBe(false);
    expect(lightOn().disabled).toBe(false);
  });

  it('cutting: says what it is doing, Stop is live, and the switches are locked', () => {
    fakeConsole(RUNNING);
    withMachine({ status: RUNNING });
    render(<MachinesScope />);

    expect(card().getAttribute('data-state')).toBe('running');
    expect(headline().textContent).toBe('Cutting program — 42% done');
    expect(stop().disabled).toBe(false);
    expect(stop().textContent).toBe('■ Stop · stops now');
    expect(unlock().disabled).toBe(true);
    expect(vacuumOn().disabled).toBe(true);
    expect(lightOn().disabled).toBe(true);
  });

  it('alarm: quotes the machine’s own words; Unlock is live and primary, Stop is off', () => {
    fakeConsole(ALARM);
    withMachine({ status: ALARM });
    render(<MachinesScope />);

    expect(card().getAttribute('data-state')).toBe('alarm');
    expect(headline().textContent).toBe('In alarm — “ALARM: Probe fail”');
    expect(unlock().disabled).toBe(false);
    expect(unlock().textContent).toBe('Unlock');
    expect(unlock().className).toContain('btn--primary');
    expect(stop().disabled).toBe(true);
    expect(vacuumOn().disabled).toBe(true);
  });

  it('silent: a missed poll beats the stale status line', () => {
    fakeConsole();
    withMachine({ reachable: false, lastSeenAt: LAST_SEEN });
    render(<MachinesScope />);

    expect(card().getAttribute('data-state')).toBe('silent');
    expect(headline().textContent).toBe(`Not answering since ${clockWords(LAST_SEEN)}`);
    expect(foundTag().textContent).toBe(`Not answering since ${clockWords(LAST_SEEN)}`);
    expect(screen.getByTestId('manage-state-recheck')).toBeTruthy();
    expect(screen.getByTestId('manage-state-plug').textContent).toContain('Switch it on at the plug');
    expect(stop().disabled).toBe(true);
    expect(unlock().disabled).toBe(true);
    expect(vacuumOn().disabled).toBe(true);
  });

  it('before the first heartbeat answer it says it is checking, not that the machine is ready', () => {
    fakeConsole();
    withMachine({ reachable: null });
    render(<MachinesScope />);

    expect(card().getAttribute('data-state')).toBe('unknown');
    expect(headline().textContent).toBe('Checking whether Z1 is answering…');
    expect(foundTag().textContent).toBe('found');
  });
});

describe('#1173A the switch rows — what this app last sent, never a state claim', () => {
  it('says “not sent this session” on open, and the send time after a clean press', async () => {
    const wire = fakeConsole();
    withMachine();
    render(<MachinesScope />);

    expect(lightState().textContent).toBe('not sent this session');
    expect(lightState().getAttribute('data-mode')).toBe('unknown');
    expect(screen.getByTestId('manage-vacuum-state').textContent).toBe('not sent this session');

    fireEvent.click(lightOn());
    await waitFor(() => expect(lightState().textContent).toMatch(/^last sent from this app: on · \d{2}:\d{2}$/));
    expect(lightState().getAttribute('data-mode')).toBe('on');
    expect(lightOn().getAttribute('aria-pressed')).toBe('true');
    expect(wire.sent).toEqual(['?', 'M821']);
  });

  it('a locked row sends nothing at all', () => {
    const wire = fakeConsole(RUNNING);
    withMachine({ status: RUNNING });
    render(<MachinesScope />);

    expect(vacuumOn().disabled).toBe(true);
    fireEvent.click(vacuumOn());
    expect(wire.sent).toEqual([]);
  });

  it('a press that lost the link goes back to “not sent this session”', async () => {
    setMachineConsoleLoader(async () => ({
      async open() {
        return {
          async send(line: string): Promise<ConsoleSend> {
            return line === '?'
              ? { ok: true, line, text: IDLE, frames: 1, elapsedMs: 20 }
              : { ok: false, reason: 'timeout', line, detail: 'no reply within 60000 ms', text: '' };
          },
          async close() {},
        };
      },
    }));
    withMachine();
    render(<MachinesScope />);

    fireEvent.click(lightOn());
    await waitFor(() => expect(screen.getByTestId('manage-light-note').textContent).toContain('no reply within'));
    expect(lightState().textContent).toBe('not sent this session');
  });

  it('a re-check remounts the rows at “not sent this session”', async () => {
    fakeConsole();
    withMachine();
    render(<MachinesScope />);

    fireEvent.click(lightOn());
    await waitFor(() => expect(lightState().textContent).toMatch(/^last sent from this app: on/));

    act(() => {
      useMachineStore.setState({ machine: { ...Z1_RECORD, observedAt: '2026-11-10T15:00:00.000Z' } });
    });
    expect(lightState().textContent).toBe('not sent this session');
  });
});
