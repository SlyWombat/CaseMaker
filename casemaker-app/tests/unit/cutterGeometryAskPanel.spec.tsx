// @vitest-environment jsdom
// #786 slice 6 — THE TWO NUMBERS A FINDING ASKS FOR, ANSWERED WHERE THE SENTENCE IS READ.
//
// `tool-tip-unrecorded` (a pointed cutter whose tip the record leaves blank) and
// `chamfer-reach-unproven` (a cone that states no base diameter) both point at a field of the
// cutter's OWN record. The panel draws that field beside the finding — a number input and a
// `Record` press — and writes through the same two doors the centre-cutting answer uses: a
// `user:` definition through the tool list, an `inv:` possession through the inventory, with the
// claim's provenance appended. Nothing is written until the press, and the press is disabled
// until a number is typed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
import { setHouseClientLoader, type HouseClient, type HouseProbe } from '@/platform/houseClient';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';
import type { EngravePreview } from '@/workers/sim/engravePreview';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPTY_MESH: NodeMeshOutput = {
  positions: new Float32Array(0),
  indices: new Uint32Array(0),
  triangleCount: 0,
  vertexCount: 0,
  bbox: { min: [0, 0, 0], max: [0, 0, 0] },
  componentCount: 0,
};

/** The findings this test's preview reports; the panel reads them exactly as the worker's own. */
let stubFindings: JobFinding[] = [];

const PREVIEW: EngravePreviewClient = {
  engravePreview: async () =>
    ({
      stock: EMPTY_MESH,
      floors: [],
      outlines: [],
      fixture: [],
      sacrificial: [],
      voids: [],
      registration: [],
      lost: [],
      engravability: [],
      findings: stubFindings,
      stages: [],
      colourBoundaryDepth: null,
      supportingFloors: {},
      goal: null,
      surfaces: [],
      recommendation: null,
    }) as unknown as EngravePreview,
};

const HEALTH: HouseProbe extends { kind: 'present'; health: infer H } ? H : never = {
  kind: 'casemaker-house',
  schemaVersion: 1,
  service: 'test',
  version: '1.0.0',
  toolCount: 1,
  feedCount: 0,
  inventoryCount: 0,
  lastSync: null,
} as never;

const KEY = 'user:chamfer-90';
/** A 90° chamfer whose record states neither a tip nor a base: both asks fire on the same cutter. */
const CHAMFER: Tool = flatEndMill(3.175, {
  name: '90° chamfer',
  typeText: 'Chamfer',
  shape: 'chamfer',
  tipDiameter: null,
  diameter: null,
  angle: 90,
  halfAngle: null,
});

function fakeHouse(entries: ToolLibraryEntry[], writes: { path: string; body: unknown }[]): HouseClient {
  return {
    probe: async () => ({ kind: 'present', health: HEALTH, base: '' }),
    tools: async () => ({ kind: 'ok', etag: '"t1"', entries }),
    feeds: async () => ({ kind: 'ok', etag: '"f1"', rows: [] }),
    inventory: async () => ({ kind: 'ok', etag: '"i1"', items: [] }),
    call: async (method, path, body) => {
      if (method === 'PATCH' && path.startsWith('/tools/')) {
        const entry = body as ToolLibraryEntry;
        writes.push({ path, body: entry });
        const at = entries.findIndex((e) => e.key === entry.key);
        if (at !== -1) entries[at] = entry;
        return { kind: 'ok', text: '' };
      }
      writes.push({ path, body });
      return { kind: 'ok', text: '' };
    },
  };
}

/** A chamfer job: a part outline and a chamfer on its edge. */
function chamferJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [
      {
        id: 'part',
        name: 'lid',
        kind: 'rect',
        position: { x: 20, y: 15 },
        rotation: 0,
        depth: 1,
        enabled: true,
        width: 20,
        height: 10,
        cornerRadius: 0,
        construction: true,
      },
    ],
    cutouts: [],
    chamfers: [{ kind: 'chamfer', id: 'ch1', name: 'lid edge', side: 'outside', width: 0.5, enabled: true, of: 'part' }],
    toolKey: KEY,
    tool: CHAMFER,
  };
}

