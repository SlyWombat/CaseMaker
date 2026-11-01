// @vitest-environment jsdom
// #856 — THE V-CARVE’S ONE PRESS.
//
// When a V-carve asks its cone for more material than the cone reaches, the row states the
// shortfall (measured from the item’s floor) and — when the house owns a V-bit whose cone reaches
// it — offers that cutter as one press. The press swaps the bit that OWNS the item: the setup’s
// `tools` and `toolItems`, and the job’s own key when that was the one replaced, so the program,
// the row and the sentence agree. With no such cutter in the house, no press is offered: the
// sentence is the whole answer.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetEngraveRows, useEngraveRowStore } from '@/store/engraveRowStore';
import { resetShopDefaultsStore } from '@/store/shopDefaultsStore';
import { useSettingsStore } from '@/store/settingsStore';
import { resetLocationStore } from '@/store/locationStore';
import { resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
import { setEngravePreviewClientLoader, useEngravePreviewStore } from '@/store/engravePreviewStore';
import { resetMachineStore } from '@/store/machineStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveRectShape } from '@/types/engraveJob';
import type { EngravePreview } from '@/workers/sim/engravePreview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The job's 30° engraver: a cone 4.9916 mm tall. */
const V30: Tool = flatEndMill(3.175, {
  id: null,
  name: '30° engraver',
  typeText: 'Engraving',
  shape: 'engraving',
  tipDiameter: 0.5,
  diameter: 3.175,
  angle: 30,
  halfAngle: 15,
  fluteLength: null,
  cornerRadius: null,
});

/** A 20° engraver: a cone (3.175 − 0.5) / (2·tan 10°) ≈ 7.58 mm — deeper than the V30. */
const V20: Tool = flatEndMill(3.175, {
  id: null,
  name: '20° engraver',
  typeText: 'Engraving',
  shape: 'engraving',
  tipDiameter: 0.5,
  diameter: 3.175,
  angle: 20,
  halfAngle: 10,
  fluteLength: null,
  cornerRadius: null,
});

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

const rect: EngraveRectShape = {
  id: 'plate',
  name: 'plate',
  kind: 'rect',
  position: { x: 20, y: 15 },
  rotation: 0,
  depth: 3,
  enabled: true,
  width: 10,
  height: 6,
  cornerRadius: 0,
};

/** One shape, and a setup that gives it to the 30° engraver. */
function job(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 40, width: 30 },
    labels: [],
    shapes: [rect],
    toolKey: 'v30',
    setups: [
      {
        id: 's1',
        orientation: { ...IDENTITY },
        mount: { kind: 'vise' },
        itemIds: ['plate'],
        tools: ['v30'],
        toolItems: { v30: ['plate'] },
      },
    ],
  };
}

/** The preview's findings are the panel's list; this spec seeds just the one under test. */
function previewWithFinding(materialMm: number | undefined): EngravePreview {
  return {
    stock: { positions: new Float32Array(0), indices: new Uint32Array(0), triangleCount: 0, vertexCount: 0, bbox: { min: [0, 0, 0], max: [0, 0, 0] }, componentCount: 0 },
    floors: [],
    outlines: [],
    fixture: [],
    sacrificial: [],
    voids: [],
    registration: [],
    lost: [],
    engravability: [],
    findings: [
      {
        severity: 'warning',
        code: 'vcarve-depth-beyond-cone',
        labelId: 'plate',
        ...(materialMm === undefined ? {} : { materialMm }),
        message: 'plate cuts 6 mm of material above its 10 mm floor, but the cutter’s cone reaches 4.992 mm.',
      },
    ],
    stages: [],
    colourBoundaryDepth: null,
    supportingFloors: {},
    goal: null,
    surfaces: [],
    recommendation: null,
  } as unknown as EngravePreview;
}

const NO_PREVIEW = { engravePreview: async () => null };

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  resetEngraveRows();
  resetShopDefaultsStore();
  resetLocationStore();
  resetMachineStore();
  resetRegistry();
  act(() => {
    useEngraveJobStore.setState({ job: job() });
    // Open the shape's row: its findings and their actions live in the editor.
    useEngraveRowStore.getState().toggle('plate');
  });
  useEngravePreviewStore.getState().dispose();
});

afterEach(() => {
  cleanup();
  act(() => resetRegistry());
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
});

describe('#856 the row’s one press to a deeper-reaching V-bit', () => {
  it('offers the house’s deepest V that reaches, and the press swaps the setup’s cutter', () => {
    act(() =>
      setRegistry([
        { key: 'v30', provenance: 'test', tool: V30 },
        { key: 'v20', provenance: 'test', tool: V20 },
      ]),
    );
    act(() => useEngravePreviewStore.setState({ preview: previewWithFinding(6), status: 'ready' }));
    render(<EngravePanel />);

    const action = screen.getByTestId('engrave-shape-finding-action-0-vcarve-depth-beyond-cone');
    const button = screen.getByTestId('engrave-vcarve-deeper-tool-plate');
    expect(action.contains(button)).toBe(true);
    expect(button.textContent).toContain('20° engraver');

    fireEvent.click(button);
    const after = useEngraveJobStore.getState().job;
    expect(after.setups![0]!.tools).toEqual(['v20']);
    expect(Object.keys(after.setups![0]!.toolItems ?? {})).toEqual(['v20']);
    // The job's own cutter was the one replaced, so its key follows.
    expect(after.toolKey).toBe('v20');
    expect(after.sources?.tool).toBe('user');
  });

  it('offers nothing when no V-bit in the house reaches the material', () => {
    act(() => setRegistry([{ key: 'v30', provenance: 'test', tool: V30 }]));
    act(() => useEngravePreviewStore.setState({ preview: previewWithFinding(9), status: 'ready' }));
    render(<EngravePanel />);
    expect(screen.getByTestId('engrave-shape-row-0')).toBeTruthy();
    expect(screen.queryByTestId('engrave-vcarve-deeper-tool-plate')).toBeNull();
  });

  it('a finding that names no material depth (a stated-flute refusal) gets no press', () => {
    act(() =>
      setRegistry([
        { key: 'v30', provenance: 'test', tool: V30 },
        { key: 'v20', provenance: 'test', tool: V20 },
      ]),
    );
    act(() => useEngravePreviewStore.setState({ preview: previewWithFinding(undefined), status: 'ready' }));
    render(<EngravePanel />);
    expect(screen.queryByTestId('engrave-vcarve-deeper-tool-plate')).toBeNull();
  });
});
