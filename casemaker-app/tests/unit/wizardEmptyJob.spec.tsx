// @vitest-environment jsdom
/**
 * #1180 — #1107 SUPERSEDES #1123 ITEM 3 ON THE PRIMARY PRESS.
 *
 * This file used to pin item 3’s empty job: an untouched step 2’s primary was available and
 * pressing it created a job with no items. #1107 replaced that door — a NEW run with nothing
 * picked is refused with its reason (“Pick what to make first.”), and the empty job remains only
 * for a RE-ENTRY’s Done, which adds nothing and replaces nothing. What survives unchanged is the
 * amber sentence a picked-but-incomplete card draws, and that a job carrying work is never
 * silently replaced.
 *
 * #1183 gives the empty job its OWN, deliberate door on the question step (a link-weight
 * secondary, new runs only), reusing the replace confirm and the job reset — and lands on Stock,
 * exactly as a pick does. The primary keeps #1107’s refusal.
 *
 * The cases below are that rule, not new behaviour:
 *   1. an untouched step 2 is refused with its reason, and no empty job is made;
 *   2. a card that needs its field holds the press with the amber sentence;
 *   3. a job with work on a re-entry is finished by Done — the work stays;
 *   4. (#1183) the secondary creates the empty job and lands on Stock; Back returns to the
 *      question with nothing picked and the job still empty;
 *   5. (#1183) a job carrying work raises the one replace confirm; No changes nothing, Yes replaces;
 *   6. (#1183) an empty job asks nothing; a re-entry does not render the secondary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StartWizard } from '@/components/welcome/StartWizard';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobItemCount } from '@/engine/cnc/stockStart';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useProjectStore } from '@/store/projectStore';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { useViewportStore } from '@/store/viewportStore';

vi.mock('@/engine/jobs/JobScheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/jobs/JobScheduler')>();
  return { ...actual, scheduleImmediate: vi.fn(async () => {}), schedule: vi.fn(async () => {}) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The wizard as AppShell mounts it: closing it unmounts the modal. */
function WizardHost() {
  const open = useStartWizardStore((s) => s.open);
  return open ? <StartWizard /> : <></>;
}

/** A NEW run: the wizard from the machine step, then on to the question. */
function openAtQuestion(): void {
  useStartWizardStore.getState().openWizard();
  render(<WizardHost />);
  fireEvent.click(screen.getByTestId('start-wizard-next')); // step 1 → step 2
  expect(screen.getByTestId('start-wizard-progress').textContent).toContain('What are you cutting?');
}

/** A RE-ENTRY: the wizard opened at the question, as an existing job’s step 2. */
function openAtQuestionAsReEntry(): void {
  useStartWizardStore.getState().openWizard('operation');
  render(<WizardHost />);
  expect(screen.getByTestId('start-wizard-progress').textContent).toContain('What are you cutting?');
}

const primary = (): HTMLButtonElement =>
  screen.getByTestId('start-wizard-operation-next') as HTMLButtonElement;

beforeEach(() => {
  cleanup();
  resetStartWizard();
  useEngraveJobStore.getState().reset(); // the shipped default job: the three demo lines, no work
  useProjectStore.getState().showWelcome();
  useViewportStore.getState().setActiveSidebarSection(null);
});

afterEach(() => cleanup());

describe('#1180 — #1107 supersedes item 3’s empty job on a new run', () => {
  it('an untouched step 2 is refused with its reason, and no empty job is made', () => {
    openAtQuestion();
    // The primary still reads Create the job, and it carries the reason it cannot press.
    expect(primary().textContent).toBe('Create the job');
    expect(primary().disabled).toBe(true);
    // #1109 item 8 — the reason is a VISIBLE line above the footer, never only a title.
    expect(primary().getAttribute('title')).toBeNull();
    expect(screen.getByTestId('start-wizard-operation-unblock').textContent).toBe('Pick what to make first.');

    // A disabled press changes nothing: the wizard stays, the job keeps its own items.
    const before = useEngraveJobStore.getState().job.labels.length;
    fireEvent.click(primary());
    expect(screen.queryByTestId('start-wizard')).not.toBeNull();
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(before);
  });

  it('picking a card that needs its field brings the amber sentence and holds the press', () => {
    openAtQuestion();
    // #1100 — the question opens on the preset cards; the sign card is the one that types text.
    fireEvent.click(screen.getByTestId('start-wizard-preset-sign'));
    expect(primary().disabled).toBe(true);
    expect(screen.getByTestId('start-wizard-create-unblock').textContent).toBe('Type the text to engrave — for example, a name.');

    fireEvent.change(screen.getByTestId('start-wizard-preset-text'), { target: { value: 'Zoomba' } });
    expect(primary().disabled).toBe(false);
    expect(screen.queryByTestId('start-wizard-create-unblock')).toBeNull();
    expect(primary().textContent).toBe('Next: stock');
  });

  it('a job with work is finished by Done on a re-entry — the work stays, nothing replaces it', () => {
    const base = defaultEngraveJob();
    useEngraveJobStore.setState({
      job: { ...base, labels: [{ ...base.labels[0]!, text: 'MINE' }] },
    });
    openAtQuestionAsReEntry();

    // The re-entry’s primary is Done, and it is available — an existing job may finish as it is.
    expect(primary().textContent).toBe('Done');
    expect(primary().disabled).toBe(false);

    fireEvent.click(primary());
    // It closes onto the job and changes none of it: no empty job, no replace prompt.
    expect(screen.queryByTestId('start-wizard')).toBeNull();
    expect(screen.queryByTestId('start-wizard-replace-confirm')).toBeNull();
    expect(useEngraveJobStore.getState().job.labels[0]!.text).toBe('MINE');
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
  });
});

