/**
 * The house's tool tiers, in the app (#306, tracking #212).
 *
 * The registry itself is not a store: `engine/cnc/toolRegistry.ts` is one small module whose
 * snapshot every picker and every worker already resolves through (#305). This store is the only
 * thing that ASKS for the tiers above the built-ins and hands them over — one probe at start-up,
 * one `setRegistry`, and the pickers re-render (`useToolRegistry`).
 *
 * WHY THE TWO CALLS AND NOT ONE. If a health probe is the same request as the tool list, then an
 * HTML 200 from a static host and an empty list from a real service are the same answer — and one
 * of them is "the service is not here" while the other is "the service is here and you own no
 * extra cutters". They are two different facts about the world, so they are two requests.
 *
 * THE FEED CATALOGUE IS A THIRD REQUEST AND A SECOND SNAPSHOT (#310). `GET /api/v1/feeds` is read
 * only AFTER the tool list, and its rows go straight into `engine/cnc/feeds.ts`'s snapshot rather
 * than being held here — the matrix is read by `feedsFor`, not rendered, so what this store keeps is
 * the count. The order is not cosmetic: catalogue rows are keyed by cutter id, and without the
 * cutters they name not one of them is reachable. Its failure is reported separately from `error`,
 * because a cutter list with no starting numbers is a perfectly usable house.
 *
 * THE INVENTORY IS A THIRD REQUEST AND A THIRD SNAPSHOT (#309). `GET /api/v1/inventory` is the
 * cutters the user physically owns, and it is a different document from the tool list for a reason
 * that shows in the UI: a definition has a shape and a tip, a possession has a count and codes. So
 * the items are kept HERE (`items`) while the `inv:` entries derived from them are pushed into the
 * registry the pickers read — the same split the feeds use, where the matrix itself lives in the
 * engine and the store keeps its count. A failed inventory read is reported as `inventoryError`,
 * for the same reason `feedError` exists: a house whose cutters read fine but whose inventory did
 * not is a usable house with a gap.
 *
 * READS HERE, WRITES NEXT DOOR. Registering, cloning, syncing, importing and exporting live in
 * `store/houseStore.ts` (#311): they are events with a result to report, not state to hold, and
 * every one of them ends by asking this store to refresh. This store's job stays what it was —
 * ask the service what it has, and put the answer where the rest of the app can see it.
 *
 * THE THREE STATES, AND WHAT THEY MEAN. `present` is "the registry came from a house service";
 * `absent` is every outcome that is not a service — a web deployment, whose own origin has none; a
 * static host answering 404; a page answering instead of JSON — and `error` is a service this build
 * cannot use (another schema version, a payload that fails the schema, a dead socket). Both carry a
 * sentence saying which, so nothing here has to be inferred from a status code.
 * `status` is deliberately about the SOURCE, not about the answer: a service holding zero cutters is
 * `present` with an empty `entries`, and any UI that needs to say "N cutters from this machine"
 * reads `entries.length` rather than inferring it from the status.
 *
 * IT NEVER BLOCKS AND NEVER THROWS. A job can be authored, verified and simulated with no service
 * at all — that is what the built-in tier is for — so an absent service costs the user nothing but
 * the cutters they defined, and a refresh that fails leaves the app exactly as it was. That is also
 * why a failed refresh CLEARS the registry rather than keeping a stale list: a tool list from a
 * service that has gone away is a claim about a machine we can no longer see, and the picker would
 * be listing cutters it cannot describe.
 *
 * NOT PERSISTED, deliberately. `settingsStore` and `machineStore` keep their own data in
 * localStorage because it is the user's configuration; the house lives on the service, in its own
 * file, and a copy here would be a second source of truth for the thing #212 exists to have one of.
 */

import { create } from 'zustand';
import { inventoryKey, setInventoryEntries, setRegistry } from '@/engine/cnc/toolRegistry';
import { clearFeedCatalogue, setFeedCatalogue } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import {
  houseFeeds,
  houseInventory,
  houseTools,
  probeHouse,
  type HouseHealth,
  type HouseRequestOptions,
  type InventoryItem,
} from '@/platform/houseClient';

