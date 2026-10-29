// @vitest-environment jsdom
// #714 (R-UI-2 of #545) — Holding writes the rotary chuck: Makera's jaw rule by diameter, the grip
// (a shop setting), the derived stick-out, the tailstock, and the front view (design
// `docs/design/rotary-flow.md` §3.4, station 3).
//
// THE MACHINE CARRIES THE ROTARY: the location's first machine has the module on its pins and the
// house owns it, so "In the rotary chuck" is a real choice for a round rod. The step's write is the
// store's own `setRotaryHolding` (#240 slice 1), which turns the stock box into the axis frame.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StartWizard } from '@/components/welcome/StartWizard';
import { MachineChangeWizard } from '@/components/machine-change';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultRotaryChuck, rotaryJawModeFor } from '@/engine/cnc/engrave/setupFlow';
import { engraveJobSchema } from '@/store/engraveJobSchema';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { resetMachineChange } from '@/store/machineChangeStore';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { resetMachineStore } from '@/store/machineStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  MachineRecordSchema,
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
    get canDriveMachine() {
      return caps.drive;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROTARY: FixtureRecord = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'machine', machineId: 'makera-z1-1a2b3c', since: '2026-10-27T09:00:00.000Z' },
  history: [],
};

/** The fixture's machine with the 4th axis on its pins and a bare bed (Makera, #717). */
function rotaryMachine(): MachineRecord {
  const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  const profile = machine.bedProfiles![0]!;
  profile.placements = [
    {
      id: 'pl-rotary',
      fixture: 'fx-rotary-1',
      where: { kind: 'pins', pins: 'rotary', anchor: null },
      count: null,
      frame: null,
      provenance: {},
    },
  ];
  profile.surface = {
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
  profile.consumables = null;
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
    accessories: [...DOC.accessories, ROTARY],
  } as unknown as LocationView;
  act(() => {
    useLocationStore.setState({ status: 'present', location, etag: '"e1"', reason: null });
  });
}

const ROD_ENTRY: JobStockEntry = { kind: 'made', shelfId: null, file: null, form: 'rod', finish: 'unknown', conductive: false };

/** A ⌀20 × 100 mm rod standing on its end (#683): D × D × L. */
function rod(): EngraveJob {
  const job = defaultEngraveJob();
  return { ...job, stock: { ...job.stock, length: 20, width: 20, thickness: 100, material: 'pla' }, stockEntry: ROD_ENTRY, labels: [] };
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
    useEngraveJobStore.setState({ job: rod() });
  });
});

afterEach(() => {
  cleanup();
  resetMachineChange();
  resetLocationStore();
});

describe('#714 Makera’s jaw rule by diameter (§3.4)', () => {
  it('standard under ⌀20, reverse inner 20–35, reverse outer over 35', () => {
    expect(rotaryJawModeFor(19.99)).toBe('standard');
    expect(rotaryJawModeFor(20)).toBe('reverse-inner');
    expect(rotaryJawModeFor(35)).toBe('reverse-inner');
    expect(rotaryJawModeFor(35.01)).toBe('reverse-outer');
  });

  it('a new chuck takes the shop’s grip, and its stick-out is the rod less it', () => {
    const chuck = defaultRotaryChuck(rod(), 15);
    expect(chuck.stickout).toBe(85);
    expect(chuck.jawMode).toBe('reverse-inner'); // ⌀20
    expect(chuck.tailstock).toBe(true);
  });

  it('a rod shorter than the grip keeps a positive stick-out', () => {
    const short = { ...rod(), stock: { ...rod().stock, length: 10, width: 10, thickness: 10 } };
    const chuck = defaultRotaryChuck(short, 15);
    expect(chuck.stickout).toBeGreaterThan(0);
    expect(chuck.stickout).toBeLessThanOrEqual(10);
    expect(chuck.jawMode).toBe('standard');
  });

  it('a document written before the rule reads its reverse jaws as the inner teeth', () => {
    const base = rod();
    const parsed = engraveJobSchema.parse({
      ...base,
      workholding: {
        kind: 'rotary-chuck',
        rotary: { stickout: 85, gripDiameter: null, jawMode: 'reverse', tailstock: true, source: 'wiki' },
      },
    });
    expect(parsed.workholding.kind).toBe('rotary-chuck');
    if (parsed.workholding.kind === 'rotary-chuck') expect(parsed.workholding.rotary.jawMode).toBe('reverse-inner');
  });
});

