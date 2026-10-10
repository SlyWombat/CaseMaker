/**
 * Writing to the house (#311, tracking #212): register, clone, edit, remove, sync, export, import.
 *
 * READS ARE NOT HERE. `store/toolRegistryStore.ts` owns what the service HAS — the tool list, the
 * feed matrix, the inventory — and every action below ends by asking it to refresh. This store owns
 * the EVENTS: one action per endpoint, the busy flag while it runs, and the sentence it produced.
 * That split is what keeps a write from being a second opinion about the state of the house.
 *
 * EVERY ACTION ENDS IN A NOTICE, THE ONES THAT WORKED INCLUDED. The panel has to be able to say
 * "Registered 2 mm flat end", "the service refused: a key must start with user:", and "nothing
 * answered at this origin" in the same slot, and it must be able to say them about an action that
 * has already finished. So the notice is state rather than a thrown error: nothing here throws to a
 * caller, and a refusal is the SERVICE'S OWN SENTENCE shown verbatim (`houseClient.ts` keeps it) —
 * a refusal re-worded in the UI is a refusal the user cannot act on.
 *
 * THE WRITE A REFUSAL DOES NOT RE-READ, AND THE ONE IT DOES. A successful write re-reads, because the
 * house changed. A refused or unanswered one leaves the house exactly as it was, so re-reading would
 * be a request whose answer is already known — and, worse, it would clear a busy flag the user is
 * watching to decide whether anything happened.
 *
 * The exception is a STALE GUARD (#321), and it is the opposite case: a 412 or a 428 means this
 * window's copy of the list is not the one being served — somebody else wrote, or this client never
 * read it — so the refused write DID change the house from this window's point of view, and the
 * version held here is now worthless. Not re-reading would leave the user retrying against the same
 * dead validator for ever, which is exactly the trap the guard exists to make visible. So the notice
 * is still the service's own sentence (a refusal, not an error) and the store re-reads behind it.
 *
 * ONE AT A TIME. `busy` is a single slot, not a set: every one of these endpoints writes the same
 * two files (`house.json`'s tools and inventory), so two in flight is two writers racing for one
 * document. The panel disables the others while one runs.
 *
 * NOT PERSISTED, for the same reason the registry is not: the house lives on the service, in its own
 * file, and a copy here would be a second source of truth for the thing #212 exists to have one of.
 * The notice is a message about a moment, and a message about last Tuesday is worse than none.
 */

import { create } from 'zustand';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import {
  houseExportHouse,
  houseImportHouse,
  houseRegisterItem,
  houseRegisterTool,
  houseRemoveItem,
  houseRemoveTool,
  houseReplaceItem,
  houseReplaceTool,
  houseSyncCatalogue,
  type HouseFailure,
  type InventoryItem,
  type SyncReport,
} from '@/platform/houseClient';
import { useToolRegistryStore } from './toolRegistryStore';

/**
 * What the house file is called when it is saved. The service sets `Content-Disposition` for its own
 * export, but a fetch's body carries no filename — this is the panel's button, not a navigation.
 *
 * NOT #247's "my machine" file (`casemaker-my-machine.json`), which is a different, wider document:
 * it carries the fixture measurements today and is the one a maintainer moves between their own two
 * Macs. This file is the house's two tiers, which is what the service serves and accepts.
 */
export const HOUSE_FILENAME = 'house.json';

/** Which action is running. Named rather than a boolean, so the panel can say what it is waiting on. */
export type HouseAction =
  | 'register-tool'
  | 'update-tool'
  | 'remove-tool'
  | 'register-item'
  | 'update-item'
  | 'remove-item'
  | 'sync'
  | 'export'
  | 'import';

export interface HouseNotice {
  kind: 'ok' | 'refused' | 'error';
  /** The sentence shown to the user. A refusal's is the service's own. */
  text: string;
}

export interface HouseState {
  /** What is running, or null. See the module doc for why this is one slot and not a set. */
  busy: HouseAction | null;
  /** What the last action said. Null before anything has been done in this session. */
  notice: HouseNotice | null;
  /** What the last catalogue sync found (#308): the counts are what the panel reports. */
  lastSync: SyncReport | null;

