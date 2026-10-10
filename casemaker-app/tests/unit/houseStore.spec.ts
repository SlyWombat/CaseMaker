// @vitest-environment jsdom
// The house's write path (#311, tracking #212): one action per endpoint, the notice each one ends
// in, and the re-read that follows a write which actually changed something. The client is the
// seam again — a `HouseClient` fake — so what is under test is this store's own orchestration.
//
// jsdom rather than the node default for one reason: saving the house file is a DOM act (an anchor
// with a `download`), and the difference between "saved" and "the browser would not" is exactly
// what the export's notice is about.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { getTools, resetRegistry } from '@/engine/cnc/toolRegistry';
import {
  HOUSE_SCHEMA_VERSION,
  setHouseClientLoader,
  type HouseCall,
  type HouseClient,
  type HouseHealth,
  type InventoryItem,
  type SyncReport,
} from '@/platform/houseClient';
import { HOUSE_FILENAME, lastSyncView, resetHouseStore, useHouseStore } from '@/store/houseStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';

const HEALTH: HouseHealth = {
  ok: true,
  schemaVersion: HOUSE_SCHEMA_VERSION,
  hasCatalogue: true,
  feedRows: 1328,
  catalogueSyncedAt: '2026-01-01T00:00:00.000Z',
  lastSync: null,
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

const ITEM: InventoryItem = {
  id: '9f8e7d6c5b',
  tool: USER.tool,
  origin: null,
  quantity: 2,
  codes: [{ symbology: 'qr', value: 'C1-BIT-FLAT-2-0' }],
  addedAt: '2026-01-02T03:04:05.000Z',
  notes: null,
};

const REPORT: SyncReport = {
  source: 'C:\\Makera\\makera_library.db',
  syncedAt: '2026-01-03T00:00:00.000Z',
  total: 129,
  added: ['cat:a', 'cat:b'],
  removed: [],
  changed: ['cat:c'],
  unchanged: 126,
  feedRows: 1328,
  notes: [],
};

/**
 * A service that answers everything, recording every call in order so a test can assert what the
 * store asked for AND what it did not. `write` decides what one write answers, and is the only way
 * a test changes what the next read sees.
 */
interface Sent {
  method: string;
  path: string;
  body: unknown;
  /** The guarded write's validator (#321), recorded so a test can assert what was sent — and, in the
   *  cases that must not be guarded, that nothing was. */
  ifMatch: string | null | undefined;
}

function fakeHouse(
  opts: {
    /** What one write answers, with a setter for what the next inventory read will see. */
    write?: (setItems: (items: InventoryItem[]) => void) => HouseCall;
    /** Holds a write open, so a test can catch the store mid-flight. */
    gate?: Promise<void>;
    /** Holds every probe but the first open, so a test can catch the store between a write and
     *  the re-read that follows it (#336). The first read has to land for there to be a version. */
    probeGate?: Promise<void>;
    /** What the inventory read serves to begin with. */
    items?: InventoryItem[];
  } = {},
) {
  const log: string[] = [];
  const sent: Sent[] = [];
  let items: InventoryItem[] = opts.items ?? [];
  const client: HouseClient = {
    probe: async () => {
      log.push('probe');
      if (opts.probeGate && log.filter((l) => l === 'probe').length > 1) await opts.probeGate;
      return { kind: 'present', health: HEALTH, base: '' };
    },
    tools: async () => {
      log.push('tools');
      return { kind: 'ok', etag: '"e1"', entries: [USER] };
    },
    feeds: async () => {
      log.push('feeds');
      return { kind: 'ok', etag: '"f1"', rows: [] };
    },
    inventory: async () => {
      log.push('inventory');
      return { kind: 'ok', etag: '"i1"', items };
    },
    call: async (method, path, body, reqOpts) => {
      log.push(`${method} ${path}`);
      sent.push({ method, path, body, ifMatch: reqOpts?.ifMatch });
      if (opts.gate) await opts.gate;
      if (!opts.write) return { kind: 'ok', text: '' };
      return opts.write((next) => {
        items = next;
      });
    },
  };
  setHouseClientLoader(async () => client);
  return { log, sent };
}

beforeEach(() => {
  resetRegistry();
  useToolRegistryStore.getState().reset();
  resetHouseStore();
  setHouseClientLoader(null);
});

const state = () => useHouseStore.getState();

describe('the guard on a write that changes a document (#321)', () => {
  it('sends the version it last read, each document its own', async () => {
    const { sent } = fakeHouse({ write: () => ({ kind: 'ok', text: '' }) });
    // Read the house first, which is the state every panel is in when it offers a Save button.
    await useToolRegistryStore.getState().refresh();
    expect(useToolRegistryStore.getState().etag).toBe('"e1"');
    expect(useToolRegistryStore.getState().inventoryEtag).toBe('"i1"');

    await state().updateTool(USER);
    await state().updateItem(ITEM);
    await state().removeTool(USER.key);
    await state().removeItem(ITEM.id);

    // The service checks each guarded write against the list it edits, so the tool writes carry the
    // tool list's validator and the inventory writes carry the inventory's — never one for the other.
    expect(sent.map((s) => [s.method, s.ifMatch])).toEqual([
      ['PATCH', '"e1"'],
      ['PATCH', '"i1"'],
      ['DELETE', '"e1"'],
      ['DELETE', '"i1"'],
    ]);
  });

  it('does not guard a register, which is judged by its key instead', async () => {
    const { sent } = fakeHouse({ write: () => ({ kind: 'ok', text: '' }) });
    await useToolRegistryStore.getState().refresh();
    await state().registerTool(USER);
    await state().registerItem(ITEM);
    expect(sent.map((s) => s.ifMatch)).toEqual([undefined, undefined]);
  });

  it('re-reads when the service says the version is stale, so the next attempt can work', async () => {
    // A 412 is the case the guard exists for: another window saved between this one's read and its
    // save. The refusal is the service's own sentence and the house is re-read behind it — without
    // that, the user retries against the validator that just failed, for ever.
    const { log } = fakeHouse({
      write: () => ({
        kind: 'refused',
        status: 412,
        message:
          'the tool list changed since you read it, so this save was based on a version that is no longer there — reload and make the change again',
      }),
    });
    await useToolRegistryStore.getState().refresh();
    log.length = 0;

    expect(await state().updateTool(USER)).toBe(false);
    expect(state().notice).toEqual({
      kind: 'refused',
      text: 'the tool list changed since you read it, so this save was based on a version that is no longer there — reload and make the change again',
    });
    expect(state().busy).toBeNull();
    // `:` percent-encoded, which is what `keyPath` puts on the wire and what axum's wildcard decodes.
    expect(log).toEqual([
      'PATCH /tools/user%3A1a2b3c4d5e',
      'probe',
      'tools',
      'feeds',
      'inventory',
    ]);
  });

  it('re-reads on a 428 too — a client that never read the list is just as stuck', async () => {
    const { log } = fakeHouse({
      write: () => ({
        kind: 'refused',
        status: 428,
        message: 'this save did not say which version of the inventory it was based on',
      }),
    });
    expect(await state().removeItem(ITEM.id)).toBe(false);
    expect(state().notice?.kind).toBe('refused');
    expect(log).toEqual(['DELETE /inventory/9f8e7d6c5b', 'probe', 'tools', 'feeds', 'inventory']);
  });

  it('does not re-read on a refusal that is not about the version', async () => {
    // A 409 carries no claim about which version the client held, so the house did not change and
    // re-reading would be a request whose answer is already known. The distinction is the whole
    // reason the status is checked rather than the notice's kind.
    const { log } = fakeHouse({
      write: () => ({ kind: 'refused', status: 409, message: 'that key is already taken' }),
    });
    await useToolRegistryStore.getState().refresh();
    log.length = 0;

    await state().updateTool(USER);
    expect(log).toEqual(['PATCH /tools/user%3A1a2b3c4d5e']);
  });
});

describe('a write that works', () => {
  it('re-reads the house, so the panel and the pickers both see the new item', async () => {
    const { log } = fakeHouse({
      write: (setItems) => {
        setItems([ITEM]);
        return { kind: 'ok', text: '' };
      },
    });
    const ok = await state().registerItem(ITEM);

    expect(ok).toBe(true);
    expect(state().busy).toBeNull();
    expect(state().notice).toEqual({
      kind: 'ok',
      text: 'Registered 2 mm flat end — 2 cutters in the inventory.',
    });
    // The write, then the whole read chain: the house changed, so everything about it is re-asked.
    expect(log).toEqual(['POST /inventory', 'probe', 'tools', 'feeds', 'inventory']);
    expect(useToolRegistryStore.getState().items).toEqual([ITEM]);
    // And the cutter is resolvable by the key a job would name it by.
    expect(getTools().map((e) => e.key)).toContain('inv:9f8e7d6c5b');
  });

  it('sends the catalogue sync with no body and keeps its report', async () => {
    const { log } = fakeHouse({ write: () => ({ kind: 'ok', text: JSON.stringify(REPORT) }) });
    const report = await state().syncCatalogue();

    expect(report).toEqual(REPORT);
    expect(state().lastSync).toEqual(REPORT);
    expect(state().notice).toEqual({
      kind: 'ok',
      text: 'Synced 129 cutters — 2 added, 0 removed, 1 changed.',
    });
    // No body: the path to Studio's own library is the service's business, never a request's.
    expect(log[0]).toBe('POST /catalogue/sync');
  });

  it('says a sync that changed nothing is current, rather than reporting zeroes', async () => {
    const still: SyncReport = { ...REPORT, added: [], changed: [], unchanged: 129 };
    fakeHouse({ write: () => ({ kind: 'ok', text: JSON.stringify(still) }) });
    await state().syncCatalogue();
    expect(state().notice?.text).toBe('The catalogue is already current — 129 cutters, nothing changed.');
  });

  it('takes an item out of the inventory and names the row that is on screen', async () => {
    fakeHouse({
      write: (setItems) => {
        setItems([]);
        return { kind: 'ok', text: '' };
      },
    });
    // The panel is showing this item, which is where the name in the sentence comes from.
    useToolRegistryStore.setState({ items: [ITEM] });

    await state().removeItem(ITEM.id);
    expect(state().notice?.text).toBe('Removed 2 mm flat end from the inventory.');
  });

  it('sends an import verbatim, byte for byte', async () => {
    const text = '{"kind":"casemaker-house",\n  "schemaVersion": 1}';
    const { sent } = fakeHouse({ write: () => ({ kind: 'ok', text: '' }) });
    await state().importHouse(text);

    // Re-encoding it would be a chance to change the file the service is asked to accept, and the
    // service is the one that decides what the file is.
    expect(sent).toEqual([{ method: 'POST', path: '/import', body: text }]);
    expect(state().notice).toEqual({ kind: 'ok', text: 'Loaded the house file.' });
  });
});

describe('a write that does not', () => {
  it('shows the service’s own refusal, in the service’s own words, and re-reads nothing', async () => {
    const { log } = fakeHouse({
      write: () => ({
        kind: 'refused',
        status: 409,
        message: 'a key must start with user: — cat: rows are the catalogue’s',
      }),
    });
    const ok = await state().registerTool({ ...USER, key: 'cat:nope' });

    expect(ok).toBe(false);
    expect(state().notice).toEqual({
      kind: 'refused',
      text: 'a key must start with user: — cat: rows are the catalogue’s',
    });
    // Nothing about the house changed, so nothing about it is asked again.
    expect(log).toEqual(['POST /tools']);
  });

  it('reports a service that is not there without claiming the write happened', async () => {
    const { log } = fakeHouse({
      write: () => ({
        kind: 'absent',
        reason: 'the page at https://electricrv.ca answered with text/html, not the house service',
      }),
    });
    expect(await state().registerTool(USER)).toBe(false);
    expect(state().notice?.kind).toBe('error');
    expect(state().notice?.text).toContain('not the house service');
    expect(log).toEqual(['POST /tools']);
    expect(state().busy).toBeNull();
  });

  it('turns a client that throws into a notice rather than an exception', async () => {
    setHouseClientLoader(async () => {
      throw new Error('the loader itself failed');
    });
    await expect(state().updateTool(USER)).resolves.toBe(false);
    expect(state().notice).toEqual({ kind: 'error', text: 'the loader itself failed' });
  });
});

describe('one writer at a time', () => {
  it('drops a second action while the first is in flight, and says which one is running', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sent } = fakeHouse({ gate });

    const first = state().registerTool(USER);
    // The panel is waiting on a named action, which is what lets it say what it is waiting for.
    expect(state().busy).toBe('register-tool');
    // Two writers would be two requests racing for one `house.json`, so the second is dropped
    // rather than queued: the user has already been shown which one is running.
    expect(await state().registerItem(ITEM)).toBe(false);
    expect(state().busy).toBe('register-tool');
    expect(sent).toHaveLength(1);
    expect(state().notice).toBeNull();

    release!();
    expect(await first).toBe(true);
    expect(state().busy).toBeNull();
    expect(sent).toHaveLength(1);
  });
});

