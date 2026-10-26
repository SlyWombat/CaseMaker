/**
 * #693 — the change-the-machine rules, pinned without a DOM or a socket.
 *
 * The pure half is the OUTCOME: which profile becomes active, what its placements and datums are,
 * what the history says, where the two fixtures' accessory records end up. The machine half is the
 * three answers step 2 reads: a status line's state and homed rest, the offline answer, and `$H`'s
 * wait for Idle-at-rest. `machineChangeWizard.spec.tsx` drives the same write through the modal.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  MACHINE_MOUNT_WORDS,
  activeMountOf,
  activeProfileOf,
  changeHeadline,
  changeRecordWords,
  datumDescriptorFor,
  fitSteps,
  planMountChange,
  profileHolds,
  refreezeSentence,
  shippedDatumFor,
  shippedDatumProfileName,
  surfaceWords,
  takeOffSteps,
  targetMountsFor,
} from '@/platform/machineChange';
import { checkMachine, homeMachine, readMachineRest } from '@/platform/machineChangeRun';
import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleSession } from '@/platform/machineConsole';
import { readStatusLine } from '@/platform/desktop/protocol';
import { MachineRecordSchema, type FixtureRecord, type MachineRecord } from '@/platform/locationClient';

const NOW = '2026-10-26T09:20:00.000Z';
const MACHINE_ID = 'machine-1a2b3c';
const TARGET = { host: '192.168.10.43', port: 2222 };
const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|WPos:147.4000,123.8000,57.6325|T:6,-17.696,-1>';
const IDLE_AWAY = '<Idle|MPos:-160.5000,-188.0000,-55.0000|WPos:19.6000,4.7000,0.4000>';
const HOMING = '<Home|MPos:-11.6000,-14.6000,-3.0000>';
const ALARM = '<Alarm|MPos:0.0000,0.0000,0.0000>';

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

/** A machine as the location serves it: a wasteboard bed with the vise on the pins. */
function machineRecord(over: Partial<MachineRecord> = {}): MachineRecord {
  return MachineRecordSchema.parse({
    id: MACHINE_ID,
    profileId: 'Z1',
    name: 'Makera_Z1_000000',
    nickname: 'Zoomba',
    serial: null,
    firmware: null,
    address: TARGET,
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
          surfaceTopZ: { value: -55.02, measuredAt: '2026-10-24T00:00:00.000Z', by: 'fx-probe-1', at: null },
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
        preferredMounting: [
          { stock: 'plate', mount: { placement: 'pl-vise', manner: 'jaws' } },
          { stock: 'sheet', mount: { placement: null, manner: 'tape' } },
        ],
        consumables: null,
        history: [{ at: '2026-10-24T00:00:00.000Z', what: 'created at the first vise registration' }],
      },
    ],
    activeBedProfileId: 'bp-vise',
    updatedAt: '2026-10-24T00:00:00.000Z',
    ...over,
  });
}

/** A second, earlier profile that measured the rotary axis — the "shipped value" the wizard carries. */
function withOldRotaryDatum(machine: MachineRecord): MachineRecord {
  const old = machine.bedProfiles![0]!;
  return {
    ...machine,
    bedProfiles: [
      ...machine.bedProfiles!,
      {
        ...old,
        id: 'bp-rotary-old',
        name: 'Rotary on the pins',
        createdAt: '2026-10-20T00:00:00.000Z',
        datums: {
          ...old.datums,
          viseJawTopZ: null,
          rotaryAxis: { value: -48.25, measuredAt: '2026-10-20T00:00:00.000Z', by: 'fx-probe-1', at: [10, 20] },
        },
        placements: [
          { ...old.placements[0]!, id: 'pl-rotary', fixture: 'fx-rotary', where: { kind: 'pins', pins: 'rotary', anchor: null } },
        ],
        history: [{ at: '2026-10-20T00:00:00.000Z', what: 'created at the first rotary fitting' }],
      },
    ],
  };
}

