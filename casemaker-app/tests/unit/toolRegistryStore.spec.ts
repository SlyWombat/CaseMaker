// The house's tool tiers in the app (#306, tracking #212): the probe → read → `setRegistry` chain,
// and the three states it can end in. The client is the seam — a `HouseClient` fake, so the store's
// own orchestration is the real one in every test.

import { beforeEach, describe, expect, it } from 'vitest';
import { getTools, resetRegistry } from '@/engine/cnc/toolRegistry';
import { feedCatalogueRows, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import {
  setHouseClientLoader,
  HOUSE_SCHEMA_VERSION,
  type HouseCall,
  type HouseClient,
  type HouseFeeds,
  type HouseHealth,
  type HouseInventory,
  type HouseProbe,
  type HouseTools,
  type InventoryItem,
} from '@/platform/houseClient';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

const HEALTH: HouseHealth = {
  ok: true,
  schemaVersion: HOUSE_SCHEMA_VERSION,
  hasCatalogue: false,
  feedRows: 0,
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

/** One catalogue row, for a cutter the fixture's tool list actually names. */
const FEED_ROW: FeedCatalogueRow = {
  cutterId: '112111313812',
  material: 'Hardwood',
  rpm: 12000,
  feed: 900,
  plungeFeed: 300,
  stepDown: 1.2,
};

/** One physical cutter, for the inventory document (#309). */
const ITEM: InventoryItem = {
  id: '1a2b3c4d5e',
  tool: USER.tool,
  origin: null,
  quantity: 2,
  codes: [{ symbology: 'qr', value: 'C1-BIT-FLAT-2-0' }],
  addedAt: '2026-01-02T03:04:05.000Z',
  notes: null,
};

/** A fake client that records what it was asked, so the store's calls can be asserted. */
function fakeClient(opts: {
  probe: HouseProbe;
  tools?: (etag: string | null) => HouseTools;
  feeds?: (etag: string | null) => HouseFeeds;
  inventory?: (etag: string | null) => HouseInventory;
  /** Never called by a read; a write test brings its own. Present so the fake is a real `HouseClient`. */
  call?: (method: string, path: string, body?: unknown) => HouseCall;
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
    feeds: async (etag) => {
      opts.log?.push(`feeds:${etag ?? '-'}`);
      // The default is a service that answers, with no catalogue rows: the fresh-machine case.
      return opts.feeds ? opts.feeds(etag) : { kind: 'ok', etag: '"f1"', rows: [] };
    },
    inventory: async (etag) => {
      opts.log?.push(`inventory:${etag ?? '-'}`);
      // The default is a service that answers, with nothing registered yet.
      return opts.inventory ? opts.inventory(etag) : { kind: 'ok', etag: '"i1"', items: [] };
    },
    call: async (method, path, body) => {
      opts.log?.push(`call:${method} ${path}`);
      return opts.call ? opts.call(method, path, body) : { kind: 'ok', text: '' };
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
    // One probe, then the three documents, each with the validator the last read returned: the
    // order is the dependency order (tools → feeds → inventory), and the second pass is all 304s.
    expect(log).toEqual([
      'probe',
      'tools:-',
      'feeds:-',
      'inventory:-',
      'probe',
      'tools:"e1"',
      'feeds:"f1"',
      'inventory:"i1"',
    ]);
    expect(state().status).toBe('present');
    expect(state().entries).toEqual([USER]);
    expect(getTools().map((e) => e.key)).toContain('user:1a2b3c4d5e');
  });
});

describe('the feed catalogue (#310)', () => {
  it('pushes the service’s rows into the feeds engine and counts them', async () => {
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: { ...HEALTH, feedRows: 1 }, base: '' },
        feeds: () => ({ kind: 'ok', etag: '"f1"', rows: [FEED_ROW] }),
      }),
    );
    await state().refresh();

    // The rows live in `engine/cnc/feeds.ts` — the module `feedsFor` reads — not in this store.
    expect(feedCatalogueRows()).toEqual([FEED_ROW]);
    expect(state().feedCount).toBe(1);
    expect(state().feedEtag).toBe('"f1"');
    expect(state().feedError).toBeNull();
  });

  it('a catalogue the service could not read is dropped, with the reason, and the registry stands', async () => {
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: HEALTH, base: '' },
        feeds: () => ({ kind: 'absent', reason: 'GET /api/v1/feeds answered 404' }),
      }),
    );
    await state().refresh();

    // A usable house with a gap: the cutters are fine, so this is not `error`.
    expect(state().status).toBe('present');
    expect(state().error).toBeNull();
    expect(state().feedError).toContain('404');
    expect(feedCatalogueRows()).toEqual([]);
    expect(state().feedCount).toBe(0);
  });

  it('losing the service drops the catalogue with it', async () => {
    let present = true;
    setHouseClientLoader(async () =>
      fakeClient({
        probe: present
          ? { kind: 'present', health: HEALTH, base: '' }
          : { kind: 'absent', reason: 'the page answered with text/html, not the house service' },
        feeds: () => ({ kind: 'ok', etag: '"f1"', rows: [FEED_ROW] }),
      }),
    );
    await state().refresh();
    expect(feedCatalogueRows()).toEqual([FEED_ROW]);

    present = false;
    await state().refresh();
    // A catalogue from a machine we can no longer see is the same kind of claim as its tool list.
    expect(feedCatalogueRows()).toEqual([]);
    expect(state().feedCount).toBe(0);
    expect(state().feedEtag).toBeNull();
  });

  it('a 304 on the catalogue keeps the rows already loaded', async () => {
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: HEALTH, base: '' },
        feeds: (etag) => (etag ? { kind: 'unchanged' } : { kind: 'ok', etag: '"f1"', rows: [FEED_ROW] }),
      }),
    );
    await state().refresh();
    await state().refresh();
    expect(feedCatalogueRows()).toEqual([FEED_ROW]);
    expect(state().feedCount).toBe(1);
  });
});

