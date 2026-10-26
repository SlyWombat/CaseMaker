// @vitest-environment jsdom
/**
 * #693 — the change-the-machine wizard, walked.
 *
 * THE LOCATION AND THE MACHINE ARE THE TWO SEAMS. `useLocationStore` is seeded with a `LocationView`
 * whose machine has a vise-profile bed; `setHouseClientLoader` serves that view and applies the two
 * PUTs the wizard makes. `setMachineConsoleLoader` answers `?`/`$H`/`M821`/`M822` — the orchestration
 * under test is the real `checkMachine`/`homeMachine`/`toggleLight` over the real console handle.
 *
 * The three things this pins, in the manager's order: an unreachable machine leaves Make-it-safe
 * unticked with the reason; closing before Confirm writes nothing; and Confirm produces the new
 * active profile, a history entry, the two accessory moves, and the re-freeze flag for a frozen job
 * whose mount the new bed cannot hold.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MachineChangeWizard } from '@/components/machine-change';
import { openMachineChange, resetMachineChange } from '@/store/machineChangeStore';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { MachineRecordSchema, type FixtureRecord, type LocationView, type MachineRecord } from '@/platform/locationClient';
import {
  setHouseClientLoader,
  type HouseCall,
  type HouseClient,
  type HouseHealth,
  type HouseProbe,
} from '@/platform/houseClient';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleSession } from '@/platform/machineConsole';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MACHINE_ID = 'machine-1a2b3c';
const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|WPos:147.4000,123.8000,57.6325|T:6,-17.696,-1>';
const IDLE_AWAY = '<Idle|MPos:-160.5000,-188.0000,-55.0000|WPos:19.6000,4.7000,0.4000>';

const HEALTH: HouseHealth = {
  ok: true,
  schemaVersion: 1,
  build: 'v-test',
  hasCatalogue: false,
  feedRows: 0,
  materialSpecRows: 0,
  catalogueSyncedAt: null,
  problems: [],
  warnings: [],
  lastSync: null,
};

const VISE: FixtureRecord = {
  id: 'fx-vise-1',
  kind: 'vise',
  product: 'makera-z1-low-profile-vise',
  variant: null,
  constants: { jawBarWidth: 10, jawLength: 100, ledgeStep: 3.1, ledgeWidth: 1.9 },
  unit: { jawStartY: -10 },
  provenance: {},
  whereabouts: { kind: 'machine', machineId: MACHINE_ID, since: '2026-10-15T09:00:00.000Z' },
  history: [{ at: '2026-10-15T09:00:00.000Z', what: 'created by migrating the legacy vise settings' }],
};

const ROTARY: FixtureRecord = {
  id: 'fx-rotary',
  kind: 'rotary-module',
  product: 'Makera 4th-axis module',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'box' },
  history: [],
};

function machine(): MachineRecord {
  return MachineRecordSchema.parse({
    id: MACHINE_ID,
    profileId: 'Z1',
    name: 'Makera_Z1_000000',
    nickname: 'Zoomba',
    serial: null,
    firmware: null,
    address: { host: '192.168.10.43', port: 2222 },
    calibration: null,
    fixtures: null,
    margins: null,
    power: null,
    wasteboard: null,
    finishedPrograms: [],
    bedProfiles: [
      {
        id: 'bp-vise',
        name: 'Vise on the pins, bare bed',
        createdAt: '2026-10-24T00:00:00.000Z',
        basedOn: null,
        surface: {
          kind: 'wasteboard',
          material: 'MDF',
          length: 200,
          width: 200,
          thickness: 2,
          position: null,
          provenance: { thickness: 'measured:2026-10-24T00:00:00.000Z' },
          scars: [],
          lastResurfacedAt: null,
        },
        datums: {
          surfaceTopZ: null,
          viseJawTopZ: { value: -56.82, measuredAt: '2026-10-23T00:00:00.000Z', by: 'fx-probe-1', at: null },
          bracketSeatZ: null,
          rotaryAxis: null,
        },
        placements: [
          {
            id: 'pl-vise',
            fixture: 'fx-vise-1',
            where: { kind: 'pins', pins: 'vise', anchor: null },
            count: null,
            frame: { fixedJawFaceX: -180.375, jawStartY: -202.75 },
            provenance: {},
          },
        ],
        preferredMounting: [],
        consumables: null,
        history: [{ at: '2026-10-24T00:00:00.000Z', what: 'created at the first vise registration' }],
      },
    ],
    activeBedProfileId: 'bp-vise',
    updatedAt: '2026-10-24T00:00:00.000Z',
  });
}

function view(m: MachineRecord = machine()): LocationView {
  return {
    kind: 'casemaker-location',
    schemaVersion: 1,
    id: 'loc-1a2b3c4d',
    name: 'Test bench',
    createdAt: '2026-10-15T09:00:00.000Z',
    migratedFrom: null,
    machines: [m],
    unreadableMachines: [],
    accessories: [VISE, ROTARY],
  } as unknown as LocationView;
}

interface Write {
  method: string;
  path: string;
  body: unknown;
}

/** The house service as this wizard uses it: one location read, machine and accessory PUTs. */
function fakeHouse(state: { view: LocationView; writes: Write[] }): HouseClient {
  return {
    probe: async (): Promise<HouseProbe> => ({ kind: 'present', health: HEALTH, base: '' }),
    tools: async () => ({ kind: 'ok', etag: '"t1"', entries: [] }),
    feeds: async () => ({ kind: 'ok', etag: '"f1"', rows: [] }),
    inventory: async () => ({ kind: 'ok', etag: '"i1"', items: [] }),
    call: async (method, path, body): Promise<HouseCall> => {
      if (method === 'GET' && path === '/location') {
        return { kind: 'ok', text: JSON.stringify(state.view), etag: '"e1"' };
      }
      state.writes.push({ method, path, body });
      if (method === 'PUT' && path.startsWith('/location/machines/')) {
        const record = body as MachineRecord;
        state.view = { ...state.view, machines: state.view.machines.map((m) => (m.id === record.id ? record : m)) };
        return { kind: 'ok', text: '' };
      }
      if (method === 'PUT' && path.startsWith('/location/accessories/')) {
        const record = body as FixtureRecord;
        const accessories = state.view.accessories ?? [];
        state.view = {
          ...state.view,
          accessories: accessories.some((a) => a.id === record.id)
            ? accessories.map((a) => (a.id === record.id ? record : a))
            : [...accessories, record],
        };
        return { kind: 'ok', text: '' };
      }
      return { kind: 'ok', text: '' };
    },
  };
}