describe('#693 what is on the machine', () => {
  it('reads the mount off the active profile’s pins placement', () => {
    expect(activeMountOf(machineRecord())).toBe('vise');
    const rotary = machineRecord();
    rotary.bedProfiles![0]!.placements = [
      { ...rotary.bedProfiles![0]!.placements[0]!, id: 'pl-rotary', fixture: 'fx-rotary', where: { kind: 'pins', pins: 'rotary', anchor: null } },
    ];
    expect(activeMountOf(rotary)).toBe('rotary');
    rotary.bedProfiles![0]!.placements = [];
    expect(activeMountOf(rotary)).toBe('bed');
    expect(activeMountOf(null)).toBe('bed');
  });

  it('offers the mounts the house owns, never the one already fitted', () => {
    const machine = machineRecord();
    expect(targetMountsFor(machine, [VISE, ROTARY])).toEqual(['rotary', 'bed']);
    expect(targetMountsFor(machine, [VISE])).toEqual(['bed']);
  });

  it('names the steps in the mockup’s words', () => {
    expect(changeHeadline('vise', 'rotary')).toBe('Vise off · rotary on');
    expect(changeRecordWords('vise', 'rotary')).toBe('vise → rotary');
    expect(takeOffSteps('vise')?.items).toEqual(['the two pin bolts', 'lift it straight up', 'on its shelf']);
    expect(fitSteps('rotary')?.items).toEqual(['onto the pins', 'the 4th-axis cable', 'chuck key in the tray']);
    expect(takeOffSteps('bed')).toBeNull();
    expect(fitSteps('bed')).toBeNull();
    expect(datumDescriptorFor('rotary')).toEqual({ key: 'rotaryAxis', word: 'axis datum' });
    expect(surfaceWords(machineRecord().bedProfiles![0]!.surface)).toBe('wasteboard under');
    expect(MACHINE_MOUNT_WORDS.rotary).toBe('Rotary on the pins');
  });
});

