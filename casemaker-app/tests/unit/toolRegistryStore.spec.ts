// The house's tool tiers in the app (#306, tracking #212): the probe → read → `setRegistry` chain,
// and the three states it can end in. The client is the seam — a `HouseClient` fake, so the store's
// own orchestration is the real one in every test.

import { beforeEach, describe, expect, it } from 'vitest';
import { getTools, resetRegistry } from '@/engine/cnc/toolRegistry';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import {
  setHouseClientLoader,
  HOUSE_SCHEMA_VERSION,
  type HouseClient,
  type HouseHealth,
  type HouseProbe,
  type HouseTools,
} from '@/platform/houseClient';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

const HEALTH: HouseHealth = {
  ok: true,
  schemaVersion: HOUSE_SCHEMA_VERSION,
  hasCatalogue: false,
  catalogueSyncedAt: null,
  problems: [],
};

const USER: ToolLibraryEntry = {
  key: 'user:1a2b3c4d5e',
  provenance: 'typed in by hand',
  tool: {
    number: null,
    id: null,
    name: '2 mm flat end',
    typeText: 'Flat End',
    shape: 'flat',
    handleDiameter: null,
    tipDiameter: 2,
    diameter: 2,
    cornerRadius: 0,
    angle: null,
    halfAngle: null,
    fluteLength: null,
    shoulderLength: 12,
    stickout: null,
    centreCutting: null,
  },
};

/** A fake client that records what it was asked, so the store's calls can be asserted. */
function fakeClient(opts: {
  probe: HouseProbe;
  tools?: (etag: string | null) => HouseTools;
  log?: string[];
}): HouseClient {
  return {
    probe: async () => {
      opts.log?.push('probe');
      return opts.probe;
    },
    tools: async (etag) => {
      opts.log?.push(`tools:${etag ?? '-'}`);
      return opts.tools ? opts.tools(etag) : { kind: 'ok', etag: '"e1"', entries: [USER] };
    },
  };
}

beforeEach(() => {
  resetRegistry();
  useToolRegistryStore.getState().reset();
  setHouseClientLoader(null);
});

const state = () => useToolRegistryStore.getState();

describe('refresh against a house service', () => {
  it('pushes the service’s tiers above the built-ins and records the health', async () => {
    setHouseClientLoader(async () => fakeClient({ probe: { kind: 'present', health: HEALTH, base: '' } }));
    await state().refresh();

    expect(state().status).toBe('present');
    expect(state().entries).toEqual([USER]);
    expect(state().health).toEqual(HEALTH);
    expect(state().error).toBeNull();
    expect(state().etag).toBe('"e1"');
    // The pickers read the registry, not this store: the entry is live for every one of them.
    expect(getTools().map((e) => e.key)).toEqual([...TOOL_LIBRARY.map((e) => e.key), 'user:1a2b3c4d5e']);
  });

  it('a service holding nothing is PRESENT with no entries, not absent', async () => {
    setHouseClientLoader(async () =>
      fakeClient({ probe: { kind: 'present', health: HEALTH, base: '' }, tools: () => ({ kind: 'ok', etag: '"e0"', entries: [] }) }),
    );
    await state().refresh();

    expect(state().status).toBe('present');
    expect(state().entries).toEqual([]);
    // Identity, not a copy: an empty house leaves the built-ins as the single default object (#305).
    expect(getTools()).toBe(TOOL_LIBRARY);
  });

  it('carries the ETag between refreshes, and a 304 keeps what the registry has', async () => {
    const log: string[] = [];
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: HEALTH, base: '' },
        tools: (etag) => (etag ? { kind: 'unchanged' } : { kind: 'ok', etag: '"e1"', entries: [USER] }),
        log,
      }),
    );
    await state().refresh();
    expect(state().entries).toEqual([USER]);

    await state().refresh();
    expect(log).toEqual(['probe', 'tools:-', 'probe', 'tools:"e1"']);
    expect(state().status).toBe('present');
    expect(state().entries).toEqual([USER]);
    expect(getTools().map((e) => e.key)).toContain('user:1a2b3c4d5e');
  });
});

describe('refresh with no service', () => {
  it('an HTML answer leaves the built-ins exactly as they were', async () => {
    setHouseClientLoader(async () =>
      fakeClient({ probe: { kind: 'absent', reason: 'the page at http://x answered with text/html, not the house service' } }),
    );
    await state().refresh();

    expect(state().status).toBe('absent');
    expect(state().entries).toEqual([]);
    expect(state().health).toBeNull();
    expect(state().error).toContain('text/html');
    expect(getTools()).toBe(TOOL_LIBRARY);
  });

  it('a service at another version is absent WITH the reason, never a guess', async () => {
    setHouseClientLoader(async () =>
      fakeClient({ probe: { kind: 'error', detail: 'the house service speaks version 2; this build reads version 1' } }),
    );
    await state().refresh();

    expect(state().status).toBe('absent');
    expect(state().error).toContain('version 2');
    expect(getTools()).toBe(TOOL_LIBRARY);
  });

  it('keeps the health when the service answers health but not its list', async () => {
    const broken: HouseHealth = { ...HEALTH, hasCatalogue: true, problems: ['house.json is not readable JSON'] };
    setHouseClientLoader(async () =>
      fakeClient({ probe: { kind: 'present', health: broken, base: '' }, tools: () => ({ kind: 'absent', reason: 'GET /api/v1/tools answered 500' }) }),
    );
    await state().refresh();

    expect(state().status).toBe('absent');
    expect(state().error).toContain('500');
    // "hasCatalogue: true and the list failed" is what someone debugging needs to see.
    expect(state().health).toEqual(broken);
    expect(getTools()).toBe(TOOL_LIBRARY);
  });

  it('a refresh that fails does not throw', async () => {
    setHouseClientLoader(async () => {
      throw new Error('the loader itself failed');
    });
    await expect(state().refresh()).resolves.toBeUndefined();
    expect(state().status).toBe('absent');
  });
});

describe('the store’s own bookkeeping', () => {
  it('a second refresh while one is in flight shares the run', async () => {
    const log: string[] = [];
    setHouseClientLoader(async () => fakeClient({ probe: { kind: 'present', health: HEALTH, base: '' }, log }));
    const first = state().refresh();
    const second = state().refresh();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(log.filter((l) => l === 'probe')).toHaveLength(1);
  });

  it('reset forgets the service and goes back to the built-ins', async () => {
    setHouseClientLoader(async () => fakeClient({ probe: { kind: 'present', health: HEALTH, base: '' } }));
    await state().refresh();
    expect(getTools()).not.toBe(TOOL_LIBRARY);

    state().reset();
    expect(state().entries).toEqual([]);
    expect(state().health).toBeNull();
    expect(state().etag).toBeNull();
    expect(getTools()).toBe(TOOL_LIBRARY);
  });
});