describe('the inventory (#309)', () => {
  it('keeps the items and puts their inv: entries in the registry', async () => {
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: HEALTH, base: '' },
        inventory: () => ({ kind: 'ok', etag: '"i1"', items: [ITEM] }),
      }),
    );
    await state().refresh();

    // The documents are here, because the panel's Qty/Codes columns are about the possession.
    expect(state().items).toEqual([ITEM]);
    expect(state().inventoryEtag).toBe('"i1"');
    expect(state().inventoryError).toBeNull();
    // And the resolver sees the cutter, under the key a job names it by.
    expect(getTools().map((e) => e.key)).toContain('inv:1a2b3c4d5e');
    expect(getTools().find((e) => e.key === 'inv:1a2b3c4d5e')?.tool.name).toBe(USER.tool.name);
  });

  it('an inventory the service could not read is dropped, with the reason, and the registry stands', async () => {
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: HEALTH, base: '' },
        inventory: () => ({ kind: 'absent', reason: 'GET /api/v1/inventory answered 500' }),
      }),
    );
    await state().refresh();

    expect(state().status).toBe('present');
    expect(state().error).toBeNull();
    expect(state().inventoryError).toContain('500');
    expect(state().items).toEqual([]);
    // The tool tier is untouched: one document failing does not take the other with it.
    expect(getTools().map((e) => e.key)).toContain('user:1a2b3c4d5e');
    expect(getTools().some((e) => e.key.startsWith('inv:'))).toBe(false);
  });

  it('losing the service drops the inventory with it', async () => {
    let present = true;
    setHouseClientLoader(async () =>
      fakeClient({
        probe: present
          ? { kind: 'present', health: HEALTH, base: '' }
          : { kind: 'absent', reason: 'the page answered with text/html, not the house service' },
        inventory: () => ({ kind: 'ok', etag: '"i1"', items: [ITEM] }),
      }),
    );
    await state().refresh();
    expect(state().items).toEqual([ITEM]);

    present = false;
    await state().refresh();
    expect(state().items).toEqual([]);
    expect(state().inventoryEtag).toBeNull();
    expect(getTools().some((e) => e.key.startsWith('inv:'))).toBe(false);
  });

  it('a 304 keeps the items and the entries already loaded', async () => {
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: HEALTH, base: '' },
        tools: (etag) => (etag ? { kind: 'unchanged' } : { kind: 'ok', etag: '"e1"', entries: [USER] }),
        inventory: (etag) =>
          etag ? { kind: 'unchanged' } : { kind: 'ok', etag: '"i1"', items: [ITEM] },
      }),
    );
    await state().refresh();
    const first = getTools();
    await state().refresh();

    expect(state().items).toEqual([ITEM]);
    expect(state().inventoryEtag).toBe('"i1"');
    // The snapshot itself is untouched by the 304 — every picker re-renders from this identity.
    expect(getTools()).toBe(first);
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
