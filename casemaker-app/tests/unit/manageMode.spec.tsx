// @vitest-environment jsdom
// Issue #311 (tracking #212) — the Manage surface: the house's tools and the machines, reached from
// the toolbar with no project open.
//
// THE CLIENT IS THE SEAM. `setHouseClientLoader` swaps the whole house service for a fake, so the
// real `toolRegistryStore` runs its real probe → read → `setRegistry` chain and the panel is drawn
// from the real registry. Nothing here stands in for the app's own orchestration.
//
// WHAT THIS PINS THAT THE BROWSER QA CANNOT. The browser run proves the mode appears and its panels
// answer a served house; it is a few seconds per assertion and it is a long way from the rule. These
// are the rules: the tiers off the KEY NAMESPACE, the grouping (a shipped assumption must never read
// as a cutter the user owns), the `—` for a dimension no source stated, and the close relationship
// between a possession and the definition it was registered from.

import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppShell } from '@/components/layout/AppShell';
import { Toolbar } from '@/components/layout/Toolbar';
import { ManageMode } from '@/components/manage/ManageMode';
import { TOOL_LIBRARY, type ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { resetRegistry } from '@/engine/cnc/toolRegistry';
import { useManageModeStore, resetManageMode } from '@/store/manageModeStore';
import { resetHouseStore } from '@/store/houseStore';
import { useMachineStore, resetMachineStore } from '@/store/machineStore';
import { useProjectStore } from '@/store/projectStore';
import { useToolRegistryStore } from '@/store/toolRegistryStore';
import {
  setHouseClientLoader,
  HOUSE_SCHEMA_VERSION,
  type HouseCall,
  type HouseClient,
  type HouseHealth,
  type HouseProbe,
  type HouseTools,
  type InventoryItem,
} from '@/platform/houseClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HEALTH: HouseHealth = {
  ok: true,
  schemaVersion: HOUSE_SCHEMA_VERSION,
  hasCatalogue: true,
  feedRows: 0,
  catalogueSyncedAt: '2026-10-08T09:30:00.000Z',
  problems: [],
};

/** One of the user's own definitions — the Yours tier, by key namespace. */
const USER: ToolLibraryEntry = {
  key: 'user:1a2b3c4d5e',
  provenance: 'cloned from Makera catalogue “3.175 mm flat end” on 2026-10-08',
  tool: {
    number: null,
    id: null,
    name: '2 mm flat end',
    typeText: 'Flat End',
    shape: 'flat',
    handleDiameter: 3.175,
    tipDiameter: 2,
    diameter: 2,
    cornerRadius: 0,
    angle: null,
    halfAngle: null,
    fluteLength: 12,
    // Deliberately unstated (#314): the panel has to print `—`, never 0.
    shoulderLength: null,
    stickout: null,
    centreCutting: null,
  },
};

/** One catalogue row — Makera's, not the user's, and read-only here. */
const CAT: ToolLibraryEntry = {
  key: 'cat:112111313812',
  provenance: 'from Makera Studio’s library on this PC',
  tool: { ...USER.tool, id: '112111313812', name: '3.175*12mm Flat End(Metal)', typeText: 'Flat End' },
};

/** One cutter the user physically owns (#309) — a possession, with a count and a code. */
const ITEM: InventoryItem = {
  id: '9f8e7d6c5b',
  tool: { ...USER.tool, name: '2 mm flat end' },
  origin: { id: '112111313812', syncedAt: '2026-10-08T09:30:00.000Z' },
  quantity: 2,
  codes: [{ symbology: 'qr', value: 'C1-BIT-FLAT-2-0' }],
  addedAt: '2026-10-08T10:00:00.000Z',
  notes: 'drawer 3',
};

/** A fake that answers like a service holding one of each tier. */
function fakeClient(opts: { probe: HouseProbe; call?: HouseClient['call'] }): HouseClient {
  return {
    probe: async () => opts.probe,
    tools: async (): Promise<HouseTools> => ({ kind: 'ok', etag: '"e1"', entries: [USER, CAT] }),
    feeds: async () => ({ kind: 'ok', etag: '"f1"', rows: [] }),
    inventory: async () => ({ kind: 'ok', etag: '"i1"', items: [ITEM] }),
    call: async (method, path, body): Promise<HouseCall> =>
      opts.call ? opts.call(method, path, body) : { kind: 'ok', text: '' },
  };
}

