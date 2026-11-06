// @vitest-environment jsdom
// #766 D — THE PANEL'S TWO ANSWERS. The preview draws at once with the #211 rule's answer, which
// is labelled `provisional — measuring…` while the sim worker measures the plan by simulation; when
// the search lands, the measured plan and its explanation replace it, and when the two differ the
// panel says what the rule's plan would have done. This pins the rendering half (the store's
// background run, cancellation and caching are `engravePreviewStore766.spec.ts`).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import { flatEndMill } from '@/engine/cnc/tool';
import { measureFingerprint } from '@/engine/cnc/engrave/measuredPick';
import type { ToolCandidate } from '@/engine/cnc/engrave/recommendTool';
import { resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
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
    chamferBands: [],
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
    goal: null,
    // #822 — no surface primitives in these fixtures.
    surfaces: [],
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

  // #1010 (the maintainer's 2026-11-05 ruling) — THE PLAN ANSWER IS PER RUN. The measured
  // auto-apply is retired: a computed job with no generated result keeps the cutter it was given,
  // the panel renders (the effect that used to re-apply itself through its own job write is gone),
  // and the "what would a different set give me" answer is the run's tradeoff line, shown here.
  it('leaves the job’s own cutter alone while the design has no generated result — the plan answer is per run', () => {
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

    // Rendered without "Maximum update depth exceeded", and the job is exactly the operator's
    // document: nothing was written behind their back. The "what would a different set give me"
    // answer is the run's tradeoff line — rendered by the Cut card and pinned where it lives
    // (`cutSurface.spec.tsx`), not by rewriting the job here.
    const after = useEngraveJobStore.getState().job;
    expect(after.toolKey).toBe('flat-1.0');
    expect(after.setups?.[0]?.tools ?? []).not.toContain('flat-3.175');
  });

  // #786 slice 4c — a hand-chosen drill bit with other work: the split KEEPS the cutter the
  // operator named, so it is applied like a computed answer. The guard's subject is the cutter,
  // not the source: a plan that would replace the drill is never applied, this one never does.
  // #1010 — A HAND-CHOSEN CUTTER IS NEVER REPLACED. The old split (a measured plan dividing the
  // work between cutters) was the auto-apply's; the measured answer is offered and applied by the
  // press, so the drill stays the drill and no split is written into the job.
  it('keeps a hand-chosen drill as the job’s cutter, and writes no split into it', () => {
    const DRILL = flatEndMill(3, {
      name: '3 mm drill',
      typeText: 'Drill',
      shape: 'drill',
      tipDiameter: 3,
      diameter: 3,
      cornerRadius: null,
      angle: 118,
      fluteLength: 20,
    });
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [
      {
        kind: 'circle',
        id: 'pocket',
        name: 'pocket',
        position: { x: 40, y: 25 },
        rotation: 0,
        depth: 2,
        enabled: true,
        diameter: 10,
      },
    ];
    job.drills = [
      { kind: 'drill', id: 'hole', position: { x: 20, y: 20 }, rotation: 0, depth: 2, enabled: true, through: false },
    ];
    job.toolKey = 'user:drill-3';
    job.tool = DRILL;
    job.sources = { tool: 'user' };
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    const measured: EngravePickSummary = {
      ...measuredFor(defaultEngraveJob()),
      cutters: [
        { key: 'user:drill-3', items: ['hole'], source: 'owned' },
        { key: 'flat-3.175', items: ['pocket'], source: 'owned' },
      ],
    };
    useEngravePreviewStore.setState({
      preview: previewWith(),
      status: 'ready',
      measured,
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });
    render(<EngravePanel />);

    const after = useEngraveJobStore.getState().job;
    // The named drill is STILL the job's cutter; no measured split is applied over it.
    expect(after.toolKey).toBe('user:drill-3');
    expect(after.setups?.[0]?.tools ?? []).not.toContain('flat-3.175');
  });

  // #786 slice 4c-2 — A MISSING OR REFUSED CUTTER IS SUBSTITUTED. The replace-guard protects a
  // decision that still holds; a key the library does not hold, or a cutter no CAM here can use,
  // holds none — the measured plan is the answer and is applied even though the source is 'user'.
  function pocketJob(): ReturnType<typeof defaultEngraveJob> {
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [
      {
        kind: 'circle',
        id: 'pocket',
        name: 'pocket',
        position: { x: 40, y: 25 },
        rotation: 0,
        depth: 2,
        enabled: true,
        diameter: 10,
      },
    ];
    return job;
  }

  function measuredFlat(): EngravePickSummary {
    return {
      ...measuredFor(defaultEngraveJob()),
      cutters: [{ key: 'flat-3.175', items: ['pocket'], source: 'owned' }],
    };
  }

  // #1010 — A MISSING KEY IS OFFERED, NOT SUBSTITUTED. The measured answer is the operator's to
  // apply (the press); the job keeps the document they wrote.
  it('offers the measured answer for a key the library does not hold — never rewrites the job', () => {
    const job = pocketJob();
    job.toolKey = 'user:gone';
    job.tool = null;
    job.sources = { tool: 'user' };
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    const measured = measuredFlat();
    useEngravePreviewStore.setState({
      preview: previewWith(),
      status: 'ready',
      measured,
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });
    render(<EngravePanel />);

    const after = useEngraveJobStore.getState().job;
    expect(after.toolKey).toBe('user:gone');
    expect(after.setups?.[0]?.tools ?? []).toEqual([]);
  });

  // #1010 — A REFUSED CUTTER IS OFFERED, NOT SUBSTITUTED (see above).
  it('offers the measured answer for a cutter no CAM here can use — the ball stays the job’s', () => {
    const job = pocketJob();
    job.toolKey = 'user:ball';
    job.tool = flatEndMill(3.175, { name: 'ball nose', typeText: 'Ball End', shape: 'ball' });
    job.sources = { tool: 'user' };
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    const measured = measuredFlat();
    useEngravePreviewStore.setState({
      preview: previewWith(),
      status: 'ready',
      measured,
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });
    render(<EngravePanel />);

    expect(useEngraveJobStore.getState().job.toolKey).toBe('user:ball');
  });

  // #1010 — NO SILENT SUBSTITUTION AT ALL. The old slice 4c-2 path changed the operator's cutter
  // and stated it afterwards; with the auto-apply retired nothing is substituted, so no
  // substitution finding or override button is fabricated either.
  it('leaves the operator’s own cutter in place instead of substituting it silently', () => {
    // The measured answer's cutter is in the registry, so the job's snapshot resolves and the
    // cutter line can name it (the app's own state; the other tests only assert the key).
    act(() => {
      setRegistry([{ key: 'flat-3.175', tool: flatEndMill(3.175, { name: '3.175 mm flat end' }), provenance: 'test' }]);
    });
    const job = pocketJob();
    job.toolKey = 'user:ball';
    job.tool = flatEndMill(3.175, { name: 'ball nose', typeText: 'Ball End', shape: 'ball' });
    job.sources = { tool: 'user' };
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    const measured = measuredFlat();
    useEngravePreviewStore.setState({
      preview: previewWith(),
      status: 'ready',
      measured,
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });
    render(<EngravePanel />);

    expect(useEngraveJobStore.getState().job.toolKey).toBe('user:ball');
    expect(screen.queryByTestId(/^engrave-finding-\d+-cutter-substituted$/)).toBeNull();
    expect(screen.queryByTestId('cutter-substituted-choose')).toBeNull();
  });

  // #1035 — THE OFFER RETIRES WHEN ITS OWN PLAN IS THE JOB. A job with no goal still compares the
  // measured plan against the document: the rough-key clause is a GOAL's rule, and an absent
  // `targetObject` reads `undefined`, which never equals the `null` the clause compares it to — so
  // `measuredApplied` stayed false forever, the button never retired after the press and the
  // fidelity line never showed. RED before the fix: the button is still there after the click.
  it('#1035 — the pressed measured pick retires the offer and the cutter line states the fidelity', () => {
    act(() => {
      setRegistry([{ key: 'flat-3.175', tool: flatEndMill(3.175, { name: '3.175 mm flat end' }), provenance: 'test' }]);
    });
    const job = pocketJob();
    job.toolKey = '';
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    const measured = measuredFlat();
    useEngravePreviewStore.setState({
      preview: previewWith(),
      status: 'ready',
      measured,
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-use-measured')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-use-measured'));

    expect(useEngraveJobStore.getState().job.toolKey).toBe('flat-3.175');
    expect(screen.queryByTestId('engrave-use-measured')).toBeNull();
    // The applied plan is recognised as the answer: its fidelity is on the cutter line.
    expect(document.body.textContent).toContain('chosen by simulation');
    expect(document.body.textContent).toContain('97 % fidelity');
  });

  // #1035 — A THREAD JOB'S MEASURED OFFER CARRIES THE THREAD MILL, and the press is the write.
  // The retired auto-apply used to assign the mill behind the operator; #1010's ruling makes the
  // measured answer the offer and the press the write, so the split is stated before Generate.
  function bossThreadJob(): ReturnType<typeof defaultEngraveJob> {
    const job = defaultEngraveJob();
    job.labels = [];
    job.stock = { ...job.stock, length: 40, width: 40, thickness: 20 };
    job.shapes = [
      { kind: 'circle', id: 'boss', name: 'boss', position: { x: 20, y: 20 }, rotation: 0, depth: 8, enabled: true, diameter: 8, construction: true },
      { kind: 'circle', id: 'field', name: 'field', position: { x: 20, y: 20 }, rotation: 0, depth: 8, enabled: true, diameter: 30, construction: true },
    ] as NonNullable<ReturnType<typeof defaultEngraveJob>['shapes']>;
    job.combined = [
      { kind: 'cutaway', id: 'ring', name: 'ring', position: { x: 20, y: 20 }, rotation: 0, depth: 8, enabled: true, outer: 'field', islands: ['boss'] },
    ] as NonNullable<ReturnType<typeof defaultEngraveJob>['combined']>;
    job.threads = [
      { kind: 'thread', id: 'thr', position: { x: 20, y: 20 }, enabled: true, size: 'M8', standard: 'metric', classFit: '6h', side: 'external', depth: 6, through: false },
    ] as NonNullable<ReturnType<typeof defaultEngraveJob>['threads']>;
    job.toolKey = 'user:848-flat3';
    job.tool = flatEndMill(3, { name: '3 mm flat end mill', fluteLength: 20 });
    job.sources = { tool: 'user' };
    return job;
  }

  it('#1035 — a thread job’s measured offer carries the thread mill and the press states the split', () => {
    act(() => {
      setRegistry([
        { key: 'user:848-flat3', tool: flatEndMill(3, { name: '3 mm flat end mill', fluteLength: 20 }), provenance: 'test' },
        {
          key: 'user:848-m8',
          tool: flatEndMill(6, { name: 'Thread mill M8x1.25 (d6mm)', typeText: 'Thread Mill', shape: 'thread', tipDiameter: 6, diameter: 6, fluteLength: 20 }),
          provenance: 'test',
        },
      ]);
    });
    const job = bossThreadJob();
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    const base = measuredFlat();
    const measured: EngravePickSummary = {
      ...base,
      cutters: [
        { key: 'user:848-flat3', items: ['ring'], source: 'owned' },
        { key: 'user:848-m8', items: ['thr'], source: 'owned' },
      ],
      words: { ...base.words, plan: '3 mm flat + M8 thread mill', verdict: 'Chosen by simulation: the split posts.' },
    };
    // No preview: the panel then computes the job's findings itself (`preview?.findings ??
    // validateJob(...)`), which is where the split sentence comes from.
    useEngravePreviewStore.setState({
      preview: null,
      status: 'ready',
      measured,
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-use-measured')).toBeTruthy();

    fireEvent.click(screen.getByTestId('engrave-use-measured'));

    const setups = useEngraveJobStore.getState().job.setups ?? [];
    expect(setups[0]?.tools).toEqual(['user:848-flat3', 'user:848-m8']);
    expect(setups[0]?.toolItems?.['user:848-m8']).toEqual(['thr']);
    // The split is stated, so Generate's program count is explained before it happens.
    expect(document.body.textContent).toContain('Split into 2 programs');
    expect(screen.queryByTestId('engrave-use-measured')).toBeNull();
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
