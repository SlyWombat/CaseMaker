// @vitest-environment jsdom
// #511 — the Machines card's Bed block: renders every surface kind, and Switch writes the location
// without ever sending a machine command.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { setHouseClientLoader, type HouseClient } from '@/platform/houseClient';
import { setMachineConsoleLoader } from '@/platform/machineConsole';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MachineBed } from '@/components/manage/MachineBed';
import { LocationViewSchema, type BedProfile, type MachineRecord } from '@/platform/locationClient';
import { resetLocationStore, useLocationStore } from '@/store/locationStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = dirname(fileURLToPath(import.meta.url));
vi.mock('@/platform/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/platform/capabilities')>();
  return { ...actual, canDriveMachine: true };
});
// #637 — the mount-tap runner is stubbed so the card host's plumbing (prompt, busy, completion) is
// what this test drives.
vi.mock('@/engine/cnc/registration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/cnc/registration')>();
  return {
    ...actual,
    runMountTap: vi.fn(async (_tap: unknown, _from: unknown, _settings: unknown, deps: { operator: (s: { kind?: string; text: string }) => Promise<boolean> }) => {
      const ok = await deps.operator({ kind: 'fit-probe', text: 'Fit the wired probe in the spindle, then continue.' });
      if (!ok) return { ok: false as const, reason: 'stopped: the probe was not fitted', transcript: [] };
      return { ok: true as const, z: -56.82, at: { x: -186.2, y: -180 }, probe: { lengthZ: -76.063, rest: 'Probe: 0' }, transcript: [{ line: '?', reply: '<Idle|MPos:-1,-1,-1>' }] };
    }),
  };
});

const VIEW = LocationViewSchema.parse(
  JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')),
);

function machine(overrides: Partial<MachineRecord> = {}): MachineRecord {
  return { ...VIEW.machines[0]!, ...overrides };
}

/** The surface records for the four kinds, each one the schema accepts. */
const SURFACES: Record<string, BedProfile['surface']> = {
  'bare-bed': { kind: 'bare-bed', material: null, length: null, width: null, thickness: null, position: null, provenance: {}, scars: [], lastResurfacedAt: null },
  wasteboard: { kind: 'wasteboard', material: 'MDF', length: 200, width: 200, thickness: 10, position: { frontLeft: [-200, -200], frame: 'machine' }, provenance: { thickness: 'measured' }, scars: [], lastResurfacedAt: null },
  'fixture-plate': { kind: 'fixture-plate', material: null, length: null, width: null, thickness: null, position: null, provenance: {}, scars: [], lastResurfacedAt: null },
  'vacuum-bed': { kind: 'vacuum-bed', material: null, length: null, width: null, thickness: null, position: null, provenance: {}, scars: [], lastResurfacedAt: null },
};

beforeEach(() => {
  resetLocationStore();
});
afterEach(() => {
  cleanup();
  setHouseClientLoader(null);
  setMachineConsoleLoader(null);
});

