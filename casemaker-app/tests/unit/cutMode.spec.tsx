// @vitest-environment jsdom
// #419 §3, slice 1 — the Design/Cut switch, the mode store, and the preflight page it opens.
//
// The collector and the hub have their own specs; this one is about the SURFACE: Design is the
// panel as it was, pressing Cut always asks the gate and shows the page, and Back to Design leaves
// the page and expands the row the first red finding names (#411's seam).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EngravePanel } from '@/components/panels/EngravePanel';
import { useCncModeStore, resetCncMode } from '@/store/cncModeStore';
import { useEngraveJobStore, resetEngraveRemovalUndo } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { resetEngraveRows, useEngraveRowStore } from '@/store/engraveRowStore';
import { resetEngravePackageStore } from '@/store/engravePackageStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { EngraveJob } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every preview request answers "no new preview"; this spec is not about the worker. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

/** A generated run whose program belongs to `job`'s own scope. */
function generatedFor(job: EngraveJob): EngraveGenerated {
  const verify: VerifyReport = {
    ok: true,
    findings: [],
    stats: { lines: 2, cuttingMoves: 1, deepestZ: -2, bbox: { min: [0, 0, -2], max: [1, 1, 0] } },
  };
  const nc = 'G90\nM02';
  return {
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    threads: null,
    cam: { operations: 1, cuttingMoves: 1, estimatedSeconds: 5, passes: 1 },
    nc,
    verify,
    frameNc: null,
    frameVerify: null,
    facingNc: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    predicted: [],
    programs: [
      {
        setupIndex: 1,
        setupId: 'setup-implicit',
        toolKey: job.toolKey,
        nc,
        verify,
        frameNc: null,
        frameVerify: null,
        programHash: '00000000',
        cam: null,
      },
    ],
    errors: [],
  };
}

function pressed(id: 'cnc-mode-design' | 'cnc-mode-cut'): string | null {
  return screen.getByTestId(id).getAttribute('aria-pressed');
}

function openCut(): void {
  fireEvent.click(screen.getByTestId('cnc-mode-cut'));
}

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  // These are all module-level session state; a case that entered Cut or expanded a row must not
  // decide what the next one sees.
  resetCncMode();
  resetEngraveRows();
  resetEngraveRemovalUndo();
  resetEngravePackageStore();
  useEngraveRunStore.getState().reset();
  act(() => {
    useEngraveJobStore.setState({ job: defaultEngraveJob() });
  });
  useEngravePreviewStore.getState().dispose();
});

afterEach(() => {
  cleanup();
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
});

describe('useCncModeStore (#419 §3)', () => {
  it('starts in Design', () => {
    expect(useCncModeStore.getState().mode).toBe('design');
  });

  it('keeps the mode for the same job and returns to Design for another', () => {
    const store = useCncModeStore.getState();
    store.syncJob('job-a');
    store.show('cut');
    useCncModeStore.getState().syncJob('job-a');
    expect(useCncModeStore.getState().mode).toBe('cut');

    useCncModeStore.getState().syncJob('job-b');
    expect(useCncModeStore.getState().mode).toBe('design');
    expect(useCncModeStore.getState().jobId).toBe('job-b');
  });
});

