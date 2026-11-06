// @vitest-environment jsdom
// #786 slice 6 → #1010 — A REFUSED CUTTER OR A DEAD SETUP KEY IS OFFERED, NEVER SUBSTITUTED.
//
// Slice 6 answered two refusals by writing the measured plan into the document behind the
// operator: `tool-refused` (a record the CAM cannot model — here a drill that states no cutting
// diameter) and `setup-rest-unavailable` (a setup's later cutter the library does not hold).
// #1010 (the maintainer's 2026-11-05 ruling, and 11-06 for the setup level) retires both writes:
// the measured answer is OFFERED — the job-level block's press (`engrave-use-measured`), or a
// per-setup offer and press for the setup-level one — and the document keeps what the operator
// wrote until they press it. The negative control is unchanged: a cutter the CAM models, with
// the same measured answer waiting, is the operator's choice and is not offered a replacement.
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
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { measureFingerprint } from '@/engine/cnc/engrave/measuredPick';
import { resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import type { EngravePreview } from '@/workers/sim/engravePreview';
import type { EngraveGenerated } from '@/workers/sim/engraveGenerate';
import type { EngravePickSummary } from '@/workers/sim/smartPickRun';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

const EMPTY_MESH: NodeMeshOutput = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangleCount: 0,
  vertexCount: 0,
  bbox: { min: [0, 0, 0], max: [0, 0, 0] },
  componentCount: 0,
};

/** The panel needs a preview for its findings block; no recommendation, so the rule pick is quiet. */
function barePreview(): EngravePreview {
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
    goal: null,
    surfaces: [],
    recommendation: null,
  } as unknown as EngravePreview;
}

const KEY_DRILL_SIZELESS = 'user:drill-sizeless';
const KEY_DRILL = 'user:drill-3-786';
const KEY_FLAT = 'user:flat-3.175-786';
const KEY_REST = 'user:flat-1-786';
const MISSING_REST = 'inv:gone';

/**
 * A drill that states NO cutting diameter. The feeds rule refuses it too, but `namedRefused`
 * exempts drills (a drill's feeds never resolve, so the exemption keeps every ordinary drill job
 * from being substituted) — so before slice 6 nothing answered this record.
 */
const DRILL_SIZELESS: Tool = flatEndMill(3.175, {
  name: '3 mm drill (size not recorded)',
  typeText: 'Drill',
  shape: 'drill',
  tipDiameter: null,
  diameter: null,
  cornerRadius: null,
  angle: 118,
});

/** A dimensioned drill: the simulator models it, so nothing substitutes it. */
const DRILL: Tool = { ...DRILL_SIZELESS, name: '3 mm drill', tipDiameter: 3, diameter: 3 };

const FLAT: Tool = flatEndMill(3.175, { name: '3.175 mm flat end', fluteLength: 20, shoulderLength: 20 });
const REST_FLAT: Tool = flatEndMill(1, { name: '1 mm flat end', fluteLength: 20, shoulderLength: 20 });

const ENTRIES: ToolLibraryEntry[] = [
  { key: KEY_DRILL_SIZELESS, tool: DRILL_SIZELESS, provenance: 'test' },
  { key: KEY_DRILL, tool: DRILL, provenance: 'test' },
  { key: KEY_FLAT, tool: FLAT, provenance: 'test' },
  { key: KEY_REST, tool: REST_FLAT, provenance: 'test' },
];

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

function jobWith(toolKey: string, tool: Tool, setups?: JobSetup[]): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    toolKey,
    tool,
    sources: { ...(base.sources ?? {}), tool: 'user' },
    ...(setups === undefined ? {} : { setups }),
  };
}

/** A drill-only job: one hole, so the drill is the whole program. */
function drillJob(toolKey: string, tool: Tool): EngraveJob {
  const base = jobWith(toolKey, tool);
  return {
    ...base,
    labels: [],
    shapes: [],
    drills: [
      { kind: 'drill', id: 'hole', position: { x: 50, y: 30 }, rotation: 0, depth: 2, enabled: true, through: false },
    ],
  };
}

/** The same job on a wrapped rod: `rotaryMapOf` reads the stock shape and the chuck. */
function rotaryJob(toolKey: string, tool: Tool): EngraveJob {
  const job = drillJob(toolKey, tool);
  return {
    ...job,
    stock: { ...job.stock, shape: 'cylinder', diameter: 20, width: 20 },
    workholding: {
      kind: 'rotary-chuck',
      rotary: { stickout: 40, gripDiameter: null, jawMode: 'reverse-inner', tailstock: false, source: 'test' },
    },
  };
}

/** The measured answer: the cutters the search chose, in program order. */
function measuredPlan(cutters: { key: string; items: string[] }[]): EngravePickSummary {
  return {
    jobKey: 'test-key',
    cutters: cutters.map((c) => ({ ...c, source: 'owned' as const })),
    words: {
      plan: 'a measured plan',
      verdict: 'Chosen by simulation.',
      fallback: null,
      cutters: [],
      runnerUp: null,
      buyThis: null,
      difference: null,
      notes: [],
    },
    worstFidelity: 0.97,
    toolChanges: 1,
    seconds: 200,
    considered: 4,
  };
}

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

