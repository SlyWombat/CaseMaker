// @vitest-environment jsdom
// Issue #418 — the start wizard's material-first step: shelf stock → mount → an empty design, with
// the project's part sized to the stock. The shelf is a fake house client (as `stockShelf.spec.ts`
// fakes it); `scheduleImmediate` is mocked because jsdom has no geometry worker.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { jobVise } from '@/engine/cnc/fixture';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import locationDoc from './fixtures/location-doc.json';
import { StartWizard } from '@/components/welcome/StartWizard';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetMachineStore } from '@/store/machineStore';
import { createDefaultProject, useProjectStore } from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { resetStockStore } from '@/store/stockStore';
import { useViewportStore } from '@/store/viewportStore';
import type { JobStockEntry } from '@/types/engraveJob';

vi.mock('@/engine/jobs/JobScheduler', () => ({ scheduleImmediate: vi.fn(async () => {}) }));

const caps = vi.hoisted(() => ({ drive: false }));
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

const SHELF = (locationDoc as { stock: unknown[] }).stock;

/** The service's shelf: GET and POST, and every request logged. `null` = no service at all. */
function fakeShelf(initial: unknown[] | null) {
  const items = JSON.parse(JSON.stringify(initial ?? [])) as Array<{ id: string }>;
  const calls: string[] = [];
  const client = {
    call: async (method: string, path: string, body?: unknown): Promise<HouseCall> => {
      calls.push(`${method} ${path}`);
      if (initial === null) return { kind: 'absent', reason: 'no house service here' };
      if (method === 'GET' && path === '/stock') return { kind: 'ok', text: JSON.stringify(items), etag: '"s-1"' };
      if (method === 'POST' && path === '/stock') {
        items.push(body as { id: string });
        return { kind: 'ok', text: '' };
      }
      return { kind: 'refused', status: 400, message: `unexpected ${method} ${path}` };
    },
  } as unknown as HouseClient;
  setHouseClientLoader(async () => client);
  return { calls, items: () => items };
}

beforeEach(() => {
  cleanup();
  resetMachineStore();
  useSettingsStore.getState().resetSettings();
  resetStartWizard();
  resetStockStore();
  useProjectStore.setState({ project: createDefaultProject('rpi-4b'), welcomeMode: true });
  useViewportStore.setState({ activeSidebarSection: null, selection: null });
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
});

afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
});

/** The wizard as `AppShell` mounts it: closing it unmounts the modal. */
function WizardHost() {
  const open = useStartWizardStore((s) => s.open);
  return open ? <StartWizard /> : <></>;
}

async function toStockStep(): Promise<void> {
  act(() => {
    useStartWizardStore.getState().openWizard();
  });
  render(<WizardHost />);
  await act(async () => {
    fireEvent.click(screen.getByTestId('start-wizard-next'));
  });
  expect(screen.getByTestId('start-wizard-step-stock')).toBeDefined();
}

function chooseMaterial(value: string): void {
  fireEvent.change(screen.getByTestId('start-wizard-stock-material'), { target: { value } });
}

/** A closed 40 × 30 × 6 mm box as an ASCII STL — the smallest file the stock reader accepts. */
function boxStl(name = 'blank.stl'): File {
  const p: [number, number, number][] = [
    [0, 0, 0],
    [40, 0, 0],
    [40, 30, 0],
    [0, 30, 0],
    [0, 0, 6],
    [40, 0, 6],
    [40, 30, 6],
    [0, 30, 6],
  ];
  const faces = [
    [4, 5, 6],
    [4, 6, 7], // top
    [0, 2, 1],
    [0, 3, 2], // bottom
    [0, 1, 5],
    [0, 5, 4], // y = 0
    [1, 2, 6],
    [1, 6, 5], // x = 40
    [2, 3, 7],
    [2, 7, 6], // y = 30
    [3, 0, 4],
    [3, 4, 7], // x = 0
  ];
  const facets = faces
    .map(
      (f) =>
        `facet normal 0 0 0\nouter loop\n${f.map((i) => `vertex ${p[i]!.join(' ')}`).join('\n')}\nendloop\nendfacet`,
    )
    .join('\n');
  return new File([`solid blank\n${facets}\nendsolid blank\n`], name);
}

