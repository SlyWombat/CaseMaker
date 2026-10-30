// @vitest-environment jsdom
// #662/#681/#685 — step 4 of the one cutting-job wizard: "What are you cutting?".
//
// The picker is the SHARED grouped one (`OperationPicker`, `operationTypes.ts`): the fourteen
// operations in the mockup's four groups, in the table's own order and words. The button that
// leaves the step CREATES the answer and lands in Design. A job with nothing to cut opens on
// Engrave text with the field it needs; Create waits for that field, and the sentence beside it
// says what to type (§3.5 — never a placeholder "New text"). A template's job starts with nothing
// selected and Create finishes without adding a duplicate. Surface a mesh is the one whole-job
// operation: its card is disabled with its reason on a job that has items (B6), and on an empty
// job its one essential field is the FILE, read here into the job's goal (#685).

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StartWizard } from '@/components/welcome/StartWizard';
import { OPERATION_TYPES } from '@/components/panels/operationTypes';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { useEngraveJobStore, newItemDepthFor } from '@/store/engraveJobStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import type { EngraveJob } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The tetrahedron `targetObject.spec.ts` reads: a real, non-flat STL. */
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
    vertex 0 0 10
    vertex 0 10 0
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

/** The default job with every operation removed — a job nobody has said what to cut yet. */
function emptyJob(): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    traces: [],
    drills: [],
    threads: [],
    primitives: [],
    cutouts: [],
    vectors: [],
  };
}

/** The wizard as `AppShell` mounts it: closing it unmounts the modal. */
function WizardHost() {
  const open = useStartWizardStore((s) => s.open);
  return open ? <StartWizard /> : <></>;
}

/** Open the one wizard at its step 4, the way the panel's operation door does. */
function openOperationStep(): void {
  act(() => {
    useStartWizardStore.getState().openWizard('operation');
  });
  render(<WizardHost />);
}

beforeEach(() => {
  cleanup();
  resetStartWizard();
  act(() => {
    useEngraveJobStore.setState({ job: emptyJob() });
  });
});

afterEach(() => {
  cleanup();
});

