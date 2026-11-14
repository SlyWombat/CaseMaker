// @vitest-environment jsdom
// Issue #897 — the work comes before the blank.
//
// The wizard asks what is being cut BEFORE it asks for the stock, and the stock step opens on the
// blank that work needs: a line's measured extent plus the margin, a board's outline plus the
// import's scrap. Every number stays the operator's to change, and an edited answer is kept when
// they go back to the question. A board is the one route whose ITEMS already exist when the stock
// step opens — those must survive it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { seedTestShopShelf } from '../tools/testShopStock';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { StartWizard } from '@/components/welcome/StartWizard';
import { PCB_STANDARD_THICKNESS_MM, jobItemCount } from '@/engine/cnc/stockStart';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { resetStockStore } from '@/store/stockStore';

vi.mock('@/engine/jobs/JobScheduler', () => ({ scheduleImmediate: vi.fn(async () => {}) }));
// The board's chip drives the store's real import action. Its PLANNER needs the Manifold runtime
// and real Gerber bytes (pinned in `pcbJobImport.spec.ts` and the e2e walk); here the question is
// what survives the stock step, so the planner answers with one outline vector and no drills.
vi.mock('@/workers/geometry/ManifoldRuntime', () => ({ getToplevel: async () => ({}) }));
vi.mock('@/engine/import/pcbJobImport', () => ({
  planPcbJobImport: async () => ({
    ok: true as const,
    plan: {
      files: [{ name: 'practice-F_Cu.gbr', kind: 'gerber' }],
      board: { left: 0, top: 0, width: 60, height: 40 },
      mount: { kind: 'tape' },
      mirrored: false,
      twoSided: false,
      second: null,
      copperId: 'vec-copper',
      outlineId: 'vec-outline',
      items: {
        vectors: [
          {
            id: 'vec-outline',
            kind: 'vector',
            name: 'Board outline',
            sourceName: 'practice-F_Cu.gbr',
            position: { x: 30, y: 20 },
            rotation: 0,
            depth: 1.6,
            enabled: true,
            construction: true,
            contours: [
              [
                [0, 0],
                [60, 0],
                [60, 40],
                [0, 40],
              ],
            ],
            fillRule: 'NonZero',
            width: 60,
            height: 40,
          },
        ],
        frames: [],
        drills: [],
        cutouts: [],
      },
      notes: [],
      warnings: [],
    },
    sources: [],
    skipped: [],
  }),
}));

