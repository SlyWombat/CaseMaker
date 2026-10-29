// @vitest-environment jsdom
// #684 — step 3 Holding: the mount this stock calls for, the machine's state in one line, the
// top-view picture, the technical fold, and the #693 escape.
//
// THE LOCATION IS THE SEAM. The step reads the location's first machine (the one the
// machine-change wizard changes), so each test seeds `useLocationStore` with the shared fixture's
// machine and accessories. The fixture's bed has no consumables; tests that name boards/tape add
// them, because those are the house's records rather than the app's defaults.
//
// The jsdom has no CSS pipeline, so the z-order test reads the two overlays' INLINE z-index (the
// machine-change backdrop carries one for exactly this) and the stacking scale's own values from
// `tokens.css` — the same source-reading approach `benchDefaults.spec.ts` uses.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobVise } from '@/engine/cnc/fixture';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StartWizard } from '@/components/welcome/StartWizard';
import { MachineChangeWizard } from '@/components/machine-change';
import {
  applyMount,
  applyRecommendedMount,
  boardChoices,
  boardSeatProud,
  currentMount,
  defaultBoardMm,
  fmt,
  machineNow,
  recommendedMount,
  seatedProud,
} from '@/components/welcome/holdingMounts';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultSetupAnswers } from '@/engine/cnc/engrave/setupFlow';
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
import type { EngraveJob, JobStockEntry } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'location-doc.json');
const APP = join(HERE, '..', '..');
const DOC = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  id: string;
  name: string;
  createdAt: string;
  machines: unknown[];
  accessories: FixtureRecord[];
};

// The desktop build's escape is offered only where the app can drive the machine; the step's
// tests are about that offer, so the capability is on unless a test says otherwise.
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

/** The fixture's machine, parsed and cloned, with the bed's consumables the test needs. */
function machineWith(
  consumables: NonNullable<BedProfile['consumables']> | null,
  patch: (m: MachineRecord) => void = () => undefined,
): MachineRecord {
  const parsed = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  parsed.bedProfiles![0]!.consumables = consumables;
  patch(parsed);
  return parsed;
}

const BOARDS_AND_TAPE: NonNullable<BedProfile['consumables']> = {
  tape: { widthMm: 25, thicknessMm: 0.1, provenance: 'typed' },
  boards: [{ material: 'MDF', size: [300, 200, 2], count: 4 }],
};

const ROTARY: FixtureRecord = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'box' },
  history: [],
};