beforeEach(() => {
  setRegistry(ENTRIES);
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  resetShopDefaultsStore();
  resetEngraveRows();
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

describe('#786 slice 6 — a refused cutter and a missing rest cutter are substituted by the search', () => {
  it('`tool-refused`: a cutter the simulator cannot model keeps the job, and the measured answer is offered', () => {
    const job = drillJob(KEY_DRILL_SIZELESS, DRILL_SIZELESS);
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    useEngravePreviewStore.setState({
      preview: barePreview(),
      status: 'ready',
      measured: measuredPlan([{ key: KEY_DRILL, items: ['hole'] }]),
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });

    render(<EngravePanel />);

    // #1010 — nothing is written behind the operator: the refused record stays the document's.
    const before = useEngraveJobStore.getState().job;
    expect(before.toolKey).toBe(KEY_DRILL_SIZELESS);
    expect(before.substitution).toBeUndefined();
    // The measured answer is OFFERED, and applying it is the press.
    expect(screen.getByTestId('engrave-pick-measured')).toBeTruthy();
    expect(screen.getByTestId('engrave-use-measured')).toBeTruthy();
    act(() => {
      screen.getByTestId('engrave-use-measured').click();
    });
    const after = useEngraveJobStore.getState().job;
    expect(after.toolKey).toBe(KEY_DRILL);
    // The press applies a plan; it does not record a substitution nobody made.
    expect(after.substitution).toBeUndefined();
  });

  it('the negative control: a cutter the CAM DOES model is the operator’s choice and is never rewritten', () => {
    const job = drillJob(KEY_DRILL, DRILL);
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    useEngravePreviewStore.setState({
      preview: barePreview(),
      status: 'ready',
      measured: measuredPlan([{ key: KEY_FLAT, items: ['hole'] }]),
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });

    render(<EngravePanel />);

    const after = useEngraveJobStore.getState().job;
    expect(after.toolKey).toBe(KEY_DRILL);
    expect(after.substitution).toBeUndefined();
  });

  // #835 — THE SAME DRILL IS REFUSED ON A WRAPPED JOB. A turntable column holds one radius per
  // (θ, X), so a drill's cone point has no profile there; the substitution predicate asks the
  // simulator's resolver WITH the job's frame, and the sentence names the cutter that sweeps it.
  it('#835 — a drill the rotary engine cannot model keeps the job, and the measured answer is offered', () => {
    const job = rotaryJob(KEY_DRILL, DRILL);
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    useEngravePreviewStore.setState({
      preview: barePreview(),
      status: 'ready',
      measured: measuredPlan([{ key: KEY_FLAT, items: ['hole'] }]),
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });

    render(<EngravePanel />);

    const before = useEngraveJobStore.getState().job;
    expect(before.toolKey).toBe(KEY_DRILL);
    expect(before.substitution).toBeUndefined();
    expect(screen.getByTestId('engrave-use-measured')).toBeTruthy();
    act(() => {
      screen.getByTestId('engrave-use-measured').click();
    });
    expect(useEngraveJobStore.getState().job.toolKey).toBe(KEY_FLAT);
  });

  it('`setup-rest-unavailable`: a setup’s missing later cutter keeps the document until the press', () => {
    const base = defaultEngraveJob();
    const itemIds = base.labels.map((l) => l.id);
    const setups: JobSetup[] = [
      { id: 'setup-1', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds, tools: [KEY_FLAT, MISSING_REST] },
    ];
    const job = jobWith(KEY_FLAT, FLAT, setups);
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    useEngravePreviewStore.setState({
      preview: barePreview(),
      status: 'ready',
      measured: measuredPlan([
        { key: KEY_FLAT, items: itemIds },
        { key: KEY_REST, items: [] },
      ]),
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });

    render(<EngravePanel />);

    const before = useEngraveJobStore.getState().job;
    expect(before.toolKey).toBe(KEY_FLAT);
    expect(before.setups?.[0]?.tools).toEqual([KEY_FLAT, MISSING_REST]);
    expect(before.substitution).toBeUndefined();
    // The measured pair — the operator's program-1 cutter and the rest — is the OFFER.
    expect(screen.getByTestId('engrave-use-measured')).toBeTruthy();
    act(() => {
      screen.getByTestId('engrave-use-measured').click();
    });
    const after = useEngraveJobStore.getState().job;
    expect(after.toolKey).toBe(KEY_FLAT);
    expect(after.setups?.[0]?.tools).toEqual([KEY_FLAT, KEY_REST]);
  });

  // #835 → #1010 — A LATER SETUP'S DEAD CUTTER IS MEASURED ON THAT SETUP'S OWN WORK, AND OFFERED.
  // The whole-job search refuses a multi-setup job, so the preview store measures each dead setup
  // separately (`setupWorkJob`). The panel used to write the plan into that setup behind the
  // operator; the ruling is the job-level one — the document keeps the dead key, the answer is
  // OFFERED beside it, and the press (per setup) is the write and the only time the substitution
  // record is made. This is the red-first the retirement was built against.
  it('#835 — a dead key in a LATER setup is offered that setup’s plan; the job keeps the key until the press', () => {
    const base = defaultEngraveJob();
    const itemIds = base.labels.map((l) => l.id);
    const setups: JobSetup[] = [
      { id: 'setup-1', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds: itemIds.slice(0, 2), tools: [KEY_FLAT] },
      { id: 'setup-2', orientation: { ...IDENTITY }, mount: { kind: 'tape' }, itemIds: itemIds.slice(2), tools: [MISSING_REST] },
    ];
    const job = jobWith(KEY_FLAT, FLAT, setups);
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    useEngravePreviewStore.setState({
      preview: barePreview(),
      status: 'ready',
      setupMeasured: [{ setupIndex: 1, forKeys: [MISSING_REST], pick: measuredPlan([{ key: KEY_REST, items: itemIds.slice(2) }]) }],
      setupMeasuredJob: measureFingerprint(job),
      measuredStatus: 'idle',
    });

    render(<EngravePanel />);

    // NOTHING IS WRITTEN BEHIND THE OPERATOR: the dead key stays in its setup, setup 1 and the
    // document's own cutter are untouched, and no substitution is recorded yet.
    const before = useEngraveJobStore.getState().job;
    expect(before.setups?.[1]?.tools).toEqual([MISSING_REST]);
    expect(before.setups?.[0]?.tools).toEqual([KEY_FLAT]);
    expect(before.toolKey).toBe(KEY_FLAT);
    expect(before.setupSubstitutions).toBeUndefined();
    // The answer is OFFERED, naming the setup and the key it answers.
    const offer = screen.getByTestId('engrave-setup-measured-2');
    expect(offer.textContent).toContain('Setup 2');
    expect(offer.textContent).toContain(MISSING_REST);

    // The press writes THAT setup's plan, records the substitution, and the cutter line states it
    // in the one sentence, naming the setup. The offer is gone once the plan is in.
    act(() => {
      screen.getByTestId('engrave-use-measured-setup-2').click();
    });
    const after = useEngraveJobStore.getState().job;
    expect(after.setups?.[1]?.tools).toEqual([KEY_REST]);
    expect(after.setups?.[0]?.tools).toEqual([KEY_FLAT]);
    expect(after.toolKey).toBe(KEY_FLAT);
    expect(after.setupSubstitutions).toMatchObject([
      { setupId: 'setup-2', setupNumber: 2, fromKey: MISSING_REST, reason: 'missing', toKey: KEY_REST },
    ]);
    const note = screen.getByTestId('engrave-cutter-line').textContent ?? '';
    expect(note).toContain('Setup 2');
    expect(note).toContain(MISSING_REST);
    expect(note).toContain('is not in the tool library');
    expect(note).toContain('is used instead');
    expect(screen.queryByTestId('engrave-setup-measured-2')).toBeNull();
  });

  it('#835 — an answer measured on older content is neither written nor offered', () => {
    const base = defaultEngraveJob();
    const itemIds = base.labels.map((l) => l.id);
    const setups: JobSetup[] = [
      { id: 'setup-1', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds: itemIds.slice(0, 2), tools: [KEY_FLAT] },
      { id: 'setup-2', orientation: { ...IDENTITY }, mount: { kind: 'tape' }, itemIds: itemIds.slice(2), tools: [MISSING_REST] },
    ];
    const job = jobWith(KEY_FLAT, FLAT, setups);
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    useEngravePreviewStore.setState({
      preview: barePreview(),
      status: 'ready',
      setupMeasured: [{ setupIndex: 1, forKeys: [MISSING_REST], pick: measuredPlan([{ key: KEY_REST, items: itemIds.slice(2) }]) }],
      setupMeasuredJob: 'content-that-has-moved-on',
      measuredStatus: 'idle',
    });

    render(<EngravePanel />);

    const after = useEngraveJobStore.getState().job;
    expect(after.setups?.[1]?.tools).toEqual([MISSING_REST]);
    expect(after.setupSubstitutions).toBeUndefined();
    expect(screen.queryByTestId('engrave-setup-measured-2')).toBeNull();
  });

  it('a generated job is offered the answer, never rewritten behind its own program', () => {
    const job = drillJob(KEY_DRILL_SIZELESS, DRILL_SIZELESS);
    act(() => {
      useEngraveJobStore.setState({ job });
    });
    act(() => {
      useEngraveRunStore.setState({ generated: freshGenerated(), staleSince: null, phase: 'ready' });
    });
    useEngravePreviewStore.setState({
      preview: barePreview(),
      status: 'ready',
      measured: measuredPlan([{ key: KEY_DRILL, items: ['hole'] }]),
      measuredJob: measureFingerprint(job),
      measuredStatus: 'ready',
    });

    render(<EngravePanel />);

    const after = useEngraveJobStore.getState().job;
    expect(after.toolKey).toBe(KEY_DRILL_SIZELESS);
    expect(after.substitution).toBeUndefined();
  });
});
