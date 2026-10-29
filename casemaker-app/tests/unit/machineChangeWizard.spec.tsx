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
import { planMountChange } from '@/platform/machineChange';
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

/** #706 — the same location with the bed clear: nothing on the pins, the MDF board still on. */
function bedMachine(): MachineRecord {
  const m = machine();
  m.bedProfiles = m.bedProfiles!.map((p) => ({ ...p, placements: [] }));
  return m;
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

function seedLocation(seed: MachineRecord = machine()): { view: LocationView; writes: Write[] } {
  const state = { view: view(seed), writes: [] as Write[] };
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
    // #717 — the vise and the rotary fit with the machine off: step 2 asks for its own switch (the
    // operator's tick, never an app command), and the work light line moves to after the power
    // returns (step 4), so there is no light button here.
    expect((screen.getByTestId('machine-change-powered-off') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('machine-change-light')).toBeNull();
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
    // #717 — Makera's power order: the fit is done with the machine off at its own switch.
    fireEvent.click(screen.getByTestId('machine-change-powered-off'));
    await waitFor(() => expect(screen.getByTestId('machine-change-power-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-checked'));

    // 3 · Take off the vise — and, because the rotary follows it, the MDF wasteboard (#706).
    await screen.findByTestId('machine-change-take');
    const takeText = screen.getByTestId('machine-change-take').textContent ?? '';
    expect(takeText).toContain('the left fixed jaw off');
    expect(takeText).toContain('the six M5 × 20 screws');
    expect(takeText).toContain('the wasteboard’s screws');
    expect(takeText).toContain('the wasteboard on its shelf');
    for (let i = 0; i < 6; i++) clickCheck(`machine-change-take-${i}`);
    fireEvent.click(screen.getByTestId('machine-change-take-done'));

    // 4 · Fit the rotary in Makera's order: power off, the pins, the screws, the cable, power on,
    // wait, the key. The axis is left for the registration to measure.
    await screen.findByTestId('machine-change-fit');
    const fitText = screen.getByTestId('machine-change-fit').textContent ?? '';
    let at = -1;
    for (const word of [
      'the 4th-axis cable is never plugged in live',
      'the two 4 × 11 mm locating pins',
      'onto the two pins',
      'the three M5 × 10 screws',
      'the 4th-axis cable, rear left',
      'chuck key in the tray',
      'switch the machine on',
      'wait for it to answer',
    ]) {
      const next = fitText.indexOf(word);
      expect(next, word).toBeGreaterThan(at);
      at = next;
    }
    for (let i = 0; i < 8; i++) clickCheck(`machine-change-fit-${i}`);
    expect((screen.getByTestId('machine-change-use-shipped') as HTMLButtonElement).disabled).toBe(true);
    // #725 W13 — WHY it is disabled is on the screen, in the rotary's own words (A10: not a hover
    // title), and no longer the vise's "jaw-top reading".
    expect(screen.getByTestId('machine-change-use-shipped-reason').textContent).toBe(
      'No axis datum has been measured on this machine yet — measure one after fitting.',
    );
    expect(screen.getByTestId('machine-change-use-shipped').getAttribute('title')).toBeNull();
    fireEvent.click(screen.getByTestId('machine-change-measure-now'));
    // #717 — the power is back; the light comes on now, before any hand goes back in.
    fireEvent.click(screen.getByTestId('machine-change-light-again'));
    await waitFor(() =>
      expect(screen.getByTestId('machine-change-light-after-power').getAttribute('data-done')).toBe('true'),
    );
    fireEvent.click(screen.getByTestId('machine-change-fit-done'));
    // #706 — the rotary fit's Done asks the machine (the same status read step 2 uses). It answers
    // Idle here; the step collapsing into its summary and step 5 opening IS that answer.

    // 5 · Confirm — the one write, and it must not move the machine: the operator may still have a
    // hand in it, so the light-off and the home are the two presses after this one.
    const confirm = await screen.findByTestId('machine-change-confirm-button');
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    // The bed line names the board's absence, not the old profile's "wasteboard under".
    expect(screen.getByTestId('machine-change-bed-now').textContent).toContain(
      'Rotary on the pins · wasteboard off',
    );
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
    // #706 — the rotary mounts on the bare bed: the profile says so, and the history keeps it.
    expect(fresh.surface.kind).toBe('bare-bed');
    expect(fresh.surface.thickness).toBeNull();
    expect(fresh.history.at(-1)?.what).toContain('vise off, rotary on, wasteboard off, for Zoomba badge');

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
        wasteboard: 'off',
        bracket: null,
        refreeze: true,
        jobName: 'Zoomba badge',
      },
    ]);
  });

  it('#706 — the rotary fit’s Done waits for the machine to answer after power-on', async () => {
    const state = seedLocation();
    let online = true;
    let homing = false;
    const z1 = fakeMachine({
      status: () =>
        online
          ? sent('?', homing ? IDLE.replace('<Idle', '<Home') : IDLE)
          : { ok: false, reason: 'timeout', line: '?', detail: 'no reply within 6000 ms', text: '' },
    });
    openMachineChange({ target: 'rotary' });
    render(<MachineChangeWizard />);

    // 2 · safe: the initial check found it idle and homed; the switch and the look are the operator's.
    await screen.findByTestId('machine-change-home-line');
    await waitFor(() => expect(screen.getByTestId('machine-change-home-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-powered-off'));
    await waitFor(() => expect(screen.getByTestId('machine-change-power-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-checked'));

    // 3 · take the vise and the board off: the jaw, six screws, off the pins, the shelf, the board.
    await screen.findByTestId('machine-change-take');
    for (let i = 0; i < 6; i++) clickCheck(`machine-change-take-${i}`);
    fireEvent.click(screen.getByTestId('machine-change-take-done'));

    // 4 · the fit — with the machine switched off for the cable, as Makera's guide requires.
    await screen.findByTestId('machine-change-fit');
    for (let i = 0; i < 8; i++) clickCheck(`machine-change-fit-${i}`);
    fireEvent.click(screen.getByTestId('machine-change-measure-now'));
    // #717 — the light comes on once the power is back, before Done.
    fireEvent.click(screen.getByTestId('machine-change-light-again'));
    await waitFor(() =>
      expect(screen.getByTestId('machine-change-light-after-power').getAttribute('data-done')).toBe('true'),
    );

    // Done asks the machine through the same status read step 2 uses. It is still off: no answer,
    // no advance, and the sentence says what to do at the machine's own switch.
    online = false;
    fireEvent.click(screen.getByTestId('machine-change-fit-done'));
    await waitFor(() =>
      expect(screen.getByTestId('machine-change-fit-note').textContent).toContain('has not answered'),
    );
    // #728 — an answer while it is still homing itself is not Done either: wait for Idle.
    homing = true;
    online = true;
    fireEvent.click(screen.getByTestId('machine-change-fit-done'));
    await waitFor(() =>
      expect(screen.getByTestId('machine-change-fit-note').textContent).toContain('reads Home — it is still homing'),
    );
    expect(screen.getByTestId('machine-change-step-4').getAttribute('data-state')).toBe('current');
    homing = false;
    online = false;
    fireEvent.click(screen.getByTestId('machine-change-fit-done'));
    await waitFor(() =>
      expect(screen.getByTestId('machine-change-fit-note').textContent).toContain('has not answered'),
    );
    expect(screen.getByTestId('machine-change-fit-note').textContent).toContain('Switch it on at its switch');
    expect(screen.getByTestId('machine-change-step-4').getAttribute('data-state')).toBe('current');
    expect(screen.queryByTestId('machine-change-confirm-button')).toBeNull();

    // Switched on, the same press goes through; the fit collapses and step 5 opens — the machine's
    // answer is what let it.
    online = true;
    fireEvent.click(screen.getByTestId('machine-change-fit-done'));
    const confirm = await screen.findByTestId('machine-change-confirm-button');
    fireEvent.click(confirm);
    await screen.findByTestId('machine-change-record');

    const machineWrite = state.writes.find((w) => w.method === 'PUT' && w.path.startsWith('/location/machines/'));
    expect(machineWrite).toBeDefined();
    const written = machineWrite!.body as MachineRecord;
    const fresh = written.bedProfiles!.find((p) => p.id === written.activeBedProfileId)!;
    expect(fresh.surface).toMatchObject({ kind: 'bare-bed', thickness: null });
    expect(fresh.history.at(-1)?.what).toContain('wasteboard off');
    // Nothing in Case Maker powered, reset or commanded the machine for the switch: the fit's only
    // line to the controller is the status read.
    expect(z1.lines.filter((line) => line !== '?' && line !== '$H' && line !== 'M821')).toEqual([]);
  });

  it('#706 — a bed with only a wasteboard still takes the board off before the rotary', async () => {
    seedLocation(bedMachine());
    fakeMachine({ status: () => sent('?', IDLE) });
    openMachineChange({ target: 'rotary' });
    render(<MachineChangeWizard />);

    await screen.findByTestId('machine-change-home-line');
    await waitFor(() => expect(screen.getByTestId('machine-change-home-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-powered-off'));
    await waitFor(() => expect(screen.getByTestId('machine-change-power-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-checked'));

    // Nothing is on the pins, but the bed has a board: step 3 is NOT skipped — it is the board's
    // take-off, and the rotary cannot mount until it is off.
    const take = await screen.findByTestId('machine-change-take');
    expect(take.textContent).toContain('the wasteboard’s screws');
    expect(screen.getByTestId('machine-change-step-3').getAttribute('data-state')).toBe('current');
  });

  it('#717 — clearing the pins for a bed job puts the wasteboard back on, after the fixture comes off', async () => {
    // A machine already swapped to the rotary: its active profile is the bare bed, and the
    // original wasteboard is still saved on the earlier profile, ready to come back.
    const toRotary = planMountChange({
      machine: machine(),
      to: 'rotary',
      datum: null,
      profileId: 'bp-rotary',
      at: '2026-10-26T09:21:00.000Z',
      accessories: [VISE, ROTARY],
    });
    if ('error' in toRotary) throw new Error(toRotary.error);
    const state = seedLocation(toRotary.machine);
    fakeMachine({ status: () => sent('?', IDLE) });
    openMachineChange({ target: 'bed' });
    render(<MachineChangeWizard />);

    await screen.findByTestId('machine-change-what');
    expect(screen.getByTestId('machine-change-what').textContent).toContain(
      'Rotary on the pins → Nothing on the pins',
    );

    // 2 · make it safe: the rotary's fit/removal is done with the machine off at its switch.
    await screen.findByTestId('machine-change-home-line');
    await waitFor(() => expect(screen.getByTestId('machine-change-home-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-powered-off'));
    await waitFor(() => expect(screen.getByTestId('machine-change-power-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-checked'));

    // 3 · take the rotary off: cable first, three screws, off the pins.
    await screen.findByTestId('machine-change-take');
    const takeText = screen.getByTestId('machine-change-take').textContent ?? '';
    expect(takeText).toContain('the 4th-axis cable, rear left');
    expect(takeText).toContain('the three M5 × 10 screws');
    for (let i = 0; i < 4; i++) clickCheck(`machine-change-take-${i}`);
    fireEvent.click(screen.getByTestId('machine-change-take-done'));

    // 4 · the ONE change that puts the MDF board back on, and the machine back on after it.
    await screen.findByTestId('machine-change-fit');
    expect(screen.getByTestId('machine-change-step-4').textContent).toContain('Put the wasteboard back on');
    expect(screen.getByTestId('machine-change-fit').textContent).toContain('the wasteboard back on');
    expect(screen.getByTestId('machine-change-fit').textContent).toContain('switch the machine on');
    for (let i = 0; i < 3; i++) clickCheck(`machine-change-fit-${i}`);
    fireEvent.click(screen.getByTestId('machine-change-light-again'));
    await waitFor(() =>
      expect(screen.getByTestId('machine-change-light-after-power').getAttribute('data-done')).toBe('true'),
    );
    fireEvent.click(screen.getByTestId('machine-change-fit-done'));

    // 5 · the bed line reads the restored surface, and the write carries it.
    const confirm = await screen.findByTestId('machine-change-confirm-button');
    expect(screen.getByTestId('machine-change-bed-now').textContent).toContain(
      'Nothing on the pins · wasteboard under',
    );
    fireEvent.click(confirm);
    await screen.findByTestId('machine-change-record');
    const machineWrite = state.writes.find((w) => w.method === 'PUT' && w.path.startsWith('/location/machines/'));
    expect(machineWrite).toBeDefined();
    const written = machineWrite!.body as MachineRecord;
    const fresh = written.bedProfiles!.find((p) => p.id === written.activeBedProfileId)!;
    expect(fresh.surface).toMatchObject({ kind: 'wasteboard', material: 'MDF', thickness: 2 });
    expect(fresh.placements).toEqual([]);
    expect(fresh.history.at(-1)?.what).toContain('rotary off, wasteboard back on');
  });

  it('#718 — a bed job with no bracket gets one fitted at anchor 1, without moving the pins', async () => {
    // A bed-current machine (nothing on the pins, the wasteboard back on) with no bracket at an anchor.
    const toRotary = planMountChange({
      machine: machine(),
      to: 'rotary',
      datum: null,
      profileId: 'bp-rotary',
      at: '2026-10-26T09:21:00.000Z',
      accessories: [VISE, ROTARY],
    });
    if ('error' in toRotary) throw new Error(toRotary.error);
    const toBed = planMountChange({
      machine: toRotary.machine,
      to: 'bed',
      datum: null,
      profileId: 'bp-bed',
      at: '2026-10-26T09:30:00.000Z',
      accessories: toRotary.accessoryWrites,
    });
    if ('error' in toBed) throw new Error(toBed.error);
    const state = seedLocation(toBed.machine);
    fakeMachine({ status: () => sent('?', IDLE) });
    openMachineChange({ target: 'bed', fitBracket: true, forJob: { name: 'Tray', holding: 'held in a bracket and clamps on the bed' } });
    render(<MachineChangeWizard />);

    // 1 · What changes: the bracket at anchor 1, the anchor a choice here (Makera's default is 1).
    await screen.findByTestId('machine-change-what');
    expect(screen.getByTestId('machine-change-title').textContent).toContain('Bracket at anchor 1 on');
    expect(screen.getByTestId('machine-change-what').textContent).toContain('bracket at anchor 1');
    expect((screen.getByTestId('machine-change-bracket-anchor') as HTMLSelectElement).value).toBe('1');

    // 2 · safe: the machine stays ON for a bracket fit — the light line is here, not after a power-on.
    await screen.findByTestId('machine-change-home-line');
    await waitFor(() => expect(screen.getByTestId('machine-change-home-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-light'));
    await waitFor(() => expect(screen.getByTestId('machine-change-light-line').getAttribute('data-done')).toBe('true'));
    fireEvent.click(screen.getByTestId('machine-change-checked'));

    // 3 · nothing was on the pins, so step 3 is the empty line and step 4 opens.
    await screen.findByTestId('machine-change-fit');
    expect(screen.getByTestId('machine-change-step-3').getAttribute('data-state')).toBe('done');
    expect(screen.getByTestId('machine-change-step-4').textContent).toContain('Fit the bracket');
    const fitText = screen.getByTestId('machine-change-fit').textContent ?? '';
    for (const word of [
      "the thin L-bracket into anchor 1's corner",
      'its two 4 mm dowels',
      'its three M5 × 20 screws',
      'two top clamps in the tray',
    ]) {
      expect(fitText).toContain(word);
    }
    // #718 — the machine never went off for this fit, so the list does not switch it back on.
    expect(fitText).not.toContain('switch the machine on');
    for (let i = 0; i < 4; i++) clickCheck(`machine-change-fit-${i}`);
    fireEvent.click(screen.getByTestId('machine-change-fit-done'));

    // 5 · Confirm names the bracket, and the write carries the placement and the record.
    const confirm = await screen.findByTestId('machine-change-confirm-button');
    expect(screen.getByTestId('machine-change-bed-now').textContent).toContain(
      'Nothing on the pins · bracket at anchor 1 · wasteboard under',
    );
    expect(screen.getByTestId('machine-change-record-preview').textContent).toContain('bracket at anchor 1 on');
    fireEvent.click(confirm);
    await screen.findByTestId('machine-change-record');
    // #725 W14 — after the write the wizard still names the BRACKET: the request's own fit flag
    // turns false once the new profile carries the anchor, so the RESULT is what the title reads.
    expect(screen.getByTestId('machine-change-title').textContent).toContain('Bracket at anchor 1 on');
    expect(screen.getByTestId('machine-change-record').textContent).toContain('bracket at anchor 1 on');
    expect(screen.getByTestId('machine-change-title').textContent).not.toContain('Bed unchanged');

    const machineWrite = state.writes.find((w) => w.method === 'PUT' && w.path.startsWith('/location/machines/'));
    expect(machineWrite).toBeDefined();
    const written = machineWrite!.body as MachineRecord;
    const fresh = written.bedProfiles!.find((p) => p.id === written.activeBedProfileId)!;
    expect(fresh.placements).toEqual([
      expect.objectContaining({ id: 'pl-bracket', where: expect.objectContaining({ kind: 'anchor', anchor: 1 }) }),
    ]);
    expect(fresh.surface.kind).toBe('wasteboard');
    expect(fresh.history.at(-1)?.what).toContain('nothing on the pins, bracket at anchor 1, for Tray');
    const bracketWrite = state.writes.find(
      (w) => w.method === 'PUT' && w.path === '/location/accessories/fx-bracket-thin',
    );
    expect(bracketWrite).toBeDefined();
    expect((bracketWrite!.body as FixtureRecord).variant).toBe('thin');
  });

  it('#725 P14 — a jaw datum the active bed MEASURED reads “measured”, not “shipped value”', async () => {
    // The exercise's machine: the vise is off the pins, and the active profile still carries the
    // jaw-top reading taken on this very bed. That is this machine's measurement, not a carry-over.
    const base = machine();
    const bareBed = { ...base, bedProfiles: [{ ...base.bedProfiles![0]!, placements: [], preferredMounting: [] }] };
    seedLocation(bareBed);
    fakeMachine({ status: () => sent('?', IDLE) });
    openMachineChange({ target: 'vise' });
    render(<MachineChangeWizard />);

    await screen.findByTestId('machine-change-what');
    const line = screen.getByTestId('machine-change-step-4').textContent ?? '';
    expect(line).toContain('jaw datum: measured');
    expect(line).not.toContain('shipped value');
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