function seedLocation(machine: MachineRecord, accessories: FixtureRecord[] = DOC.accessories): void {
  const location = {
    kind: 'casemaker-location',
    schemaVersion: 1,
    id: DOC.id,
    name: DOC.name,
    createdAt: DOC.createdAt,
    machines: [machine],
    accessories,
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

describe('#684 — the machine’s state and the stock’s numbers decide the mount', () => {
  it('opens on the active bed profile in one line, with the stock’s mount preselected', () => {
    seedLocation(machineWith(BOARDS_AND_TAPE));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    const now = screen.getByTestId('engrave-setup-machine-now').textContent ?? '';
    expect(now).toContain('On the machine now');
    expect(now).toContain('Vise on the pins');
    expect(now).toContain('wasteboard under');
    expect(now).toContain('2 mm MDF boards ×4');
    expect(now).toContain('tape');
    expect(now).not.toContain('vise-default');

    // 3.81 mm on the 3.1 mm ledge: 0.71 proud, and that is the one this stock calls for.
    expect(radio('ledge').checked).toBe(true);
    expect(rowText('ledge')).toContain('3.81 mm stands 0.71 mm proud of the jaws');
    expect(rowText('ledge')).not.toContain('surface');
  });

  it('shows all six mounts, with each machine-only one’s cost and escape; an unowned fixture says only "not owned"', () => {
    seedLocation(machineWith(BOARDS_AND_TAPE));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    for (const mount of ['ledge', 'board', 'block', 'bed-tape', 'bed-bracket', 'rotary']) {
      expect(screen.getByTestId(`engrave-setup-mount-row-${mount}`)).toBeTruthy();
    }
    expect(rowText('bed-tape')).toContain('needs the vise off the pins');
    expect(screen.getByTestId('engrave-setup-change-bed-tape')).toBeTruthy();
    expect(rowText('bed-bracket')).toContain('needs the vise off the pins');
    // The house owns no rotary module: "not owned", and no change to offer for it.
    expect(rowText('rotary')).toContain('not owned');
    expect(rowText('rotary')).not.toContain('needs');
    expect(screen.queryByTestId('engrave-setup-change-rotary')).toBeNull();
    // The audit's sentence about a rotary being "asked about here" is gone.
    expect(screen.getByTestId('engrave-setup-step-holding').textContent).not.toMatch(/asked about|not yet offered/i);
  });

  it('thin stock calls for the waste board, and the ledge says why it is not the mount', () => {
    seedLocation(machineWith(BOARDS_AND_TAPE));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 2 }));

    // The recommendation is applied on arrival: a 2 mm sheet on a 2 mm board stands 0.9 mm proud.
    expect(radio('board').checked).toBe(true);
    expect(radio('ledge').disabled).toBe(true);
    expect(rowText('ledge')).toContain('it would sit 1.1 mm below the jaw tops');
    expect(rowText('board')).toContain('2 mm on a 2 mm board stands 0.9 mm proud of the jaws');
    expect((screen.getByTestId('engrave-setup-sacrificial') as HTMLSelectElement).value).toBe('loc:0');
    const job = useEngraveJobStore.getState().job;
    expect(jobVise(job).seat).toBe('ledge');
    expect(jobVise(job).stockProud).toBeCloseTo(0.9, 6);
    expect(job.sacrificial.under?.thickness).toBe(2);
    // ONE sacrificial control, and it is the board choice inside the mount.
    expect(screen.getByTestId('engrave-setup-sacrificial')).toBeTruthy();
  });

  it('a 1 mm sheet on the only 2 mm board still sits below, and the board line says so', () => {
    seedLocation(
      machineWith({
        tape: null,
        boards: [{ material: 'MDF', size: [300, 200, 2], count: 4 }],
      }),
    );
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 1 }));

    // No house board leaves a 1 mm sheet proud, so the thickest (here, the only) board is
    // preselected — and its line says plainly how far the stock still sits below the jaws.
    expect(radio('board').checked).toBe(true);
    expect((screen.getByTestId('engrave-setup-sacrificial') as HTMLSelectElement).value).toBe('loc:0');
    expect(rowText('board')).toContain(
      'still 0.1 mm below the jaw tops — a thicker board, or tape it to the bed',
    );
    expect(rowText('board')).not.toContain('stands 0.9 mm proud');
    const job = useEngraveJobStore.getState().job;
    expect(job.sacrificial.under?.thickness).toBe(2);
    expect(jobVise(job).stockProud).toBeCloseTo(-0.1, 6);
  });

  it('a 1 mm sheet takes the 3 mm board over the 2 mm: only the 3 mm leaves it proud', () => {
    seedLocation(
      machineWith({
        tape: null,
        boards: [
          { material: 'MDF', size: [300, 200, 2], count: 4 },
          { material: 'MDF', size: [300, 200, 3], count: 2 },
        ],
      }),
    );
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 1 }));

    // 1 + 2 − 3.1 is 0.1 below; 1 + 3 − 3.1 is 0.9 proud. The default is the thinnest board that
    // leaves the stock proud, not simply the thinnest board on the shelf.
    expect(radio('board').checked).toBe(true);
    expect((screen.getByTestId('engrave-setup-sacrificial') as HTMLSelectElement).value).toBe('loc:1');
    expect(rowText('board')).toContain('1 mm on a 3 mm board stands 0.9 mm proud of the jaws');
    const job = useEngraveJobStore.getState().job;
    expect(job.sacrificial.under?.thickness).toBe(3);
    expect(jobVise(job).stockProud).toBeCloseTo(0.9, 6);
  });

  it('a board picked from the select reports the seat it gives, proud or below', () => {
    seedLocation(
      machineWith({
        tape: null,
        boards: [
          { material: 'MDF', size: [300, 200, 2], count: 4 },
          { material: 'MDF', size: [300, 200, 3], count: 2 },
        ],
      }),
    );
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 1 }));
    const select = screen.getByTestId('engrave-setup-sacrificial') as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'loc:0' } });
    expect(rowText('board')).toContain(
      'still 0.1 mm below the jaw tops — a thicker board, or tape it to the bed',
    );
    expect(useEngraveJobStore.getState().job.sacrificial.under?.thickness).toBe(2);
    expect(jobVise(useEngraveJobStore.getState().job).stockProud).toBeCloseTo(-0.1, 6);

    fireEvent.change(select, { target: { value: 'loc:1' } });
    expect(rowText('board')).toContain('1 mm on a 3 mm board stands 0.9 mm proud of the jaws');
    expect(useEngraveJobStore.getState().job.sacrificial.under?.thickness).toBe(3);
    expect(jobVise(useEngraveJobStore.getState().job).stockProud).toBeCloseTo(0.9, 6);
  });

  it('a block taller than the jaws is gripped as a block, its sides free', () => {
    seedLocation(machineWith(null));
    openHolding(dj({ length: 40, width: 40, thickness: 25 }));

    expect(radio('block').checked).toBe(true);
    expect(rowText('block')).toContain('the sides free; for a block taller than the jaws');
    const job = useEngraveJobStore.getState().job;
    expect(jobVise(job).seat).toBe('floor');
    expect(jobVise(job).stockProud).toBeCloseTo(5, 6);
  });

  it('a stock that does not fit the rotary is the rotary’s reason, not the machine’s', () => {
    seedLocation(machineWith(null), [...DOC.accessories, ROTARY]);
    openHolding(dj({ length: 200, width: 100, thickness: 5 }));

    expect(radio('rotary').disabled).toBe(true);
    expect(rowText('rotary')).toContain('does not fit the rotary');
    expect(rowText('rotary')).toContain('80 × 150 mm');
    // A machine change cannot make the stock fit, so there is no escape on that line.
    expect(screen.queryByTestId('engrave-setup-change-rotary')).toBeNull();
  });

  it('the same stock with a rotary in the house but off the pins gets the machine cost and its escape', () => {
    seedLocation(machineWith(null), [...DOC.accessories, ROTARY]);
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    expect(rowText('rotary')).toContain('needs the rotary on the pins');
    expect(screen.getByTestId('engrave-setup-change-rotary')).toBeTruthy();
    expect(radio('rotary').disabled).toBe(true);
  });

  // #713 review — step 2 no longer blocks a long rod, so Holding is where a rod that cannot stand
  // in the jaws is caught: no vise seat takes it, and the wizard will not let the job leave held in
  // one.
  describe('a rod longer than the vise’s grip (#713 review)', () => {
    const LONG_ROD = { length: 20, width: 20, thickness: 100, shape: 'cylinder' as const, diameter: 20 };
    const ROD_ENTRY: JobStockEntry = {
      kind: 'made',
      shelfId: null,
      file: null,
      form: 'rod',
      finish: 'rough',
      conductive: false,
    };

    it('refuses every vise seat with the grip sentence, and blocks Next until the rod is in the chuck', () => {
      // The machine carries the VISE on the pins: the chuck is one machine change away.
      seedLocation(machineWith(BOARDS_AND_TAPE), [...DOC.accessories, ROTARY]);
      openHolding(dj(LONG_ROD, ROD_ENTRY));

      for (const mount of ['ledge', 'board', 'block']) {
        expect(radio(mount).disabled, mount).toBe(true);
        expect(rowText(mount)).toContain('the vise holds a rod up to 20 mm standing on its end');
        expect(rowText(mount)).toContain('this rod is 100 mm');
        expect(screen.queryByTestId(`engrave-setup-change-${mount}`)).toBeNull();
      }
      // The chuck is offered through Change the machine…, because the vise occupies the pins.
      expect(radio('rotary').disabled).toBe(true);
      expect(rowText('rotary')).toContain('needs the rotary on the pins');
      expect(screen.getByTestId('engrave-setup-change-rotary')).toBeTruthy();
      // …and the footer's rule matches the rows: Next is disabled, with the one sentence.
      expect((screen.getByTestId('engrave-setup-next') as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId('start-wizard-holding-block').textContent).toContain(
        'hold it in the rotary chuck',
      );
    });

    it('lets the job through once the machine has the rotary on the pins and the rod is in the chuck', () => {
      seedLocation(
        machineWith(BOARDS_AND_TAPE, (m) => {
          const placement = m.bedProfiles![0]!.placements[0]!;
          m.bedProfiles![0]!.placements = [
            {
              ...placement,
              id: 'pl-rotary',
              where: { kind: 'pins', pins: 'rotary', anchor: null },
            },
          ];
        }),
        [...DOC.accessories, ROTARY],
      );
      openHolding(dj(LONG_ROD, ROD_ENTRY));

      expect(radio('rotary').disabled).toBe(false);
      act(() => {
        fireEvent.click(radio('rotary'));
      });
      expect(useEngraveJobStore.getState().job.workholding.kind).toBe('rotary-chuck');
      expect((screen.getByTestId('engrave-setup-next') as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByTestId('start-wizard-holding-block')).toBeNull();
    });
  });

  it('no machine record: the app’s three vise mounts still work, with no dead escape', () => {
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    expect(screen.getByTestId('engrave-setup-machine-none').textContent).toContain('Not read from a machine record');
    expect(radio('ledge').checked).toBe(true);
    expect(screen.queryByTestId('engrave-setup-mount-bed-tape')).toBeNull();
    expect(screen.queryByTestId('engrave-setup-change-machine')).toBeNull();
  });

  it('a build that cannot drive a machine does not show the machine-only options at all', () => {
    caps.drive = false;
    seedLocation(machineWith(null));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    expect(screen.getByTestId('engrave-setup-mount-ledge')).toBeTruthy();
    expect(screen.queryByTestId('engrave-setup-mount-bed-tape')).toBeNull();
    expect(screen.queryByTestId('engrave-setup-change-machine')).toBeNull();
  });
});

