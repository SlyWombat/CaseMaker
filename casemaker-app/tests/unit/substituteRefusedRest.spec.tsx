// @vitest-environment jsdom
// #786 slice 6 — THE TWO REFUSALS THAT HAD NO SMART-PICK ANSWER.
//
// Slice 4c-2 substitutes the search's plan for a cutter the operator chose that is MISSING from
// the library or has no feeds for the material. Two refusals still stopped the job with their
// sentence alone:
//
//   - `tool-refused` — a record the simulator cannot model (here a drill that states no cutting
//     diameter: the feeds rule exempts drills from its own refusal, so nothing else notices);
//   - `setup-rest-unavailable` — a setup's LATER cutter key the library no longer holds.
//
// Both now hand the job to the measured plan exactly as a missing key does, and a replacement of
// the operator's own document is RECORDED — the cutter line and the `cutter-substituted` finding
// print the one substitution sentence, so nothing is replaced silently. The negative control is
// the other half of the contract: a cutter the CAM models, with the same measured answer waiting,
// is the operator's choice and is not rewritten.
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
  it('`tool-refused`: a cutter the simulator cannot model is replaced by the measured plan, and the job says so', () => {
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

    const after = useEngraveJobStore.getState().job;
    expect(after.toolKey).toBe(KEY_DRILL);
    expect(after.substitution).toMatchObject({
      fromKey: KEY_DRILL_SIZELESS,
      reason: 'refused',
      toKey: KEY_DRILL,
    });
    // The one sentence both surfaces print says whose cutter it was and what cuts instead.
    const note = screen.getByTestId('engrave-cutter-line').textContent ?? '';
    expect(note).toContain('cannot cut this job');
    expect(note).toContain('is used instead');
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

  it('`setup-rest-unavailable`: a setup’s missing later cutter is replaced, keeping the operator’s program-1 cutter', () => {
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

    const after = useEngraveJobStore.getState().job;
    // Program 1 is the cutter the operator named; the rest pass's dead key is the plan's ⌀1.
    expect(after.toolKey).toBe(KEY_FLAT);
    expect(after.setups?.[0]?.tools).toEqual([KEY_FLAT, KEY_REST]);
    expect(after.substitution).toMatchObject({
      fromKey: MISSING_REST,
      reason: 'missing',
      toKey: KEY_REST,
    });
    const note = screen.getByTestId('engrave-cutter-line').textContent ?? '';
    expect(note).toContain(MISSING_REST);
    expect(note).toContain('is not in the tool library');
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