/** Whether the tool list came from a house service. See the module doc for why this is not `error`. */
export type HouseStatus = 'checking' | 'present' | 'absent';

export interface ToolRegistryState {
  status: HouseStatus;
  /**
   * The tiers above the built-ins, exactly what `GET /api/v1/tools` returned. `[]` with
   * `status: 'present'` is a real answer — a service whose house has no extra cutters yet.
   */
  entries: readonly ToolLibraryEntry[];
  /** What the service said about itself, when it answered. Null when it did not. */
  health: HouseHealth | null;
  /** Why there is no service, in one sentence, or null when there is one. */
  error: string | null;
  /** The last validator received, for the next read's `If-None-Match`. */
  etag: string | null;
  /**
   * How many catalogue feed rows are loaded into the feeds engine (#310). The rows themselves are
   * in `engine/cnc/feeds.ts`; this is the count a "N starting rows from this machine" line needs,
   * not a second copy of a 1 328-row matrix.
   */
  feedCount: number;
  /** The feed document's validator, for the next read's `If-None-Match`. */
  feedEtag: string | null;
  /**
   * Why the catalogue is not loaded, when the service had one to offer and the read failed.
   * Deliberately not `error`: that one is about the registry, and a house whose cutters read fine
   * but whose feed matrix did not is a usable house with a gap, not a house that is gone.
   */
  feedError: string | null;
  /**
   * The cutters the user physically owns, exactly what `GET /api/v1/inventory` returned (#309).
   * Their `inv:` entries are in the registry; these are the documents, because the panel's Qty,
   * Codes and Added columns are about the possession and not about the cutter.
   */
  items: readonly InventoryItem[];
  /** The inventory document's validator, for the next read's `If-None-Match`. */
  inventoryEtag: string | null;
  /** Why the inventory is not loaded, when the service had one to offer and the read failed. */
  inventoryError: string | null;
  /**
   * Probe the house service and push what it has into the registry. Safe to call any number of
   * times; concurrent calls share one run rather than racing (`main.tsx` mounts under StrictMode,
   * whose effects run twice in development).
   */
  refresh: (opts?: HouseRequestOptions) => Promise<void>;
  /** Back to the built-ins: forget the service. For tests, and for a "forget this machine". */
  reset: () => void;
}

/** Why a probe, a tool read or a feed read that is not `ok` says what it says. */
function reasonFor(outcome: { kind: 'absent'; reason: string } | { kind: 'error'; detail: string }) {
  return outcome.kind === 'absent' ? outcome.reason : outcome.detail;
}

/**
 * The registry entry for a possession (#309). The key is `inv:<id>` (`inventoryKey`), the tool is
 * the item's own materialised snapshot — which is the point of materialising it: a job that names
 * this cutter still resolves when the catalogue row it came from is gone.
 *
 * Exported because #309's panels mint the same entries and the Engrave panel's picker lists them
 * straight off the registry.
 */
export function inventoryEntryFor(item: InventoryItem): ToolLibraryEntry {
  return {
    key: inventoryKey(item.id),
    tool: item.tool,
    provenance: item.origin ? 'your cutter, cloned from the catalogue' : 'your cutter, registered here',
  };
}

/**
 * Drop both of the service's tiers. They arrive from one machine and leave together: a tool list
 * from a service we can no longer reach and an inventory from the same unreachable service are the
 * same claim about the world, and neither is safe to keep.
 */
function clearHouseTiers(): void {
  setRegistry([]);
  setInventoryEntries([]);
}

/** The in-flight refresh, so a double-mount is one request. */
let inFlight: Promise<void> | null = null;