describe('#684 — a saved setup is the operator’s, not the stock’s recommendation', () => {
  it('a saved vise is never rewritten by the recommendation', () => {
    const a = defaultSetupAnswers(dj({ thickness: 2 }));
    a.vise = { ...a.vise, source: 'saved' };
    expect(applyRecommendedMount(a)).toBe(a);
    expect(currentMount(a)).toBe('ledge');
  });

  it('a default vise with no board takes the recommendation', () => {
    const a = defaultSetupAnswers(dj({ thickness: 2 }));
    const next = applyRecommendedMount(a, 2);
    expect(currentMount(next)).toBe('board');
    expect(next.sacrificial.under?.thickness).toBe(2);
    expect(next.workholding).toBe('vise');
    expect(next.vise.stockProud).toBeCloseTo(0.9, 6);
  });

  it('seatedProud counts the board under the part and the seat under it', () => {
    const a = defaultSetupAnswers(dj({ thickness: 3.81 }));
    expect(seatedProud(a, 'ledge')).toBeCloseTo(0.71, 9);
    const board = applyMount(a, 'board', 2);
    expect(seatedProud(board, 'board')).toBeCloseTo(2.71, 9);
    const block = applyMount(a, 'block');
    expect(seatedProud(block, 'block')).toBeCloseTo(-16.19, 9);
  });

  it('names the recommended mount from the numbers, not the form word', () => {
    expect(recommendedMount({ thickness: 2 })).toBe('board');
    expect(recommendedMount({ thickness: 3.1 })).toBe('ledge');
    expect(recommendedMount({ thickness: 3.81 })).toBe('ledge');
    expect(recommendedMount({ thickness: 12 })).toBe('ledge');
    expect(recommendedMount({ thickness: 20 })).toBe('ledge');
    expect(recommendedMount({ thickness: 25 })).toBe('block');
  });

  it('defaults to the thinnest board that leaves the stock proud, else the thickest', () => {
    const two = [{ thickness: 2, material: 'MDF', count: 4 }];
    const twoAndThree = [...two, { thickness: 3, material: 'MDF', count: 2 }];

    // 1 mm sheet: a 2 mm board leaves it 0.1 mm below; a 3 mm board leaves it 0.9 mm proud.
    expect(boardSeatProud(1, 2)).toBeCloseTo(-0.1, 9);
    expect(boardSeatProud(1, 3)).toBeCloseTo(0.9, 9);
    expect(defaultBoardMm({ thickness: 1 }, two)).toBe(2);
    expect(defaultBoardMm({ thickness: 1 }, twoAndThree)).toBe(3);

    // 2 mm sheet: the thinnest board already leaves it 0.9 mm proud.
    expect(boardSeatProud(2, 2)).toBeCloseTo(0.9, 9);
    expect(defaultBoardMm({ thickness: 2 }, two)).toBe(2);

    // No house board named: the typed default is the only choice there is.
    expect(defaultBoardMm({ thickness: 1 }, [])).toBe(2);
  });

  it('lists the house’s boards in the record’s order on the machine line, thinnest first in the choice', () => {
    const machine = machineWith({
      tape: null,
      boards: [
        { material: 'MDF', size: [300, 200, 12], count: 1 },
        { material: 'MDF', size: [300, 200, 2], count: 4 },
      ],
    });
    const now = machineNow(machine);
    expect(now?.text).toBe('Vise on the pins · wasteboard under · 12 mm MDF boards ×1 · 2 mm MDF boards ×4');
    expect(boardChoices(now!.profile).map((b) => b.thickness)).toEqual([2, 12]);
    expect(defaultBoardMm({ thickness: 2 }, boardChoices(now!.profile))).toBe(2);
  });
});

