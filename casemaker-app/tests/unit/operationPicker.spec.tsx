// @vitest-environment jsdom
// #662/#681 — step 4 of the one cutting-job wizard: "What are you cutting?".
//
// The picker is our grouped one, and the button that leaves it CREATES the answer and lands in
// Design. A job with nothing to cut opens on Engrave text with the field it needs; Create waits
// for the text, and the sentence beside it says what to type (#679 §3.5 — never a placeholder
// "New text"). An established job starts with nothing selected and Create finishes without adding
// a duplicate. A pick that needs a file (Surface a mesh) asks the panel that owns the input.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StartWizard } from '@/components/welcome/StartWizard';
import { setOperationIntake } from '@/components/panels/operationIntake';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { useEngraveJobStore, newItemDepthFor } from '@/store/engraveJobStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import type { EngraveJob } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
  setOperationIntake(null);
});

describe('#681 — step 4, what are you cutting', () => {
  it('opens on the grouped picker with Engrave text chosen and Create waiting for its text', () => {
    openOperationStep();

    expect(screen.getByTestId('start-wizard-progress').textContent).toBe(
      'Step 4 of 4 · What are you cutting?',
    );
    // The mockup's four groups, and every type inside them.
    for (const group of ['engrave-carve', 'cut-away', 'holes', '3d']) {
      expect(screen.getByTestId(`start-wizard-op-group-${group}`)).toBeTruthy();
    }
    for (const type of ['engrave', 'v-carve', 'pocket', 'profile', 'hole', 'thread', 'surface']) {
      expect(screen.getByTestId(`engrave-setup-what-${type}`)).toBeTruthy();
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

    // Surface a mesh is a whole-job operation, so an established job is told why it is not here
    // rather than shown a control that cannot run.
    expect(screen.queryByTestId('engrave-setup-what-surface')).toBeNull();
    expect(screen.getByTestId('start-wizard-op-surface-hint').textContent).toBe(
      'a whole-job operation; starts an empty job with it',
    );

    const before = useEngraveJobStore.getState().job.labels.length;
    fireEvent.click(create);
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(before);
    expect(screen.queryByTestId('start-wizard')).toBeNull();
  });

  it('asks the panel for the one pick that needs a file, and closes', () => {
    const asked: string[] = [];
    setOperationIntake((type) => asked.push(type));
    openOperationStep();
    fireEvent.click(screen.getByTestId('engrave-setup-what-surface'));
    expect(asked).toEqual(['surface']);
    expect(useStartWizardStore.getState().open).toBe(false);
    expect(screen.queryByTestId('start-wizard')).toBeNull();
    // No operation was invented from a pick that could not read a file.
    expect(useEngraveJobStore.getState().job.labels ?? []).toHaveLength(0);
    expect(useEngraveJobStore.getState().job.shapes ?? []).toHaveLength(0);
  });
});