export const useToolRegistryStore = create<ToolRegistryState>((set, get) => ({
  status: 'checking',
  entries: [],
  health: null,
  error: null,
  etag: null,
  feedCount: 0,
  feedEtag: null,
  feedError: null,
  items: [],
  inventoryEtag: null,
  inventoryError: null,

  refresh: (opts) => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      // `checking` ONLY WHILE THERE IS NO ANSWER YET. The status is about the SOURCE, and a re-read
      // — which is what every write ends in — does not make a source we already have an answer for
      // unknown again. Flipping it back matters beyond the status bar: `ToolsScope` draws a
      // different branch for `checking`, so a save used to unmount the whole tools pane and
      // everything under it, which took the register frame's half-typed scan with it (#309).
      set(get().status === 'present' ? { error: null } : { status: 'checking', error: null });
      const probe = await probeHouse(opts);
      if (probe.kind !== 'present') {
        clearHouseTiers();
        clearFeedCatalogue();
        set({
          status: 'absent',
          entries: [],
          health: null,
          error: reasonFor(probe),
          etag: null,
          feedCount: 0,
          feedEtag: null,
          feedError: null,
          items: [],
          inventoryEtag: null,
          inventoryError: null,
        });
        return;
      }
      const read = await houseTools(get().etag, opts);
      if (read.kind !== 'ok' && read.kind !== 'unchanged') {
        clearHouseTiers();
        clearFeedCatalogue();
        set({
          status: 'absent',
          entries: [],
          // The service answered its health but not its list: keep the health report, because
          // "hasCatalogue: true" plus "the list failed" is exactly what someone debugging needs.
          health: probe.health,
          error: reasonFor(read),
          etag: null,
          feedCount: 0,
          feedEtag: null,
          feedError: null,
          items: [],
          inventoryEtag: null,
          inventoryError: null,
        });
        return;
      }
      // `unchanged` is a 304: what is already in the registry is byte-identical to what the service
      // holds, so the tool tier and its validator stay exactly as they are.
      if (read.kind === 'ok') setRegistry(read.entries);
      const tools =
        read.kind === 'ok'
          ? { entries: read.entries, etag: read.etag }
          : { entries: get().entries, etag: get().etag };

      // The catalogue is read second, and only once there IS a tool list: its rows are keyed by
      // cutter id, so without the cutters they name not one of them could ever be reached.
      const feeds = await houseFeeds(get().feedEtag, opts);
      let feed: { count: number; etag: string | null; error: string | null };
      if (feeds.kind === 'ok') {
        setFeedCatalogue(feeds.rows);
        feed = { count: feeds.rows.length, etag: feeds.etag, error: null };
      } else if (feeds.kind === 'unchanged') {
        feed = { count: get().feedCount, etag: get().feedEtag, error: null };
      } else {
        // Same rule as the tool list: a catalogue from a service we can no longer read is a claim
        // about a machine we cannot see, so it is dropped — with the reason kept, so the gap is
        // visible rather than looking like a service that simply has no rows.
        clearFeedCatalogue();
        feed = { count: 0, etag: null, error: reasonFor(feeds) };
      }

      // The inventory is the third document (#309), and the only one that has no order dependency
      // on the others: it is the user's own list of what they physically own, and each item carries
      // its own tool rather than naming a row in the catalogue. Same treatment as the feeds, though
      // — a failing read drops what it would have supplied rather than keeping a stale list.
      const inventory = await houseInventory(get().inventoryEtag, opts);
      let items: readonly InventoryItem[];
      let inventoryEtag: string | null;
      let inventoryError: string | null;
      if (inventory.kind === 'ok') {
        // Only a real read re-pushes the tier: a 304's entries are already in the registry, and
        // replacing them with equal ones would churn the snapshot every picker re-renders from.
        setInventoryEntries(inventory.items.map(inventoryEntryFor));
        items = inventory.items;
        inventoryEtag = inventory.etag;
        inventoryError = null;
      } else if (inventory.kind === 'unchanged') {
        items = get().items;
        inventoryEtag = get().inventoryEtag;
        inventoryError = null;
      } else {
        setInventoryEntries([]);
        items = [];
        inventoryEtag = null;
        inventoryError = reasonFor(inventory);
      }

      set({
        status: 'present',
        entries: tools.entries,
        health: probe.health,
        error: null,
        etag: tools.etag,
        feedCount: feed.count,
        feedEtag: feed.etag,
        feedError: feed.error,
        items,
        inventoryEtag,
        inventoryError,
      });
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  },

  reset: () => {
    clearHouseTiers();
    clearFeedCatalogue();
    set({
      status: 'checking',
      entries: [],
      health: null,
      error: null,
      etag: null,
      feedCount: 0,
      feedEtag: null,
      feedError: null,
      items: [],
      inventoryEtag: null,
      inventoryError: null,
    });
  },
}));