describe('#684 — the picture, the folds, and the technical provenance', () => {
  it('draws the vise top view with X between the jaws and the fixed jaw on the left', () => {
    seedLocation(machineWith(null));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    const svg = screen.getByTestId('engrave-setup-holding-picture');
    expect(svg.getAttribute('data-mechanism')).toBe('vise');
    expect(svg.textContent).toContain('fixed jaw');
    expect(svg.textContent).toContain('moving jaw');
    expect(svg.textContent).toContain('X runs between the jaws');
    expect(svg.textContent).toContain('76.2 × 38.1');
    expect(svg.querySelector('circle')).toBeNull();
    expect(screen.getByTestId('engrave-setup-holding-caption').textContent).toContain(
      'The fixed jaw is on the left',
    );
  });

  it('#726 W18 — the blank is drawn to its own aspect, so the badge starter reads at a glance', () => {
    seedLocation(machineWith(null));
    // The badge starter's blank as the bench holds it (#383): 38.1 mm across the jaws (X), 76.2
    // along them (Y). The picture used to draw every blank 136 × 46 whatever the stock said — this
    // one came out long along X, the opposite of its own numbers.
    openHolding(dj({ length: 38.1, width: 76.2, thickness: 3.81 }));
    const starter = screen.getByTestId('engrave-setup-holding-picture-stock');
    expect(Number(starter.getAttribute('height'))).toBeGreaterThan(Number(starter.getAttribute('width')));
    // Too narrow to hold "38.1 × 76.2" across it: the dims run along the blank instead.
    const label = Array.from(screen.getByTestId('engrave-setup-holding-picture').querySelectorAll('text')).find(
      (t) => t.textContent === '38.1 × 76.2',
    );
    expect(label?.getAttribute('transform')).toBe('rotate(-90 120 79)');

    // The typed route's 76.2 × 38.1 is wide — the same blank the other way round, and drawn so.
    cleanup();
    seedLocation(machineWith(null));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));
    const typed = screen.getByTestId('engrave-setup-holding-picture-stock');
    expect(Number(typed.getAttribute('width'))).toBeGreaterThan(Number(typed.getAttribute('height')));
    const typedLabel = Array.from(screen.getByTestId('engrave-setup-holding-picture').querySelectorAll('text')).find(
      (t) => t.textContent === '76.2 × 38.1',
    );
    expect(typedLabel?.getAttribute('transform')).toBeNull();
  });

  it('#705 — a disc is a circle labelled ⌀, and the caption names the disc', () => {
    seedLocation(machineWith(null));
    openHolding(
      dj(
        { length: 55, width: 55, thickness: 10 },
        { kind: 'made', shelfId: null, file: null, form: 'disc', finish: 'unknown', conductive: false },
      ),
    );

    const svg = screen.getByTestId('engrave-setup-holding-picture');
    expect(svg.getAttribute('data-form')).toBe('disc');
    expect(svg.querySelector('circle')).not.toBeNull();
    expect(svg.textContent).toContain('⌀ 55');
    expect(svg.textContent).not.toContain('55 × 55');
    expect(screen.getByTestId('engrave-setup-holding-caption').textContent).toContain('disc');
  });

  it('#705 — a rod on its end is the same circle, and the caption names the rod', () => {
    seedLocation(machineWith(null));
    openHolding(
      dj(
        { length: 55, width: 55, thickness: 60 },
        { kind: 'made', shelfId: null, file: null, form: 'rod', finish: 'unknown', conductive: false },
      ),
    );

    const svg = screen.getByTestId('engrave-setup-holding-picture');
    expect(svg.getAttribute('data-form')).toBe('rod');
    expect(svg.querySelector('circle')).not.toBeNull();
    expect(svg.textContent).toContain('⌀ 55');
    expect(screen.getByTestId('engrave-setup-holding-caption').textContent).toContain('rod');
  });

  it('#705 — the picture follows the mount radio, and a waste board is drawn under the stock', () => {
    seedLocation(machineWith(null));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    const svg = () => screen.getByTestId('engrave-setup-holding-picture');
    expect(svg().getAttribute('data-mount')).toBe('ledge');
    expect(screen.getByTestId('engrave-setup-holding-proud').textContent).toContain('0.71 mm proud');

    fireEvent.click(radio('board'));
    expect(svg().getAttribute('data-mount')).toBe('board');
    expect(screen.getByTestId('engrave-setup-holding-picture-board')).toBeTruthy();
    // 3.81 mm on the 2 mm board: 2.71 mm proud of the jaws.
    expect(screen.getByTestId('engrave-setup-holding-proud').textContent).toContain('2.71 mm proud');

    fireEvent.click(radio('block'));
    expect(svg().getAttribute('data-mount')).toBe('block');
    expect(screen.getByTestId('engrave-setup-holding-side').getAttribute('data-mount')).toBe('block');
    expect(screen.getByTestId('engrave-setup-holding-proud').textContent).toContain('sides free');
  });

  it('#705 — a disc on a waste board draws a circle on a board', () => {
    seedLocation(machineWith(null));
    // 2 mm is thinner than the ledge step, so the stock calls for the board and the step applies it.
    openHolding(
      dj(
        { length: 55, width: 55, thickness: 2 },
        { kind: 'made', shelfId: null, file: null, form: 'disc', finish: 'unknown', conductive: false },
      ),
    );

    const svg = screen.getByTestId('engrave-setup-holding-picture');
    expect(svg.getAttribute('data-mount')).toBe('board');
    expect(svg.querySelector('circle')).not.toBeNull();
    expect(screen.getByTestId('engrave-setup-holding-picture-board')).toBeTruthy();
    expect(svg.textContent).toContain('⌀ 55');
  });

  it('#705 — a mount that needs the machine change still draws on hover, labelled with what it needs', () => {
    seedLocation(machineWith(null));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    // The bed options are shown (this build can drive a machine) and disabled: the vise is on the
    // pins. Hovering one draws it, with the cost line — there is no pretend selection.
    const row = screen.getByTestId('engrave-setup-mount-row-bed-tape');
    expect(row.getAttribute('data-disabled')).toBe('true');
    fireEvent.mouseOver(row);
    expect(screen.getByTestId('engrave-setup-holding-picture').getAttribute('data-mount')).toBe('bed-tape');
    expect(screen.getByTestId('engrave-setup-holding-note').textContent).toContain(
      'needs the vise off the pins',
    );
    fireEvent.mouseOut(row);
    expect(screen.getByTestId('engrave-setup-holding-picture').getAttribute('data-mount')).toBe('ledge');
  });

  it('#698 — the orientation fold draws the three landmarks as labelled pictures, in the top view’s frame', () => {
    // The badge's blank in the vise's own frame (#383): 38.1 mm across the jaws in X, 76.2 mm
    // along them in Y — so its long edge is the one drawn on the LEFT, against the fixed jaw.
    const printed = dj(
      { length: 38.1, width: 76.2, thickness: 3.81 },
      { kind: 'made', shelfId: null, file: null, form: 'printed-blank', finish: 'printed', conductive: false },
    );
    seedLocation(machineWith(null));
    openHolding(printed);

    const fold = screen.getByTestId('engrave-setup-orientation') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    fireEvent.click(fold.querySelector('summary')!);
    expect(fold.open).toBe(true);

    const cards = [
      { key: 'face-up', label: 'Face up', caption: /printed face is up/i },
      { key: 'fixed-jaw', label: 'Against the fixed jaw', caption: /left edge.*fixed jaw/i },
      { key: 'nearest', label: 'Nearest you', caption: /front edge.*closest to you/i },
    ] as const;
    for (const card of cards) {
      const svg = screen.getByTestId(`engrave-setup-orientation-picture-${card.key}`);
      expect(svg.getAttribute('role')).toBe('img');
      expect(svg.getAttribute('aria-label')).toBeTruthy();
      expect(svg.querySelectorAll('rect, line, path, circle').length).toBeGreaterThan(0);
      expect(screen.getByTestId(`engrave-setup-orientation-label-${card.key}`).textContent).toBe(card.label);
      expect(screen.getByTestId(`engrave-setup-orientation-caption-${card.key}`).textContent).toMatch(
        card.caption,
      );
    }

    // THE PICTURES FOLLOW THE TOP VIEW'S OWN CONVENTION: the fixed jaw is on the LEFT, X runs
    // between the jaws, and the operator's front is the BOTTOM of the picture.
    const fixed = screen.getByTestId('engrave-setup-orientation-picture-fixed-jaw');
    const fixedJaw = fixed.querySelector('[data-role="fixed-jaw"]')!;
    const fixedStock = fixed.querySelector('[data-role="stock"]')!;
    const fixedMoving = fixed.querySelector('[data-role="moving-jaw"]')!;
    const jawRight = Number(fixedJaw.getAttribute('x')) + Number(fixedJaw.getAttribute('width'));
    const stockX = Number(fixedStock.getAttribute('x'));
    const stockRight = stockX + Number(fixedStock.getAttribute('width'));
    expect(jawRight).toBe(stockX);
    expect(stockRight).toBe(Number(fixedMoving.getAttribute('x')));
    const leftEdge = fixed.querySelector('[data-role="left-edge"]')!;
    expect(Number(leftEdge.getAttribute('x1'))).toBe(stockX);
    expect(Number(leftEdge.getAttribute('x2'))).toBe(stockX);

    const near = screen.getByTestId('engrave-setup-orientation-picture-nearest');
    const nearStock = near.querySelector('[data-role="stock"]')!;
    const nearFixed = near.querySelector('[data-role="fixed-jaw"]')!;
    const nearMoving = near.querySelector('[data-role="moving-jaw"]')!;
    const nearX = Number(nearStock.getAttribute('x'));
    const nearBottom = Number(nearStock.getAttribute('y')) + Number(nearStock.getAttribute('height'));
    expect(Number(nearFixed.getAttribute('x')) + Number(nearFixed.getAttribute('width'))).toBe(nearX);
    expect(nearX + Number(nearStock.getAttribute('width'))).toBe(Number(nearMoving.getAttribute('x')));
    const frontEdge = near.querySelector('[data-role="front-edge"]')!;
    expect(Number(frontEdge.getAttribute('y1'))).toBe(nearBottom);
    expect(Number(frontEdge.getAttribute('y2'))).toBe(nearBottom);
    // The operator stands BELOW the front edge: the near side is the bottom, never the left.
    expect(Number(near.querySelector('[data-role="operator"]')!.getAttribute('cy'))).toBeGreaterThan(
      nearBottom,
    );

    // The face-up picture is a side view: the printed layer is the top of the stock, with the
    // cutter above it — the face the operator must turn up.
    const face = screen.getByTestId('engrave-setup-orientation-picture-face-up');
    const slab = face.querySelector('[data-role="stock-slab"]')!;
    const layer = face.querySelector('[data-role="face-layer"]')!;
    expect(Number(layer.getAttribute('y'))).toBe(Number(slab.getAttribute('y')));
    expect(Number(layer.getAttribute('height'))).toBeLessThan(Number(slab.getAttribute('height')));
    expect(face.querySelector('[data-role="face-up-arrow"]')).not.toBeNull();
    expect(Number(face.querySelector('[data-role="cutter"]')!.getAttribute('y'))).toBeLessThan(
      Number(slab.getAttribute('y')),
    );

    // Stated facts, not a control (A10): nothing to choose inside the fold, and no codes.
    expect(fold.querySelectorAll('select, input, button')).toHaveLength(0);
    expect(fold.textContent).not.toMatch(/left end/i);
    expect(fold.textContent).not.toMatch(/vise-default|#\d/);
  });

  it('#698 — a finished face is named as finished; the fold still states the landmarks', () => {
    const finished = dj(
      { length: 38.1, width: 76.2, thickness: 3.81 },
      { kind: 'made', shelfId: null, file: null, form: 'plate', finish: 'finished', conductive: false },
    );
    seedLocation(machineWith(null));
    openHolding(finished);

    const faceUp = screen.getByTestId('engrave-setup-orientation-caption-face-up').textContent ?? '';
    expect(faceUp).toContain('finished face');
    expect(faceUp).not.toContain('printed');
    expect(screen.getByTestId('engrave-setup-orientation-picture-face-up').textContent).toContain(
      'finished face',
    );
    // The three facts are still there, whatever the face is called.
    expect(screen.getByTestId('engrave-setup-orientation-label-fixed-jaw').textContent).toBe(
      'Against the fixed jaw',
    );
    expect(screen.getByTestId('engrave-setup-orientation-label-nearest').textContent).toBe('Nearest you');
  });

  it('#698 — the orientation fold is not shown for an undifferentiated blank', () => {
    seedLocation(machineWith(null));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));
    expect(screen.queryByTestId('engrave-setup-orientation')).toBeNull();
  });

  it('keeps the jaw numbers and the vise-default provenance in the Technical fold, once', () => {
    seedLocation(machineWith(null));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));

    const rows = screen.getAllByTestId('engrave-setup-step-finding-vise-default');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Vise: the shipped dimensions, not measured on this machine');
    const technical = screen.getByTestId('engrave-setup-holding-technical');
    expect(technical.contains(rows[0]!)).toBe(true);
    expect(technical.textContent).toContain('10 mm fixed');
    expect(technical.textContent).toContain('10 mm moving');
    expect(technical.textContent).toContain('100 mm long');
    expect(technical.textContent).toContain('ledge 3.1 mm');
    // The panel's warning was the duplicate (B12): the step itself has no separate row.
    expect(screen.queryByTestId('engrave-setup-findings')?.textContent ?? '').not.toContain(
      'Vise dimensions: shipped defaults',
    );
  });
});