describe('#693 the change the wizard writes', () => {
  it('copies the active profile into a new one: rotary on the pins, the vise’s datums and mounting gone', () => {
    const machine = machineRecord();
    const old = machine.bedProfiles![0]!;
    const plan = planMountChange({
      machine,
      to: 'rotary',
      datum: null,
      profileId: 'bp-new',
      at: NOW,
      jobName: 'Zoomba badge',
      accessories: [VISE, ROTARY],
    });
    if ('error' in plan) throw new Error(plan.error);

    expect(plan.from).toBe('vise');
    expect(plan.to).toBe('rotary');
    expect(plan.headline).toBe('Vise off · rotary on');
    expect(plan.profile.id).toBe('bp-new');
    expect(plan.profile.name).toBe('Vise off · rotary on — 2026-10-26');
    expect(plan.profile.basedOn).toBe('bp-vise');
    expect(plan.profile.placements).toHaveLength(1);
    expect(plan.profile.placements[0]).toMatchObject({
      fixture: 'fx-rotary',
      where: { kind: 'pins', pins: 'rotary' },
      frame: null,
    });
    // The datum that belonged to the fixture that came off is cleared; the surface's stays.
    expect(plan.profile.datums.viseJawTopZ).toBeNull();
    expect(plan.profile.datums.surfaceTopZ?.value).toBe(-55.02);
    // A mounting that named the placement which is gone is dropped; tape survives.
    expect(plan.profile.preferredMounting).toEqual([{ stock: 'sheet', mount: { placement: null, manner: 'tape' } }]);
    expect(plan.profile.history.at(-1)).toEqual({
      at: NOW,
      what: 'created from "Vise on the pins, bare bed": vise off, rotary on, for Zoomba badge',
    });
    // The surface and its scars carry over: the wasteboard did not move.
    expect(plan.profile.surface.thickness).toBe(2);

    // The old profile is untouched, and the machine now names the new one.
    expect(machine.bedProfiles![0]).toBe(old);
    expect(old.datums.viseJawTopZ?.value).toBe(-56.82);
    expect(plan.machine.activeBedProfileId).toBe('bp-new');
    expect(plan.machine.bedProfiles).toHaveLength(2);

    // The two fixtures' whereabouts move with them.
    expect(plan.accessoryWrites).toHaveLength(2);
    expect(plan.accessoryWrites[0]).toMatchObject({ id: 'fx-vise-1', whereabouts: { kind: 'box' } });
    expect(plan.accessoryWrites[1]).toMatchObject({
      id: 'fx-rotary',
      whereabouts: { kind: 'machine', machineId: MACHINE_ID, since: NOW },
    });
  });

  it('writes a machine record that reads back through the schema', () => {
    const plan = planMountChange({
      machine: machineRecord(),
      to: 'rotary',
      datum: null,
      profileId: 'bp-new',
      at: NOW,
      accessories: [VISE, ROTARY],
    });
    if ('error' in plan) throw new Error(plan.error);
    const parsed = MachineRecordSchema.safeParse(plan.machine);
    expect(parsed.success).toBe(true);
  });

  it('carries the chosen shipped datum onto the incoming fixture and clears the outgoing one', () => {
    const machine = withOldRotaryDatum(machineRecord());
    // The newest rotary-axis reading lives on an OLDER profile; the wizard offers it.
    expect(shippedDatumFor(machine, 'rotaryAxis')?.value).toBe(-48.25);
    expect(shippedDatumProfileName(machine, 'rotaryAxis')).toBe('Rotary on the pins');

    const plan = planMountChange({
      machine,
      to: 'rotary',
      datum: shippedDatumFor(machine, 'rotaryAxis'),
      profileId: 'bp-new',
      at: NOW,
      accessories: [VISE, ROTARY],
    });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.profile.datums.rotaryAxis?.value).toBe(-48.25);
    expect(plan.profile.datums.rotaryAxis?.measuredAt).toBe('2026-10-20T00:00:00.000Z');
  });

  it('leaves the rotary axis unmeasured when the operator chose to measure it after fitting', () => {
    const plan = planMountChange({
      machine: machineRecord(),
      to: 'rotary',
      datum: null,
      profileId: 'bp-new',
      at: NOW,
      accessories: [VISE, ROTARY],
    });
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.profile.datums.rotaryAxis).toBeNull();
  });

  it('refuses a change to what is already fitted, and a fixture the house does not own', () => {
    const same = planMountChange({
      machine: machineRecord(),
      to: 'vise',
      datum: null,
      profileId: 'bp-new',
      at: NOW,
      accessories: [VISE, ROTARY],
    });
    expect(same).toEqual({ error: 'Vise on the pins is already on the machine.' });

    const missing = planMountChange({
      machine: machineRecord(),
      to: 'rotary',
      datum: null,
      profileId: 'bp-new',
      at: NOW,
      accessories: [VISE],
    });
    expect(missing).toEqual({ error: 'The house does not own a rotary module, so there is nothing to fit.' });
  });

  it('refuses when the machine has no bed described', () => {
    const plan = planMountChange({
      machine: machineRecord({ bedProfiles: undefined, activeBedProfileId: undefined }),
      to: 'rotary',
      datum: null,
      profileId: 'bp-new',
      at: NOW,
      accessories: [VISE, ROTARY],
    });
    expect(plan).toEqual({ error: 'This machine has no bed described yet — set the bed up in Manage first.' });
    expect(activeProfileOf(machineRecord({ bedProfiles: undefined, activeBedProfileId: undefined }))).toBeNull();
  });
});

describe('#693 the frozen job’s mount', () => {
  it('says which mounts a profile can still hold', () => {
    const vise = machineRecord().bedProfiles![0]!;
    expect(profileHolds(vise, 'vise')).toBe(true);
    expect(profileHolds(vise, 'tape')).toBe(true);
    expect(profileHolds(vise, 'rotary')).toBe(false);
    expect(profileHolds(vise, 'bracket')).toBe(false);
    expect(profileHolds(vise, null)).toBe(true);
  });

  it('flags a frozen vise job once the vise is off the pins', () => {
    const plan = planMountChange({
      machine: machineRecord(),
      to: 'rotary',
      datum: null,
      profileId: 'bp-new',
      at: NOW,
      accessories: [VISE, ROTARY],
    });
    if ('error' in plan) throw new Error(plan.error);
    expect(profileHolds(plan.profile, 'vise')).toBe(false);
    expect(refreezeSentence('Zoomba badge', 'vise')).toBe(
      '“Zoomba badge” is frozen for the vise, and the vise is no longer on the machine — Generate it again before cutting.',
    );
  });
});