/** Point the store at a service that answers. Awaits the real refresh chain. */
async function goOnline(): Promise<void> {
  setHouseClientLoader(async () => fakeClient({ probe: { kind: 'present', health: HEALTH, base: '' } }));
  await useToolRegistryStore.getState().refresh();
}

/** Point the store at an origin with no service, and let it conclude that. */
async function goAbsent(reason = 'the page at http://localhost answered with text/html, not the house service') {
  setHouseClientLoader(async () => fakeClient({ probe: { kind: 'absent', reason } }));
  await useToolRegistryStore.getState().refresh();
}

beforeEach(() => {
  cleanup();
  resetRegistry();
  useToolRegistryStore.getState().reset();
  resetHouseStore();
  resetManageMode();
  resetMachineStore();
  setHouseClientLoader(null);
  useProjectStore.setState({ welcomeMode: false });
});

const q = (id: string) => screen.queryByTestId(id);
const groupIds = () =>
  screen.getAllByTestId(/^manage-group-/).map((el) => el.getAttribute('data-testid')!.replace('manage-group-', ''));

describe('#311 — how the mode is entered', () => {
  it('the toolbar carries the Manage toggle, and it is a toggle', () => {
    render(<Toolbar />);
    const btn = screen.getByTestId('manage-open');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(useManageModeStore.getState().open).toBe(true);
    expect(screen.getByTestId('manage-open').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('manage-open'));
    expect(useManageModeStore.getState().open).toBe(false);
  });

  it('the compact bar keeps it behind the ⋯ menu, beside New', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 390 });
    render(<Toolbar />);
    expect(q('manage-open')).toBeNull();
    fireEvent.click(screen.getByTestId('toolbar-overflow-toggle'));
    expect(q('manage-open')).not.toBeNull();
  });

  it('the mode takes the whole main area, even over the welcome overlay', () => {
    // Welcome mode is the state it has to be reachable FROM — this is the no-project case the
    // surface exists for, and `welcomeMode` is what makes that state testable without a rebuild.
    useProjectStore.setState({ welcomeMode: true });
    useManageModeStore.getState().openManage();
    render(<AppShell />);
    expect(q('manage-mode')).not.toBeNull();
    expect(q('welcome-search')).toBeNull();
    // The project rail is project UI and has nothing to say about a house.
    expect(q('sidebar-button-board')).toBeNull();
    expect(q('status-bar-manage')).not.toBeNull();
  });

  it('leaving the mode leaves the project exactly as it was', () => {
    useProjectStore.setState({ welcomeMode: true });
    useManageModeStore.getState().openManage();
    const before = useProjectStore.getState().project;
    useManageModeStore.getState().closeManage();
    expect(useProjectStore.getState().project).toBe(before);
    expect(useProjectStore.getState().welcomeMode).toBe(true);
  });
});

