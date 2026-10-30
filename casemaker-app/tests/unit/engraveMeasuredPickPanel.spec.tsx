// @vitest-environment jsdom
// #766 D — THE PANEL'S TWO ANSWERS. The preview draws at once with the #211 rule's answer, which
// is labelled `provisional — measuring…` while the sim worker measures the plan by simulation; when
// the search lands, the measured plan and its explanation replace it, and when the two differ the
// panel says what the rule's plan would have done. This pins the rendering half (the store's
// background run, cancellation and caching are `engravePreviewStore766.spec.ts`).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { resetEngraveRows } from '@/store/engraveRowStore';
import { resetShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { measureFingerprint } from '@/engine/cnc/engrave/measuredPick';
import type { ToolCandidate } from '@/engine/cnc/engrave/recommendTool';
import { resetRegistry } from '@/engine/cnc/toolRegistry';
import type { EngravePreview } from '@/workers/sim/engravePreview';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { EngravePickSummary } from '@/workers/sim/smartPickRun';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A preview-only client: this spec seeds the states it renders, and no search is run. */
const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

const EMPTY_MESH: NodeMeshOutput = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangleCount: 0,
  vertexCount: 0,
  bbox: { min: [0, 0, 0], max: [0, 0, 0] },
  componentCount: 0,
};

/** The provisional rule pick: the ⌀1 cutter the rule stops at. */
const PICK: ToolCandidate = {
  key: 'flat-1.0',
  diameter: 1,
  qualifies: true,
  worst: null,
  reachKnown: false,
  reachOk: true,
  condition: null,
};

/** The smallest preview the panel's recommendation box renders (as `engraveRecommendationNotes`). */
function previewWith(reason = 'the largest cutter that keeps every item intact'): EngravePreview {
  return {
    stock: EMPTY_MESH,
    floors: [],
    outlines: [],
    fixture: [],
    sacrificial: [],
    voids: [],
    registration: [],
    lost: [],
    engravability: [],
    findings: [],
    stages: [],
    colourBoundaryDepth: null,
    supportingFloors: {},
    recommendation: {
      key: PICK.key,
      compromise: false,
      reason,
      conditionNote: null,
      catalogueNote: null,
      selectedNote: null,
      candidates: [PICK],
    },
  };
}

/** The measured answer: a ⌀3.175 clearance with a 0.3 mm V rest, and the ⌀1 rest as the difference. */
function measuredFor(job: ReturnType<typeof defaultEngraveJob>): EngravePickSummary {
  return {
    jobKey: 'test-key',
    cutters: [
      { key: 'flat-3.175', items: [job.labels[0]!.id], source: 'owned' },
      { key: 'engraver-0.3', items: [], source: 'owned' },
    ],
    words: {
      plan: '⌀3.175 + ⌀0.3 V rest',
      verdict: 'Chosen by simulation: 97 % fidelity on the worst item, 1 tool change, about 311 s.',
      fallback: null,
      cutters: ['⌀3.175 mm cuts one item and its worst item is clear at 97 % fidelity.'],
      runnerUp: null,
      buyThis: null,
      difference: 'the quick rule\'s ⌀1 rest would leave "Software" joined at 7 pinches',
      notes: [],
    },
    worstFidelity: 0.97,
    toolChanges: 1,
    seconds: 311,
    considered: 6,
  };
}

/** A job whose cutter was chosen BY HAND, so the panel does not auto-apply the measured answer. */
function handChosenJob(): ReturnType<typeof defaultEngraveJob> {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  job.sources = { ...(job.sources ?? {}), tool: 'user' };
  return job;
}

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  resetShopDefaultsStore();
  resetEngraveRows();
  act(() => {
    useEngraveJobStore.setState({ job: handChosenJob() });
  });
  useEngravePreviewStore.getState().dispose();
  useEngraveRunStore.setState({ generated: null, staleSince: null, phase: 'idle', inputs: null });
});

afterEach(() => {
  cleanup();
  act(() => resetRegistry());
  useEngravePreviewStore.getState().dispose();
  resetShopDefaultsStore();
  setEngravePreviewClientLoader(null);
});

