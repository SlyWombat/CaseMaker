/**
 * #693 — the change-the-machine rules, pinned without a DOM or a socket.
 *
 * The pure half is the OUTCOME: which profile becomes active, what its placements and datums are,
 * what the history says, where the two fixtures' accessory records end up. The machine's own answers
 * (the status reading, the offline answer, `$H`'s wait for Idle-at-rest) are `machineChangeRun.spec.ts`;
 * `machineChangeWizard.spec.tsx` drives the same write through the modal.
 */

import { describe, expect, it } from 'vitest';
import {
  MACHINE_MOUNT_WORDS,
  activeMountOf,
  changePowersOff,
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
import { MachineRecordSchema, type FixtureRecord, type MachineRecord } from '@/platform/locationClient';

const NOW = '2026-10-26T09:20:00.000Z';
const MACHINE_ID = 'machine-1a2b3c';
const TARGET = { host: '192.168.10.43', port: 2222 };

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

  it('names the steps in Makera’s install order, with the wasteboard and power rules (#706/#717)', () => {
    expect(changeHeadline('vise', 'rotary')).toBe('Vise off · rotary on');
    expect(changeRecordWords('vise', 'rotary')).toBe('vise → rotary');
    // #717 — Makera's vise install, reversed: the jaw off to reach the six screws, then off the pins.
    expect(takeOffSteps('vise')?.items).toEqual([
      'the left fixed jaw off',
      'the six M5 × 20 screws',
      'lift it straight up off the two pins',
      'on its shelf',
    ]);
    // A legacy record can still show the vise over a wasteboard: the board comes off after it.
    expect(takeOffSteps('vise', { wasteboard: 'off' })?.items).toEqual([
      'the left fixed jaw off',
      'the six M5 × 20 screws',
      'lift it straight up off the two pins',
      'on its shelf',
      'the wasteboard’s screws',
      'the wasteboard on its shelf',
    ]);
    // The rotary comes off cable-first: it is never unplugged live (the switch is step 2's line).
    expect(takeOffSteps('rotary')?.items).toEqual([
      'the 4th-axis cable, rear left',
      'the three M5 × 10 screws',
      'lift it straight up',
      'on its shelf',
    ]);
    // The fit is Makera's order: the pins, the three screws, the cable, power on, wait.
    expect(fitSteps('rotary')?.items).toEqual([
      'the 4th-axis cable is never plugged in live',
      'onto the two pins',
      'the three M5 × 10 screws',
      'the 4th-axis cable, rear left',
      'switch the machine on',
      'wait for it to answer',
      'chuck key in the tray',
    ]);
    // #717 — Makera's vise page, in its own order. The wasteboard is NEVER put back under it: the
    // first thing Makera says is to remove it.
    expect(fitSteps('vise')?.items).toEqual([
      'the two 4 × 11 mm locating pins',
      'the vise onto the pins',
      'the left fixed jaw off',
      'the six M5 × 20 screws',
      'the fixed jaw back on, its locating key seated',
      'switch the machine on',
    ]);
    expect(fitSteps('vise', { wasteboard: 'back' })?.items).toEqual(fitSteps('vise')?.items);
    // The ONE change that puts the board back on: clearing the pins for a bed job.
    expect(fitSteps('bed', { wasteboard: 'back' })?.items).toEqual([
      'the wasteboard back on',
      'its screws',
      'switch the machine on',
    ]);
    // #718 — the bracket's fit step, on the board when one comes back, and on its own otherwise.
    const bracketItems = [
      "the thin L-bracket into anchor 1's corner",
      'its two 4 mm dowels',
      'its three M5 × 20 screws',
      'two top clamps in the tray',
      'switch the machine on',
    ];
    expect(fitSteps('bed', { bracket: 1 })?.title).toBe('Fit the bracket');
    expect(fitSteps('bed', { bracket: 1 })?.items).toEqual(bracketItems);
    expect(fitSteps('bed', { wasteboard: 'back', bracket: 2 })?.items).toEqual([
      'the wasteboard back on',
      'its screws',
      "the thin L-bracket into anchor 2's corner",
      'its two 4 mm dowels',
      'its three M5 × 20 screws',
      'two top clamps in the tray',
      'switch the machine on',
    ]);
    expect(changeHeadline('vise', 'bed', 1)).toBe('Vise off · bracket at anchor 1 on');
    expect(changeHeadline('bed', 'bed', 1)).toBe('Bracket at anchor 1 on');
    expect(changeRecordWords('bed', 'bed', 1)).toBe('bracket at anchor 1 on');
    // Nothing on the pins but a board on the bed: the board is still a take-off.
    expect(takeOffSteps('bed', { wasteboard: 'off' })?.items).toEqual([
      'the wasteboard’s screws',
      'the wasteboard on its shelf',
    ]);
    expect(takeOffSteps('bed')).toBeNull();
    expect(fitSteps('bed')).toBeNull();
    // #717 — every change that touches the vise or the rotary is made with the machine off.
    expect(changePowersOff('vise', 'rotary')).toBe(true);
    expect(changePowersOff('rotary', 'vise')).toBe(true);
    expect(changePowersOff('vise', 'bed')).toBe(true);
    expect(changePowersOff('bed', 'vise')).toBe(true);
    expect(changePowersOff('bed', 'bed')).toBe(false);
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
      what: 'created from "Vise on the pins, bare bed": vise off, rotary on, wasteboard off, for Zoomba badge',
    });
    // #706 — Makera's module mounts on the BARE bed: the MDF wasteboard comes off with the vise,
    // and the new profile says so. The old profile keeps the board's measurements and scars.
    expect(plan.wasteboard).toBe('off');
    expect(plan.profile.surface).toMatchObject({
      kind: 'bare-bed',
      material: null,
      thickness: null,
      scars: [],
    });
    expect(old.surface).toMatchObject({ kind: 'wasteboard', thickness: 2 });

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

  it('#717 — rotary → vise stays on the BARE bed: Makera takes the wasteboard off for the vise too', () => {
    const toRotary = planMountChange({
      machine: machineRecord(),
      to: 'rotary',
      datum: null,
      profileId: 'bp-rotary',
      at: NOW,
      accessories: [VISE, ROTARY],
    });
    if ('error' in toRotary) throw new Error(toRotary.error);
    const back = planMountChange({
      machine: toRotary.machine,
      to: 'vise',
      datum: null,
      profileId: 'bp-back',
      at: '2026-10-26T10:00:00.000Z',
      accessories: toRotary.accessoryWrites,
    });
    if ('error' in back) throw new Error(back.error);
    // No restore step, no "wasteboard under": the vise's own first step is to remove it.
    expect(back.wasteboard).toBeNull();
    expect(back.profile.surface).toMatchObject({ kind: 'bare-bed' });
    expect(back.profile.history.at(-1)?.what).toContain('rotary off, vise on');
    expect(back.profile.placements.some((p) => p.where.kind === 'pins' && p.where.pins === 'vise')).toBe(true);
    expect(MachineRecordSchema.safeParse(back.machine).success).toBe(true);
  });

  it('#718 — fitting the bracket writes its placement and its fixture record, and moves no pins', () => {
    // A bed job's machine: nothing on the pins, the wasteboard back on, no bracket yet.
    const toRotary = planMountChange({
      machine: machineRecord(),
      to: 'rotary',
      datum: null,
      profileId: 'bp-rotary',
      at: NOW,
      accessories: [VISE, ROTARY],
    });
    if ('error' in toRotary) throw new Error(toRotary.error);
    const toBed = planMountChange({
      machine: toRotary.machine,
      to: 'bed',
      datum: null,
      profileId: 'bp-bed',
      at: '2026-10-26T10:00:00.000Z',
      accessories: toRotary.accessoryWrites,
    });
    if ('error' in toBed) throw new Error(toBed.error);

    const fit = planMountChange({
      machine: toBed.machine,
      to: 'bed',
      datum: null,
      profileId: 'bp-bracket',
      at: '2026-10-26T10:30:00.000Z',
      accessories: toBed.accessoryWrites,
      bracket: { anchor: 1 },
      jobName: 'Tray',
    });
    if ('error' in fit) throw new Error(fit.error);
    expect(fit.bracket).toBe(1);
    expect(fit.from).toBe('bed');
    expect(fit.to).toBe('bed');
    expect(fit.headline).toBe('Bracket at anchor 1 on');
    // The placement is the bracket's, at anchor 1; nothing on the pins moved.
    expect(fit.profile.placements).toEqual([
      expect.objectContaining({ id: 'pl-bracket', fixture: 'fx-bracket-thin', where: expect.objectContaining({ kind: 'anchor', anchor: 1 }) }),
    ]);
    // The bracket's own record is created and checked out to this machine.
    expect(fit.accessoryWrites).toEqual([
      expect.objectContaining({
        id: 'fx-bracket-thin',
        kind: 'bracket',
        variant: 'thin',
        whereabouts: expect.objectContaining({ kind: 'machine', machineId: MACHINE_ID }),
      }),
    ]);
    expect(fit.profile.history.at(-1)?.what).toContain('nothing on the pins, bracket at anchor 1, for Tray');
    expect(MachineRecordSchema.safeParse(fit.machine).success).toBe(true);
    // A second fit at the same bed is the same write — the bracket is already there, so nothing
    // is added twice; the wizard does not offer the step when the bed carries one.
    const again = planMountChange({
      machine: toBed.machine,
      to: 'bed',
      datum: null,
      profileId: 'bp-bracket-2',
      at: '2026-10-26T11:00:00.000Z',
      accessories: toBed.accessoryWrites,
      bracket: { anchor: 2 },
    });
    if ('error' in again) throw new Error(again.error);
    expect(again.profile.placements.filter((p) => p.where.kind === 'anchor')).toHaveLength(1);
  });

  it('#717 — a change to a bed job puts the wasteboard back on, from the newest saved board profile', () => {
    const toRotary = planMountChange({
      machine: machineRecord(),
      to: 'rotary',
      datum: null,
      profileId: 'bp-rotary',
      at: NOW,
      accessories: [VISE, ROTARY],
    });
    if ('error' in toRotary) throw new Error(toRotary.error);
    const toBed = planMountChange({
      machine: toRotary.machine,
      to: 'bed',
      datum: null,
      profileId: 'bp-bed',
      at: '2026-10-26T10:00:00.000Z',
      accessories: toRotary.accessoryWrites,
    });
    if ('error' in toBed) throw new Error(toBed.error);
    expect(toBed.wasteboard).toBe('back');
    expect(toBed.profile.surface).toMatchObject({ kind: 'wasteboard', material: 'MDF', thickness: 2 });
    expect(toBed.profile.history.at(-1)?.what).toContain('rotary off, wasteboard back on');
    // The written record still parses — the restored surface is a schema-valid wasteboard row.
    expect(MachineRecordSchema.safeParse(toBed.machine).success).toBe(true);
    // A bed job can now be held on it; nothing is on the pins.
    expect(activeMountOf(toBed.machine)).toBe('bed');
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