const writes: { path: string; body: unknown }[] = [];
let entries: ToolLibraryEntry[] = [];

beforeEach(() => {
  writes.length = 0;
  stubFindings = [];
  entries = [{ key: KEY, tool: CHAMFER, provenance: 'typed in here' }];
  setRegistry(entries);
  setHouseClientLoader(async () => fakeHouse(entries, writes));
  setEngravePreviewClientLoader(async () => PREVIEW);
  useSettingsStore.getState().resetSettings();
  resetShopDefaultsStore();
  resetEngraveRows();
  act(() => {
    useEngraveJobStore.setState({ job: chamferJob() });
  });
  useEngravePreviewStore.getState().dispose();
  useEngraveRunStore.setState({ generated: null, staleSince: null, phase: 'idle', inputs: null });
});

afterEach(() => {
  cleanup();
  act(() => {
    resetRegistry();
    useToolRegistryStore.setState({ entries: [], items: [], status: 'checking', error: null });
  });
  useEngravePreviewStore.getState().dispose();
  resetShopDefaultsStore();
  setEngravePreviewClientLoader(null);
  setHouseClientLoader(null);
});

describe('#786 slice 6 — a blank field is asked for in place and written to the cutter', () => {
  it('the tip ask: disabled until a number is typed, then writes tipDiameter with its provenance', async () => {
    stubFindings = [
      {
        severity: 'error',
        code: 'tool-tip-unrecorded',
        message: 'The cutter "90° chamfer" records no tip ⌀ (mm). Record the tip ⌀ (mm) on this cutter’s record, then Generate again.',
      },
    ];
    render(<EngravePanel />);

    const input = await screen.findByTestId('tool-tip-record-input');
    const press = screen.getByTestId('tool-tip-record') as HTMLButtonElement;
    expect(press.disabled).toBe(true);

    // A tip of 0 is a claim (a sharp point), so it is answerable; an empty field is not.
    fireEvent.change(input, { target: { value: '0' } });
    expect(press.disabled).toBe(false);
    fireEvent.change(input, { target: { value: '0.2' } });
    fireEvent.click(press);

    await waitFor(() => {
      expect(useEngraveJobStore.getState().job.tool?.tipDiameter).toBe(0.2);
    });
    const write = writes.find((w) => w.path.startsWith('/tools/'));
    expect(write).toBeDefined();
    const written = write!.body as ToolLibraryEntry;
    expect(written.tool.tipDiameter).toBe(0.2);
    expect(written.provenance).toContain('tip ⌀ 0.2 mm stated by you');
  });

  it('the chamfer ask: the input sits under the finding in the chamfer’s own row, and writes diameter', async () => {
    stubFindings = [
      {
        severity: 'error',
        code: 'chamfer-reach-unproven',
        labelId: 'ch1',
        message:
          'Chamfer "lid edge" needs the cutter’s cutting diameter to know how wide a chamfer its cone reaches, and "90° chamfer" states none. Record the cutter’s diameter.',
      },
    ];
    render(<EngravePanel />);

    // The sentence lives in the row: open it, then answer there.
    fireEvent.click(await screen.findByTestId('engrave-chamfer-expand-0'));
    const input = await screen.findByTestId('chamfer-diameter-record-input');
    fireEvent.change(input, { target: { value: '3.175' } });
    fireEvent.click(screen.getByTestId('chamfer-diameter-record'));

    await waitFor(() => {
      expect(useEngraveJobStore.getState().job.tool?.diameter).toBe(3.175);
    });
    const written = writes.find((w) => w.path.startsWith('/tools/'))!.body as ToolLibraryEntry;
    expect(written.tool.diameter).toBe(3.175);
    expect(written.provenance).toContain('cutting diameter 3.175 mm stated by you');
  });
});