const sent = (line: string, text: string): ConsoleSend => ({ ok: true, line, text, frames: 1, elapsedMs: 10 });

/** A machine whose `?` answer is `status`, whose `$H` answers `home`, and whose modes are taken. */
function fakeMachine(opts: {
  status: () => ConsoleSend;
  home?: () => ConsoleSend;
  other?: (line: string) => ConsoleSend;
}): { lines: string[] } {
  const lines: string[] = [];
  const session: MachineConsoleSession = {
    async send(line) {
      lines.push(line);
      if (line === '?') return opts.status();
      if (line === '$H') return (opts.home ?? (() => sent(line, IDLE)))();
      return (opts.other ?? ((l) => sent(l, 'ok')))(line);
    },
    async close() {},
  };
  setMachineConsoleLoader(async () => ({ async open() { return session; } }));
  return { lines };
}

function seedLocation(): { view: LocationView; writes: Write[] } {
  const state = { view: view(), writes: [] as Write[] };
  setHouseClientLoader(async () => fakeHouse(state));
  useLocationStore.setState({
    status: 'present',
    location: state.view,
    etag: '"e1"',
    reason: null,
    writeNote: null,
    accessoryNote: null,
    marginsHome: 'defaults',
  });
  return state;
}

const clickCheck = (testId: string): void => {
  const box = screen.getByTestId(testId).querySelector('input');
  if (box === null) throw new Error(`${testId} has no checkbox`);
  fireEvent.click(box);
};

beforeEach(() => {
  cleanup();
  resetLocationStore();
  resetMachineChange();
  setHouseClientLoader(null);
  setMachineConsoleLoader(null);
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
  setMachineConsoleLoader(null);
});