// #336 — `busy` used to clear before the re-read, and the validators live in the registry store
// and are only replaced BY the re-read. A click in that window sent the pre-write `If-Match`, got a
// 412, and told the user the house had "moved on" — about their own write.
describe('busy outlives the write, until the re-read lands (#336)', () => {
  it('holds the slot while the house is re-read, so a second click is dropped rather than stale', async () => {
    let release: (() => void) | null = null;
    const probeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sent } = fakeHouse({ write: () => ({ kind: 'ok', text: '' }), probeGate });
    await useToolRegistryStore.getState().refresh();

    const first = state().updateItem(ITEM);
    // The write has concluded — its sentence is up — but the re-read is held at the probe.
    await vi.waitFor(() => expect(state().notice?.kind).toBe('ok'));
    expect(state().busy).toBe('update-item');
    // This is the trap: the version held here is still the one from before the write.
    expect(useToolRegistryStore.getState().inventoryEtag).toBe('"i1"');

    // A second write in this window is dropped by the one-writer rule — not sent with that version.
    expect(await state().updateItem(ITEM)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(state().busy).toBe('update-item');

    release!();
    expect(await first).toBe(true);
    expect(state().busy).toBeNull();
    expect(sent).toHaveLength(1);
  });
});

// #328 decision 2 — the service keeps the last sync's report on `/health`, and the panel shows that
// record until a sync is clicked here. Which one to show is one rule, pinned without two stores.
describe('which last sync the panel talks about (#328)', () => {
  const served = { syncedAt: '2026-01-02T00:00:00.000Z', source: 'db', total: 120, feedRows: 0, notes: [] };

  it('is the service’s record when nothing has been synced here, and says so', () => {
    expect(lastSyncView(null, null)).toBeNull();
    expect(lastSyncView(null, served)).toEqual({ summary: served, fromHealth: true });
  });

  it('is this session’s report once a sync is clicked here', () => {
    // The common case: the sync's re-read brings the same record back on `/health`.
    expect(lastSyncView(REPORT, { ...served, syncedAt: REPORT.syncedAt })).toEqual({ summary: REPORT, fromHealth: false });
    expect(lastSyncView(REPORT, null)).toEqual({ summary: REPORT, fromHealth: false });
  });

  it('is the service’s again when it reports a sync newer than this session’s', () => {
    // Another client synced since: the house is the authority (decision 31).
    const newer = { ...served, syncedAt: '2026-01-04T00:00:00.000Z' };
    expect(lastSyncView(REPORT, newer)).toEqual({ summary: newer, fromHealth: true });
  });
});

