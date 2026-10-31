// @vitest-environment jsdom
// #786 slice 4c-2 — THE PLUNGE QUESTION, ANSWERED IN PLACE ON THE FINDING.
//
// A cutter whose record says nothing about centre-cutting leaves its plunge holes out of the
// programs, and the finding asks "Is the ⌀3.175 mm flat end centre-cutting?". The panel's Yes/No
// write the answer to the cutter's own record through the house service (provenance "stated by
// you"), so the question is asked once per cutter, ever; the job's snapshot is refreshed and the
// finding clears. The write half is this spec; the withholding is `plungeQuestion.spec.ts`.
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
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

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

const KEY = 'user:flat-3';
const FLAT: Tool = flatEndMill(3.175, { name: '3.175 mm flat end', fluteLength: 20, centreCutting: null });
const entryWith = (tool: Tool): ToolLibraryEntry => ({ key: KEY, tool, provenance: 'typed in here' });

/** The house service, with the tool list mutating under a PATCH so `refresh` re-reads it. */
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
      if (method === 'PATCH' && path.startsWith('/inventory/')) {
        writes.push({ path, body });
        return { kind: 'ok', text: '' };
      }
      return { kind: 'ok', text: '' };
    },
  };
}

function drillJob(tool: Tool): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    labels: [],
    shapes: [],
    drills: [
      { kind: 'drill', id: 'hole', position: { x: 50, y: 30 }, rotation: 0, depth: 2, enabled: true, through: false },
    ],
    toolKey: KEY,
    tool,
  };
}

const writes: { path: string; body: unknown }[] = [];
let entries: ToolLibraryEntry[] = [];

beforeEach(() => {
  writes.length = 0;
  entries = [entryWith(FLAT)];
  setRegistry(entries);
  setHouseClientLoader(async () => fakeHouse(entries, writes));
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  resetShopDefaultsStore();
  resetEngraveRows();
  act(() => {
    useEngraveJobStore.setState({ job: drillJob(FLAT) });
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

describe('#786 4c-2 the panel asks, and writes the answer to the cutter', () => {
  it('asks the question with Yes/No, and Yes records centre-cutting on the tool', async () => {
    render(<EngravePanel />);
    expect(screen.getByText(/Is the ⌀ 3.175 mm flat end centre-cutting\?/)).toBeTruthy();
    expect(screen.getByTestId('plunge-centre-yes')).toBeTruthy();
    expect(screen.getByTestId('plunge-centre-no')).toBeTruthy();

    fireEvent.click(screen.getByTestId('plunge-centre-yes'));

    await waitFor(() => {
      expect(useEngraveJobStore.getState().job.tool?.centreCutting).toBe(true);
    });
    // The record is written with the answer and its provenance, and the question is gone.
    const write = writes.find((w) => w.path.startsWith('/tools/'));
    expect(write).toBeDefined();
    const written = write!.body as ToolLibraryEntry;
    expect(written.key).toBe(KEY);
    expect(written.tool.centreCutting).toBe(true);
    expect(written.provenance).toContain('centre-cutting stated by you');
    await waitFor(() => {
      expect(screen.queryByText(/centre-cutting\?/)).toBeNull();
    });
  });

  it('No records centre-cutting false, and the sentence says the holes stay out', async () => {
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('plunge-centre-no'));

    await waitFor(() => {
      expect(useEngraveJobStore.getState().job.tool?.centreCutting).toBe(false);
    });
    const written = writes.find((w) => w.path.startsWith('/tools/'))!.body as ToolLibraryEntry;
    expect(written.tool.centreCutting).toBe(false);
    await waitFor(() => {
      expect(screen.getByText(/recorded as NOT centre-cutting/)).toBeTruthy();
    });
  });
});
