// @vitest-environment jsdom
/**
 * #680 — the door: the CNC card on the welcome page, its starters and its recent jobs.
 *
 * THE CARD IS THE UNIT. It must be a card of its own beside the print projects, with the approved
 * copy and the primary button; the starters must open the one wizard with the template id it seeds
 * from; and the recent list must appear only when there is one, newest first, and open the job.
 *
 * THE SNAPSHOT STORE IS INJECTED, not faked in a database this repo does not ship: `recentJobsStore`
 * keeps only metadata in `localStorage` and asks a `RecentJobTexts` for each document (IndexedDB in
 * the app), so an in-memory double is the whole dependency. The tests that matter for the blocker
 * are here: three max-size documents leave the `localStorage` key under 2 KB, a text that is gone
 * refuses the entry rather than opening a truncated job, and an entry pushed off the list loses its
 * text.
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
  recentSavedAtWords,
  recordRecentJob,
  resetRecentJobs,
  setRecentJobTextStore,
  startRecentJobTracking,
  useRecentJobsStore,
  type RecentJobTexts,
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

/** The text store, in memory: the app's IndexedDB without a database fake. */
function memoryTexts(): { store: RecentJobTexts; texts: Map<string, string> } {
  const texts = new Map<string, string>();
  return {
    texts,
    store: {
      put: async (fileName, text) => {
        texts.set(fileName, text);
      },
      get: async (fileName) => texts.get(fileName) ?? null,
      delete: async (fileName) => {
        texts.delete(fileName);
      },
    },
  };
}

let texts: ReturnType<typeof memoryTexts>;

beforeEach(() => {
  cleanup();
  texts = memoryTexts();
  setRecentJobTextStore(texts.store);
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
  setRecentJobTextStore(null);
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
    await recordRecentJob('alpha.cutjob.json', jobText('Alpha'), '2026-10-26T09:00:00.000Z');
    await recordRecentJob('beta.cutjob.json', jobText('Beta'), '2026-10-26T10:00:00.000Z');
    await recordRecentJob('gamma.cutjob.json', jobText('Gamma'), '2026-10-26T11:00:00.000Z');
    await recordRecentJob('delta.cutjob.json', jobText('Delta'), '2026-10-26T12:00:00.000Z');
    expect(readRecentJobs().map((j) => j.name)).toEqual(['Delta', 'Gamma', 'Beta']);
    // The entry pushed off the list lost its snapshot too.
    expect(texts.texts.has('alpha.cutjob.json')).toBe(false);
    expect(texts.texts.has('gamma.cutjob.json')).toBe(true);

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
    // …and it says WHEN the snapshot was taken, so a Save over a newer file is an informed act.
    expect(useEngraveJobFileStore.getState().notice?.text).toContain('Opened Gamma as it was saved');
  });

  it('refuses a recent whose snapshot is gone, and leaves the welcome page up', async () => {
    await recordRecentJob('gone.cutjob.json', jobText('Gone'), '2026-10-26T09:00:00.000Z');
    await texts.store.delete('gone.cutjob.json');
    render(<WelcomeOverlay />);
    fireEvent.click(screen.getByTestId('welcome-recent-0'));
    await screen.findByTestId('welcome-recent-error');
    expect(screen.getByTestId('welcome-recent-error').textContent).toContain('no longer available');
    expect(useProjectStore.getState().welcomeMode).toBe(true);
  });

  it('says why a recent that no longer parses was not opened, and leaves the welcome page up', async () => {
    await recordRecentJob('broken.cutjob.json', '{"schemaVersion": 99}', '2026-10-26T09:00:00.000Z');
    render(<WelcomeOverlay />);
    fireEvent.click(screen.getByTestId('welcome-recent-0'));
    await screen.findByTestId('welcome-recent-error');
    expect(screen.getByTestId('welcome-recent-error').textContent).toContain('broken');
    expect(useProjectStore.getState().welcomeMode).toBe(true);
  });
});

describe('#680 the recent record', () => {
  it('is fed by the job file store, and keeps only the newest three', async () => {
    startRecentJobTracking();
    const saved = new Map<string, string>();
    for (const [i, name] of ['One', 'Two', 'Three', 'Four'].entries()) {
      const fileName = `job-${i}.cutjob.json`;
      const text = jobText(name);
      saved.set(fileName, text);
      useEngraveJobFileStore.setState({ busy: false, fileName, savedText: text, dirty: false });
    }
    await waitFor(() =>
      expect(useRecentJobsStore.getState().jobs.map((j) => j.name)).toEqual(['Four', 'Three', 'Two']),
    );
    expect(readRecentJobs().map((j) => j.name)).toEqual(['Four', 'Three', 'Two']);
    // The evicted entry's text went with it; the kept three are readable.
    expect(texts.texts.has('job-0.cutjob.json')).toBe(false);
    expect(texts.texts.get('job-3.cutjob.json')).toBe(saved.get('job-3.cutjob.json'));
  });

  it('keeps localStorage to metadata: three max-size documents stay under 2 KB', async () => {
    for (let i = 0; i < 3; i++) {
      const padded = jobText(`Huge${i}`).padEnd(MAX_RECENT_JOB_CHARS, ' ');
      expect(padded.length).toBe(MAX_RECENT_JOB_CHARS);
      await recordRecentJob(`huge-${i}.cutjob.json`, padded);
    }
    expect(useRecentJobsStore.getState().jobs).toHaveLength(3);
    const stored = localStorage.getItem(RECENT_JOBS_KEY) ?? '';
    expect(stored.length).toBeLessThan(2048);
    expect(stored).not.toContain('"text"');
  });

  it('does not offer a document past the size the door keeps', async () => {
    const huge = jobText('Huge') + ' '.repeat(MAX_RECENT_JOB_CHARS);
    await recordRecentJob('huge.cutjob.json', huge);
    expect(useRecentJobsStore.getState().jobs).toEqual([]);
    expect(texts.texts.has('huge.cutjob.json')).toBe(false);
  });

  it('names the snapshot’s time in the operator’s words', () => {
    const now = new Date(2026, 9, 26, 12, 0, 0);
    const today = new Date(2026, 9, 26, 9, 14, 0).toISOString();
    const older = new Date(2026, 9, 24, 18, 5, 0).toISOString();
    expect(recentSavedAtWords(today, now)).toBe(' as it was saved at 09:14');
    expect(recentSavedAtWords(older, now)).toBe(' as it was saved on 2026-10-24 at 18:05');
    expect(recentSavedAtWords('not a date', now)).toBe('');
  });
});