/** #1183 — the question step's secondary, at link weight under the presets and the drop zone. */
const emptyDoor = (): HTMLButtonElement => screen.getByTestId('start-wizard-empty-job') as HTMLButtonElement;

describe('#1183 — the empty job gets its own, deliberate door', () => {
  it('a new run: the secondary makes the empty job and lands on Stock; Back returns, still empty', () => {
    openAtQuestion();
    // The primary keeps #1107's refusal; the secondary is the deliberate way in.
    expect(primary().disabled).toBe(true);
    expect(primary().getAttribute('title')).toBeNull();
    expect(screen.getByTestId('start-wizard-operation-unblock').textContent).toBe('Pick what to make first.');
    expect(emptyDoor().textContent).toBe('Start with an empty job');

    // The shipped demo lines are not the operator's work, so there is nothing to ask about.
    fireEvent.click(emptyDoor());
    expect(screen.queryByTestId('start-wizard-replace-confirm')).toBeNull();
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Stock');
    // The job is empty NOW: the stock step — and Back from it — see the job it will be.
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(0);
    expect(jobItemCount(useEngraveJobStore.getState().job)).toBe(0);

    // The analyst's acceptance line: Back from Stock returns to the question with nothing
    // picked, the door still offered, and the job still empty.
    fireEvent.click(screen.getByTestId('start-wizard-back'));
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 2 of 4 · What are you cutting?');
    expect(primary().disabled).toBe(true);
    expect(primary().getAttribute('title')).toBeNull();
    expect(screen.getByTestId('start-wizard-operation-unblock').textContent).toBe('Pick what to make first.');
    expect(emptyDoor().textContent).toBe('Start with an empty job');
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(0);
  });

  it('a job carrying work is asked first: No changes nothing, Yes replaces it and lands on Stock', () => {
    const base = defaultEngraveJob();
    // Three of the operator's OWN lines — the shipped demo set would not count as work.
    const labels = base.labels.map((l, i) => ({ ...l, id: `mine-${i + 1}`, text: `MINE ${i + 1}` }));
    useEngraveJobStore.setState({ job: { ...base, labels } });
    openAtQuestion();
    expect(jobItemCount(useEngraveJobStore.getState().job)).toBe(3);

    fireEvent.click(emptyDoor());
    expect(screen.getByTestId('start-wizard-replace-confirm').textContent).toContain(
      'The job open now has 3 items on it.',
    );

    // No: the box closes and the job is untouched — its items, its package, every field.
    const before = JSON.stringify(useEngraveJobStore.getState().job);
    fireEvent.click(screen.getByTestId('start-wizard-replace-no'));
    expect(screen.queryByTestId('start-wizard-replace-confirm')).toBeNull();
    expect(JSON.stringify(useEngraveJobStore.getState().job)).toBe(before);
    expect(jobItemCount(useEngraveJobStore.getState().job)).toBe(3);
    expect(screen.getByTestId('start-wizard-progress').textContent).toContain('What are you cutting?');

    // Yes: the empty job replaces it and the wizard walks on to the blank like any pick.
    fireEvent.click(emptyDoor());
    fireEvent.click(screen.getByTestId('start-wizard-replace-yes'));
    expect(screen.queryByTestId('start-wizard-replace-confirm')).toBeNull();
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Stock');
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(0);
  });

  it('an open job with nothing on it asks nothing', () => {
    useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), labels: [], shapes: [] } });
    openAtQuestion();
    fireEvent.click(emptyDoor());
    expect(screen.queryByTestId('start-wizard-replace-confirm')).toBeNull();
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Stock');
  });

  it('a pick made before the door is not the empty job’s answer', () => {
    openAtQuestion();
    // The sign card picked and typed: a real answer standing in the shell…
    fireEvent.click(screen.getByTestId('start-wizard-preset-sign'));
    fireEvent.change(screen.getByTestId('start-wizard-preset-text'), { target: { value: 'ZOOMBA' } });
    expect(primary().disabled).toBe(false);
    // …the door is pressed anyway. It makes the empty job and clears that answer, so Back to the
    // question meets the untouched step — nothing picked — and no ghost item can be created.
    fireEvent.click(emptyDoor());
    expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Stock');
    fireEvent.click(screen.getByTestId('start-wizard-back'));
    expect(primary().disabled).toBe(true);
    expect(primary().getAttribute('title')).toBeNull();
    expect(screen.getByTestId('start-wizard-operation-unblock').textContent).toBe('Pick what to make first.');
    expect(screen.queryByTestId('start-wizard-preset-text')).toBeNull();
  });

  it('a re-entry does not render the door — its Done finishes the job', () => {
    openAtQuestionAsReEntry();
    expect(screen.queryByTestId('start-wizard-empty-job')).toBeNull();
  });
});