describe('#684 — the #693 escape, over the job wizard', () => {
  it('an option’s Change the machine… opens the real wizard with that mount and this job', () => {
    seedLocation(machineWith(null));
    const job = dj({ length: 76.2, width: 38.1, thickness: 3.81 });
    openHolding(job);

    fireEvent.click(screen.getByTestId('engrave-setup-change-bed-tape'));

    const state = useMachineChangeStore.getState();
    expect(state.open).toBe(true);
    expect(state.request.target).toBe('bed');
    expect(state.request.forJob?.name).toBe(job.name);
    expect(state.request.forJob?.holding).toBe('held on the bed, taped');
    expect(typeof state.request.onDone).toBe('function');

    // Both dialogs are up at once: the job wizard is still behind the change wizard.
    expect(screen.getByTestId('start-wizard')).toBeTruthy();
    expect(screen.getByTestId('machine-change')).toBeTruthy();
  });

  it('the machine-now Change the machine… opens the wizard with no target, letting step 1 offer the mounts', () => {
    seedLocation(machineWith(null));
    const job = dj({ length: 76.2, width: 38.1, thickness: 3.81 });
    openHolding(job);

    fireEvent.click(screen.getByTestId('engrave-setup-change-machine'));
    expect(useMachineChangeStore.getState().request.target).toBeUndefined();
    expect(useMachineChangeStore.getState().request.forJob?.holding).toBe('held in the vise on the jaw ledge');
  });

  it('the change wizard’s dialog sits above the job wizard’s dialog', () => {
    seedLocation(machineWith(null));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 3.81 }));
    fireEvent.click(screen.getByTestId('engrave-setup-change-bed-tape'));

    // The job wizard is at the modal layer of the one stacking scale; the change wizard must be at
    // the raised layer (jsdom does not process the CSS import, so both carry the token inline).
    const jobOverlay = screen.getByTestId('start-wizard');
    const changeOverlay = screen.getByTestId('machine-change-backdrop');
    expect(jobOverlay.style.zIndex).toBe('var(--cm-z-modal)');
    expect(changeOverlay.style.zIndex).toBe('var(--cm-z-modal-raised)');

    // …and the tokens themselves are ordered, so the names are not just labels.
    const tokens = readFileSync(join(APP, 'src', 'styles', 'tokens.css'), 'utf8');
    const value = (name: string): number => {
      const match = new RegExp(`${name}:\\s*(\\d+)`).exec(tokens);
      expect(match, `${name} should be in tokens.css`).not.toBeNull();
      return Number(match![1]);
    };
    expect(value('--cm-z-modal-raised')).toBeGreaterThan(value('--cm-z-modal'));
  });
});

describe('#684 — operator words', () => {
  it('has no finding codes or internal keys in the step’s visible words', () => {
    seedLocation(machineWith(BOARDS_AND_TAPE));
    openHolding(dj({ length: 76.2, width: 38.1, thickness: 2 }));
    const text = screen.getByTestId('engrave-setup-step-holding').textContent ?? '';
    for (const code of ['vise-default', 'vise-stock-proud', 'sacrificial', 'stockProud', 'seatDepth']) {
      expect(text).not.toContain(code);
    }
  });

  it('formats numbers to at most three decimals with trailing zeros dropped', () => {
    expect(fmt(0.7100000001)).toBe('0.71');
    expect(fmt(3.1)).toBe('3.1');
    expect(fmt(4)).toBe('4');
    expect(fmt(-1.1000000001)).toBe('-1.1');
  });
});