describe('#311 — the tool list, grouped by tier', () => {
  beforeEach(async () => {
    await goOnline();
    useManageModeStore.getState().openManage();
  });

  it('draws one group per tier that has rows, in the tier order', () => {
    render(<ManageMode />);
    expect(groupIds()).toEqual(['owned', 'yours', 'catalogue', 'builtin']);
    // The counts line and the table read the same list, so they cannot disagree.
    const counts = screen.getByTestId('manage-counts').textContent ?? '';
    expect(counts).toContain(`${TOOL_LIBRARY.length + 3} definitions`);
    expect(counts).toContain('1 owned');
    expect(counts).toContain('1 yours');
    expect(counts).toContain('1 catalogue');
    expect(counts).toContain(`${TOOL_LIBRARY.length} built-in`);
  });

  it('a dimension no source stated is `—`, never 0', () => {
    render(<ManageMode />);
    const row = screen.getByTestId('manage-tools-row-user:1a2b3c4d5e');
    const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent ?? '');
    // tip ⌀ 2, shank 3.175, flute 12, shoulder unstated, stick-out unstated, qty not applicable.
    expect(cells[2]).toBe('2.0');
    expect(cells[3]).toBe('3.175');
    expect(cells[4]).toBe('12.0');
    expect(cells[5]).toBe('—');
    expect(cells[6]).toBe('—');
    expect(cells[7]).toBe('·');
  });

  it('search narrows the list, and says so when nothing matches', () => {
    render(<ManageMode />);
    fireEvent.change(screen.getByTestId('manage-search'), { target: { value: 'ball' } });
    expect(q('manage-no-matches')).not.toBeNull();
    fireEvent.change(screen.getByTestId('manage-search'), { target: { value: 'C1-BIT-FLAT-2-0' } });
    // Found by the CODE on the box, which lives on the possession and not on the definition.
    expect(q('manage-tools-row-inv:9f8e7d6c5b')).not.toBeNull();
    expect(groupIds()).toEqual(['owned']);
  });

  it('a tier chip filters to that tier alone', () => {
    render(<ManageMode />);
    fireEvent.click(screen.getByTestId('manage-chip-yours'));
    expect(groupIds()).toEqual(['yours']);
    expect(screen.getByTestId('manage-chip-yours').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('#311 — the detail rail', () => {
  beforeEach(async () => {
    await goOnline();
    useManageModeStore.getState().openManage();
  });

  it('selecting a row shows the definition, unknowns named', () => {
    render(<ManageMode />);
    expect(q('manage-detail-empty')).not.toBeNull();
    fireEvent.click(screen.getByTestId('manage-tools-row-user:1a2b3c4d5e'));
    const rail = screen.getByTestId('manage-detail');
    expect(rail.textContent).toContain('2 mm flat end');
    // A null shoulder is not a missing row: it is the depth the cutter cannot be proven to support.
    expect(rail.textContent).toContain('the depth it supports (#314)');
    expect(rail.textContent).toContain('unset; the machine probes the tip');
    // The only write a catalogue row offers is a clone.
    expect(q('manage-clone-here')).not.toBeNull();
  });

  it('an owned row shows the possession as well as the definition', () => {
    render(<ManageMode />);
    fireEvent.click(screen.getByTestId('manage-tools-row-inv:9f8e7d6c5b'));
    const rail = screen.getByTestId('manage-detail');
    expect(rail.textContent).toContain('owned · ×2');
    expect(rail.textContent).toContain('C1-BIT-FLAT-2-0');
    expect((screen.getByTestId('manage-item-quantity') as HTMLInputElement).value).toBe('2');
    // The catalogue row it was registered from is named by its own id, not by the key.
    expect(rail.textContent).toContain('112111313812');
  });
});

// #331 — the quantity rule is written once. The editor used to re-derive it (`Number('')` is 0, so
// blank was refused) and spell the sentence again in its own capitalisation. Both ends now answer
// to `registerCutter.ts`: blank means one, and the refusal is that module's wording.
describe('#331 — the inventory editor answers to the shared count rule', () => {
  /** The service's writes, as the fake saw them: `[method, path, body]`. */
  let calls: Array<{ method: string; path: string; body: unknown }>;

  beforeEach(async () => {
    calls = [];
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: HEALTH, base: '' },
        call: async (method, path, body) => {
          calls.push({ method, path, body });
          return { kind: 'ok', text: '' };
        },
      }),
    );
    await useToolRegistryStore.getState().refresh();
    useManageModeStore.getState().openManage();
  });

  /** The editor for the one owned cutter, with `text` in its quantity box. */
  function openEditor(text: string): HTMLInputElement {
    render(<ManageMode />);
    fireEvent.click(screen.getByTestId('manage-tools-row-inv:9f8e7d6c5b'));
    const field = screen.getByTestId('manage-item-quantity') as HTMLInputElement;
    fireEvent.change(field, { target: { value: text } });
    return field;
  }

  it('saves one for a cleared box, the same answer the register doors give', async () => {
    const field = openEditor('');
    // Visible, not silent: the field says which count a blank will send.
    expect(field.placeholder).toBe('1');
    fireEvent.click(screen.getByTestId('manage-item-save'));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.path).toBe('/inventory/9f8e7d6c5b');
    expect((calls[0]!.body as InventoryItem).quantity).toBe(1);
  });

  it('refuses zero and a fraction, in the one sentence', () => {
    openEditor('0');
    const save = screen.getByTestId('manage-item-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    // The wording is `quantityProblem`'s, not a second copy of it: one string in the source, and the
    // issue's own grep for it (`grep -rn "whole number of cutters" src`) finds exactly one file.
    expect(save.title).toContain('a quantity is a whole number of cutters, one or more');

    fireEvent.change(screen.getByTestId('manage-item-quantity'), { target: { value: '1.5' } });
    expect((screen.getByTestId('manage-item-save') as HTMLButtonElement).disabled).toBe(true);
    // And with a count the schema would accept, the tooltip stops being a complaint.
    fireEvent.change(screen.getByTestId('manage-item-quantity'), { target: { value: '3' } });
    const ok = screen.getByTestId('manage-item-save') as HTMLButtonElement;
    expect(ok.disabled).toBe(false);
    expect(ok.title).toBe('Save the count and the notes');
  });
});