describe('#714 the rotary option and its four lines (station 3)', () => {
  it('a rod on a rotary machine opens IN THE CHUCK, with the grip, the jaw rule and the tailstock', () => {
    seedLocation(rotaryMachine());
    openHolding(rod());

    // #714 — the module on the pins and a round rod that fits: the chuck is the default mount.
    expect(radio('rotary').disabled).toBe(false);
    expect(radio('rotary').checked).toBe(true);
    expect(screen.getByTestId('engrave-setup-mount-row-rotary').textContent).toContain(
      'the rod turns about X; the cutter stays over it',
    );

    const held = job().workholding;
    expect(held.kind).toBe('rotary-chuck');
    if (held.kind === 'rotary-chuck') {
      expect(held.rotary.stickout).toBe(85);
      expect(held.rotary.jawMode).toBe('reverse-inner');
      expect(held.rotary.tailstock).toBe(true);
    }
    // The axis frame: length along X, diameter twice across (#240 slice 1).
    expect(job().stock).toMatchObject({ length: 100, width: 20, thickness: 20, shape: 'cylinder', diameter: 20 });

    // The four lines, under the checked option.
    expect((screen.getByTestId('engrave-setup-rotary-jaws') as HTMLSelectElement).value).toBe('reverse-inner');
    expect(screen.getByTestId('engrave-setup-rotary-rule').textContent).toBe(
      'Makera’s rule for ⌀20: standard under ⌀20, reverse inner 20–35, reverse outer over 35',
    );
    expect((screen.getByTestId('engrave-setup-rotary-grip') as HTMLInputElement).value).toBe('15');
    expect(screen.getByTestId('engrave-setup-rotary-stickout').textContent).toBe('Stick-out 85 mm');
    expect((screen.getByTestId('engrave-setup-rotary-tailstock') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('engrave-setup-rotary-fields').textContent).toContain(
      'drill a centre hole in the free end first',
    );

    // The front view: the chuck and jaws, the grip, the rod and its stick-out, the tailstock, X and A.
    const svg = screen.getByTestId('engrave-setup-holding-picture');
    expect(svg.getAttribute('data-mount')).toBe('rotary');
    expect(svg.textContent).toContain('rod ⌀20');
    expect(svg.textContent).toContain('grip 15 mm');
    expect(svg.textContent).toContain('stick-out 85 mm');
    expect(svg.textContent).toContain('tailstock');
    expect(svg.textContent).toContain('X 0 at the jaws');
    expect(svg.textContent).toContain('A turns the rod about X');
    expect(screen.getByTestId('engrave-setup-holding-caption').textContent).toContain('Front view.');
    expect(screen.getByTestId('engrave-setup-holding-caption').textContent).toContain('A turns it');
  });

  it('#698 — the rotary fold keeps its stated fact, and offers no orientation control', () => {
    seedLocation(rotaryMachine());
    // A printed rod: the colour planes are what make its ends differ, so the fold has a fact to
    // state. (The arrival conversion clears the stock ENTRY — the box is now the axis frame — but
    // the colour plane belongs to the stock, so the fold stays.)
    const base = rod();
    openHolding({
      ...base,
      stock: { ...base.stock, colour: { kind: 'printed', capMm: 0.4, layerHeight: 0.2 } },
    });

    const fold = screen.getByTestId('engrave-setup-orientation') as HTMLDetailsElement;
    expect(fold.querySelector('summary')!.textContent).toBe('Which end is in the jaws');
    fireEvent.click(fold.querySelector('summary')!);
    expect(fold.open).toBe(true);
    // A round rod has no face or edge to square: the one landmark is its ends, and either will do.
    expect(fold.textContent).toContain('Either end');
    expect(fold.textContent).toContain('unless the ends differ');
    // A10 — the fold states the fact; it is not a control.
    expect(fold.querySelectorAll('select, input, button')).toHaveLength(0);
    // The three rectangular-blank landmarks (face, fixed-jaw edge, near end) do not apply to a rod.
    expect(screen.queryByTestId('engrave-setup-orientation-picture-fixed-jaw')).toBeNull();
  });

  it('the grip edits the stick-out, the jaws and the tailstock write what they say', () => {
    seedLocation(rotaryMachine());
    openHolding(rod());

    fireEvent.change(screen.getByTestId('engrave-setup-rotary-grip'), { target: { value: '20' } });
    let held = job().workholding;
    if (held.kind === 'rotary-chuck') expect(held.rotary.stickout).toBe(80);
    expect(screen.getByTestId('engrave-setup-rotary-stickout').textContent).toBe('Stick-out 80 mm');

    fireEvent.change(screen.getByTestId('engrave-setup-rotary-jaws'), { target: { value: 'reverse-outer' } });
    held = job().workholding;
    if (held.kind === 'rotary-chuck') expect(held.rotary.jawMode).toBe('reverse-outer');

    fireEvent.click(screen.getByTestId('engrave-setup-rotary-tailstock'));
    held = job().workholding;
    if (held.kind === 'rotary-chuck') expect(held.rotary.tailstock).toBe(false);
    // The picture follows: no tailstock at the rod's end.
    expect(screen.getByTestId('engrave-setup-holding-picture').textContent).not.toContain('tailstock');
  });

  it('the Technical fold names each source', () => {
    seedLocation(rotaryMachine());
    openHolding(rod());

    const technical = screen.getByTestId('engrave-setup-rotary-technical');
    expect(technical.textContent).toContain('⌀80 × 150 mm — Makera’s figure');
    expect(technical.textContent).toContain('Makera’s rule by diameter');
    expect(screen.getByTestId('engrave-setup-rotary-grip-source').textContent).toContain('the shop’s seeded default, not measured');
    expect(technical.textContent).toContain('Makera’s shipped value');
    expect(screen.getByTestId('engrave-setup-rotary-axis-datum').textContent).toContain('shipped value');
  });

  it('reloading a rotary job shows its own chuck, not a fresh default', () => {
    seedLocation(rotaryMachine());
    const base = rod();
    openHolding({
      ...base,
      stock: { ...base.stock, length: 100, width: 25, thickness: 25, shape: 'cylinder', diameter: 25 },
      workholding: {
        kind: 'rotary-chuck',
        rotary: { stickout: 60, gripDiameter: null, jawMode: 'reverse-outer', tailstock: false, source: 'test' },
      },
    });

    expect(radio('rotary').checked).toBe(true);
    expect((screen.getByTestId('engrave-setup-rotary-grip') as HTMLInputElement).value).toBe('40');
    expect(screen.getByTestId('engrave-setup-rotary-stickout').textContent).toBe('Stick-out 60 mm');
    expect((screen.getByTestId('engrave-setup-rotary-jaws') as HTMLSelectElement).value).toBe('reverse-outer');
    expect((screen.getByTestId('engrave-setup-rotary-tailstock') as HTMLInputElement).checked).toBe(false);
  });
});

// #737 — THE NECK FOR PARTING lives beside the chuck's own facts (design §3.6, §3.11): off until
// the operator turns it on, then the side, the ⌀ and the length, with the sentence the findings
// and the run sheet will use.
describe('#737 the neck for parting (station 3)', () => {
  it('is off by default, then writes its side, diameter and length — and clears back to absent', () => {
    seedLocation(rotaryMachine());
    openHolding(rod());

    const toggle = screen.getByTestId('engrave-setup-rotary-neck') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.queryByTestId('engrave-setup-rotary-neck-end')).toBeNull();
    let held = job().workholding;
    expect(held.kind).toBe('rotary-chuck');
    if (held.kind === 'rotary-chuck') expect('neck' in held.rotary).toBe(false);

    fireEvent.click(toggle);

    held = job().workholding;
    if (held.kind === 'rotary-chuck') expect(held.rotary.neck).toEqual({ end: 'chuck', diameter: 7, length: 5 });
    expect((screen.getByTestId('engrave-setup-rotary-neck-end') as HTMLSelectElement).value).toBe('chuck');
    expect((screen.getByTestId('engrave-setup-rotary-neck-diameter') as HTMLInputElement).value).toBe('7');
    expect((screen.getByTestId('engrave-setup-rotary-neck-length') as HTMLInputElement).value).toBe('5');
    const note = screen.getByTestId('engrave-setup-rotary-neck-note').textContent ?? '';
    expect(note).toContain('The program’s last operation cuts it down to ⌀7 mm');
    expect(note).toContain('you saw the part off at X 5.5 mm');
    expect(note).toContain('X 3–8 mm on the chuck side');
    expect(note).toContain('The stock goes into the jaws at the chuck side, so the saw frees the whole part.');
    expect(note).toContain('Case Maker starts the neck at ⌀7 mm and 5 mm long');
    expect(note).toContain('a saw needs at least 2.5 mm');
    expect(note).toContain('those are labelled defaults, not measurements');
    expect(note).toContain('runs 82 mm from the neck’s root at X 3 mm to the free end');
    expect(note).toContain('the neck and the tailstock centre hold its ends');
    expect(note).toContain('the bending is shared and the check counts half its length (41 mm)');
    expect(note).toContain('The safe minimum is ⌀5.18 mm');
    expect(note).toContain('Case Maker’s defaults (10 N sideways at its free end, 30 MPa allowable bending stress)');
    expect(note).toContain('not measurements');
    expect(note).toContain('a rough check and the minimum is a guess until it is checked on the machine');
    expect(note).not.toContain('(#238)');
    expect(note).not.toContain('below that minimum');
    // The jaw clearance is not checked: the warning says so and tells the operator to air-cut it
    // first, until the rotary is measured on the machine.
    expect(note).toContain('The jaw clearance beside the neck is not checked');
    expect(note).toContain('does not model the jaws as a solid');
    expect(note).toContain('Air-cut the neck first');
    expect(note).toContain('until the rotary is measured on the machine');
    // The panel calls the carried piece what the check treats it as, rather than saying the saw
    // frees a "stub" measured from the root.
    expect(note).toContain('The check treats the whole part beyond the neck as carried');
    expect(note).not.toContain('The saw frees the');

    fireEvent.change(screen.getByTestId('engrave-setup-rotary-neck-end'), { target: { value: 'tailstock' } });
    held = job().workholding;
    if (held.kind === 'rotary-chuck') expect(held.rotary.neck).toEqual({ end: 'tailstock', diameter: 7, length: 5 });
    const tailNote = screen.getByTestId('engrave-setup-rotary-neck-note').textContent ?? '';
    expect(tailNote).toContain('X 70–75 mm on the tailstock side');
    // A tailstock-side neck frees only the scrap end. The note must not say the part comes off —
    // it says the opposite two sentences later.
    expect(tailNote).toContain('you saw the scrap end off at X 72.5 mm');
    expect(tailNote).not.toContain('you saw the part off');
    expect(tailNote).toContain('runs 15 mm from the neck’s root at X 70 mm to the free end');
    expect(tailNote).toContain('The check treats the scrap stub beyond the neck as carried');
    expect(tailNote).toContain('the bending is shared and the check counts half its length (7.5 mm)');
    expect(tailNote).toContain(
      'The stock goes into the jaws at the chuck side, so a neck here frees only the scrap stub: ' +
        'the part stays joined to the stock in the chuck and is not parted off.',
    );
    expect(tailNote).toContain('The safe minimum is ⌀2.94 mm');
    expect(tailNote).toContain('Air-cut the neck first');

    fireEvent.change(screen.getByTestId('engrave-setup-rotary-neck-diameter'), { target: { value: '6' } });
    fireEvent.change(screen.getByTestId('engrave-setup-rotary-neck-length'), { target: { value: '8' } });
    held = job().workholding;
    if (held.kind === 'rotary-chuck') expect(held.rotary.neck).toEqual({ end: 'tailstock', diameter: 6, length: 8 });

    fireEvent.click(screen.getByTestId('engrave-setup-rotary-neck'));
    held = job().workholding;
    if (held.kind === 'rotary-chuck') expect('neck' in held.rotary).toBe(false);
    expect(screen.queryByTestId('engrave-setup-rotary-neck-note')).toBeNull();
  });

  it('reloading a job that already has a neck shows its own numbers', () => {
    seedLocation(rotaryMachine());
    const base = rod();
    openHolding({
      ...base,
      stock: { ...base.stock, length: 100, width: 20, thickness: 20, shape: 'cylinder', diameter: 20 },
      workholding: {
        kind: 'rotary-chuck',
        rotary: {
          stickout: 85,
          gripDiameter: null,
          jawMode: 'reverse-inner',
          tailstock: true,
          source: 'test',
          neck: { end: 'chuck', diameter: 3, length: 4 },
        },
      },
    });

    expect((screen.getByTestId('engrave-setup-rotary-neck') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('engrave-setup-rotary-neck-end') as HTMLSelectElement).value).toBe('chuck');
    expect((screen.getByTestId('engrave-setup-rotary-neck-diameter') as HTMLInputElement).value).toBe('3');
    expect((screen.getByTestId('engrave-setup-rotary-neck-length') as HTMLInputElement).value).toBe('4');
    const note = screen.getByTestId('engrave-setup-rotary-neck-note').textContent ?? '';
    expect(note).toContain('X 3–7 mm on the chuck side');
    expect(note).toContain('runs 82 mm from the neck’s root at X 3 mm to the free end');
    // The panel says when the chosen neck is below the check's minimum, rather than leaving the
    // operator to discover it at Generate.
    expect(note).toContain('This ⌀3 mm neck is below that minimum');
    expect(note).toContain('make it thicker, shorten the part, or choose a stronger stock');
  });

  it('caps the default diameter to a slim rod, so ticking the box does not refuse at once', () => {
    seedLocation(rotaryMachine());
    const base = rod();
    openHolding({
      ...base,
      stock: { ...base.stock, length: 7, width: 7, thickness: 100, shape: 'cylinder', diameter: 7 },
    });

    fireEvent.click(screen.getByTestId('engrave-setup-rotary-neck'));

    const held = job().workholding;
    expect(held.kind).toBe('rotary-chuck');
    if (held.kind === 'rotary-chuck') {
      // ⌀7 mm on a ⌀7 mm rod is `neck-wider-than-part`; the default stays just inside the rod.
      expect(held.rotary.neck).toEqual({ end: 'chuck', diameter: 6.9, length: 5 });
    }
    expect((screen.getByTestId('engrave-setup-rotary-neck-diameter') as HTMLInputElement).value).toBe('6.9');
    expect(screen.getByTestId('engrave-setup-rotary-neck-note').textContent).toContain(
      'Case Maker starts the neck at ⌀6.9 mm',
    );
  });
});
