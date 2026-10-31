// @vitest-environment jsdom
// #715 (BM-2 of #707) — Holding writes the bed: the two options as real choices, their lines and
// pictures, and the clamp handles dragged on the picture (design stations 2–3).
//
// THE MACHINE'S STATE IS THE SEAM, as in `holdingStep.spec.tsx`: the step reads the location's
// first machine, so each test seeds a machine record whose active bed profile is the one under
// test — nothing on the pins, with or without the bracket at anchor 1, on the wasteboard or the
// bare bed.

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
import { resetMachineChange, useMachineChangeStore } from '@/store/machineChangeStore';
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
import type { EngraveJob, EngraveShape, JobStockEntry } from '@/types/engraveJob';

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
    get canDriveMachine() {
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

/**
 * The fixture's machine with NOTHING ON THE PINS (its vise placement removed), its bed optionally
 * carrying the bracket at anchor 1 and optionally a bare bed.
 */
function bedMachine(opts: { anchor?: boolean; anchorAt?: 1 | 2; bare?: boolean; consumables?: NonNullable<BedProfile['consumables']> | null } = {}): MachineRecord {
  const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  const profile = machine.bedProfiles![0]!;
  profile.placements = profile.placements.filter((pl) => pl.where.kind !== 'pins');
  if (opts.anchor === true) {
    profile.placements.push({
      id: 'pl-bracket',
      fixture: 'fx-bracket-thin',
      where: { kind: 'anchor', anchor: opts.anchorAt ?? 1, pins: null },
      count: null,
      frame: null,
      provenance: {},
    });
  }
  profile.surface = opts.bare === true ? { ...BARE_SURFACE } : { ...profile.surface, length: 300, width: 200, position: { frontLeft: [20, 30], frame: 'machine' } };
  profile.consumables = opts.consumables === undefined ? BOARDS_AND_TAPE : opts.consumables;
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
function rowText(mount: string): string {
  return screen.getByTestId(`engrave-setup-mount-row-${mount}`).textContent ?? '';
}
function radio(mount: string): HTMLInputElement {
  return screen.getByTestId(`engrave-setup-mount-${mount}`) as HTMLInputElement;
}

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

describe('#715 with nothing on the pins, the bed options are real choices', () => {
  it('a plate takes the bed’s default mount: taped, with the house roll and its lines', () => {
    seedLocation(bedMachine());
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    // The default is written: the job is taped, with the roll’s width and the typed thickness.
    const held = job().workholding;
    expect(held.kind).toBe('tape');
    if (held.kind === 'tape') {
      expect(held.tape).toMatchObject({ width: 20, thickness: 0.2, inset: 2, where: null, squareTo: 'front' });
    }
    expect(radio('bed-tape').checked).toBe(true);
    expect(rowText('bed-tape')).toContain('two strips of the 20 mm tape, 2 mm in from every edge');

    // Its fields: what is under it (the record's words, never asked), the board, where, square to.
    const fields = screen.getByTestId('engrave-setup-bed-fields-bed-tape');
    // The FIELD's length: "Under it  wasteboard" — the top line carries "wasteboard under".
    expect(fields.textContent).toContain('Under itwasteboard');
    expect(screen.getByTestId('engrave-setup-tape-where').textContent).toBe('the middle of the bed');
    expect((screen.getByTestId('engrave-setup-bed-board') as HTMLSelectElement).value).toBe('none');
    expect(fields.textContent).toContain('the front edge of the bed');

    // The picture draws the tape under the stock, two strips for a 38.1 mm plate.
    const svg = screen.getByTestId('engrave-setup-holding-picture');
    expect(svg.getAttribute('data-mount')).toBe('bed-tape');
    expect(screen.getAllByTestId('engrave-setup-holding-picture-tape')).toHaveLength(2);
    // The old sentence is gone.
    expect(screen.getByTestId('engrave-setup-step-holding').textContent).not.toContain('the job is held in the vise');
  });

  it('the vise’s three seats are one line while the vise is off the pins', () => {
    seedLocation(bedMachine());
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    expect(rowText('ledge')).toContain('In the vise, …');
    expect(rowText('ledge')).toContain('needs the vise on the pins');
    expect(screen.queryByTestId('engrave-setup-mount-row-block')).toBeNull();
    expect(screen.getByTestId('engrave-setup-change-ledge')).toBeTruthy();
  });

  it('a plate the bed can bracket takes the bracket: two clamps, the arms line, the picture’s handles', () => {
    seedLocation(bedMachine({ anchor: true }));
    openHolding(dj({ length: 100, width: 60, thickness: 6 }));

    const held = job().workholding;
    expect(held.kind).toBe('bracket');
    if (held.kind === 'bracket') {
      expect(held.bracket.anchor).toBe(1);
      expect(held.bracket.variant).toBe('thin');
      expect(held.bracket.clamps).toEqual([
        { edge: 'back', at: 22.5 },
        { edge: 'back', at: 77.5 },
      ]);
    }
    expect(radio('bed-bracket').checked).toBe(true);
    const fields = screen.getByTestId('engrave-setup-bed-fields-bed-bracket');
    expect(fields.textContent).toContain('thin, at anchor 1');
    expect(screen.getByTestId('engrave-setup-clamp-count').textContent).toContain('2 top clamps');
    expect(screen.getByTestId('engrave-setup-clamp-count').textContent).toContain('12 mm tall');
    expect(screen.getByTestId('engrave-setup-arms-above').textContent).toContain('the arms stand 4 mm above the plate');
    expect(screen.getAllByTestId('engrave-setup-holding-picture-clamp')).toHaveLength(2);
    expect(screen.getByTestId('engrave-setup-holding-clamp-label').textContent).toContain(
      'the clamp on the back edge, 15 mm in from the left-hand corner',
    );
    // 100 mm plate on a 100 mm arm: no warning; the checks are silent.
    expect(screen.queryByTestId('engrave-setup-holding-checks')).toBeNull();
  });

  it('#718 — a bed whose bracket is at anchor 2 writes the job at anchor 2', () => {
    seedLocation(bedMachine({ anchor: true, anchorAt: 2 }));
    openHolding(dj({ length: 100, width: 60, thickness: 6 }));

    const held = job().workholding;
    expect(held.kind).toBe('bracket');
    if (held.kind === 'bracket') expect(held.bracket.anchor).toBe(2);
    expect(screen.getByTestId('engrave-setup-bed-fields-bed-bracket').textContent).toContain('thin, at anchor 2');
  });

  it('the bracket row says what it needs when the bed carries no bracket — and the way out fits one', () => {
    seedLocation(bedMachine());
    openHolding(dj({ length: 100, width: 60, thickness: 6 }));

    // No anchor placement: the default is tape, and the row asks for the bracket (#718).
    expect(job().workholding.kind).toBe('tape');
    expect(radio('bed-bracket').disabled).toBe(true);
    expect(rowText('bed-bracket')).toContain('needs the bracket at anchor 1');
    fireEvent.click(screen.getByTestId('engrave-setup-change-bed-bracket'));
    const request = useMachineChangeStore.getState().request;
    expect(request.target).toBe('bed');
    expect(request.fitBracket).toBe(true);
    expect(request.forJob?.holding).toBe('held in a bracket and clamps on the bed');
  });
});

describe('#715 the clamp handles and the board under', () => {
  const RECT = (): SVGSVGElement => screen.getByTestId('engrave-setup-holding-picture') as unknown as SVGSVGElement;

  function bracketJob(): void {
    seedLocation(bedMachine({ anchor: true }));
    openHolding(dj({ length: 100, width: 60, thickness: 6 }));
  }

  it('a clamp dragged across the corner lands on the right edge, and the job stores it', () => {
    bracketJob();
    const svg = RECT();
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 300,
      bottom: 230,
      width: 300,
      height: 230,
      toJSON: () => ({}),
    } as DOMRect);

    const clamp = screen.getAllByTestId('engrave-setup-holding-picture-clamp')[0]!;
    fireEvent.pointerDown(clamp, { clientX: 100, clientY: 30, pointerId: 1, button: 0 });
    fireEvent.pointerMove(svg, { clientX: 282, clientY: 120, pointerId: 1 });
    fireEvent.pointerUp(svg, { clientX: 282, clientY: 120, pointerId: 1 });

    const held = job().workholding;
    expect(held.kind).toBe('bracket');
    if (held.kind === 'bracket') {
      expect(held.bracket.clamps[0]!.edge).toBe('right');
      expect(held.bracket.clamps[0]!.at).toBeCloseTo(18.04, 1);
      expect(held.bracket.source).toBe('saved');
    }
  });

  it('+ clamp adds one on the longer free edge, and remove takes it away', () => {
    bracketJob();
    fireEvent.click(screen.getByTestId('engrave-setup-clamp-add'));

    const added = job().workholding;
    expect(added.kind).toBe('bracket');
    if (added.kind === 'bracket') {
      expect(added.bracket.clamps).toHaveLength(3);
      // The back edge is the longer free edge (100 ≥ 60): the third clamp goes at its middle.
      expect(added.bracket.clamps[2]).toEqual({ edge: 'back', at: 50 });
    }

    fireEvent.click(screen.getByTestId('engrave-setup-clamp-remove'));
    const removed = job().workholding;
    if (removed.kind === 'bracket') expect(removed.bracket.clamps).toHaveLength(2);
  });

  it('the board under is the field’s, and the hold stays taped while it changes', () => {
    seedLocation(bedMachine());
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    fireEvent.change(screen.getByTestId('engrave-setup-bed-board'), { target: { value: 'loc:0' } });
    expect(job().sacrificial.under?.thickness).toBe(2);
    expect(job().sacrificial.under?.attach).toBe('tape');
    expect(job().workholding.kind).toBe('tape');

    fireEvent.change(screen.getByTestId('engrave-setup-bed-board'), { target: { value: 'none' } });
    expect(job().sacrificial.under).toBeNull();
    expect(job().workholding.kind).toBe('tape');
  });

  it('on the bare bed a through cut gets the thinnest board that passes, at its field', () => {
    const tag: EngraveShape = {
      kind: 'rect',
      id: 'sh-tag',
      name: 'Tag',
      width: 40,
      height: 30,
      cornerRadius: 3,
      position: { x: 40, y: 30 },
      rotation: 0,
      depth: 2,
      through: true,
      enabled: true,
    };
    const base = dj({ length: 80, width: 60, thickness: 2, material: 'pla' });
    seedLocation(bedMachine({ bare: true }));
    openHolding({ ...base, labels: [], shapes: [tag] });

    // The bed took the job, and the required board was written as the field's default.
    expect(job().workholding.kind).toBe('tape');
    expect(job().sacrificial.under?.thickness).toBe(2);
    expect((screen.getByTestId('engrave-setup-bed-board') as HTMLSelectElement).value).toBe('loc:0');
    expect(screen.getByTestId('engrave-setup-bed-fields-bed-tape').textContent).toContain(
      'the through cut goes into the board, not the bed',
    );
  });

  it('a board too small for the plate is refused at the field in the design’s sentence', () => {
    const tag: EngraveShape = {
      kind: 'rect',
      id: 'sh-tag',
      name: 'Tag',
      width: 40,
      height: 30,
      cornerRadius: 3,
      position: { x: 40, y: 30 },
      rotation: 0,
      depth: 2,
      through: true,
      enabled: true,
    };
    const base = dj({ length: 120, width: 90, thickness: 2, material: 'pla' });
    seedLocation(bedMachine({ bare: true }));
    // A 1 mm board is under the job, below the 1.3 mm a through cut needs: the size refusal is the
    // one that names the house board (as #712's job-level rule does).
    const boardUnder = {
      under: { thickness: 1, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' as const },
      sides: { left: null, right: null, front: null, back: null },
      source: 'saved' as const,
    };
    openHolding({ ...base, labels: [], shapes: [tag], sacrificial: boardUnder });

    expect(job().workholding.kind).toBe('tape');
    expect(screen.getByTestId('engrave-setup-board-too-small').textContent).toBe(
      'The 2 mm MDF boards are 100 × 100 mm; this plate is 120 mm long, 20 mm past the board, so a ' +
        'through cut overhangs it. Generate cuts it as it is — tape it to the wasteboard, or choose a larger board.',
    );
  });

  it('a taped job reloads with its own hold: the position, the roll and the option checked', () => {
    const base = dj({ length: 76.2, width: 38.1, thickness: 3.81 });
    seedLocation(bedMachine());
    openHolding({
      ...base,
      workholding: {
        kind: 'tape',
        tape: { width: 25, thickness: 0.1, inset: 2, where: { x: 40, y: 30 }, squareTo: 'front', source: 'saved' },
      },
    });

    expect(radio('bed-tape').checked).toBe(true);
    expect(screen.getByTestId('engrave-setup-tape-where').textContent).toBe('X 40 · Y 30 mm on the bed');
    expect(rowText('bed-tape')).toContain('two strips of the 25 mm tape');
    expect(job().workholding.kind).toBe('tape');
  });
});