describe('#311 — cloning a catalogue row', () => {
  /** The service's writes, as the fake saw them: `[method, path, body]`. */
  let calls: Array<{ method: string; path: string; body: unknown }>;

  beforeEach(async () => {
    calls = [];
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: HEALTH, base: '' },
        call: async (method, path, body) => {
          calls.push({ method, path, body });
          return { kind: 'ok', text: '' };
        },
      }),
    );
    await useToolRegistryStore.getState().refresh();
    useManageModeStore.getState().openManage();
  });

  it('is a new `user:` row that does not inherit Makera’s id or cutter number', async () => {
    render(<ManageMode />);
    fireEvent.click(screen.getByTestId(`manage-tools-row-${CAT.key}`));
    fireEvent.click(screen.getByTestId('manage-clone-here'));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/tools');
    const clone = calls[0]!.body as ToolLibraryEntry;

    // A separate definition the catalogue does not own, keyed by the client.
    expect(clone.key.startsWith('user:')).toBe(true);
    expect(clone.key).not.toBe(CAT.key);
    // The `.nc` header writes `Tool.id` and `simSetupStore.matchRegistryTool` matches a header back
    // id-FIRST, so a clone that kept the vendor id would reopen as the row it was cloned from —
    // an edited cutter reading as the unedited original (#212's "Do not let a clone inherit the
    // vendor id"). A user definition has no vendor id and no vendor cutter number: null is the
    // honest value rather than a borrowed one.
    expect(clone.tool.id).toBeNull();
    expect(clone.tool.number).toBeNull();
    // Everything the source DID state is copied, so the clone is not an invention.
    expect(clone.tool.name).toBe(CAT.tool.name);
    expect(clone.tool.tipDiameter).toBe(CAT.tool.tipDiameter);
    expect(clone.provenance).toContain('Makera catalogue');
  });
});

