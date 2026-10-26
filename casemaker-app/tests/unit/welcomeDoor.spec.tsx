// @vitest-environment jsdom
/**
 * #680 — the door: the CNC card on the welcome page, its starters and its recent jobs.
 *
 * THE CARD IS THE UNIT. It must be a card of its own beside the print projects, with the approved
 * copy and the primary button; the starters must open the one wizard with the template id it seeds
 * from; and the recent list must appear only when there is one, newest first, and open the job.
 *
 * The recent store's own seam is driven directly for the empty/large cases: the card cannot invent
 * entries, and a document too large for the browser's storage must not appear as a truncated one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { WelcomeOverlay } from '@/components/welcome/WelcomeOverlay';
import { StartWizard } from '@/components/welcome/StartWizard';
import { resetStartWizard, useStartWizardStore } from '@/store/startWizardStore';
import { resetEngraveJobFileStore, useEngraveJobFileStore } from '@/store/engraveJobFileStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useProjectStore } from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { serializeJobFile } from '@/engine/cnc/engrave/jobFile';
import {
  MAX_RECENT_JOB_CHARS,
  RECENT_JOBS_KEY,
  readRecentJobs,
  recordRecentJob,
  resetRecentJobs,
  startRecentJobTracking,
  useRecentJobsStore,
} from '@/store/recentJobsStore';

// The blank's mesh build is the geometry scheduler's; this test is about the door, not a mesh.
vi.mock('@/engine/jobs/JobScheduler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/jobs/JobScheduler')>();
  return { ...actual, scheduleImmediate: vi.fn(async () => {}) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A valid job document with a name, as a recent's text. */
function jobText(name: string): string {
  return serializeJobFile({ ...defaultEngraveJob(), name });
}