describe('#685 — step 4, what are you cutting', () => {
  it('opens on the grouped picker with Engrave text chosen and Create waiting for its text', () => {
    openOperationStep();

    expect(screen.getByTestId('start-wizard-progress').textContent).toBe(
      'Step 4 of 4 · What are you cutting?',
    );
    // This run opened AT step 4, so it is a re-entry: the button adds to a job that exists.
    expect(screen.getByTestId('start-wizard-create').textContent).toBe('Add the operation');

    // The four groups, and the fourteen operations in the mockup's words and grouped order
    // (`first-job-flow-mockups.html`, station 4) — the same table the panel's picker reads.
    for (const group of ['engrave-carve', 'cut-away', 'holes', '3d']) {
      expect(screen.getByTestId(`operation-picker-group-${group}`)).toBeTruthy();
    }
    const chips = within(screen.getByTestId('operation-picker')).getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual([
      'Engrave text',
      'V-carve',
      'V-carve, variable depth',
      'Inlay',
      'Texture',
      'Flute',
      'Prism',
      'Pocket',
      'Profile',
      'Chamfer',
      'Hole',
      'Bore to size',
      'Thread',
      'Surface a mesh',
    ]);
    for (const type of OPERATION_TYPES) {
      expect(screen.getByTestId(`engrave-setup-what-${type.id}`)).toBeTruthy();
    }

    // An empty job starts on Engrave text, with the one field that operation needs.
    expect(screen.getByTestId('engrave-setup-what-engrave').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('start-wizard-op-field')).toBeTruthy();
    const create = screen.getByTestId('start-wizard-create') as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    // The ONE sentence that unblocks it, and the way to act on it is the field above.
    expect(screen.getByTestId('start-wizard-create-unblock').textContent).toBe(
      'Type the text to engrave.',
    );

    // A pocket needs no field here: it gets its size in the panel, so Create can act.
    fireEvent.click(screen.getByTestId('engrave-setup-what-pocket'));
    expect(screen.queryByTestId('start-wizard-op-field')).toBeNull();
    expect(screen.queryByTestId('start-wizard-create-unblock')).toBeNull();
    expect((screen.getByTestId('start-wizard-create') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId('start-wizard-create'));
    expect(screen.queryByTestId('start-wizard')).toBeNull();
    expect(useEngraveJobStore.getState().job.shapes).toHaveLength(1);
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(0);
  });

  it('#745 — typing the text turns Create on in the same task; no beat with a wordless disabled Create', () => {
    openOperationStep();
    const create = screen.getByTestId('start-wizard-create') as HTMLButtonElement;
    const text = screen.getByTestId('start-wizard-op-text') as HTMLInputElement;
    expect(create.disabled).toBe(true);
    expect(screen.getByTestId('start-wizard-create-unblock').textContent).toBe(
      'Type the text to engrave.',
    );

    // A real browser's input event, outside act(): the field's commit is synchronous, but a passive
    // effect (useEffect) does not run until after this task — and the acceptance walk's capture is a
    // page evaluation in exactly that window. Create and its sentence must change together. The act
    // flag is off only around the dispatch so React's "wrap it in act" advice does not drown the
    // output; the assertion is what the browser would see at that instant.
    const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    g.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      setValue.call(text, 'Zoomba');
      text.dispatchEvent(new Event('input', { bubbles: true }));
    } finally {
      g.IS_REACT_ACT_ENVIRONMENT = true;
    }

    expect(create.disabled).toBe(false);
    expect(screen.queryByTestId('start-wizard-create-unblock')).toBeNull();
  });

  it('makes the engraving with the text, depth and font that were given — never a placeholder', () => {
    openOperationStep();
    const depth = newItemDepthFor(useEngraveJobStore.getState().job);

    fireEvent.change(screen.getByTestId('start-wizard-op-text'), { target: { value: 'Hello' } });
    fireEvent.change(screen.getByTestId('start-wizard-op-depth'), { target: { value: '1.25' } });
    fireEvent.click(screen.getByTestId('start-wizard-create'));

    const job = useEngraveJobStore.getState().job;
    expect(job.labels).toHaveLength(1);
    expect(job.labels[0]).toMatchObject({ text: 'Hello', depth: 1.25, font: DEFAULT_FONT_ID });
    // The step recomputed the recommendation for this stock rather than starting from a hidden 0.5.
    expect(depth).toBeGreaterThan(0);
    expect(screen.queryByTestId('start-wizard')).toBeNull();
  });

  it('a job that already has an operation starts with nothing selected, and Create adds no duplicate', () => {
    act(() => {
      useEngraveJobStore.setState({ job: defaultEngraveJob() });
    });
    openOperationStep();

    // The template's seeded line IS the item step 4 would otherwise make.
    expect(screen.getByTestId('engrave-setup-what-engrave').getAttribute('aria-pressed')).toBe('false');
    const create = screen.getByTestId('start-wizard-create') as HTMLButtonElement;
    expect(create.disabled).toBe(false);

    // Surface a mesh is a whole-job operation: a job that has items gets a DISABLED card with its
    // reason beside it, not a sentence in place of the card (principle 4, B6).
    const surface = screen.getByTestId('engrave-setup-what-surface') as HTMLButtonElement;
    expect(surface.disabled).toBe(true);
    expect(screen.getByTestId('operation-picker-surface-hint').textContent).toBe(
      'this job already has work — Surface a mesh starts a new, empty job',
    );

    const before = useEngraveJobStore.getState().job.labels.length;
    fireEvent.click(create);
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(before);
    expect(screen.queryByTestId('start-wizard')).toBeNull();
  });

  it('Surface a mesh asks for its file, and Create waits until one reads', async () => {
    openOperationStep();
    fireEvent.click(screen.getByTestId('engrave-setup-what-surface'));

    // Its ONE essential field is the mesh file — not text, and not a size.
    expect(screen.getByTestId('start-wizard-op-field').textContent).toContain('Surface a mesh');
    const input = screen.getByTestId('start-wizard-op-surface-file') as HTMLInputElement;
    expect(input.getAttribute('accept')).toContain('.stl');
    expect((screen.getByTestId('start-wizard-create') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('start-wizard-create-unblock').textContent).toBe(
      'Choose the mesh to surface.',
    );

    // The read is a real one (file bytes, then a hash), so every wait below is on the STATE it
    // settles — not on a fixed window. A busy full-suite run can stretch the read; waiting for the
    // sentence or the button absorbs that, and stops the moment the state is there.
    const WAIT = { timeout: 15_000 };

    // A file that is not a mesh is refused with its sentence, and Create still waits.
    fireEvent.change(input, { target: { files: [new File(['hello'], 'notes.txt')] } });
    expect((await screen.findByTestId('start-wizard-op-surface-error', undefined, WAIT)).textContent).toBe(
      'notes.txt is not an STL, 3MF, STEP or PNG file.',
    );
    expect((screen.getByTestId('start-wizard-create') as HTMLButtonElement).disabled).toBe(true);

    // The mesh it needs: read once, embedded, and made the job's whole goal. The name paints in
    // the step before the effect that reports the choice to the shell, whose footer owns Create —
    // so wait for the BUTTON, which is the state this assertion is about.
    fireEvent.change(input, { target: { files: [new File([ASCII_STL], 'tet.stl')] } });
    await waitFor(() => {
      expect(screen.queryByTestId('start-wizard-op-surface-error')).toBeNull();
      expect((screen.getByTestId('start-wizard-create') as HTMLButtonElement).disabled).toBe(false);
    }, WAIT);
    expect(screen.getByText('tet.stl')).toBeTruthy();

    fireEvent.click(screen.getByTestId('start-wizard-create'));
    expect(screen.queryByTestId('start-wizard')).toBeNull();
    const job = useEngraveJobStore.getState().job;
    expect(job.targetObject).toMatchObject({ name: 'tet.stl', format: 'stl', role: 'goal' });
    expect(job.labels).toHaveLength(0);
    expect(job.shapes).toHaveLength(0);
    // #721 — the default is the part itself: no mold key on the goal.
    expect('goalMode' in job.targetObject!).toBe(false);
  });

  it('#721 — Surface a mesh can make a mold of the part instead', async () => {
    openOperationStep();
    fireEvent.click(screen.getByTestId('engrave-setup-what-surface'));
    expect((screen.getByTestId('start-wizard-op-surface-make-part') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('start-wizard-op-surface-make-mold'));
    expect(screen.getByTestId('start-wizard-op-surface-mold-note').textContent).toContain('two-part mold');
    const input = screen.getByTestId('start-wizard-op-surface-file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([ASCII_STL], 'tet.stl')] } });
    await waitFor(() => {
      expect((screen.getByTestId('start-wizard-create') as HTMLButtonElement).disabled).toBe(false);
    }, { timeout: 15_000 });
    fireEvent.click(screen.getByTestId('start-wizard-create'));
    expect(useEngraveJobStore.getState().job.targetObject).toMatchObject({ role: 'goal', goalMode: 'mold' });
  });
});
