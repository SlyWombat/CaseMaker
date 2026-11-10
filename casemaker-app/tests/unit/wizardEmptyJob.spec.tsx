// @vitest-environment jsdom
/**
 * #1180 — #1107 SUPERSEDES #1123 ITEM 3 ON A NEW RUN.
 *
 * This file used to pin item 3’s empty job: an untouched step 2’s primary was available and
 * pressing it created a job with no items. #1107 replaced that door — a NEW run with nothing
 * picked is refused with its reason (“Pick what to make first.”), and the empty job remains only
 * for a RE-ENTRY’s Done, which adds nothing and replaces nothing. What survives unchanged is the
 * amber sentence a picked-but-incomplete card draws, and that a job carrying work is never
 * silently replaced.
 *
 * The three cases below are the new rule, not new behaviour:
 *   1. an untouched step 2 is refused with its reason, and no empty job is made;
 *   2. a card that needs its field holds the press with the amber sentence;
 *   3. a job with work on a re-entry is finished by Done — the work stays.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StartWizard } from '@/components/welcome/StartWizard';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
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
    expect(primary().getAttribute('title')).toBe('Pick what to make first.');
    // With nothing picked the step draws no line of its own; the reason is the title's.
    expect(screen.queryByTestId('start-wizard-create-unblock')).toBeNull();

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
    expect(screen.getByTestId('start-wizard-create-unblock').textContent).toBe('Type the text to engrave.');

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
