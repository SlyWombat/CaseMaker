// @vitest-environment jsdom
// #511 — the Machines card's Bed block: renders every surface kind, and Switch writes the location
// without ever sending a machine command.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      'not measured — run a surface registration',
    );
    expect(screen.getByTestId('manage-bed-measure-viseJawTopZ').textContent).toContain(
      'not measured — press Tap the fixed jaw (probe in the spindle)',
    );
    expect(screen.getByTestId('manage-bed-measure-bracketSeatZ').textContent).toContain(
      'not measured — measure the seat beside the bracket first (one touch on the surface beside it); the arm tap checks it on later runs',
    );
    expect(screen.getByTestId('manage-bed-measure-rotaryAxis').textContent).toContain(
      'not measured — the rotary module is not characterised yet',
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