// #328 — the sync's own notes were stored and never shown, so a sync that replaced an unreadable
// catalogue file, dropped feed rows whose cells Studio left empty, or emptied the feed matrix looked
// exactly like a clean one. The fixture below is a hand-built report in the SERVICE's shape; the
// strings are the kind of sentence `SyncReportSchema.notes` carries, not vendor data.
describe('#328 — a sync’s notes reach the screen', () => {
  const REPORT = (notes: string[]): string =>
    JSON.stringify({
      source: 'C:\\Users\\Someone\\AppData\\Roaming\\MakeraStudio\\makera_library.db',
      syncedAt: '2026-10-09T14:02:57.269Z',
      total: 129,
      added: [],
      removed: [],
      changed: [],
      unchanged: 129,
      feedRows: 1328,
      notes,
    });

  /** A service whose sync answers with these notes, wired BEFORE the refresh that reads it. */
  async function goOnlineWithSync(notes: string[]): Promise<void> {
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: HEALTH, base: '' },
        call: async (method, path): Promise<HouseCall> =>
          method === 'POST' && path === '/catalogue/sync' ? { kind: 'ok', text: REPORT(notes) } : { kind: 'ok', text: '' },
      }),
    );
    await useToolRegistryStore.getState().refresh();
  }

  it('lists every note under the counts, and keeps them when the notice is dismissed', async () => {
    const notes = [
      'makera_library.db could not be read: the catalogue file was replaced with an empty one',
      '40 feed rows were dropped: their numbers were empty',
    ];
    await goOnlineWithSync(notes);
    useManageModeStore.getState().openManage();
    render(<ManageMode />);

    // Before any sync there is nothing to show: these are the LAST sync's notes, not a standing box.
    expect(q('manage-sync-notes')).toBeNull();

    fireEvent.click(screen.getByTestId('manage-sync'));
    await waitFor(() => expect(q('manage-sync-notes')).not.toBeNull());

    expect(screen.getByTestId('manage-sync-notes').getAttribute('data-count')).toBe('2');
    expect(screen.getByTestId('manage-sync-note-0').textContent).toContain('could not be read');
    expect(screen.getByTestId('manage-sync-note-1').textContent).toContain('40 feed rows were dropped');
    // The counts sentence is the notice, and it never carried these.
    expect(screen.getByTestId('manage-notice').textContent).toContain('129 cutters');

    // Dismissing the notice must not take the record of what the sync did with it.
    fireEvent.click(screen.getByTestId('manage-notice-dismiss'));
    expect(q('manage-notice')).toBeNull();
    expect(q('manage-sync-notes')).not.toBeNull();
    expect(screen.getByTestId('manage-sync-note-1').textContent).toContain('40 feed rows were dropped');
  });

  it('shows nothing at all when the sync had nothing to add', async () => {
    await goOnlineWithSync([]);
    useManageModeStore.getState().openManage();
    render(<ManageMode />);

    fireEvent.click(screen.getByTestId('manage-sync'));
    await waitFor(() => expect(q('manage-notice')).not.toBeNull());
    expect(screen.getByTestId('manage-notice').textContent).toContain('nothing changed');
    expect(q('manage-sync-notes')).toBeNull();
  });
});