describe('#693 the wizard with the machine offline', () => {
  it('cannot tick Home or the light, says why, and leaves the bed untouched on Close', async () => {
    const state = seedLocation();
    fakeMachine({
      status: () => ({ ok: false, reason: 'timeout', line: '?', detail: 'no reply within 6000 ms', text: '' }),
    });
    openMachineChange({ target: 'rotary' });
    render(<MachineChangeWizard />);

    const homeLine = await screen.findByTestId('machine-change-home-line');
    await waitFor(() => expect(within(homeLine).getByText(/not answering at 192\.168\.10\.43:2222/)).toBeTruthy());
    expect(within(homeLine).getByText(/no reply within 6000 ms/)).toBeTruthy();
    expect(screen.queryByTestId('machine-change-home-done')).toBeNull();
    expect((screen.getByTestId('machine-change-light') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('machine-change-step-3').getAttribute('data-state')).toBe('later');
    // The manual line is the operator's own eyes, and it can still be answered.
    expect((screen.getByTestId('machine-change-checked') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('machine-change-close'));
    await waitFor(() => expect(screen.queryByTestId('machine-change')).toBeNull());
    expect(state.writes).toEqual([]);
    expect(useLocationStore.getState().location?.machines[0]?.activeBedProfileId).toBe('bp-vise');
  });
});

describe('#693 closing the wizard', () => {
  it('writes no profile and no history when closed before Confirm', async () => {
    const state = seedLocation();
    fakeMachine({ status: () => sent('?', IDLE) });
    openMachineChange({ target: 'rotary' });
    render(<MachineChangeWizard />);

    await screen.findByTestId('machine-change-what');
    // Step 1 names the change and the job that would ask for it.
    expect(screen.getByTestId('machine-change-what').textContent).toContain('Vise on the pins → Rotary on the pins');

    fireEvent.click(screen.getByTestId('machine-change-close'));
    await waitFor(() => expect(screen.queryByTestId('machine-change')).toBeNull());
    expect(state.writes).toEqual([]);
    const machineNow = useLocationStore.getState().location?.machines[0];
    expect(machineNow?.activeBedProfileId).toBe('bp-vise');
    expect(machineNow?.bedProfiles).toHaveLength(1);
    expect(machineNow?.bedProfiles?.[0]?.history).toHaveLength(1);
  });
});

describe('#693 walking the change', () => {
  it('makes it safe, swaps the fixture, records the change and flags a frozen vise job for re-freeze', async () => {
    const state = seedLocation();
    // The check finds the machine home; switching the light on is the operator reaching in, so the
    // final Home has a real `$H` to run rather than short-circuiting on an already-homed read.
    let homed = false;
    let handsIn = false;
    const z1 = fakeMachine({
      status: () => sent('?', homed ? IDLE : handsIn ? IDLE_AWAY : IDLE),
      home: () => {
        homed = true;
        // The macro's reply carries the finished rest, as the console's quiet window can collect it.
        return sent('$H', IDLE);
      },
      other: (line) => {
        if (line === 'M821') handsIn = true;
        return sent(line, 'ok');
      },
    });
    const done: unknown[] = [];
    openMachineChange({
      target: 'rotary',
      forJob: { name: 'Zoomba badge', holding: 'held in the rotary chuck', frozen: true, frozenMount: 'vise' },
      onDone: (r) => done.push(r),
    });
    render(<MachineChangeWizard />);

    // 1 · What changes — the mockup's line.
    const what = await screen.findByTestId('machine-change-what');
    expect(what.textContent).toContain('Vise on the pins → Rotary on the pins');
    expect(what.textContent).toContain('for Zoomba badge, held in the rotary chuck');

    // 2 · Make it safe — the machine is already Idle at its homed rest, so Home is its answer.
    await screen.findByTestId('machine-change-home-line');
    await waitFor(() => expect(screen.getByTestId('machine-change-home-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-light'));
    await waitFor(() => expect(screen.getByTestId('machine-change-light-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-checked'));

    // 3 · Take off the vise.
    await screen.findByTestId('machine-change-take');
    clickCheck('machine-change-take-0');
    clickCheck('machine-change-take-1');
    clickCheck('machine-change-take-2');
    fireEvent.click(screen.getByTestId('machine-change-take-done'));

    // 4 · Fit the rotary, and leave the axis for the registration to measure.
    await screen.findByTestId('machine-change-fit');
    clickCheck('machine-change-fit-0');
    clickCheck('machine-change-fit-1');
    clickCheck('machine-change-fit-2');
    expect((screen.getByTestId('machine-change-use-shipped') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('machine-change-measure-now'));
    fireEvent.click(screen.getByTestId('machine-change-fit-done'));

    // 5 · Confirm — the one write, and it must not move the machine: the operator may still have a
    // hand in it, so the light-off and the home are the two presses after this one.
    const confirm = await screen.findByTestId('machine-change-confirm-button');
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    const linesBeforeConfirm = z1.lines.length;
    fireEvent.click(confirm);

    await screen.findByTestId('machine-change-record');
    expect(z1.lines.slice(linesBeforeConfirm)).toEqual([]);
    expect(screen.getByTestId('machine-change-record').textContent).toContain('vise → rotary');
    expect(screen.getByTestId('machine-change-record').textContent).toContain('for Zoomba badge');
    expect(screen.getByTestId('machine-change-refreeze').textContent).toContain(
      'frozen for the vise, and the vise is no longer on the machine',
    );
    // The change as asked for is still the story the confirmed screen tells — the new active
    // profile must not relabel step 1 or the take-off as a rotary-to-rotary change.
    expect(screen.getByTestId('machine-change-step-1').textContent).toContain(
      'Vise on the pins → Rotary on the pins',
    );
    expect(screen.getByTestId('machine-change-step-1').textContent).toContain('for Zoomba badge');
    expect(screen.getByTestId('machine-change-step-3').textContent).toContain('Take off the vise');

    const machineWrite = state.writes.find((w) => w.method === 'PUT' && w.path.startsWith('/location/machines/'));
    expect(machineWrite).toBeDefined();
    const written = machineWrite!.body as MachineRecord;
    expect(written.activeBedProfileId).not.toBe('bp-vise');
    const fresh = written.bedProfiles!.find((p) => p.id === written.activeBedProfileId)!;
    expect(fresh.basedOn).toBe('bp-vise');
    expect(fresh.placements).toHaveLength(1);
    expect(fresh.placements[0]?.where).toMatchObject({ kind: 'pins', pins: 'rotary' });
    expect(fresh.datums.viseJawTopZ).toBeNull();
    expect(fresh.datums.rotaryAxis).toBeNull();
    expect(fresh.history.at(-1)?.what).toContain('vise off, rotary on, for Zoomba badge');

    // The two fixtures moved: the vise back to its shelf, the rotary onto this machine.
    const accessoryWrites = state.writes.filter((w) => w.method === 'PUT' && w.path.startsWith('/location/accessories/'));
    expect(accessoryWrites.map((w) => (w.body as FixtureRecord).id).sort()).toEqual(['fx-rotary', 'fx-vise-1']);
    const writtenVise = accessoryWrites.map((w) => w.body as FixtureRecord).find((a) => a.id === 'fx-vise-1')!;
    const writtenRotary = accessoryWrites.map((w) => w.body as FixtureRecord).find((a) => a.id === 'fx-rotary')!;
    expect(writtenVise.whereabouts).toEqual({ kind: 'box' });
    expect(writtenRotary.whereabouts).toMatchObject({ kind: 'machine', machineId: MACHINE_ID });

    // The two closing lines are their own presses, each answered by the machine. The record is
    // already written and "Back to the job" does not wait for them.
    expect(screen.getByTestId('machine-change-final-light').getAttribute('data-done')).toBe('false');
    expect(screen.getByTestId('machine-change-final-home').getAttribute('data-done')).toBe('false');
    expect((screen.getByTestId('machine-change-finish') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('machine-change-light-off'));
    await waitFor(() =>
      expect(screen.getByTestId('machine-change-final-light').getAttribute('data-done')).toBe('true'),
    );
    expect(screen.getByTestId('machine-change-final-light').textContent).toContain('M822 ✓');
    fireEvent.click(screen.getByTestId('machine-change-home-again'));
    await waitFor(() =>
      expect(screen.getByTestId('machine-change-final-home').getAttribute('data-done')).toBe('true'),
    );
    expect(screen.getByTestId('machine-change-final-home').textContent).toContain('$H · Idle · homed ✓');
    // Light off asks `?` and sends M822; home asks `?` and sends `$H` — one action per line.
    expect(z1.lines.slice(linesBeforeConfirm)).toEqual(['?', 'M822', '?', '$H']);
    expect(z1.lines).toContain('M821');

    // The caller gets the outcome on the final press, once.
    expect(done).toEqual([]);
    fireEvent.click(screen.getByTestId('machine-change-finish'));
    await waitFor(() => expect(screen.queryByTestId('machine-change')).toBeNull());
    expect(done).toEqual([
      {
        profileId: written.activeBedProfileId,
        profileName: fresh.name,
        from: 'vise',
        to: 'rotary',
        refreeze: true,
        jobName: 'Zoomba badge',
      },
    ]);
  });

  it('offers the mounts this house can give when no target was asked for (Manage’s entry)', async () => {
    seedLocation();
    fakeMachine({ status: () => sent('?', IDLE) });
    openMachineChange();
    render(<MachineChangeWizard />);

    const targets = await screen.findByTestId('machine-change-targets');
    expect(within(targets).getByTestId('machine-change-target-rotary')).toBeTruthy();
    expect(within(targets).getByTestId('machine-change-target-bed')).toBeTruthy();
    // The vise is already on the machine; it is not offered as a change.
    expect(within(targets).queryByTestId('machine-change-target-vise')).toBeNull();
    expect(screen.getByTestId('machine-change-title').textContent).toContain('Change the machine');
  });
});
