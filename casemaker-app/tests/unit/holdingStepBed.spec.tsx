// @vitest-environment jsdom
// #1102 (ruling B, items 6–9) — THE TAPED ROW SAYS WHAT HOLDS AND WHAT LOCATES. The bed holds two
// facts the old radio could not state: tape holds the blank down, and the bracket may be the fence
// it is pushed into. The two rows stay (`bed-tape` / `bed-bracket`); the taped row gains
// "Located against" and "Tape goes on", the bracket row states its datum as a fact, and the top
// view draws the fence's arms in grey.
//
// THE MACHINE'S STATE IS THE SEAM, as in bedHoldStep.spec.tsx: nothing on the pins, with or
// without the bracket at an anchor.
//
// Existing holding test ids are not renamed or removed: `engrave-setup-mount-bed-tape`,
// `engrave-setup-mount-bed-bracket`, `engrave-setup-bed-fields-bed-tape`,
// `engrave-setup-bed-fields-bed-bracket`, `engrave-setup-holding-picture` and its tape/stock/board
// parts all keep their names (the e2e walks rely on them).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StartWizard } from '@/components/welcome/StartWizard';
import { MachineChangeWizard } from '@/components/machine-change';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { resetMachineChange } from '@/store/machineChangeStore';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  MachineRecordSchema,
  type BedProfile,
  type FixtureRecord,
  type LocationView,
  type MachineRecord,
} from '@/platform/locationClient';
import type { EngraveJob, JobStockEntry } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'location-doc.json');
const DOC = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  id: string;
  name: string;
  createdAt: string;
  machines: unknown[];
  accessories: FixtureRecord[];
};

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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOARDS_AND_TAPE: NonNullable<BedProfile['consumables']> = {
  tape: { widthMm: 20, thicknessMm: 0.2, provenance: 'typed' },
  boards: [{ material: 'MDF', size: [100, 100, 2], count: 4 }],
};

const BARE_SURFACE: BedProfile['surface'] = {
  kind: 'bare-bed',
  material: null,
  length: null,
  width: null,
  thickness: null,
  position: null,
  provenance: {},
  scars: [],
  lastResurfacedAt: null,
};

/** The fixture's machine with NOTHING on the pins, optionally the bracket at an anchor. */
function bedMachine(opts: { anchor?: boolean; anchorAt?: 1 | 2 } = {}): MachineRecord {
  const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  const profile = machine.bedProfiles![0]!;
  profile.placements = profile.placements.filter((pl) => pl.where.kind !== 'pins');
  if (opts.anchor === true) {
    profile.placements.push({
      id: 'pl-bracket',
      fixture: 'fx-bracket-thin',
      where: { kind: 'anchor', anchor: opts.anchorAt ?? 1, pins: null },
      count: null,
      seed: null,
      frame: null,
      provenance: {},
    });
  }
  // A recorded wasteboard, so the board-under question ("Tape goes on") is on offer.
  profile.surface = {
    ...BARE_SURFACE,
    kind: 'wasteboard',
    material: 'MDF',
    thickness: 18,
    length: 300,
    width: 200,
    position: { frontLeft: [20, 30], frame: 'machine' },
  } as BedProfile['surface'];
  profile.consumables = BOARDS_AND_TAPE;
  return machine;
}

function seedLocation(machine: MachineRecord): void {
  const location = {
    kind: 'casemaker-location',
    schemaVersion: 1,
    id: DOC.id,
    name: DOC.name,
    createdAt: DOC.createdAt,
    machines: [machine],
    accessories: DOC.accessories,
  } as unknown as LocationView;
  act(() => {
    useLocationStore.setState({ status: 'present', location, etag: '"e1"', reason: null });
  });
}

function dj(stock: Partial<EngraveJob['stock']> = {}, entry?: JobStockEntry): EngraveJob {
  const job = defaultEngraveJob();
  job.stock = { ...job.stock, ...stock };
  if (entry !== undefined) job.stockEntry = entry;
  return job;
}

function openHolding(job: EngraveJob): void {
  act(() => {
    useEngraveJobStore.setState({ job });
    useStartWizardStore.getState().openWizard('holding');
  });
  render(
    <>
      <StartWizard />
      <MachineChangeWizard />
    </>,
  );
}

const job = (): EngraveJob => useEngraveJobStore.getState().job;
const radio = (mount: string): HTMLInputElement => screen.getByTestId(`engrave-setup-mount-${mount}`) as HTMLInputElement;
const rowText = (mount: string): string => screen.getByTestId(`engrave-setup-mount-row-${mount}`).textContent ?? '';

beforeEach(() => {
  caps.drive = true;
  resetStartWizard();
  resetMachineChange();
  resetLocationStore();
  resetMachineStore();
  useSettingsStore.getState().resetSettings();
  act(() => {
    useEngraveJobStore.setState({ job: dj() });
  });
});

afterEach(() => {
  cleanup();
  resetMachineChange();
  resetLocationStore();
});