describe('#511 the Bed block', () => {
  it('renders every surface kind in the summary', () => {
    const words: Record<string, string> = {
      'bare-bed': 'bare bed',
      wasteboard: 'MDF wasteboard',
      'fixture-plate': 'fixture plate',
      'vacuum-bed': 'vacuum bed',
    };
    for (const [kind, word] of Object.entries(words)) {
      cleanup();
      const m = machine();
      m.bedProfiles![0]!.surface = SURFACES[kind]!;
      render(<MachineBed machine={m} />);
      expect(screen.getByTestId('manage-bed-summary').textContent).toContain(word);
    }
  });

  it('says the bed is not described before the migration has run', () => {
    const m = machine({ bedProfiles: undefined, activeBedProfileId: undefined });
    render(<MachineBed machine={m} />);
    expect(screen.getByTestId('manage-bed').textContent).toContain('not described');
  });

  it('says what measures each unmeasured datum, in operator language (#616)', () => {
    const m = machine();
    // A fresh copy, so the null datums do not leak into the shared fixture for later tests.
    m.bedProfiles = m.bedProfiles!.map((p) => ({
      ...p,
      datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null },
    }));
    render(<MachineBed machine={m} />);

    expect(screen.getByTestId('manage-bed-measure-surfaceTopZ').textContent).toContain(
      'Run a surface registration',
    );
    expect(screen.getByTestId('manage-bed-measure-viseJawTopZ').textContent).toContain(
      'Tap the fixed jaw (probe in the spindle)',
    );
    expect(screen.getByTestId('manage-bed-measure-bracketSeatZ').textContent).toContain(
      'Measure the seat beside the bracket — one touch on the surface beside it; the arm tap checks it on later runs',
    );
    expect(screen.getByTestId('manage-bed-measure-rotaryAxis').textContent).toContain(
      'Fit and characterise the rotary module first',
    );
  });

  it('Switch writes the location (a new active id) and never sends a machine command', async () => {
    const consoleSends: string[] = [];
    setMachineConsoleLoader(async () => ({
      open: async () => ({
        send: async (line: string) => {
          consoleSends.push(line);
          return { ok: true, line, text: '', frames: 0, elapsedMs: 0 };
        },
        close: async () => {},
      }),
    }));

    const calls: { method: string; path: string; body?: unknown }[] = [];
    const client = {
      probe: async () => ({ kind: 'absent', reason: 'test' }),
      tools: async () => ({ kind: 'absent', reason: 'test' }),
      feeds: async () => ({ kind: 'absent', reason: 'test' }),
      inventory: async () => ({ kind: 'absent', reason: 'test' }),
      call: async (method: string, path: string, body?: unknown) => {
        calls.push({ method, path, body });
        return { kind: 'ok', text: '{}' };
      },
    } as unknown as HouseClient;
    setHouseClientLoader(async () => client);

    // A second saved profile, so Switch has somewhere to go.
    const second = { ...machine().bedProfiles![0]!, id: 'bp-second', name: 'Second bed' };
    const m = machine({ bedProfiles: [...machine().bedProfiles!, second], activeBedProfileId: 'bp-migrated-2026-10-15' });
    useLocationStore.setState({ status: 'present', location: { ...VIEW, machines: [m] }, etag: '"x"' });

    render(<MachineBed machine={m} />);
    fireEvent.change(screen.getByTestId('manage-bed-switch'), { target: { value: 'bp-second' } });

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.path === '/location/machines/machine-1a2b3c')).toBe(true));

    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({ activeBedProfileId: 'bp-second' });
    // The profiles are untouched — Switch only re-names which one is active.
    expect((put?.body as MachineRecord).bedProfiles).toHaveLength(2);

    // No machine command went anywhere: the console loader's session was never opened/sent to.
    expect(consoleSends).toEqual([]);
    // And nothing but the location write and its re-read crossed the service client.
    expect(calls.every((c) => c.path.startsWith('/location'))).toBe(true);
  });
});

describe('#637 the Bed card drives the shared mount tap', () => {
  it('prompts with testids, disables while busy, and completes on Continue', async () => {
    const m = machine();
    useLocationStore.setState({ status: 'present', location: { ...VIEW, machines: [m] }, etag: '"x"' });
    // The write-back is not this test's subject.
    useLocationStore.setState({ saveMachine: async () => 'ok' });
    render(<MachineBed machine={m} />);

    const tapButton = screen.getByTestId('manage-bed-tap-jaw-button') as HTMLButtonElement;
    fireEvent.click(tapButton);
    await screen.findByTestId('engrave-mount-tap-continue');
    expect(screen.getByTestId('engrave-mount-tap-cancel')).toBeTruthy();
    expect((screen.getByTestId('manage-bed-tap-jaw-button') as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByTestId('engrave-mount-tap-continue'));
    });
    await waitFor(() => expect(screen.getByTestId('manage-bed-tap-note').textContent).toContain('recorded'));
    expect((screen.getByTestId('manage-bed-tap-jaw-button') as HTMLButtonElement).disabled).toBe(false);
  });
});
