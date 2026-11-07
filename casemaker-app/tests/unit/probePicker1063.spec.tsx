// @vitest-environment jsdom
// #1063 — THE PICKER OFFERS CUTTERS. The shop inventory's instrument records (probes) are not
// choices: the k3 inventory's 35 records must list as 33 cutters in the Design panel's tool picker.
//
// RED at m1-follow (217a4f518): the two probes are listed, 35 options.
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
import { resetRegistry, setRegistry } from '@/engine/cnc/toolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NO_PREVIEW: EngravePreviewClient = { engravePreview: async () => null };

/** The k3 inventory's shape: 33 cutters and two probes (T9999, T8888). */
function inventory(): ToolLibraryEntry[] {
  const out: ToolLibraryEntry[] = [];
  for (let i = 0; i < 33; i++) {
    out.push({
      key: `user:cutter-${i}`,
      provenance: 'test',
      tool: flatEndMill(0.5 + i * 0.25, { name: `cutter ${i}` }),
    });
  }
  const probe = (number: number, name: string): Tool => ({
    ...flatEndMill(3.175, { number, name }),
    typeText: 'Probe',
    shape: 'unknown',
  });
  out.push({ key: 'inv:probe-v2', provenance: 'test', tool: probe(9999, 'Makera wired probe V2') });
  out.push({ key: 'inv:probe-3d', provenance: 'test', tool: probe(8888, 'Makera 3D probe') });
  return out;
}

beforeEach(() => {
  setRegistry(inventory());
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

describe('#1063 the cutter picker', () => {
  it('lists 33 cutters, not 35: the two instrument records are not choices', () => {
    const base = defaultEngraveJob();
    act(() => {
      useEngraveJobStore.setState({ job: { ...base, toolKey: 'user:cutter-0' } });
    });
    render(<EngravePanel />);
    const select = screen.getByLabelText('Tool') as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll('option'))
      .map((o) => (o as HTMLOptionElement).value)
      .filter((v) => v !== '');
    // The picker also offers the app's two built-in cutters (there is no catalogue to fall back
    // on), so the count is asserted over the INVENTORY's own keys: 33 cutters, no probe.
    expect(values.filter((v) => v.startsWith('user:cutter-'))).toHaveLength(33);
    expect(values.some((v) => v.includes('probe'))).toBe(false);
  });

  it('a job whose own key is a probe still lists that key, so the select’s value is an option', () => {
    const base = defaultEngraveJob();
    act(() => {
      useEngraveJobStore.setState({ job: { ...base, toolKey: 'inv:probe-v2' } });
    });
    render(<EngravePanel />);
    const select = screen.getByLabelText('Tool') as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value);
    expect(values).toContain('inv:probe-v2');
    expect(values.filter((v) => v.includes('probe'))).toEqual(['inv:probe-v2']);
  });
});