  /** Add a definition the house did not have — a clone, or one typed in by hand (#309). */
  registerTool: (entry: ToolLibraryEntry) => Promise<boolean>;
  /** Replace a definition in place, by key. The service refuses a body that disagrees with its URL. */
  updateTool: (entry: ToolLibraryEntry) => Promise<boolean>;
  /** Drop one of the user's own definitions. The catalogue's rows are the service's and stay. */
  removeTool: (key: string) => Promise<boolean>;
  /** Register a cutter the user physically owns (#309's third door). */
  registerItem: (item: InventoryItem) => Promise<boolean>;
  /** Change a possession: its count, its notes, the codes that identify it. */
  updateItem: (item: InventoryItem) => Promise<boolean>;
  /** Take a cutter out of the inventory. Its definition is a separate thing and survives. */
  removeItem: (id: string) => Promise<boolean>;
  /** Import Makera's catalogue from Studio's own library (#308), and keep the report. */
  syncCatalogue: () => Promise<SyncReport | null>;
  /** Save the house file. */
  exportHouse: () => Promise<boolean>;
  /** Load a house file over what the service holds. */
  importHouse: (text: string) => Promise<boolean>;
  /** Clear the notice — the panel's dismiss, and what a test's `beforeEach` wants. */
  dismissNotice: () => void;
}

/** What one action concluded, in the form the notice is built from. */
type Done =
  | { ok: true; text: string }
  | { ok: false; kind: 'refused' | 'error'; text: string; stale?: true };

/**
 * Turn a failure into a notice. `refused` is marked as such because the panel shows the service's
 * own words differently from a transport failure — the first is something the user can fix, the
 * second is something they can only report.
 *
 * A 412 or a 428 additionally marks the failure STALE (#321): the service said this save was based on
 * a version that is not the one it serves, so the caller has to re-read before it can be tried again
 * (see the module doc). Both statuses are still refusals — the sentence shown is the service's.
 */
function failed(f: HouseFailure): Done {
  const text = f.kind === 'absent' ? f.reason : f.kind === 'refused' ? f.message : f.detail;
  if (f.kind === 'refused') {
    if (f.status === 412 || f.status === 428) return { ok: false, kind: 'refused', text, stale: true };
    return { ok: false, kind: 'refused', text };
  }
  return { ok: false, kind: 'error', text };
}

