// @vitest-environment jsdom
// Issue #682 — step 1 is the house's machine, checked when the step opens.
//
// The design's line (docs/design/first-job-flow.md §3.2) is the whole claim, so these tests hold it
// to that shape: the location's machine named and addressed, ONE line of state in the machine
// strip's words, the check on open rather than on a click, `another machine…` as the only fold, and
// Next never gated on any of it. Only the socket is faked (`setMachineProbeLoader`), so the real
// probe runs. `bare 'Idle'` is NOT a status line: `readStatusLine` needs the `|`-separated frame, so
// the fixtures use one — otherwise the line would honestly read "Not answering".
//
// The old #347 picker tests are gone with the picker: the machine is no longer a question here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { StartWizard } from '@/components/welcome/StartWizard';
import { setMachineProbeLoader, type MachineProbeClient } from '@/platform/machineProbe';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetMachineStore, useMachineStore } from '@/store/machineStore';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetStartWizard } from '@/store/startWizardStore';

// #346 — vitest runs the WEB target, where the wizard has no socket. The step-1 tests run with the
// capability on (the desktop build); the no-socket case is covered in startWizard.spec.tsx.
const caps = vi.hoisted(() => ({ drive: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canDriveMachine() {
      return caps.drive;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUSE_HOST = '192.168.10.43';
/** A complete status line, as the controller sends it (`?`), with the machine at its homed rest. */
const IDLE_LINE = '<Idle|MPos:-1.000,-1.000,-1.000|F:0,0,100|S:0,0,100|T:0>';

type Location = NonNullable<ReturnType<typeof useLocationStore.getState>['location']>;
type HouseRecord = Location['machines'][number];

const HOUSE = {
  id: 'm1',
  profileId: 'Z1',
  name: 'Makera_Z1_010290',
  nickname: 'Zoomba',
  address: { host: HOUSE_HOST, port: 2222 },
} as unknown as HouseRecord;

function withHouse(): void {
  useLocationStore.setState({
    status: 'present',
    location: { machines: [HOUSE] } as unknown as Location,
    etag: '"e1"',
    reason: null,
  });
}

/** A bench Z1 that answers; `found: false` is a search that hears nothing. */
function bench(options: { found?: boolean } = {}): MachineProbeClient {
  const found = options.found ?? true;
  return {
    discover: async () =>
      found ? [{ name: 'Makera_Z1_010290', host: HOUSE_HOST, port: 2222, busy: false }] : [],
    identify: async (target) => ({ ip: target.host, mac: 'aa:bb:cc:dd:ee:ff' }),
    status: async () => ({ ok: true, text: IDLE_LINE }),
    readConfig: async () => ({ values: new Map<string, string>(), failures: [] }),
  };
}

function useClient(client: MachineProbeClient): void {
  setMachineProbeLoader(async () => client);
}

/** `09:02` in local time, the way the step prints a check's moment. */
function hhmm(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function stateLine(): HTMLElement {
  return screen.getByTestId('start-wizard-machine-state');
}

beforeEach(() => {
  cleanup();
  resetMachineStore();
  resetLocationStore();
  resetStartWizard();
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
  useClient(bench());
});

afterEach(() => {
  cleanup();
  setMachineProbeLoader(null);
  caps.drive = true;
});

describe('#682 — step 1 is the house’s machine', () => {
  it('names the location’s machine and checks it when the step opens — no click', async () => {
    withHouse();
    render(<StartWizard />);

    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    expect(screen.getByTestId('start-wizard-machine-name').textContent).toBe('Makera Z1 “Zoomba”');
    expect(screen.getByTestId('start-wizard-machine-address').textContent).toBe(HOUSE_HOST);
    expect(stateLine().textContent).toContain('Online · Idle');
    const machine = useMachineStore.getState().machine;
    expect(machine?.host).toBe(HOUSE_HOST);
    expect(stateLine().textContent).toContain(`· checked ${hhmm(machine!.observedAt)}`);
    // No `homed`: the status line carries no homed flag and a check sends no `$H` (protocol.spec).
    expect(stateLine().textContent).not.toContain('homed');
    expect((screen.getByTestId('start-wizard-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('checks once on open; Check again is the same check on demand', async () => {
    withHouse();
    let searches = 0;
    const client = bench();
    useClient({
      ...client,
      discover: async () => {
        searches += 1;
        return [{ name: 'Makera_Z1_010290', host: HOUSE_HOST, port: 2222, busy: false }];
      },
    });
    render(<StartWizard />);

    await waitFor(() => expect(searches).toBe(1));
    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    fireEvent.click(screen.getByTestId('start-wizard-check'));
    await waitFor(() => expect(searches).toBe(2));
    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
  });

  it('offline: says so with when it was last seen, and Next still goes on', async () => {
    // The last check reached the machine; this one hears nothing. The store forgets a machine on a
    // failed check, so the step captures the record before the check runs.
    useMachineStore.getState().setProbeResult({
      kind: 'found',
      observation: {
        name: 'Makera_Z1_010290',
        host: HOUSE_HOST,
        port: 2222,
        busy: false,
        ip: HOUSE_HOST,
        mac: 'aa:bb:cc:dd:ee:ff',
        status: IDLE_LINE,
        profileId: 'Z1',
        observedAt: '2026-10-25T13:55:00',
        notes: [],
      },
      calibration: null,
    });
    withHouse();
    useClient(bench({ found: false }));
    render(<StartWizard />);

    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('not-found'));
    expect(stateLine().textContent).toContain('Offline');
    expect(stateLine().textContent).not.toContain('Online');
    expect(stateLine().textContent).toContain('last seen 2026-10-25 13:55');
    expect(screen.getByTestId('start-wizard-machine-name').textContent).toBe('Makera Z1 “Zoomba”');
    expect(screen.getByTestId('start-wizard-machine-offline-note').textContent).toBe(
      'The job can be written, checked and simulated now; the machine is needed at Cut.',
    );
    expect((screen.getByTestId('start-wizard-next') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('start-wizard-next'));
    expect(screen.getByTestId('start-wizard-step-job')).toBeDefined();
  });

  it('no machine anywhere: Offline, no invented last-seen, and the job continues', async () => {
    useClient(bench({ found: false }));
    render(<StartWizard />);

    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('not-found'));
    expect(stateLine().textContent).toBe('Offline');
    expect(screen.queryByTestId('start-wizard-machine-name')).toBeNull();
    expect(screen.queryByTestId('start-wizard-machine-address')).toBeNull();
    expect(screen.queryByTestId('start-wizard-machine-offline-note')).not.toBeNull();
    expect((screen.getByTestId('start-wizard-next') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('start-wizard-next'));
    expect(screen.getByTestId('start-wizard-step-job')).toBeDefined();
  });

  it('with no location record, a found machine names itself and its address', async () => {
    render(<StartWizard />);

    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    expect(screen.getByTestId('start-wizard-machine-name').textContent).toBe('Makera Z1');
    expect(screen.getByTestId('start-wizard-machine-address').textContent).toBe(HOUSE_HOST);
    expect(stateLine().textContent).toContain('Online · Idle');
  });

  it('the address and Connect live under the one fold; the paragraphs and placeholder are gone', async () => {
    withHouse();
    render(<StartWizard />);
    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));

    // A3: the picker, its paragraph, the check paragraph and the example address are gone.
    expect(screen.queryByTestId('start-wizard-machine-select')).toBeNull();
    expect(screen.queryByTestId('start-wizard-machine-pick-note')).toBeNull();
    expect(screen.queryByText(/Every job is written for one machine/)).toBeNull();
    expect(screen.queryByText(/Whether a machine is on the network/)).toBeNull();
    expect(screen.queryByTestId('start-wizard-address')).toBeNull();
    expect(screen.queryByTestId('start-wizard-connect-address')).toBeNull();

    fireEvent.click(screen.getByTestId('start-wizard-machine-another'));
    const input = screen.getByTestId('start-wizard-address');
    expect(input.getAttribute('placeholder')).toBeNull();
    const connect = screen.getByTestId('start-wizard-connect-address') as HTMLButtonElement;
    // Principle 4: the disabled Connect says what unblocks it, with the field right there.
    expect(connect.disabled).toBe(true);
    expect(screen.getByTestId('start-wizard-machine-address-unblock').textContent).toBe(
      'Type the machine’s address to connect to it.',
    );
    fireEvent.change(input, { target: { value: '10.0.0.7' } });
    expect(connect.disabled).toBe(false);
    expect(screen.queryByTestId('start-wizard-machine-address-unblock')).toBeNull();

    // One fold: the same control closes it, and the field goes with it.
    fireEvent.click(screen.getByTestId('start-wizard-machine-another'));
    expect(screen.queryByTestId('start-wizard-address')).toBeNull();
  });

  it('Connect checks the typed address instead of searching, and the line follows it', async () => {
    withHouse();
    let searches = 0;
    const client = bench();
    useClient({
      ...client,
      discover: async () => {
        searches += 1;
        return [{ name: 'Makera_Z1_010290', host: HOUSE_HOST, port: 2222, busy: false }];
      },
    });
    render(<StartWizard />);
    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));

    fireEvent.click(screen.getByTestId('start-wizard-machine-another'));
    fireEvent.change(screen.getByTestId('start-wizard-address'), { target: { value: '10.0.0.7' } });
    fireEvent.click(screen.getByTestId('start-wizard-connect-address'));

    await waitFor(() =>
      expect(screen.getByTestId('start-wizard-machine-address').textContent).toBe('10.0.0.7'),
    );
    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    expect(stateLine().textContent).toContain('Online · Idle');
    // The typed route is the manual fallback, not a second search.
    expect(searches).toBe(1);
    // It said nothing about what it is, so the step names no model for it.
    expect(screen.queryByTestId('start-wizard-machine-name')).toBeNull();
  });

  it('Next is not gated while the check is still running', async () => {
    withHouse();
    let release: (() => void) | null = null;
    const client = bench();
    useClient({
      ...client,
      discover: () =>
        new Promise((resolve) => {
          release = () => resolve([{ name: 'Makera_Z1_010290', host: HOUSE_HOST, port: 2222, busy: false }]);
        }),
    });
    render(<StartWizard />);

    await waitFor(() => expect(release).not.toBeNull());
    expect(stateLine().getAttribute('data-state')).toBe('checking');
    expect(stateLine().textContent).toBe('Checking…');
    expect((screen.getByTestId('start-wizard-next') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('start-wizard-next'));
    expect(screen.getByTestId('start-wizard-step-job')).toBeDefined();

    await act(async () => {
      release!();
    });
  });
});
