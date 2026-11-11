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
import { resetManageMode, useManageModeStore } from '@/store/manageModeStore';
import { useMachineChangeStore } from '@/store/machineChangeStore';
import { MachineRecordSchema, type MachineRecord } from '@/platform/locationClient';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// #346 — vitest runs the WEB target, where the wizard has no socket. The step-1 tests run with the
// capability on (the desktop build); the no-socket case is covered in startWizard.spec.tsx.
const caps = vi.hoisted(() => ({ drive: true }));
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return caps.drive;
    },
  };
});

// jsdom has no geometry worker; startFromStock schedules one after the job is made.
vi.mock('@/engine/jobs/JobScheduler', () => ({ scheduleImmediate: vi.fn(async () => {}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOUSE_HOST = '192.168.10.43';
/** A complete status line, as the controller sends it (`?`), with the machine at the Z1's homed rest (-1, -1, -1). */
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

/**
 * A bench Z1 that answers. `found: false` is a machine that is not there at all: the search hears
 * nothing AND its recorded address refuses (#882) — an absent machine, not merely a silent
 * broadcast. `hearNothing: true` is the k3 bridge's case: the search is deaf but the machine answers
 * at its recorded address.
 */
function bench(options: { found?: boolean; hearNothing?: boolean } = {}): MachineProbeClient {
  const found = options.found ?? true;
  const heard = found && options.hearNothing !== true;
  return {
    discover: async () =>
      heard ? [{ name: 'Makera_Z1_010290', host: HOUSE_HOST, port: 2222, busy: false }] : [],
    identify: async (target) => {
      if (!found) throw new Error('ECONNREFUSED');
      return { ip: target.host, mac: 'aa:bb:cc:dd:ee:ff' };
    },
    status: async () => {
      if (!found) throw new Error('ECONNREFUSED');
      return { ok: true, text: IDLE_LINE };
    },
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
  resetManageMode();
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
  useClient(bench());
});

afterEach(() => {
  cleanup();
  setMachineProbeLoader(null);
  caps.drive = true;
});

describe('#682 — step 1 is the house’s machine', () => {
  it('the location’s machine is the selected row, and the check runs when the step opens — no click', async () => {
    withHouse();
    render(<StartWizard />);

    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    // #1106 item 7 — the old single-machine header is gone: the ROW is where the machine is named.
    const row = screen.getByTestId(`start-wizard-machine-row-${HOUSE.id}`);
    expect(row.textContent).toContain('Makera Z1 “Zoomba”');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    const machine = useMachineStore.getState().machine;
    expect(machine?.host).toBe(HOUSE_HOST);
    // #693's reader: Idle with MPos at the Z1's homed rest is `homed`; the check sends no `$H`.
    expect(stateLine().textContent).toBe(
      `Online · Idle · knows where it is · checked ${hhmm(machine!.observedAt)}`,
    );
    expect((screen.getByTestId('start-wizard-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('#882 — Online when only the recorded address answers, and the line says which route', async () => {
    withHouse();
    useClient(bench({ hearNothing: true }));
    render(<StartWizard />);

    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    expect(stateLine().textContent).toContain('Online');
    expect(screen.getByTestId('start-wizard-machine-route').textContent).toContain(
      'Found at its recorded address',
    );
    expect(screen.getByTestId('start-wizard-machine-route').textContent).toContain('cannot receive broadcasts');
    // The route is remembered with the check, so a re-opened wizard can still say it.
    expect(useMachineStore.getState().route).toBe('recorded');
  });

  it('#726 W24 — step 1 says what is on the machine, from the active bed profile', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = JSON.parse(readFileSync(join(here, 'fixtures', 'location-doc.json'), 'utf8')) as { machines: unknown[] };
    const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(doc.machines[0]))) as MachineRecord & {
      address?: { host: string; port: number };
    };
    machine.address = { host: HOUSE_HOST, port: 2222 };
    useLocationStore.setState({
      status: 'present',
      location: { machines: [machine] } as unknown as Location,
      etag: '"e1"',
      reason: null,
    });
    useClient(bench());
    render(<StartWizard />);

    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    // The design's line (first-job-flow §3.2/§3.4): the bed profile, not a guess.
    expect(screen.getByTestId('start-wizard-machine-now').textContent).toBe(
      'On the machine now: Vise on the pins · wasteboard under',
    );
  });

  it('#513 — a bed with nothing measured says so on the Start line, once — not as a finding per job', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const doc = JSON.parse(readFileSync(join(here, 'fixtures', 'location-doc.json'), 'utf8')) as { machines: unknown[] };
    const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(doc.machines[0]))) as MachineRecord & {
      address?: { host: string; port: number };
    };
    machine.address = { host: HOUSE_HOST, port: 2222 };
    // A freshly shipped profile: nothing has been measured on it yet.
    machine.bedProfiles = machine.bedProfiles!.map((p) => ({
      ...p,
      datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null, rotaryFaceAngle: null },
    }));
    useLocationStore.setState({
      status: 'present',
      location: { machines: [machine] } as unknown as Location,
      etag: '"e1"',
      reason: null,
    });
    useClient(bench());
    render(<StartWizard />);

    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    expect(screen.getByTestId('start-wizard-machine-now').textContent).toBe(
      'On the machine now: Vise on the pins · wasteboard under · not measured yet',
    );
  });

  it('an Idle line away from the homed rest does not say homed', async () => {
    withHouse();
    useClient({
      ...bench(),
      status: async () => ({
        ok: true,
        text: '<Idle|MPos:10.000,20.000,-1.000|F:0,0,100|S:0,0,100|T:0>',
      }),
    });
    render(<StartWizard />);

    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    expect(stateLine().textContent).toContain('Online · Idle');
    expect(stateLine().textContent).not.toContain('homed');
    const machine = useMachineStore.getState().machine;
    expect(stateLine().textContent).toContain(`· checked ${hhmm(machine!.observedAt)}`);
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
    expect(screen.getByTestId(`start-wizard-machine-row-${HOUSE.id}`).textContent).toContain('Makera Z1 “Zoomba”');
    expect(screen.getByTestId('start-wizard-machine-offline-note').textContent).toBe(
      'The job can be written, checked and simulated now; the machine is needed at Cut.',
    );
    expect((screen.getByTestId('start-wizard-next') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('start-wizard-next'));
    // #897 — the work comes before the blank: step 2 is the question.
    expect(screen.getByTestId('start-wizard-progress').textContent).toContain('What are you making?');
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
    // #897 — the work comes before the blank: step 2 is the question.
    expect(screen.getByTestId('start-wizard-progress').textContent).toContain('What are you making?');
  });

  it('with no location record, the check’s own line names the state and there is no row to name', async () => {
    render(<StartWizard />);

    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    expect(screen.queryByTestId('start-wizard-machine-list')).toBeNull();
    expect(screen.queryByTestId('start-wizard-machine-name')).toBeNull();
    expect(stateLine().textContent).toContain('Online · Idle');
  });

  it('the old header, fold and typed address are gone; the rows are the picker and Add a machine… opens Manage', async () => {
    withHouse();
    resetManageMode();
    render(<StartWizard />);
    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));

    // A3: the picker, its paragraph, the check paragraph and the example address are gone.
    expect(screen.queryByTestId('start-wizard-machine-select')).toBeNull();
    expect(screen.queryByTestId('start-wizard-machine-pick-note')).toBeNull();
    expect(screen.queryByText(/Every job is written for one machine/)).toBeNull();
    expect(screen.queryByText(/Whether a machine is on the network/)).toBeNull();
    // #1106 item 7 — the single-machine header and the "another machine…" fold are gone.
    expect(screen.queryByTestId('start-wizard-machine-name')).toBeNull();
    expect(screen.queryByTestId('start-wizard-machine-address')).toBeNull();
    expect(screen.queryByTestId('start-wizard-machine-another')).toBeNull();
    expect(screen.queryByTestId('start-wizard-address')).toBeNull();
    expect(screen.queryByTestId('start-wizard-connect-address')).toBeNull();
    // The record is a row, selected; the list's last row opens Manage › Machines (item 6).
    expect(screen.getByTestId(`start-wizard-machine-row-${HOUSE.id}`).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('start-wizard-add-machine'));
    expect(useManageModeStore.getState().open).toBe(true);
    expect(useManageModeStore.getState().scope).toBe('machines');
  });

  // #1106 item 7 — the typed-address route ("Connect") is gone with the fold: the records are the
  // picker, and their own addresses are what the probe batch uses (#882 above).

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
    // #897 — the work comes before the blank: step 2 is the question.
    expect(screen.getByTestId('start-wizard-progress').textContent).toContain('What are you making?');

    await act(async () => {
      release!();
    });
    // #1106 item 4 — the result landed after the step was left: it is DISCARDED, never written.
    expect(useMachineStore.getState().outcome).toBeNull();
    expect(useMachineStore.getState().machine).toBeNull();
  });

  it('a location with one machine selects it without a click', async () => {
    withHouse();
    render(<StartWizard />);
    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    expect(screen.getByTestId(`start-wizard-machine-row-${HOUSE.id}`).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByTestId('start-wizard-next') as HTMLButtonElement).disabled).toBe(false);
  });

  it('Change what’s on the bed… opens the machine-change store for the SELECTED row’s record (#1106 item 10)', async () => {
    withHouse();
    render(<StartWizard />);
    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));
    fireEvent.click(screen.getByTestId('start-wizard-change-bed'));
    expect(useMachineChangeStore.getState().open).toBe(true);
    expect(useMachineChangeStore.getState().request.machineId).toBe(HOUSE.id);
  });

  it('creating a job writes the last machine (#1106 item 5)', async () => {
    window.localStorage.removeItem('casemaker.lastMachineId');
    withHouse();
    render(<StartWizard />);
    await waitFor(() => expect(stateLine().getAttribute('data-state')).toBe('found'));

    fireEvent.click(screen.getByTestId('start-wizard-next'));
    // Step 2 — the sign preset, with its own text field.
    fireEvent.click(screen.getByTestId('start-wizard-preset-sign'));
    fireEvent.change(screen.getByTestId('start-wizard-preset-text'), { target: { value: 'A block' } });
    fireEvent.click(screen.getByTestId('start-wizard-operation-next'));
    expect(screen.getByTestId('start-wizard-step-stock')).toBeDefined();
    const stockNext = screen.getByTestId('start-wizard-stock-next') as HTMLButtonElement;
    await waitFor(() => expect(stockNext.disabled).toBe(false));
    await act(async () => {
      fireEvent.click(stockNext);
    });
    expect(window.localStorage.getItem('casemaker.lastMachineId')).toBe(HOUSE.id);
  });
});