describe('#766 D the panel’s provisional → measured answers', () => {
  it('labels the rule answer provisional while the search runs', () => {
    const job = useEngraveJobStore.getState().job;
    useEngravePreviewStore.setState({
      preview: previewWith(),
      status: 'ready',
      measured: null,
      measuredJob: null,
      measuredStatus: 'measuring',
    });
    render(<EngravePanel />);

    // The #211 answer is on screen, with the provisional label beside it.
    expect(screen.getByTestId('engrave-recommendation')).toBeTruthy();
    expect(screen.getByTestId('engrave-pick-provisional').textContent).toContain('provisional — measuring…');
    expect(screen.queryByTestId('engrave-pick-measured')).toBeNull();
    expect(job.toolKey).toBe('flat-1.0');
  });

  it('replaces the provisional answer with the measured one, its explanation and the difference', () => {
    const job = useEngraveJobStore.getState().job;
    const measured = measuredFor(job);
    useEngravePreviewStore.setState({
      preview: previewWith(),
      status: 'ready',
      measured,
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });
    render(<EngravePanel />);

    const block = screen.getByTestId('engrave-pick-measured');
    expect(block.textContent).toContain('measured: ⌀3.175 + ⌀0.3 V rest');
    // The difference names what the quick rule's plan would have done — the manager's sentence.
    expect(block.textContent).toContain('the quick rule\'s ⌀1 rest would leave "Software" joined at 7 pinches');
    expect(screen.getByTestId('engrave-pick-verdict').textContent).toContain('Chosen by simulation');
    expect(screen.getByTestId('engrave-pick-cutter-1').textContent).toContain('⌀3.175 mm');
    // REPLACES: the rule's box and its provisional label are gone.
    expect(screen.queryByTestId('engrave-recommendation')).toBeNull();
    expect(screen.queryByTestId('engrave-pick-provisional')).toBeNull();
    // 'Use the recommendation' applies the CURRENT (measured) answer; this job's cutter is the
    // operator's own, so nothing was applied for them.
    expect(screen.getByTestId('engrave-use-measured')).toBeTruthy();
  });

  // #766 regression — the panel's measured answer must never edit a job it was not asked to edit.
  /** The smallest generated result the panel's run rows tolerate; only its EXISTENCE matters here. */
  function freshGenerated(): EngraveGenerated {
    return {
      ok: true,
      stage: 'done',
      findings: [],
      feeds: null,
      threads: null,
      cam: null,
      nc: '<gcode>',
      verify: null,
      frameNc: null,
      programs: [],
      facingNc: null,
      facingCam: null,
      surface3d: null,
    } as unknown as EngraveGenerated;
  }

  /** A job the software owns the cutter for — the state the auto-apply path runs in. */
  function computedJob(): ReturnType<typeof defaultEngraveJob> {
    const job = defaultEngraveJob();
    job.toolKey = 'flat-1.0';
    job.sources = { ...(job.sources ?? {}), tool: 'computed' };
    return job;
  }

  it('offers a measured answer that lands after Generate — it never rewrites a generated job', () => {
    const job = computedJob();
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    act(() => {
      useEngraveRunStore.setState({ generated: freshGenerated(), staleSince: null, phase: 'ready' });
    });
    const measured = measuredFor(job);
    useEngravePreviewStore.setState({
      preview: previewWith(),
      status: 'ready',
      measured,
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });

    render(<EngravePanel />);

    // OFFERED, not applied: the generated program still describes the job, and a background answer
    // that silently changed it would make every fresh Generate stale the instant it finished.
    const after = useEngraveJobStore.getState().job;
    expect(after.toolKey).toBe('flat-1.0');
    expect(after.setups?.[0]?.tools ?? []).not.toContain('flat-3.175');
    expect(screen.getByTestId('engrave-use-measured')).toBeTruthy();
  });

  it('still follows the measured answer while the design has no generated result', () => {
    const job = computedJob();
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    const measured = measuredFor(job);
    useEngravePreviewStore.setState({
      preview: previewWith(),
      status: 'ready',
      measured,
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });

    render(<EngravePanel />);

    // No run exists, so the answer is the current design's: the whole plan is written.
    const after = useEngraveJobStore.getState().job;
    expect(after.toolKey).toBe('flat-3.175');
    expect(after.setups?.[0]?.tools ?? []).toEqual(['flat-3.175', 'engraver-0.3']);
  });

  it('leaves the rule answer standing, labelled, when the search fails', () => {
    useEngravePreviewStore.setState({ preview: previewWith(), status: 'ready' });
    render(<EngravePanel />);
    // The failure lands after the panel mounted (the mount's request is what starts the search).
    act(() => {
      useEngravePreviewStore.setState({
        measured: null,
        measuredJob: null,
        measuredStatus: 'error',
        measuredError: 'the generator refused every candidate',
      });
    });
    expect(screen.getByTestId('engrave-recommendation')).toBeTruthy();
    expect(screen.getByTestId('engrave-pick-error').textContent).toContain('the generator refused every candidate');
    expect(screen.queryByTestId('engrave-pick-provisional')).toBeNull();
  });
});