describe('#309 — the register frame and its three doors', () => {
  /** The service's writes, as the fake saw them: `[method, path, body]`. */
  let calls: Array<{ method: string; path: string; body: unknown }>;

  beforeEach(async () => {
    calls = [];
    setHouseClientLoader(async () =>
      fakeClient({
        probe: { kind: 'present', health: HEALTH, base: '' },
        call: async (method, path, body) => {
          calls.push({ method, path, body });
          return { kind: 'ok', text: '' };
        },
      }),
    );
    await useToolRegistryStore.getState().refresh();
    useManageModeStore.getState().openManage();
  });

  /** Register from the rail, and open a door. */
  function openRegister(door: 'scan' | 'catalogue' | 'type' = 'scan') {
    render(<ManageMode />);
    fireEvent.click(screen.getByTestId('manage-register-open'));
    if (door !== 'scan') fireEvent.click(screen.getByTestId(`manage-door-${door}`));
  }

  /** Type a code and press the scanner's Enter. */
  function scan(value: string) {
    const field = screen.getByTestId('manage-scan-code');
    fireEvent.change(field, { target: { value } });
    fireEvent.keyDown(field, { key: 'Enter' });
  }

  it('Register replaces the rail with the three doors, Scan drawn first', () => {
    openRegister();
    expect(q('manage-register')).not.toBeNull();
    expect(q('manage-detail')).toBeNull();
    for (const door of ['scan', 'catalogue', 'type']) {
      expect(q(`manage-door-${door}`), door).not.toBeNull();
    }
    // Scan is the default and its field is what a scanner types into.
    expect(q('manage-scan-code')).not.toBeNull();
  });

  it('there is no camera button where the browser has no BarcodeDetector', () => {
    // jsdom has none, which is also every browser that would refuse it — the camera is an
    // ADDITION, never the only way in (#309).
    openRegister();
    expect(q('manage-scan-camera')).toBeNull();
    expect('BarcodeDetector' in window).toBe(false);
  });

  it('a code that is on a cutter already owned offers a count, not a second row', async () => {
    openRegister();
    scan(ITEM.codes[0]!.value);
    const sentence = screen.getByTestId('manage-scan-owned');
    expect(sentence.textContent).toContain('2 mm flat end');
    expect(sentence.textContent).toContain('2 on record');

    fireEvent.click(screen.getByTestId('manage-scan-plus-one'));
    await waitFor(() => expect(calls).toHaveLength(1));
    // An UPDATE of the possession it already is: same id, one more box.
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.path).toBe(`/inventory/${ITEM.id}`);
    expect((calls[0]!.body as InventoryItem).quantity).toBe(3);
    expect((calls[0]!.body as InventoryItem).id).toBe(ITEM.id);

    // The frame survives its own write. Every write ends in a re-read, and a re-read used to put the
    // store back into `checking`, which `ToolsScope` answers with a DIFFERENT branch — unmounting
    // the rail and taking the half-typed scan with it. The browser QA found it; this pins it.
    expect(q('manage-register')).not.toBeNull();
    expect((screen.getByTestId('manage-scan-code') as HTMLInputElement).value).toBe(ITEM.codes[0]!.value);
  });

  it('Enter on a code no row fits reads it back and offers the other two doors', () => {
    openRegister();
    scan('C1-BIT-BALL-NOSE-1-4');
    const unknown = screen.getByTestId('manage-scan-unknown');
    // The provisional reading is drawn, so the user can check it against the box in their hand.
    expect(unknown.textContent).toContain('ball nose');
    expect(unknown.textContent).toContain('1.0 mm tip');
    fireEvent.click(screen.getByTestId('manage-scan-to-type'));
    expect(q('manage-type-name')).not.toBeNull();
  });

  it('a code that fits a catalogue row registers an owned copy against that row', async () => {
    openRegister();
    scan('C1-BIT-FLAT-2-12');
    const reading = screen.getByTestId('manage-scan-reading');
    expect(reading.textContent).toContain('1 row fit');

    fireEvent.click(screen.getByTestId(`manage-scan-candidate-${CAT.key}`));
    fireEvent.change(screen.getByTestId('manage-scan-quantity'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('manage-scan-register'));
    await waitFor(() => expect(calls).toHaveLength(1));

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/inventory');
    const sent = calls[0]!.body as InventoryItem;
    expect(sent.quantity).toBe(2);
    // The definition stays Makera's — same id as the row — but `origin` names the ROW it came from.
    expect(sent.tool.id).toBe(CAT.tool.id);
    expect(sent.origin).toEqual({ id: '112111313812', syncedAt: HEALTH.catalogueSyncedAt });
    // The code is kept with the symbology the field implies: typed, not decoded from a QR.
    expect(sent.codes).toEqual([{ symbology: 'text', value: 'C1-BIT-FLAT-2-12' }]);
  });

  it('a quantity the service would refuse cannot be sent', () => {
    openRegister();
    scan('C1-BIT-FLAT-2-12');
    fireEvent.click(screen.getByTestId(`manage-scan-candidate-${CAT.key}`));
    const register = screen.getByTestId('manage-scan-register') as HTMLButtonElement;
    expect(register.disabled).toBe(false);
    fireEvent.change(screen.getByTestId('manage-scan-quantity'), { target: { value: '0' } });
    expect(register.disabled).toBe(true);
  });

  it('the Catalogue door searches the synced rows and registers against one', async () => {
    openRegister('catalogue');
    const rows = () => screen.queryAllByTestId(/^manage-catalogue-row-/);
    expect(rows()).toHaveLength(1);

    // A word that is in the row, and one that is not: the AND over words is `toolTiers`' own.
    fireEvent.change(screen.getByTestId('manage-catalogue-search'), { target: { value: 'flat' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(screen.getByTestId('manage-catalogue-search'), { target: { value: 'ball' } });
    expect(q('manage-catalogue-nomatch')).not.toBeNull();

    fireEvent.change(screen.getByTestId('manage-catalogue-search'), { target: { value: 'metal' } });
    fireEvent.click(screen.getByTestId(`manage-catalogue-row-${CAT.key}`));
    fireEvent.click(screen.getByTestId('manage-catalogue-register'));
    await waitFor(() => expect(calls).toHaveLength(1));
    const sent = calls[0]!.body as InventoryItem;
    // Picked out of a list, not scanned: there is no code to record.
    expect(sent.codes).toEqual([]);
    expect(sent.origin?.id).toBe('112111313812');
  });

  it('the Type door refuses a nameless cutter and writes nulls for the blanks', async () => {
    openRegister('type');
    const submit = screen.getByTestId('manage-type-register') as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // a cutter needs a name

    fireEvent.change(screen.getByTestId('manage-type-name'), { target: { value: 'drawer 3 ball' } });
    fireEvent.change(screen.getByTestId('manage-type-shape'), { target: { value: 'ball' } });
    fireEvent.change(screen.getByTestId('manage-type-tip'), { target: { value: '1' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(calls).toHaveLength(1));

    const sent = calls[0]!.body as InventoryItem;
    expect(sent.tool.name).toBe('drawer 3 ball');
    expect(sent.tool.shape).toBe('ball');
    expect(sent.tool.tipDiameter).toBe(1);
    // Blank is UNKNOWN, never 0 — the shank, the flute and the shoulder were all left alone.
    expect(sent.tool.handleDiameter).toBeNull();
    expect(sent.tool.fluteLength).toBeNull();
    expect(sent.tool.shoulderLength).toBeNull();
    // No Makera row and no catalogue behind it.
    expect(sent.tool.id).toBeNull();
    expect(sent.tool.number).toBeNull();
    expect(sent.origin).toBeNull();
  });
});

describe('#311 — no service at this origin', () => {
  it('the card carries the probe’s own sentence, and the built-ins are drawn beside it', async () => {
    const reason = 'the page at http://localhost:5199 answered with text/html, not the house service';
    await goAbsent(reason);
    useManageModeStore.getState().openManage();
    render(<ManageMode />);

    expect(q('manage-absent')).not.toBeNull();
    // Verbatim: a re-worded reason is a second opinion about why a socket did not answer.
    expect(screen.getByTestId('manage-absent-reason').textContent).toBe(reason);
    // The loudest sentence on the card is checkable right there.
    const aside = screen.getByTestId('manage-builtins-aside');
    expect(aside.textContent).toContain(TOOL_LIBRARY[0]!.tool.name);
    expect(aside.textContent).toContain('assumption');
  });
});

describe('#311 — the machines scope', () => {
  it('with nothing checked, says so rather than showing an empty card', async () => {
    await goAbsent();
    useManageModeStore.getState().openManage('machines');
    render(<ManageMode />);
    expect(q('manage-machine-none')).not.toBeNull();
    expect(q('manage-machine-card')).toBeNull();
    // The "my machine" file (#247) is a fact about the setup, so an empty pane offers it too.
    expect(q('manage-machine-export')).not.toBeNull();
  });

  it('a machine that answered is shown as the moment it answered, with the profile behind it', async () => {
    await goOnline();
    useMachineStore.setState({
      machine: {
        name: 'Z1',
        host: '192.168.10.43',
        port: 2222,
        busy: false,
        ip: '192.168.10.43',
        mac: 'AA:BB:CC:DD:EE:FF',
        status: '<Idle|MPos:0.000,0.000,0.000|Bf:14,128>',
        profileId: 'Z1',
        observedAt: '2026-10-09T06:00:00.000Z',
        notes: [],
      },
      outcome: 'found',
      reason: null,
      checkedAt: '2026-10-09T06:00:00.000Z',
    });
    useManageModeStore.getState().openManage('machines');
    render(<ManageMode />);

    const card = screen.getByTestId('manage-machine-card');
    // The status line verbatim, and the state word from the one parser that exists for it. The
    // vendor's own `T:1,-9.751,1` tool-offset field is NOT read here — no source states its units.
    expect(card.textContent).toContain('<Idle|MPos:0.000,0.000,0.000|Bf:14,128>');
    expect(card.textContent).toContain('Idle');
    expect(card.textContent).toContain('192.168.10.43');
    // The profile's standing numbers are every machine-dependent figure a `.nc` is verified against.
    expect(card.textContent).toContain('work envelope');
    expect(screen.getByTestId('manage-machine-detail').textContent).toContain('Tool-length probe');
  });
});