describe('#1102 the taped row separates what holds from what locates', () => {
  it('the taped row asks what it is located against', () => {
    seedLocation(bedMachine());
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    expect(radio('bed-tape').checked).toBe(true);
    const fields = screen.getByTestId('engrave-setup-bed-fields-bed-tape');
    expect(fields.contains(screen.getByTestId('engrave-setup-tape-located'))).toBe(true);
    for (const id of ['front', 'corner-1', 'corner-2']) {
      expect(screen.getByTestId(`engrave-setup-tape-located-${id}`), id).toBeTruthy();
    }
    // No bracket on the pins: the front edge is the choice, and it is the one written.
    expect((screen.getByTestId('engrave-setup-tape-located-front') as HTMLInputElement).checked).toBe(true);
    const held = job().workholding;
    expect(held.kind).toBe('tape');
    if (held.kind === 'tape') expect(held.tape.fence ?? null).toBeNull();
  });

  it('with the bracket on the pins the default is the corner at its anchor', () => {
    seedLocation(bedMachine({ anchor: true }));
    // A 6 mm plate opens on the bracket; choosing Tape must keep the bracket as the fence.
    openHolding(dj({ length: 100, width: 60, thickness: 6 }));
    fireEvent.click(radio('bed-tape'));

    const held = job().workholding;
    expect(held.kind).toBe('tape');
    if (held.kind === 'tape') {
      expect(held.tape.fence).toMatchObject({ kind: 'bracket', anchor: 1, variant: 'thin', edges: 'corner' });
      expect(held.tape.squareTo).toBe('fence');
      expect(held.tape.where).toBeNull();
    }
    expect((screen.getByTestId('engrave-setup-tape-located-corner-1') as HTMLInputElement).checked).toBe(true);
  });

  it('with no bracket the corner choices are disabled and say why', () => {
    seedLocation(bedMachine());
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    expect((screen.getByTestId('engrave-setup-tape-located-corner-1') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('engrave-setup-tape-located-corner-2') as HTMLInputElement).disabled).toBe(true);
    const why = screen.getByTestId('engrave-setup-tape-located-needs-bracket');
    expect(why.textContent).toContain('The bracket is not on the pins');
    // The #1104 action is in place, not a dead end.
    expect(screen.getByTestId('engrave-setup-tape-located-change')).toBeTruthy();
  });

  it('each combination writes its document', () => {
    seedLocation(bedMachine({ anchor: true }));
    openHolding(dj({ length: 100, width: 60, thickness: 6 }));
    fireEvent.click(radio('bed-tape'));

    // Corner at anchor 2.
    fireEvent.click(screen.getByTestId('engrave-setup-tape-located-corner-2'));
    let held = job().workholding;
    expect(held.kind).toBe('tape');
    if (held.kind === 'tape') expect(held.tape.fence).toMatchObject({ anchor: 2, edges: 'corner' });

    // Front edge: tape, no fence, squared to the front.
    fireEvent.click(screen.getByTestId('engrave-setup-tape-located-front'));
    held = job().workholding;
    expect(held.kind).toBe('tape');
    if (held.kind === 'tape') {
      expect(held.tape.fence ?? null).toBeNull();
      expect(held.tape.squareTo).toBe('front');
    }

    // Tape goes on the blank (default), or on a board under it — the board is sacrificial.under.
    fireEvent.click(screen.getByTestId('engrave-setup-tape-on-board'));
    expect(job().sacrificial.under?.attach).toBe('tape');
    expect(job().sacrificial.under?.thickness).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('engrave-setup-tape-on-blank'));
    expect(job().sacrificial.under).toBeNull();
  });

  it('each taped hold draws the fence’s arms, and a front-edge hold draws none', () => {
    seedLocation(bedMachine({ anchor: true }));
    openHolding(dj({ length: 100, width: 60, thickness: 6 }));
    fireEvent.click(radio('bed-tape'));
    expect(screen.getAllByTestId('engrave-setup-holding-picture-fence-arm')).toHaveLength(2);
    expect(screen.getByTestId('engrave-setup-holding-caption').textContent).toContain(
      "pushed into the bracket’s corner at anchor 1",
    );

    fireEvent.click(screen.getByTestId('engrave-setup-tape-located-front'));
    expect(screen.queryAllByTestId('engrave-setup-holding-picture-fence-arm')).toHaveLength(0);
  });
});

describe('#1102 the bracket row states its datum', () => {
  it('the bracket row says which corner locates it, as a fact', () => {
    seedLocation(bedMachine({ anchor: true, anchorAt: 2 }));
    openHolding(dj({ length: 100, width: 60, thickness: 6 }));

    expect(radio('bed-bracket').checked).toBe(true);
    // Ruling B item 8 — the row reads as the held-by fact.
    expect(rowText('bed-bracket')).toContain('On the bed, clamped in the bracket');
    const datum = screen.getByTestId('engrave-setup-bracket-located');
    expect(datum.textContent).toContain("the bracket’s corner at anchor 2");
  });
});
