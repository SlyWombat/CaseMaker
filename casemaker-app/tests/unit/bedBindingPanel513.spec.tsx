// @vitest-environment jsdom
// #513 — THE PANEL'S HALF OF THE BED BINDING.
//
// Two things the engine module cannot prove on its own:
//   1. Generate BINDS the job to the machine's active bed on its first run (id, version and the
//      datum snapshot), and a job already bound KEEPS its binding — that is what makes a changed
//      bed visible instead of silently re-planned;
//   2. a `bed-changed` warning's two presses do what they say: "Re-plan on the current bed" rebinds
//      the job to the bed the machine has now, and "Switch the bed back" makes the profile the job
//      was set up on the machine's active one again, through the machine's own write path.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { EngravePanel } from '@/components/panels/EngravePanel';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { setEngraveRunClientLoader, useEngraveRunStore } from '@/store/engraveRunStore';
import { setEngravePreviewClientLoader, useEngravePreviewStore } from '@/store/engravePreviewStore';
import { resetEngraveRows } from '@/store/engraveRowStore';
import { resetShopDefaultsStore } from '@/store/shopDefaultsStore';
import { settleShopSettings } from '../tools/settledShop';
import { useSettingsStore } from '@/store/settingsStore';
import { resetMachineStore } from '@/store/machineStore';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';
import { HOUSE_SCHEMA_VERSION, setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import {
  LocationViewSchema,
  type BedProfile,
  type LocationView,
  type MachineRecord,
} from '@/platform/locationClient';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { bindJob, profileVersion } from '@/engine/cnc/bed/binding';
import { resetRegistry } from '@/engine/cnc/toolRegistry';
import type { EngraveJob } from '@/types/engraveJob';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEW = LocationViewSchema.parse(JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')));
const MACHINE = VIEW.machines[0]!;
const PROFILE = MACHINE.bedProfiles![0]!;

/** A second profile the machine also holds: the job is "set up on" this one, the bed B is active. */
const OTHER: BedProfile = {
  ...PROFILE,
  id: 'bp-other',
  name: 'Z1 — Wasteboard + tape',
  createdAt: '2026-10-14T09:00:00.000Z',
  history: [{ at: '2026-10-14T09:00:00.000Z', what: 'shipped default' }],
};

function machineWith(profiles: BedProfile[], activeId: string): MachineRecord {
  return { ...MACHINE, bedProfiles: profiles, activeBedProfileId: activeId };
}

function seedLocation(machine: MachineRecord): void {
  const location = { ...VIEW, machines: [machine] } as unknown as LocationView;
  act(() => {
    useLocationStore.setState({ status: 'present', location, etag: '"e1"', reason: null });
  });
}

/** A 100 × 60 × 6 plate with the ⌀1 cutter the panel's Generate path expects (#516 item 5). */
function job(): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, toolKey: 'flat-1.0', stock: { ...base.stock, length: 100, width: 60, thickness: 6 } };
}

/** No preview worker: this spec seeds the states it renders. */
const NO_PREVIEW = { engravePreview: async () => null };

/** The run's seam: a generate that answers at once, so Generate can be pressed in a unit test. */
function stubGenerate(): void {
  setEngraveRunClientLoader(async () => ({
    engraveGenerate: async () =>
      ({ ok: false, stage: 'findings', findings: [], feeds: null, cam: null, nc: null, verify: null, programs: [], errors: [] }) as never,
    simOracle: async () => ({ ok: true, band: 0.016, levels: [], worst: { underCut: 0, overCut: 0 } }),
  }));
}

/** A house service that serves GET /location and accepts PUT /location/machines/:id, recording the writes. */
function fakeHouse(machines: MachineRecord[]): { writes: MachineRecord[] } {
  const writes: MachineRecord[] = [];
  let served = { ...VIEW, machines } as unknown as LocationView;
  const client: HouseClient = {
    probe: async () => ({
      kind: 'present' as const,
      base: '',
      health: {
        ok: true,
        runs: true,
        schemaVersion: HOUSE_SCHEMA_VERSION,
        build: 'v-test',
        hasCatalogue: false,
        feedRows: 0,
        materialSpecRows: 0,
        catalogueSyncedAt: null,
        lastSync: null,
        problems: [],
        warnings: [],
      },
    }),
    tools: async () => ({ kind: 'ok' as const, etag: '"t"', entries: [] }),
    feeds: async () => ({ kind: 'absent' as const, reason: 'none' }),
    inventory: async () => ({ kind: 'ok' as const, etag: '"i"', items: [] }),
    call: async (method, path, body): Promise<HouseCall> => {
      if (method === 'GET' && path === '/location') {
        return { kind: 'ok', text: JSON.stringify(served), etag: '"e2"' };
      }
      if (method === 'PUT' && path.startsWith('/location/machines/')) {
        const record = body as MachineRecord;
        writes.push(record);
        served = {
          ...served,
          machines: served.machines.map((m) => (m.id === record.id ? record : m)),
        } as unknown as LocationView;
        return { kind: 'ok', text: '' };
      }
      return { kind: 'refused', status: 404, message: `${method} ${path} is not served` };
    },
  };
  setHouseClientLoader(async () => client);
  return { writes };
}