describe('the material-first start (#418)', () => {
  it('shelf stock → mount → an empty design, the part sized to the stock, nothing reserved', async () => {
    const svc = fakeShelf(SHELF);
    await toStockStep();
    chooseMaterial('aluminium-6061');
    const plate = await screen.findByTestId('start-wizard-shelf-item-stock-plate1');
    expect(plate.getAttribute('data-state')).toBe('ok');
    fireEvent.click(plate);

    // The shelf row IS the answer: its numbers sit in the panel's own size fields (#683).
    expect((screen.getByTestId('start-wizard-make-length') as HTMLInputElement).value).toBe('100');
    expect((screen.getByTestId('start-wizard-make-width') as HTMLInputElement).value).toBe('100');
    expect((screen.getByTestId('start-wizard-make-thickness') as HTMLInputElement).value).toBe('5');
    // No prose repeats what the row and the fields already say (#683, A8).
    expect(screen.queryByTestId('start-wizard-stock-summary')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });

    // Step 3 of the SAME wizard. The hand-off seeds an EMPTY job and the shelf already answered
    // the material and the blank, so the mount is the next question — one modal, one counter.
    expect(screen.getByTestId('engrave-setup-step-holding')).toBeDefined();
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Holding');
    expect(screen.queryByTestId('engrave-setup-flow')).toBeNull();

    const job = useEngraveJobStore.getState().job;
    expect(job.stock).toMatchObject({ length: 100, width: 100, thickness: 5, material: 'aluminium-6061' });
    expect(job.sources?.stock?.length).toBe('user');
    expect(job.labels).toEqual([]);
    expect(job.stockEntry).toEqual({
      kind: 'shelf',
      shelfId: 'stock-plate1',
      file: null,
      form: 'plate',
      finish: 'rough',
      conductive: true,
    });
    // The vise followed the 5 mm plate (#344): the shipped 4 mm proud would not seat it.
    expect(jobVise(job).stockProud).toBeLessThanOrEqual(5 - 3.1 + 1e-9);

    // The part IS the stock — what the viewport draws.
    const project = useProjectStore.getState().project;
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(project.case.blank).toMatchObject({ enabled: true, width: 100, height: 100, thickness: 5, cornerRadius: 0 });
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');

    // Named, not reserved: Cut mode (#419) reserves.
    expect(svc.calls.filter((c) => !c.startsWith('GET'))).toEqual([]);

    // Step 4 — the grouped picker; Create makes the one operation asked for and lands in Design.
    fireEvent.click(screen.getByTestId('engrave-setup-next'));
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe(
      'Step 4 of 4 · What are you cutting?',
    );
    fireEvent.click(screen.getByTestId('engrave-setup-what-pocket'));
    fireEvent.click(screen.getByTestId('start-wizard-create'));
    expect(screen.queryByTestId('start-wizard')).toBeNull();

    // The design holds only the operation step 4 asked for, never a label from the project, and
    // the name of the piece survives the exit.
    const after = useEngraveJobStore.getState().job;
    expect(after.labels).toEqual([]);
    expect(after.shapes).toHaveLength(1);
    expect(after.stockEntry?.shelfId).toBe('stock-plate1');
  });

  it('a laminate row names its assumed cap, and the job takes the cap and its provenance (#492)', async () => {
    fakeShelf(SHELF);
    await toStockStep();
    chooseMaterial('plastic');
    const laminate = await screen.findByTestId('start-wizard-shelf-item-stock-laminate1');
    expect(laminate.textContent).toContain('cap 0.075 (assumed)');
    fireEvent.click(laminate);

    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    await screen.findByTestId('engrave-setup-step-holding');

    const job = useEngraveJobStore.getState().job;
    expect(job.stock.material).toBe('plastic');
    expect(job.stock.colour).toEqual({ kind: 'laminate', capMm: 0.075 });
    expect(job.sources?.stock?.colour).toBe('assumed');
    // A laminate is not a print: no layer grid and no dome are invented from the shelf entry.
    expect(job.stock).not.toHaveProperty('flatness');
    expect(job.sources?.stock?.colour).not.toBe('computed');
  });

  it('a used-up entry is listed, greyed, with the job that used it', async () => {
    fakeShelf(SHELF);
    await toStockStep();
    chooseMaterial('pla');
    const blank = await screen.findByTestId('start-wizard-shelf-item-stock-blank1');
    expect(blank.getAttribute('data-state')).toBe('refused');
    expect((blank as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('start-wizard-shelf-item-stock-blank1-reason').textContent).toBe('none left — consumed by job-12');
    expect((screen.getByTestId('start-wizard-stock-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('no service: no shelf block and no tick; a typed piece still starts the job', async () => {
    fakeShelf(null);
    await toStockStep();
    // Nothing on the shelf and nowhere to keep a piece: the block is absent, not a disabled
    // control with a sentence about a service the operator cannot see (#683, principle 4).
    expect(screen.queryByTestId('start-wizard-shelf')).toBeNull();
    expect(screen.queryByTestId('start-wizard-make-save')).toBeNull();
    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '80' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-width'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-thickness'), { target: { value: '6' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    await screen.findByTestId('engrave-setup-step-holding');
    const job = useEngraveJobStore.getState().job;
    expect(job.stock).toMatchObject({ length: 80, width: 50, thickness: 6 });
    // The opening finish is "as bought" (#683, A8), so a made piece is rough unless said otherwise.
    expect(job.stockEntry).toMatchObject({ kind: 'made', shelfId: null, form: 'plate', finish: 'rough' });
    // Non-square on purpose: an X/Y swap would show here. Length (X) is the blank's width, width (Y)
    // its height — `blankStockFor`'s mapping, read back the other way.
    expect(useProjectStore.getState().project.case.blank).toMatchObject({ width: 80, height: 50, thickness: 6 });
  });

  it('a typed piece kept on the shelf is POSTed first, and the job names the new entry', async () => {
    const svc = fakeShelf(SHELF);
    await toStockStep();
    chooseMaterial('brass');
    // Nothing in brass on the shelf, so the block is absent; the service is there, so the tick
    // is offered beside the size. The shelf gets its first piece this way.
    const tick = await screen.findByTestId('start-wizard-make-save');
    expect(screen.queryByTestId('start-wizard-shelf')).toBeNull();
    fireEvent.click(screen.getByTestId('start-wizard-form-block'));
    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '40' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-width'), { target: { value: '30' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-thickness'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('start-wizard-stock-finish'), { target: { value: 'finished' } });
    fireEvent.click(tick);
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    await screen.findByTestId('engrave-setup-step-holding');
    expect(svc.calls).toContain('POST /stock');
    const saved = svc.items().find((i) => (i as { material?: string }).material === 'brass')!;
    expect(useEngraveJobStore.getState().job.stockEntry).toMatchObject({ kind: 'made', shelfId: saved.id, form: 'block' });
  });

  // #474/#493 — the maintainer, 2026-10-17: facing plastic will never work. Any plastic blank seeds
  // off with no depth even when it says it is rough — printed PETG and purchased acrylic alike — and
  // the wizard says why rather than staying silent.
  it.each([
    ['petg'],
    ['acrylic'],
  ] as const)('a plastic seeds facing off with no depth, whatever the finish (#474, #493)', async (material) => {
    fakeShelf(SHELF);
    await toStockStep();
    chooseMaterial(material);
    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '60' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-width'), { target: { value: '40' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-thickness'), { target: { value: '3' } });
    fireEvent.change(screen.getByTestId('start-wizard-stock-finish'), { target: { value: 'rough' } });

    // One line on the step, not a paragraph (#683, A8): plastic is cut as it is.
    expect(screen.getByTestId('start-wizard-stock-finish-hint').textContent).toContain(
      'plastic is cut as it is; wood and metal are faced first',
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    await screen.findByTestId('engrave-setup-step-holding');
    expect(useEngraveJobStore.getState().job.stock.material).toBe(material);
    expect(useEngraveJobStore.getState().job.facing).toEqual({ enabled: false, depth: 0 });
  });

  it('Back to stock after the project was made: a changed piece re-sizes the drawn part', async () => {
    fakeShelf(null);
    await toStockStep();
    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '60' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-width'), { target: { value: '40' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-thickness'), { target: { value: '8' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    await screen.findByTestId('engrave-setup-step-holding');
    expect(useProjectStore.getState().project.case.blank).toMatchObject({ width: 60, height: 40, thickness: 8 });

    fireEvent.click(screen.getByTestId('start-wizard-back'));
    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '80' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-width'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-thickness'), { target: { value: '6' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    await screen.findByTestId('engrave-setup-step-holding');

    // The part IS the stock: a step-2 change inside this run is a new start, not an edit under the
    // old-sized part.
    expect(useProjectStore.getState().project.case.blank).toMatchObject({ width: 80, height: 50, thickness: 6 });
    expect(useEngraveJobStore.getState().job.stock).toMatchObject({ length: 80, width: 50, thickness: 6 });
    expect(useEngraveJobStore.getState().job.stockEntry).toMatchObject({ kind: 'made' });
    // Nothing was on the job to lose, so nothing was asked.
    expect(screen.queryByTestId('start-wizard-replace-confirm')).toBeNull();
  });

  it('a round form is a picture with its sentence, and its size is a diameter (#683, #713)', async () => {
    fakeShelf(SHELF);
    await toStockStep();
    // Seven pictures, in the mockup's order, never a refusal paragraph on the default path.
    const order = ['plate', 'block', 'sheet', 'printed-blank', 'disc', 'rod', 'tube'];
    const drawn = Array.from(
      screen.getByTestId('start-wizard-make-form').querySelectorAll('button'),
    ).map((b) => b.getAttribute('data-testid'));
    expect(drawn).toEqual(order.map((form) => `start-wizard-form-${form}`));
    // The block's sentence states which mount takes it, in the module's own numbers.
    fireEvent.click(screen.getByTestId('start-wizard-form-block'));
    expect(screen.getByTestId('start-wizard-form-sentence').textContent).toBe(
      'Block — squared stock: in the vise as today, or in the chuck when its diagonal fits ⌀80 × 150.',
    );
    fireEvent.click(screen.getByTestId('start-wizard-form-rod'));
    expect(screen.getByTestId('start-wizard-form-sentence').textContent).toBe(
      'Rod — round stock: a dowel, a rod. A rod up to 20 mm long stands on its end in the vise; a longer one is held in the rotary chuck and cut around (step 3 offers it).',
    );
    // The rod's own fields: its diameter and its length, and no invented width or thickness.
    expect(screen.getByTestId('start-wizard-make-diameter')).toBeDefined();
    expect(screen.getByTestId('start-wizard-make-length')).toBeDefined();
    expect(screen.queryByTestId('start-wizard-make-width')).toBeNull();
    expect(screen.queryByTestId('start-wizard-make-thickness')).toBeNull();
    // Nothing is around until a diameter is typed.
    expect(screen.queryByTestId('start-wizard-stock-around')).toBeNull();

    fireEvent.change(screen.getByTestId('start-wizard-make-diameter'), { target: { value: '20' } });
    // The surface a map lays text against: 2π × 10 = 62.832.
    expect(screen.getByTestId('start-wizard-stock-around').textContent).toBe('Around: 62.832 mm at the surface');

    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '18' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    await screen.findByTestId('engrave-setup-step-holding');
    // The rod stands on its end: D × D × L, cut on the ⌀D end, and the form stays 'rod'. The round
    // facts are written, and a rod states no wall.
    const job = useEngraveJobStore.getState().job;
    expect(job.stock).toMatchObject({ length: 20, width: 20, thickness: 18, shape: 'cylinder', diameter: 20 });
    expect(job.stock).not.toHaveProperty('wall');
    expect(job.stockEntry).toMatchObject({ kind: 'made', form: 'rod' });
  });

  it('a long rod is the rotary sentence under the picture, and Next goes on (#713)', async () => {
    fakeShelf(SHELF);
    await toStockStep();
    fireEvent.click(screen.getByTestId('start-wizard-form-rod'));
    fireEvent.change(screen.getByTestId('start-wizard-make-diameter'), { target: { value: '12' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '30' } });
    // The form's own sentence says it — not a second red line about a number the operator typed.
    expect(screen.getByTestId('start-wizard-form-sentence').textContent).toBe(
      'A rod this long is held in the rotary — the vise holds one up to 20 mm tall standing on its end, and this one is 30 mm.',
    );
    expect(screen.queryByTestId('start-wizard-stock-problem')).toBeNull();
    // NOT a block since #713: the answer stands, and Next goes on to Holding, which offers the chuck.
    expect((screen.getByTestId('start-wizard-stock-next') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('start-wizard-stock-unblock')).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    await screen.findByTestId('engrave-setup-step-holding');
    expect(useEngraveJobStore.getState().job.stock).toMatchObject({
      shape: 'cylinder',
      diameter: 12,
      length: 12,
      width: 12,
      thickness: 30,
    });
  });

  it('a tube on the shelf and a typed tube write their wall; the rotary refuses the envelope (#713)', async () => {
    const disc = {
      ...(SHELF[0] as object),
      id: 'stock-disc1',
      form: 'disc',
      size: { diameter: 50, thickness: 5 },
      reservations: [],
    };
    const tube = {
      ...(SHELF[0] as object),
      id: 'stock-tube1',
      form: 'tube',
      size: { diameter: 40, wall: 2, length: 100 },
      reservations: [],
    };
    fakeShelf([...SHELF, disc, tube]);
    await toStockStep();
    chooseMaterial('aluminium-6061');
    const discRow = await screen.findByTestId('start-wizard-shelf-item-stock-disc1');
    expect(discRow.getAttribute('data-state')).toBe('ok');
    expect(discRow.textContent).toContain('⌀50 × 5 mm');
    fireEvent.click(discRow);
    expect((screen.getByTestId('start-wizard-make-diameter') as HTMLInputElement).value).toBe('50');
    expect((screen.getByTestId('start-wizard-make-thickness') as HTMLInputElement).value).toBe('5');

    const tubeRow = screen.getByTestId('start-wizard-shelf-item-stock-tube1');
    expect(tubeRow.getAttribute('data-state')).toBe('ok');
    expect(tubeRow.textContent).toContain('⌀40 × 100 mm, wall 2 mm');
    fireEvent.click(tubeRow);
    // The tube's number lands in its own fields, wall included, and its surface is shown.
    expect((screen.getByTestId('start-wizard-make-diameter') as HTMLInputElement).value).toBe('40');
    expect((screen.getByTestId('start-wizard-make-wall') as HTMLInputElement).value).toBe('2');
    expect((screen.getByTestId('start-wizard-make-length') as HTMLInputElement).value).toBe('100');
    expect(screen.getByTestId('start-wizard-stock-around').textContent).toBe('Around: 125.664 mm at the surface');

    // The rotary's envelope is the one size refusal, at the size field, in the module's numbers.
    fireEvent.change(screen.getByTestId('start-wizard-make-diameter'), { target: { value: '90' } });
    expect(screen.getByTestId('start-wizard-stock-problem').textContent).toBe(
      "⌀90 mm does not fit the rotary's ⌀80 × 150 mm.",
    );
    expect((screen.getByTestId('start-wizard-stock-next') as HTMLButtonElement).disabled).toBe(true);

    // The envelope's other end, at the same field: a 200 mm rod is past the module's 150 mm span.
    // The refusal is ONE sentence on screen — not a second copy under the size or in the footer.
    fireEvent.change(screen.getByTestId('start-wizard-make-diameter'), { target: { value: '40' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '200' } });
    expect(screen.getByTestId('start-wizard-stock-problem').textContent).toBe(
      "200 mm does not fit the rotary's ⌀80 × 150 mm.",
    );
    expect(screen.getAllByText(/does not fit the rotary/)).toHaveLength(1);
    expect((screen.getByTestId('start-wizard-stock-next') as HTMLButtonElement).disabled).toBe(true);

    // Inside it again, Next goes on, and the tube writes the cylinder stock with its wall.
    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '100' } });
    fireEvent.change(screen.getByTestId('start-wizard-make-diameter'), { target: { value: '40' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    await screen.findByTestId('engrave-setup-step-holding');
    expect(useEngraveJobStore.getState().job.stock).toMatchObject({
      length: 40,
      width: 40,
      thickness: 100,
      shape: 'cylinder',
      diameter: 40,
      wall: 2,
    });
    // Editing a number made the tube the operator's own: the entry is a made tube, still with its wall.
    expect(useEngraveJobStore.getState().job.stockEntry).toMatchObject({ kind: 'made', form: 'tube' });
  });

  it("the material is grouped three ways, this house's own first (#683, A4, A5)", async () => {
    fakeShelf(SHELF);
    await toStockStep();
    // A fresh house is PLA — never the shipped demo's softwood.
    const select = screen.getByTestId('start-wizard-stock-material') as HTMLSelectElement;
    expect(select.value).toBe('pla');
    const groups = Array.from(select.querySelectorAll('optgroup'));
    expect(groups.map((g) => g.label)).toEqual(['Plastics', 'Woods', 'Metals']);
    const plastics = Array.from(groups[0]!.querySelectorAll('option')).map((o) => o.value);
    expect(plastics[plastics.length - 1]).toBe('plastic'); // "plastic (unspecified)" is last
    expect(plastics).not.toContain('softwood');
    expect(screen.getByTestId('start-wizard-stock-material-hint').textContent).toContain(
      "Plastics · Woods · Metals, this house's first",
    );
  });

  it('a job that states its material is the house material a new job opens on', async () => {
    fakeShelf(SHELF);
    const base = defaultEngraveJob();
    useEngraveJobStore.setState({ job: { ...base, stock: { ...base.stock, material: 'brass' } } });
    await toStockStep();
    expect((screen.getByTestId('start-wizard-stock-material') as HTMLSelectElement).value).toBe('brass');
  });

  it('asks before replacing a job that has items, and Keep it leaves the job alone', async () => {
    fakeShelf(SHELF);
    const before = { ...defaultEngraveJob(), labels: defaultEngraveJob().labels.slice(0, 1) };
    useEngraveJobStore.setState({ job: before });
    await toStockStep();
    chooseMaterial('aluminium-6061');
    fireEvent.click(await screen.findByTestId('start-wizard-shelf-item-stock-plate1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    expect(screen.getByTestId('start-wizard-replace-confirm').textContent).toContain('1 item on it');
    fireEvent.click(screen.getByTestId('start-wizard-replace-no'));
    expect(screen.queryByTestId('start-wizard-replace-confirm')).toBeNull();
    expect(useEngraveJobStore.getState().job).toBe(before);

    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-replace-yes'));
    });
    await screen.findByTestId('engrave-setup-step-holding');
    expect(useEngraveJobStore.getState().job.labels).toEqual([]);
  });

  it('a job with only the demo lines starts without asking', async () => {
    fakeShelf(SHELF);
    await toStockStep();
    chooseMaterial('aluminium-6061');
    fireEvent.click(await screen.findByTestId('start-wizard-shelf-item-stock-plate1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    expect(screen.queryByTestId('start-wizard-replace-confirm')).toBeNull();
    await screen.findByTestId('engrave-setup-step-holding');
  });

  it('the blank checks that lost their own step still speak, on the holding step', () => {
    // A job whose stock is thinner than the vise stands it: the #231 refusal the old blank step
    // owned. It is shown where the operator can act on it — the holding step of the one wizard.
    const stock = { ...defaultEngraveJob().stock, length: 60, width: 30, thickness: 4.5 };
    useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), stock } });
    act(() => {
      useEngraveJobStore.getState().setVise({ stockProud: 5, source: 'saved' });
    });
    act(() => {
      useStartWizardStore.getState().openWizard('holding');
    });
    render(<StartWizard />);

    expect(screen.getByTestId('engrave-setup-fix-slot')).toBeDefined();
    expect(screen.getByTestId('engrave-setup-fix-slot').textContent).toContain(
      'taller than this 4.5 mm blank',
    );
    const row = screen.getByTestId('engrave-setup-step-finding-vise-stock-proud-exceeds-thickness');
    // The sentence is operator text; the CODE stays in the test id (A10, D1).
    expect(row.textContent).toContain('nothing is left in the jaws');
    expect(row.textContent).not.toContain('vise-stock-proud-exceeds-thickness');
  });
});

describe('stockEntry follows the stock (#418 review)', () => {
  const entry: JobStockEntry = { kind: 'shelf', shelfId: 'stock-plate1', file: null, form: 'plate', finish: 'rough', conductive: true };

  it('an edit to the size or the material clears it; re-stating the same stock keeps it', async () => {
    await import('@/store/stockEntryFollow');
    const store = useEngraveJobStore.getState();
    store.replace({ ...defaultEngraveJob(), stockEntry: entry });
    store.setStock({ length: useEngraveJobStore.getState().job.stock.length });
    expect(useEngraveJobStore.getState().job.stockEntry).toEqual(entry);
    store.setStock({ length: 90 });
    expect(useEngraveJobStore.getState().job).not.toHaveProperty('stockEntry');

    store.replace({ ...useEngraveJobStore.getState().job, stockEntry: entry });
    store.setStock({ material: 'brass' });
    expect(useEngraveJobStore.getState().job).not.toHaveProperty('stockEntry');
  });

  it('a template start clears an entry an earlier start named', async () => {
    fakeShelf(SHELF);
    useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), stockEntry: entry } });
    // The door's starter (#680) is the one template path since #683 took the cards out of step 2.
    act(() => {
      useStartWizardStore.getState().openWizard('machine', 'blank');
    });
    render(<WizardHost />);
    await screen.findByTestId('engrave-setup-step-holding');
    expect(useEngraveJobStore.getState().job).not.toHaveProperty('stockEntry');
  });
});