describe('EngravePanel — the Design/Cut switch (#419 §3)', () => {
  it('opens on the Design stack, with today`s controls and no preflight page', () => {
    render(<EngravePanel />);
    expect(screen.getByTestId('cnc-mode-switch')).toBeTruthy();
    expect(pressed('cnc-mode-design')).toBe('true');
    expect(pressed('cnc-mode-cut')).toBe('false');
    expect(screen.getByTestId('engrave-setup-open')).toBeTruthy();
    expect(screen.getByTestId('engrave-generate')).toBeTruthy();
    expect(screen.queryByTestId('engrave-preflight')).toBeNull();
  });

  it('pressing Cut asks the gate; with nothing generated the page says there is no program', () => {
    render(<EngravePanel />);
    openCut();

    expect(pressed('cnc-mode-cut')).toBe('true');
    expect(screen.getByTestId('engrave-preflight')).toBeTruthy();
    // The Design stack is gone, not merely covered.
    expect(screen.queryByTestId('engrave-setup-open')).toBeNull();
    expect(screen.getByTestId('engrave-preflight').getAttribute('data-state')).toBe('blocked');
    expect(screen.getByTestId('engrave-preflight-summary').textContent).toContain('blocking');
    // `collect()` was actually asked: the run gate names the missing program in its own words.
    expect(screen.getByText('no-generate')).toBeTruthy();
    expect(screen.getByText('Generate first.')).toBeTruthy();
  });

  it('shows a green gate when the generated program is clean', () => {
    const job = defaultEngraveJob();
    act(() => {
      useEngraveRunStore.setState({ generated: generatedFor(job), phase: 'ready', simStatus: null });
    });
    render(<EngravePanel />);
    openCut();

    expect(screen.getByTestId('engrave-preflight').getAttribute('data-state')).toBe('clear');
    expect(screen.getByTestId('engrave-preflight-summary').textContent).toContain('nothing blocking');
    expect(screen.getByTestId('engrave-preflight-scope-0')).toBeTruthy();

    // Back to Design is never dead, green or red.
    fireEvent.click(screen.getByTestId('engrave-back-to-design'));
    expect(pressed('cnc-mode-design')).toBe('true');
    expect(screen.getByTestId('engrave-setup-open')).toBeTruthy();
  });

  it('lands a red row on the page in the owner`s words', () => {
    const job = defaultEngraveJob();
    const deep: EngraveJob = {
      ...job,
      labels: job.labels.map((l, i) => (i === 0 ? { ...l, depth: 11.5 } : l)),
    };
    act(() => {
      useEngraveJobStore.setState({ job: deep });
    });
    render(<EngravePanel />);
    openCut();

    expect(screen.getByTestId('engrave-preflight').getAttribute('data-state')).toBe('blocked');
    const row = screen.getByTestId(/^engrave-preflight-row-\d+-depth-exceeds-stock$/);
    expect(row.getAttribute('data-severity')).toBe('error');
    expect(row.getAttribute('data-expanded')).toBe('true');
    expect(screen.getByTestId('engrave-preflight-first-blocking').textContent).toContain('11.5 mm deep');
  });

  it('Back to Design expands the item the first red row names', () => {
    const job = defaultEngraveJob();
    const labelId = job.labels[0]!.id;
    const deep: EngraveJob = {
      ...job,
      labels: job.labels.map((l, i) => (i === 0 ? { ...l, depth: 11.5 } : l)),
    };
    act(() => {
      useEngraveJobStore.setState({ job: deep });
    });
    render(<EngravePanel />);
    openCut();
    expect(useEngraveRowStore.getState().open.has(labelId)).toBe(false);

    fireEvent.click(screen.getByTestId('engrave-back-to-design'));

    expect(pressed('cnc-mode-design')).toBe('true');
    expect(screen.getByTestId('engrave-setup-open')).toBeTruthy();
    expect(useEngraveRowStore.getState().open.has(labelId)).toBe(true);
  });

  it('keeps Cut across a remount of the panel, because the mode belongs to the job', () => {
    const first = render(<EngravePanel />);
    openCut();
    expect(screen.getByTestId('engrave-preflight')).toBeTruthy();
    first.unmount();

    render(<EngravePanel />);
    expect(pressed('cnc-mode-cut')).toBe('true');
    expect(screen.getByTestId('engrave-preflight')).toBeTruthy();
  });

  it('returns to Design when another job is opened', () => {
    render(<EngravePanel />);
    openCut();
    expect(screen.getByTestId('engrave-preflight')).toBeTruthy();

    act(() => {
      useEngraveJobStore.setState({ job: { ...defaultEngraveJob(), id: 'job-other' } });
    });

    expect(pressed('cnc-mode-design')).toBe('true');
    expect(screen.queryByTestId('engrave-preflight')).toBeNull();
    expect(screen.getByTestId('engrave-setup-open')).toBeTruthy();
  });
});