// The web target: no socket to check, so step 1 is one press ("Continue without a machine").
vi.mock('@/platform/capabilities', async (orig) => {
  const real = await orig<typeof import('@/platform/capabilities')>();
  return {
    ...real,
    get canReachMachine() {
      return false;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function WizardHost() {
  const open = useStartWizardStore((s) => s.open);
  return open ? <StartWizard /> : <></>;
}

function openWizard(): void {
  act(() => {
    useStartWizardStore.getState().openWizard();
  });
  render(<WizardHost />);
}

function progress(): string {
  return screen.getByTestId('start-wizard-progress').textContent ?? '';
}

/** Step 1 → step 2, the question — the work comes before the blank. */
function toQuestion(): void {
  fireEvent.click(screen.getByTestId('start-wizard-next'));
  expect(progress()).toContain('What are you making?');
}

/** Leaving the blank: a job with items on it asks before it is replaced. */
async function leaveStock(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
  });
  const yes = screen.queryByTestId('start-wizard-replace-yes');
  if (yes !== null) {
    await act(async () => {
      fireEvent.click(yes);
    });
  }
}

beforeEach(() => {
  cleanup();
  resetStartWizard();
  resetStockStore();
  useEngraveJobStore.setState({ job: defaultEngraveJob() });
});

afterEach(() => {
  cleanup();
});


/** The tetrahedron `targetObject.spec.ts` reads: a real, non-flat 10 × 10 × 10 mm STL. */
const ASCII_STL = `solid tet
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 0 10 0
  endloop
endfacet
facet normal 0 1 0
  outer loop
    vertex 0 0 0
    vertex 10 0 0
    vertex 0 0 10
  endloop
endfacet
facet normal 1 0 0
  outer loop
    vertex 0 0 0
    vertex 0 10 0
    vertex 0 0 10
  endloop
endfacet
facet normal 1 1 1
  outer loop
    vertex 10 0 0
    vertex 0 10 0
    vertex 0 0 10
  endloop
endfacet
endsolid tet
`;

describe('#897 — the question comes first, and it sizes the blank', () => {
  it('a line of text proposes the blank from the shop’s shelf, and the sentence says so', async () => {
    seedTestShopShelf();
    openWizard();
    toQuestion();
    // #1100 — a text job comes from the sign card now.
    fireEvent.click(screen.getByTestId('start-wizard-preset-sign'));
    fireEvent.change(screen.getByTestId('start-wizard-preset-text'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('start-wizard-operation-next'));

    expect(progress()).toContain('Stock');
    // #1259 — THE SHELF'S OWN STICK, not a plate sized from the line: the shop's recorded stock
    // holds the line, so a first job keeps every default. (The stick lies ALONG the jaws: 36 mm
    // between them (X), 100 mm along them (Y), 36 tall.)
    expect(screen.getByTestId('engrave-setup-stock-provenance').textContent).toContain(
      'From your shelf: hardwood block, 36 × 100 × 36 mm.',
    );
    expect(screen.getByTestId('start-wizard-stock-summary').textContent).toContain('36 × 100 × 36 mm');

    await leaveStock();
    // The hold follows from the blank the work asked for, and the last step creates the line.
    expect(screen.getByTestId('engrave-setup-step-holding')).toBeDefined();
    expect(screen.queryByTestId('start-wizard-holding-block')).toBeNull();
    expect(screen.getByTestId('engrave-setup-next').textContent).toBe('Create the job');
    fireEvent.click(screen.getByTestId('engrave-setup-next'));

    const job = useEngraveJobStore.getState().job;
    expect(job.labels).toHaveLength(1);
    // #1100 — the sign card states no depth: the line takes the job's own stock-aware default.
    expect(job.labels[0]).toMatchObject({ text: 'Hello' });
    expect(job.stock.material).toBe('hardwood');
    expect([job.stock.length, job.stock.width, job.stock.thickness]).toEqual([36, 100, 36]);
    // …and a finished face is cut as it is: the first-job path does not face.
    expect(job.facing).toEqual({ enabled: false, depth: 0.2, source: 'seed' });
  });

  it('a job that states its own material is held only by stock of it, so brass on the hardwood stick asks for the blank the work needs', () => {
    seedTestShopShelf();
    const base = defaultEngraveJob();
    useEngraveJobStore.setState({ job: { ...base, stock: { ...base.stock, material: 'brass' } } });
    openWizard();
    toQuestion();
    // #1100 — a text job comes from the sign card now.
    fireEvent.click(screen.getByTestId('start-wizard-preset-sign'));
    fireEvent.change(screen.getByTestId('start-wizard-preset-text'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('start-wizard-operation-next'));

    // The proposal does not overrule the piece the job has named, and a hardwood stick is not a
    // piece of brass (#1259): nothing on the shelf holds this in brass.
    expect((screen.getByTestId('start-wizard-stock-material') as HTMLSelectElement).value).toBe('brass');
    expect(screen.getByTestId('engrave-setup-stock-provenance').textContent).toContain(
      'Nothing on your shelf holds this in brass.',
    );
  });

  it('a mesh is seated on the blank its own box proposed, not on the one it was read against', async () => {
    openWizard();
    toQuestion();
    // #1100 — the engine chips live under Something else… now.
    fireEvent.click(screen.getByTestId('start-wizard-preset-something-else'));
    fireEvent.click(screen.getByTestId('engrave-setup-what-surface'));
    const input = screen.getByTestId('start-wizard-op-surface-file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([ASCII_STL], 'tet.stl')] } });
    await waitFor(
      () => {
        expect((screen.getByTestId('start-wizard-operation-next') as HTMLButtonElement).disabled).toBe(false);
      },
      { timeout: 30_000 },
    );
    fireEvent.click(screen.getByTestId('start-wizard-operation-next'));

    // The blank the mesh proposes: its 10 × 10 × 10 mm box, 5 mm each side and 1 mm under.
    expect(screen.getByTestId('engrave-setup-stock-provenance').textContent).toContain('Sized from the mesh');
    expect((screen.getByTestId('start-wizard-make-length') as HTMLInputElement).value).toBe('20');
    expect((screen.getByTestId('start-wizard-make-width') as HTMLInputElement).value).toBe('20');
    expect((screen.getByTestId('start-wizard-make-thickness') as HTMLInputElement).value).toBe('11');

    await leaveStock();
    expect(screen.getByTestId('engrave-setup-step-holding')).toBeDefined();
    fireEvent.click(screen.getByTestId('engrave-setup-next'));

    const job = useEngraveJobStore.getState().job;
    // Read before the blank existed, the file was centred on the demo plank (50, 30); on the
    // blank the work proposed it is centred on the blank it is cut on.
    expect(job.targetObject?.position).toEqual({ x: 10, y: 10, z: 0 });
    expect(job.targetObject?.size).toEqual({ x: 10, y: 10, z: 10 });
  });

  it('an edited blank is kept when the operator goes back to the question and returns', () => {
    openWizard();
    toQuestion();
    // #1100 — a text job comes from the sign card now.
    fireEvent.click(screen.getByTestId('start-wizard-preset-sign'));
    fireEvent.change(screen.getByTestId('start-wizard-preset-text'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByTestId('start-wizard-operation-next'));

    fireEvent.change(screen.getByTestId('start-wizard-make-length'), { target: { value: '123' } });
    // Back to the question, then forward again: the proposal must not overwrite the answer.
    fireEvent.click(screen.getByTestId('start-wizard-back'));
    expect(progress()).toContain('What are you making?');
    fireEvent.click(screen.getByTestId('start-wizard-operation-next'));

    expect((screen.getByTestId('start-wizard-make-length') as HTMLInputElement).value).toBe('123');
    // …and the proposal's sentence is gone, because those numbers are the operator's now.
    expect(screen.queryByTestId('engrave-setup-stock-provenance')).toBeNull();
  });

  it('a board proposes its outline plus the import’s scrap, and the items it wrote survive the blank', async () => {
    openWizard();
    toQuestion();
    // #1100 — the engine chips live under Something else… now.
    fireEvent.click(screen.getByTestId('start-wizard-preset-something-else'));
    fireEvent.click(screen.getByTestId('engrave-setup-what-pcb'));
    const input = screen.getByTestId('start-wizard-op-pcb-files') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1, 2, 3])], 'practice-F_Cu.gbr')] } });
    await waitFor(
      () => {
        expect(screen.getByTestId('start-wizard-op-pcb-summary').textContent).toContain('The board is in');
      },
      { timeout: 30_000 },
    );
    // #1099 item 2 — the read board carries the outline thumbnail and the set's file count.
    const thumb = screen.getByTestId('wizard-thumbnail');
    expect(thumb.textContent).toContain('60 × 40 mm');
    expect(thumb.textContent).toContain('1 Gerber file');
    const itemsBefore = jobItemCount(useEngraveJobStore.getState().job);
    expect(itemsBefore).toBeGreaterThan(0);

    fireEvent.click(screen.getByTestId('start-wizard-operation-next'));
    expect(progress()).toContain('Stock');
    // The import laid the board on the blank the fresh job had; a different size here would
    // leave the Gerber items off the piece, so the proposal states that blank.
    expect(screen.getByTestId('engrave-setup-stock-provenance').textContent).toContain(
      'laid on the 100 × 60 mm blank',
    );
    expect((screen.getByTestId('start-wizard-stock-material') as HTMLSelectElement).value).toBe('pcb');
    expect((screen.getByTestId('start-wizard-make-length') as HTMLInputElement).value).toBe('100');
    expect((screen.getByTestId('start-wizard-make-width') as HTMLInputElement).value).toBe('60');
    expect((screen.getByTestId('start-wizard-make-thickness') as HTMLInputElement).value).toBe(
      String(PCB_STANDARD_THICKNESS_MM),
    );

    // A board's set IS the job: the blank it asks for sizes that job rather than starting over.
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-wizard-stock-next'));
    });
    expect(screen.queryByTestId('start-wizard-replace-confirm')).toBeNull();
    expect(screen.getByTestId('engrave-setup-step-holding')).toBeDefined();
    fireEvent.click(screen.getByTestId('engrave-setup-next'));

    const job = useEngraveJobStore.getState().job;
    expect(jobItemCount(job)).toBe(itemsBefore);
    expect(job.stock.material).toBe('pcb');
    expect(job.stock.thickness).toBe(PCB_STANDARD_THICKNESS_MM);
    expect(screen.queryByTestId('start-wizard')).toBeNull();
  });
});