describe('a mesh loaded as stock takes its finish default from the material (#463)', () => {
  // The classes a slicer can produce — PrusaSlicer's filament words, #456.
  const PRINTED = ['pla', 'petg', 'pet', 'abs', 'asa', 'hips', 'pa', 'pa-cf', 'pa-gf', 'pc', 'pp', 'tpu', 'pva'];
  // Anything else is bought stock, and the step's opening finish is "as bought" (#683, A8) —
  // the old "not known" default was the last option of the list.
  const NOT_PRINTED = ['softwood', 'hardwood', 'mdf', 'acrylic', 'aluminium-6061', 'brass'];

  /** Pick the material, load the same box as stock, and answer with the finish the step chose. */
  async function loadMesh(material: string): Promise<string> {
    fakeShelf(SHELF);
    await toStockStep();
    chooseMaterial(material);
    fireEvent.change(screen.getByTestId('start-wizard-load-file'), { target: { files: [boxStl()] } });
    // Wait for the read to land — the file's name is drawn — then read the finish the step chose.
    await screen.findByTestId('start-wizard-load-name');
    return (screen.getByTestId('start-wizard-stock-finish') as HTMLSelectElement).value;
  }

  it.each(PRINTED)('%s: the finish defaults to printed', async (material) => {
    expect(await loadMesh(material)).toBe('printed');
  });

  it.each(NOT_PRINTED)('%s: the finish stays as bought', async (material) => {
    expect(await loadMesh(material)).toBe('rough');
  });
});