describe('#693 the machine’s own answers', () => {
  it('reads the homed rest, and only the homed rest, as homed', () => {
    expect(readMachineRest(IDLE)).toMatchObject({ state: 'Idle', x: -1, y: -1, z: -1, homed: true });
    expect(readMachineRest(IDLE_AWAY)).toMatchObject({ state: 'Idle', homed: false });
    expect(readMachineRest(HOMING)).toMatchObject({ state: 'Home', homed: false });
    expect(readMachineRest(ALARM)).toMatchObject({ state: 'Alarm', homed: false });
    expect(readMachineRest('???')).toBeNull();
    expect(readMachineRest(null)).toBeNull();
  });

  it('agrees with the desktop status reader over the bench’s own lines', () => {
    for (const line of [IDLE, IDLE_AWAY, HOMING, ALARM]) {
      const mine = readMachineRest(line)!;
      const theirs = readStatusLine(line);
      expect(mine.state).toBe(theirs.state);
      expect([mine.x, mine.y, mine.z]).toEqual([theirs.mpos.x, theirs.mpos.y, theirs.mpos.z]);
    }
  });
});

function fakeConsole(answer: (line: string) => ConsoleSend): { sent: string[] } {
  const sent: string[] = [];
  const session: MachineConsoleSession = {
    async send(line) {
      sent.push(line);
      return answer(line);
    },
    async close() {},
  };
  setMachineConsoleLoader(async () => ({ async open() { return session; } }));
  return { sent };
}

afterEach(() => setMachineConsoleLoader(null));

const sent = (line: string, text: string): ConsoleSend => ({ ok: true, line, text, frames: 1, elapsedMs: 10 });

describe('#693 asking the machine', () => {
  it('answers online with the rest it read', async () => {
    fakeConsole((line) => sent(line, IDLE));
    const r = await checkMachine(TARGET);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.rest.homed).toBe(true);
  });

  it('answers offline with the transport’s own sentence', async () => {
    fakeConsole((line) => ({ ok: false, reason: 'timeout', line, detail: 'no reply within 6000 ms', text: '' }));
    const r = await checkMachine(TARGET);
    expect(r).toEqual({ kind: 'no', detail: 'no reply within 6000 ms' });
  });

  it('answers an alarm as a machine that cannot be made safe', async () => {
    fakeConsole((line) => sent(line, `${ALARM}\nALARM: Probe fail`));
    const r = await checkMachine(TARGET);
    expect(r.kind).toBe('no');
    // The first line carrying the dialect's alarm words IS the status line; either way the answer
    // names the alarm rather than calling the machine ready.
    if (r.kind === 'no') expect(r.detail).toContain('alarm');
  });

  it('homes on $H and waits for Idle at the homed rest, not for the macro’s acknowledgement', async () => {
    let asked = 0;
    const z1 = fakeConsole((line) => {
      if (line === '?') {
        asked += 1;
        // Idle but away from home first (the guard passes); the homed rest after `$H`.
        return sent(line, asked === 1 ? IDLE_AWAY : IDLE);
      }
      return sent(line, 'ok');
    });
    const r = await homeMachine(TARGET, { polls: 2, pollMs: 0 });
    expect(r.kind).toBe('homed');
    expect(z1.sent[0]).toBe('?');
    expect(z1.sent[1]).toBe('$H');
    expect(z1.sent).toContain('?');
  });

  it('refuses to home a machine that is running, and sends nothing', async () => {
    const z1 = fakeConsole((line) => sent(line, '<Run|MPos:-162.0500,-162.2000,-3.0000|P:0,12,4>'));
    const r = await homeMachine(TARGET, { polls: 2, pollMs: 0 });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.detail).toContain('Run');
    expect(z1.sent).toEqual(['?']);
  });

  it('does not call a machine that stays away from home homed', async () => {
    fakeConsole((line) => (line === '?' ? sent(line, IDLE_AWAY) : sent(line, 'ok')));
    const r = await homeMachine(TARGET, { polls: 2, pollMs: 0 });
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.detail).toContain('not at its homed rest');
  });

  it('reports a refused $H without claiming the head moved', async () => {
    fakeConsole((line) =>
      line === '?'
        ? sent(line, IDLE_AWAY)
        : { ok: false, reason: 'refused', line, detail: 'the console refuses that line', text: '' },
    );
    const r = await homeMachine(TARGET, { polls: 1, pollMs: 0 });
    expect(r).toEqual({ kind: 'failed', detail: 'the console refuses that line' });
  });
});
