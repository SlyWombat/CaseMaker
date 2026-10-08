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
import { setRegistry } from '@/engine/cnc/toolRegistry';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import {
  houseTools,
  probeHouse,
  type HouseHealth,
  type HouseProbe,
  type HouseRequestOptions,
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
   * Probe the house service and push what it has into the registry. Safe to call any number of
   * times; concurrent calls share one run rather than racing (`main.tsx` mounts under StrictMode,
   * whose effects run twice in development).
   */
  refresh: (opts?: HouseRequestOptions) => Promise<void>;
  /** Back to the built-ins: forget the service. For tests, and for a "forget this machine". */
  reset: () => void;
}

/** Why a probe that is not `present` says what it says. */
function reasonFor(probe: Exclude<HouseProbe, { kind: 'present' }>): string {
  return probe.kind === 'absent' ? probe.reason : probe.detail;
}

/** The in-flight refresh, so a double-mount is one request. */
let inFlight: Promise<void> | null = null;

export const useToolRegistryStore = create<ToolRegistryState>((set, get) => ({
  status: 'checking',
  entries: [],
  health: null,
  error: null,
  etag: null,

  refresh: (opts) => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      set({ status: 'checking', error: null });
      const probe = await probeHouse(opts);
      if (probe.kind !== 'present') {
        setRegistry([]);
        set({ status: 'absent', entries: [], health: null, error: reasonFor(probe), etag: null });
        return;
      }
      const read = await houseTools(get().etag, opts);
      if (read.kind === 'unchanged') {
        // The list is byte-identical to the one already in the registry; only the probe is new.
        set({ status: 'present', health: probe.health, error: null });
        return;
      }
      if (read.kind !== 'ok') {
        setRegistry([]);
        set({
          status: 'absent',
          entries: [],
          // The service answered its health but not its list: keep the health report, because
          // "hasCatalogue: true" plus "the list failed" is exactly what someone debugging needs.
          health: probe.health,
          error: reasonFor(read),
          etag: null,
        });
        return;
      }
      setRegistry(read.entries);
      set({
        status: 'present',
        entries: read.entries,
        health: probe.health,
        error: null,
        etag: read.etag,
      });
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  },

  reset: () => {
    setRegistry([]);
    set({ status: 'checking', entries: [], health: null, error: null, etag: null });
  },
}));