beforeEach(() => {
  cleanup();
  resetRecentJobs();
  resetStartWizard();
  resetEngraveJobFileStore();
  useEngraveJobStore.getState().reset();
  useProjectStore.getState().showWelcome();
  useViewportStore.getState().setActiveSidebarSection(null);
  localStorage.removeItem(RECENT_JOBS_KEY);
  // The overlay refreshes week-old source caches on mount; nothing here is stale and the network
  // is not this test's subject.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ boards: [] }),
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('#680 the cutting door', () => {
  it('is a card of its own with the approved copy and the primary button', () => {
    render(<WelcomeOverlay />);

    const print = screen.getByTestId('welcome-door-print');
    const cnc = screen.getByTestId('welcome-door-cnc');
    expect(print).toBeTruthy();
    expect(cnc).toBeTruthy();
    expect(cnc.textContent).toContain('Cut something on the CNC — a badge, a plate, a pocket, an engraving.');
    expect(within(cnc).getByTestId('welcome-start-cnc').textContent).toContain('Start a cutting job');

    fireEvent.click(screen.getByTestId('welcome-start-cnc'));
    expect(useStartWizardStore.getState().open).toBe(true);
    expect(useStartWizardStore.getState().starter).toBeNull();
  });

  it('offers both starters, and a starter opens the wizard with its template id', () => {
    render(<WelcomeOverlay />);
    const starters = screen.getByTestId('welcome-starters');
    expect(starters.textContent).toContain('Name badge');
    expect(starters.textContent).toContain('Bare blank');

    fireEvent.click(screen.getByTestId('welcome-starter-badge-blank'));
    expect(useStartWizardStore.getState().open).toBe(true);
    expect(useStartWizardStore.getState().starter).toBe('badge-blank');

    resetStartWizard();
    fireEvent.click(screen.getByTestId('welcome-starter-blank'));
    expect(useStartWizardStore.getState().starter).toBe('blank');
  });

  it('opens the one wizard on Holding with the starter blank as the stock', async () => {
    useStartWizardStore.getState().openWizard('machine', 'badge-blank');
    render(<StartWizard />);

    await waitFor(() =>
      expect(screen.getByTestId('start-wizard-progress').textContent).toBe('Step 3 of 4 · Holding'),
    );
    const stock = useEngraveJobStore.getState().job.stock;
    // The badge's blank, turned a quarter turn for the vise (#383): 38.1 across X, 76.2 along Y.
    expect([stock.length, stock.width, stock.thickness]).toEqual([38.1, 76.2, 3.81]);
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
  });

  it('shows no recent list and no empty-state sentence on a first run', () => {
    render(<WelcomeOverlay />);
    expect(screen.queryByTestId('welcome-recent-jobs')).toBeNull();
    expect(document.body.textContent).not.toMatch(/no recent/i);
  });

  it('lists the last three recents newest first, and opens one into Design', async () => {
    recordRecentJob('alpha.cutjob.json', jobText('Alpha'), '2026-10-26T09:00:00.000Z');
    recordRecentJob('beta.cutjob.json', jobText('Beta'), '2026-10-26T10:00:00.000Z');
    recordRecentJob('gamma.cutjob.json', jobText('Gamma'), '2026-10-26T11:00:00.000Z');
    recordRecentJob('delta.cutjob.json', jobText('Delta'), '2026-10-26T12:00:00.000Z');
    expect(readRecentJobs().map((j) => j.name)).toEqual(['Delta', 'Gamma', 'Beta']);

    render(<WelcomeOverlay />);
    const recents = screen.getByTestId('welcome-recent-jobs');
    expect(within(recents).getByTestId('welcome-recent-0').textContent).toBe('Delta');
    expect(within(recents).getByTestId('welcome-recent-1').textContent).toBe('Gamma');
    expect(within(recents).getByTestId('welcome-recent-2').textContent).toBe('Beta');
    expect(within(recents).queryByTestId('welcome-recent-3')).toBeNull();

    fireEvent.click(screen.getByTestId('welcome-recent-1'));
    await waitFor(() => expect(useEngraveJobStore.getState().job.name).toBe('Gamma'));
    expect(useProjectStore.getState().welcomeMode).toBe(false);
    expect(useViewportStore.getState().activeSidebarSection).toBe('cnc-engrave');
    // The file bar names the snapshot's file and has no handle: Save will ask for a file.
    expect(useEngraveJobFileStore.getState().fileName).toBe('gamma.cutjob.json');
    expect(useEngraveJobFileStore.getState().handle).toBeNull();
    expect(useEngraveJobFileStore.getState().dirty).toBe(false);
  });

  it('says why a recent that no longer parses was not opened, and leaves the welcome page up', async () => {
    recordRecentJob('broken.cutjob.json', '{"schemaVersion": 99}', '2026-10-26T09:00:00.000Z');
    render(<WelcomeOverlay />);
    fireEvent.click(screen.getByTestId('welcome-recent-0'));
    await screen.findByTestId('welcome-recent-error');
    expect(screen.getByTestId('welcome-recent-error').textContent).toContain('broken');
    expect(useProjectStore.getState().welcomeMode).toBe(true);
  });
});

describe('#680 the recent record', () => {
  it('is fed by the job file store, and keeps only the newest three', () => {
    startRecentJobTracking();
    for (const [i, name] of ['One', 'Two', 'Three', 'Four'].entries()) {
      useEngraveJobFileStore.setState({
        busy: false,
        fileName: `job-${i}.cutjob.json`,
        savedText: jobText(name),
        dirty: false,
      });
    }
    expect(useRecentJobsStore.getState().jobs.map((j) => j.name)).toEqual(['Four', 'Three', 'Two']);
    expect(readRecentJobs().map((j) => j.name)).toEqual(['Four', 'Three', 'Two']);
  });

  it('does not keep a document past the size the door can store', () => {
    const huge = jobText('Huge') + ' '.repeat(MAX_RECENT_JOB_CHARS);
    recordRecentJob('huge.cutjob.json', huge);
    expect(useRecentJobsStore.getState().jobs).toEqual([]);
  });
});
