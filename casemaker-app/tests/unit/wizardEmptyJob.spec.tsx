// @vitest-environment jsdom
/**
 * #1123 item 3 — STEP 2 IS PASSABLE WITH NOTHING PICKED.
 *
 * The question's default is Engrave text, and the press used to wait for its text: an operator who
 * only wants a job to open a file into had to invent something to type. Now pressing the primary
 * with nothing PICKED creates the empty job — no items, the blank the job already holds — and
 * closes onto the Job panel, where Open job… and Add operation are. The amber "type the text"
 * sentence still applies the moment a chip that needs its field is picked, and a job that already
 * carries real work is asked before the empty job replaces it.
 *
 * Red at the base: the primary is disabled on an untouched step 2, and the press does nothing.
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

function openAtQuestion(): void {
  useStartWizardStore.getState().openWizard();
  render(<WizardHost />);
  fireEvent.click(screen.getByTestId('start-wizard-next')); // step 1 → step 2
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

describe('#1123 item 3 — nothing picked creates the empty job', () => {
  it('the primary is available on an untouched step 2 and creates the empty job', () => {
    openAtQuestion();
    expect(primary().disabled).toBe(false);
    expect(primary().textContent).toBe('Create the job');
    // The default chip is highlighted but nothing was picked by the operator: no amber sentence.
    expect(screen.queryByTestId('start-wizard-create-unblock')).toBeNull();

    fireEvent.click(primary());
    expect(screen.queryByTestId('start-wizard')).toBeNull();
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
    const job = useEngraveJobStore.getState().job;
    expect(job.labels).toHaveLength(0);
    expect(job.shapes).toHaveLength(0);
    // The workspace has a part to draw: the job's own blank.
    const blank = useProjectStore.getState().project.case.blank;
    expect(blank?.enabled).toBe(true);
    expect(blank?.width).toBeCloseTo(job.stock.length, 6);
    expect(blank?.height).toBeCloseTo(job.stock.width, 6);
  });

  it('picking a chip that needs its field brings the amber sentence and holds the press', () => {
    openAtQuestion();
    fireEvent.click(screen.getByTestId('engrave-setup-what-engrave'));
    expect(primary().disabled).toBe(true);
    expect(screen.getByTestId('start-wizard-create-unblock').textContent).toBe('Type the text to engrave.');

    fireEvent.change(screen.getByTestId('start-wizard-op-text'), { target: { value: 'Zoomba' } });
    expect(primary().disabled).toBe(false);
    expect(screen.queryByTestId('start-wizard-create-unblock')).toBeNull();
    expect(primary().textContent).toBe('Next: stock');
  });

  it('a job that already carries work asks before the empty job replaces it', () => {
    const base = defaultEngraveJob();
    useEngraveJobStore.setState({
      job: { ...base, labels: [{ ...base.labels[0]!, text: 'MINE' }] },
    });
    openAtQuestion();

    fireEvent.click(primary());
    expect(screen.getByTestId('start-wizard-replace-confirm')).toBeTruthy();
    expect(screen.getByTestId('start-wizard')).toBeTruthy(); // nothing replaced yet
    fireEvent.click(screen.getByTestId('start-wizard-replace-no'));
    expect(useEngraveJobStore.getState().job.labels[0]!.text).toBe('MINE');

    fireEvent.click(primary());
    fireEvent.click(screen.getByTestId('start-wizard-replace-yes'));
    expect(screen.queryByTestId('start-wizard')).toBeNull();
    expect(useEngraveJobStore.getState().job.labels).toHaveLength(0);
  });
});