describe('the house file', () => {
  it('saves what the service served, under the house filename', async () => {
    const created: Blob[] = [];
    const saved = URL.createObjectURL;
    const revoked = URL.revokeObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      created.push(blob);
      return 'blob:test';
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
    let download = '';
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        download = this.download;
      });

    try {
      const text = '{"kind":"casemaker-house","schemaVersion":1,"tools":[],"inventory":[]}';
      const { log } = fakeHouse({ items: [ITEM], write: () => ({ kind: 'ok', text }) });
      // The counts in the sentence are read from the registry, so the house is loaded first.
      await useToolRegistryStore.getState().refresh();
      log.length = 0;

      expect(await state().exportHouse()).toBe(true);
      expect(download).toBe(HOUSE_FILENAME);
      expect(created).toHaveLength(1);
      expect(state().notice?.text).toBe(
        'Saved house.json — 1 definition and 1 cutter in the inventory.',
      );
      // Exporting changes nothing, so it must not cost a re-read of the whole house — 1 328 rows.
      expect(log).toEqual(['GET /export']);
    } finally {
      click.mockRestore();
      URL.createObjectURL = saved;
      URL.revokeObjectURL = revoked;
    }
  });

  it('says so when the browser will not save the file, instead of claiming success', async () => {
    const saved = URL.createObjectURL;
    // The state `jsdom` is actually in: the export worked and nothing reached the user's disk.
    (URL as { createObjectURL?: unknown }).createObjectURL = undefined;
    try {
      fakeHouse({ write: () => ({ kind: 'ok', text: '{}' }) });
      expect(await state().exportHouse()).toBe(false);
      expect(state().notice?.kind).toBe('error');
      expect(state().notice?.text).toContain('would not save the file');
    } finally {
      URL.createObjectURL = saved;
    }
  });

  it('shows the service’s refusal when the import is not a house file', async () => {
    fakeHouse({
      write: () => ({ kind: 'refused', status: 400, message: 'this is a board document, not a house file' }),
    });
    expect(await state().importHouse('{"kind":"casemaker-board"}')).toBe(false);
    expect(state().notice?.text).toBe('this is a board document, not a house file');
  });
});