beforeEach(() => {
  setEngravePreviewClientLoader(async () => NO_PREVIEW);
  useSettingsStore.getState().resetSettings();
  resetEngraveRows();
  resetShopDefaultsStore();
  // #1276 — Generate waits for / refuses without the shop's settings: this spec runs with them settled.
  settleShopSettings();
  resetLocationStore();
  resetMachineStore();
  resetRegistry();
  act(() => {
    useEngraveJobStore.setState({ job: job() });
  });
  useEngravePreviewStore.getState().dispose();
});

afterEach(() => {
  cleanup();
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
  setEngraveRunClientLoader(null);
  setHouseClientLoader(null);
  resetLocationStore();
});

describe('#513 Generate binds the job to the bed it is set up on', () => {
  it('its first run writes the active profile, its version and the datum snapshot', async () => {
    seedLocation(machineWith([PROFILE], PROFILE.id));
    stubGenerate();
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-generate'));

    await waitFor(() => expect(useEngraveJobStore.getState().job.bed).toBeDefined());
    const bed = useEngraveJobStore.getState().job.bed!;
    expect(bed.profileId).toBe(PROFILE.id);
    expect(bed.profileVersion).toBe(profileVersion(PROFILE));
    expect(bed.datums).toEqual({ surfaceTopZ: null, viseJawTopZ: -56.82, bracketSeatZ: -70.2, rotaryAxis: null, rotaryFaceAngle: null });
  });

  it('a job already bound KEEPS its binding — the changed bed stays visible', async () => {
    seedLocation(machineWith([PROFILE, OTHER], PROFILE.id));
    stubGenerate();
    act(() => useEngraveJobStore.setState({ job: { ...job(), bed: bindJob(OTHER) } }));
    render(<EngravePanel />);
    fireEvent.click(screen.getByTestId('engrave-generate'));

    await waitFor(() => expect(useEngraveRunStore.getState().generated).not.toBeNull());
    expect(useEngraveJobStore.getState().job.bed!.profileId).toBe(OTHER.id);
  });
});

describe('#513 a bed-changed warning’s two presses', () => {
  it('“Re-plan on the current bed” binds the job to the bed the machine has now', () => {
    seedLocation(machineWith([PROFILE, OTHER], PROFILE.id));
    act(() => useEngraveJobStore.setState({ job: { ...job(), bed: bindJob(OTHER) } }));
    render(<EngravePanel />);

    const row = screen.getByTestId(/engrave-finding-\d+-bed-changed/);
    expect(row.textContent).toContain('Re-plan on the current bed');
    fireEvent.click(screen.getByTestId('engrave-bed-replan'));

    const bed = useEngraveJobStore.getState().job.bed!;
    expect(bed.profileId).toBe(PROFILE.id);
    expect(bed.profileVersion).toBe(profileVersion(PROFILE));
    // Re-planning rebinds, so the warning is gone: the job now names the bed it will run on.
    expect(screen.queryByTestId(/engrave-finding-\d+-bed-changed/)).toBeNull();
  });

  it('“Switch the bed back” makes the job’s profile the machine’s active bed again', async () => {
    const service = fakeHouse([machineWith([PROFILE, OTHER], PROFILE.id)]);
    seedLocation(machineWith([PROFILE, OTHER], PROFILE.id));
    act(() => useEngraveJobStore.setState({ job: { ...job(), bed: bindJob(OTHER) } }));
    render(<EngravePanel />);

    fireEvent.click(screen.getByTestId('engrave-bed-switch-back'));
    await waitFor(() => expect(service.writes).toHaveLength(1));
    expect(service.writes[0]!.activeBedProfileId).toBe(OTHER.id);
    // The machine is written, the job is not: nothing about the job changed — the bed did.
    expect(useEngraveJobStore.getState().job.bed!.profileId).toBe(OTHER.id);
  });

  it('no switch-back press when the machine no longer holds the job’s profile', () => {
    seedLocation(machineWith([PROFILE], PROFILE.id));
    act(() => useEngraveJobStore.setState({ job: { ...job(), bed: bindJob(OTHER) } }));
    render(<EngravePanel />);
    expect(screen.getByTestId(/engrave-finding-\d+-bed-changed/).textContent).toContain('Re-plan on the current bed');
    expect(screen.queryByTestId('engrave-bed-switch-back')).toBeNull();
  });
});