/** `1 definition` / `2 definitions`, because a count that reads wrong is a count nobody trusts. */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Hand a file to the user. Returns the reason it could not be saved, or null when it was.
 *
 * The guard is not theoretical: `URL.createObjectURL` does not exist in every environment this code
 * is rendered in (a test's jsdom among them), and a download that silently did nothing is exactly
 * the failure the user would have no way to notice.
 */
function saveText(text: string, filename: string): string | null {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return 'this browser would not save the file — the export itself worked, so nothing is lost by trying again from a browser window';
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export const useHouseStore = create<HouseState>((set, get) => {
  /**
   * One write: say it is running, do it, say what happened, and re-read when the house changed.
   * Every action below is a request plus a sentence, so this is the only place a status is decided.
   */
  async function attempt(
    action: HouseAction,
    work: () => Promise<Done>,
    opts: { reRead?: boolean; onOk?: () => void } = {},
  ): Promise<boolean> {
    // One writer at a time (see the module doc). A second click while the first is in flight is
    // dropped rather than queued: the user has been shown which one is running.
    if (get().busy !== null) return false;
    set({ busy: action, notice: null });
    try {
      const done = await work();
      if (done.ok) {
        opts.onOk?.();
        set({ busy: null, notice: { kind: 'ok', text: done.text } });
        if (opts.reRead !== false) await useToolRegistryStore.getState().refresh();
      } else {
        // The house did not change, so there is nothing to re-read — except when the refusal was a
        // STALE GUARD, which is the service saying it has moved on without us (#321). That case is
        // the one where the version held here is now worthless, so the re-read is what makes the
        // user's next attempt able to succeed.
        set({ busy: null, notice: { kind: done.kind, text: done.text } });
        if (done.stale) await useToolRegistryStore.getState().refresh();
      }
      return done.ok;
    } catch (e) {
      set({ busy: null, notice: { kind: 'error', text: e instanceof Error ? e.message : String(e) } });
      return false;
    }
  }

  return {
    busy: null,
    notice: null,
    lastSync: null,

    registerTool: (entry) =>
      attempt('register-tool', async () => {
        const res = await houseRegisterTool(entry);
        return res.kind === 'ok' ? { ok: true, text: `Registered ${entry.tool.name}.` } : failed(res);
      }),

    updateTool: (entry) =>
      attempt('update-tool', async () => {
        // The version this client last read (#321), read AT THE MOMENT OF THE WRITE rather than
        // captured when the edit began: a refresh that landed while the user was typing is exactly
        // the case the guard is for, and a stale validator would announce a conflict that is not one.
        const res = await houseReplaceTool(entry, useToolRegistryStore.getState().etag);
        return res.kind === 'ok' ? { ok: true, text: `Saved ${entry.tool.name}.` } : failed(res);
      }),

    removeTool: (key) =>
      attempt('remove-tool', async () => {
        const res = await houseRemoveTool(key, useToolRegistryStore.getState().etag);
        return res.kind === 'ok' ? { ok: true, text: `Removed ${key}.` } : failed(res);
      }),

    registerItem: (item) =>
      attempt('register-item', async () => {
        const res = await houseRegisterItem(item);
        return res.kind === 'ok'
          ? { ok: true, text: `Registered ${item.tool.name} — ${plural(item.quantity, 'cutter', 'cutters')} in the inventory.` }
          : failed(res);
      }),

    updateItem: (item) =>
      attempt('update-item', async () => {
        // The INVENTORY's validator, not the tool list's (#321): a re-measured definition must not
        // make a count edit look like a conflict, and the service guards the two documents apart.
        const res = await houseReplaceItem(item, useToolRegistryStore.getState().inventoryEtag);
        return res.kind === 'ok'
          ? { ok: true, text: `Saved ${item.tool.name} — ${plural(item.quantity, 'cutter', 'cutters')} in the inventory.` }
          : failed(res);
      }),

    removeItem: (id) => {
      // Named from the list the panel is showing, so the notice reads as the row the user clicked.
      // The item may not be there (a stale click) and the sentence falls back to the id rather than
      // guessing a name that was never on screen.
      const item = useToolRegistryStore.getState().items.find((i) => i.id === id);
      return attempt('remove-item', async () => {
        const res = await houseRemoveItem(id, useToolRegistryStore.getState().inventoryEtag);
        return res.kind === 'ok'
          ? { ok: true, text: `Removed ${item ? item.tool.name : id} from the inventory.` }
          : failed(res);
      });
    },

    syncCatalogue: async () => {
      let report: SyncReport | null = null;
      await attempt(
        'sync',
        async () => {
          const res = await houseSyncCatalogue();
          if (res.kind !== 'ok') return failed(res);
          report = res.report;
          // "Nothing changed" and "eleven cutters changed" are both results worth reading, so the
          // report is kept and the sentence states the counts rather than only the outcome.
          const moved =
            res.report.added.length + res.report.removed.length + res.report.changed.length;
          return {
            ok: true,
            text:
              moved === 0
                ? `The catalogue is already current — ${plural(res.report.total, 'cutter', 'cutters')}, nothing changed.`
                : `Synced ${plural(res.report.total, 'cutter', 'cutters')} — ${res.report.added.length} added, ${res.report.removed.length} removed, ${res.report.changed.length} changed.`,
          };
        },
        { onOk: () => set({ lastSync: report }) },
      );
      return report;
    },

    exportHouse: () =>
      attempt(
        'export',
        async () => {
          const res = await houseExportHouse();
          if (res.kind !== 'ok') return failed(res);
          const why = saveText(res.text, HOUSE_FILENAME);
          if (why !== null) return { ok: false, kind: 'error', text: why };
          const { entries, items } = useToolRegistryStore.getState();
          return {
            ok: true,
            text: `Saved ${HOUSE_FILENAME} — ${plural(entries.length, 'definition', 'definitions')} and ${plural(items.length, 'cutter', 'cutters')} in the inventory.`,
          };
        },
        // Nothing about the house changed by saving it, so there is nothing to re-read. The feeds
        // and the feeds' 1 328 rows are exactly why this is worth not doing.
        { reRead: false },
      ),

    importHouse: (text) =>
      attempt('import', async () => {
        const res = await houseImportHouse(text);
        return res.kind === 'ok'
          ? { ok: true, text: 'Loaded the house file.' }
          : failed(res);
      }),

    dismissNotice: () => set({ notice: null }),
  };
});

/** Test seam: forget the last action's result without touching the registry. */
export function resetHouseStore(): void {
  useHouseStore.setState({ busy: null, notice: null, lastSync: null });
}
