/**
 * The engrave preview state (#205). Holds the latest `EngravePreview`, a status, and debounces
 * a rebuild on every job edit.
 *
 * Deliberately its own store, NOT `jobStore.nodes` and not the `EngraveJob` document: the
 * preview is derived geometry (mesh buffers), not job data, and `jobStore.nodes` is enumerated
 * by export, `FloatersBanner` and `PartsMenu` — a preview mesh there would leak into exported
 * STLs. It holds no wasm handle either: meshes arrive as transferred ArrayBuffers.
 *
 * The client is reached by a dynamic `import()` behind `featureSim` (#343) (as `simStore.ts`
 * does), so a build with the flag off contains neither the sim client nor its worker.
 */

import { featureSim } from '@/platform/features';
import { create } from 'zustand';
import type { EngraveJob, EngraveMargins } from '@/types/engraveJob';
import type { EngravePreview } from '@/workers/sim/engravePreview';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import { getTools } from '@/engine/cnc/toolRegistry';
import { feedCatalogueRows } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { inventoryConditions, type ConditionSummary } from '@/engine/cnc/toolCondition';
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import { useEngraveJobStore } from './engraveJobStore';
import { useSettingsStore } from './settingsStore';
import { shopDefault } from './shopDefaultsStore';

export type EngravePreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

export type EngravePreviewClient = {
  engravePreview: (
    job: EngraveJob,
    tools: readonly ToolLibraryEntry[],
    catalogue: readonly FeedCatalogueRow[],
    gen: number,
    margins: EngraveMargins,
    /** The inventory's condition summaries by registry key (#442) — see `run` for why it is read here. */
    conditions: ReadonlyMap<string, ConditionSummary>,
    /** The engrave shop defaults (#451) — see `run` for why they are read here. */
    shop?: EngraveShopOpts,
  ) => Promise<EngravePreview | null>;
};

const loadClient = async (): Promise<EngravePreviewClient> => {
  if (!featureSim) throw new Error('the engrave preview is not enabled in this build');
  return import('@/engine/jobs/simClient');
};
let clientLoader: () => Promise<EngravePreviewClient> = loadClient;
/** For tests: swap the (lazy) client for a fake. */
export function setEngravePreviewClientLoader(fn: (() => Promise<EngravePreviewClient>) | null): void {
  clientLoader = fn ?? loadClient;
}

/** How long the job must be quiet before a rebuild starts, ms (the issue's 150). */
export const ENGRAVE_PREVIEW_DEBOUNCE_MS = 150;

export interface EngravePreviewState {
  /** The most recent successful preview; kept on screen while a newer one builds. */
  preview: EngravePreview | null;
  status: EngravePreviewStatus;
  error: string | null;
  /** The generation of the newest request; a result from an older one is dropped. */
  gen: number;
  /** Debounced: rebuild the preview for `job` after the quiet window. */
  request: (job: EngraveJob) => void;
  /** Cancel any pending rebuild and forget the preview. */
  dispose: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

export const useEngravePreviewStore = create<EngravePreviewState>()((set) => {
  async function run(job: EngraveJob, mine: number): Promise<void> {
    // Keep the last preview on screen while the new one builds — only the status changes, so
    // the stock never disappears mid-keystroke (acceptance).
    set({ status: 'loading', error: null });
    try {
      const client = await clientLoader();
      // The registry snapshot read HERE, at request time, not at module load (#305): the list the
      // worker measures and recommends from is the one the panel's picker is showing. The Makera
      // feed rows go the same way and for the same reason (#324): this side's module state is not
      // visible in the worker, so the recommendation's feeds filter has to be handed the rows.
      // The job's depth thresholds, resolved HERE (#345) for the same reason the registry snapshot
      // is read here: the worker cannot see `useSettingsStore`, and a preview drawn to a different
      // margin than the run will use would show a void floor the verifier does not enforce.
      // The inventory's condition summaries go the same way as the registry snapshot (#442): the
      // worker has no copy of `toolCondition`'s map, so the recommendation that skips broken cutters
      // and notes a worn one would otherwise answer for a bench with no conditions set.
      // The warn ratio is the shop's (#451), read here for the same reason: the worker cannot see the
      // location, and the preview's findings must warn at the bar the run would raise.
      const preview = await client.engravePreview(
        job,
        getTools(),
        feedCatalogueRows(),
        mine,
        effectiveMargins(job, useSettingsStore.getState().margins),
        inventoryConditions(),
        { lostDetailWarnRatio: shopDefault('engrave.lostDetailWarnRatio').value },
      );
      if (mine !== seq) return; // superseded by a newer request
      // `preview === null` means the worker saw a newer generation already; keep the last one.
      if (preview) set({ preview, status: 'ready' });
      else set({ status: 'ready' });
    } catch (e) {
      if (mine === seq) set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    preview: null,
    status: 'idle',
    error: null,
    gen: 0,
    request(job) {
      const mine = ++seq;
      set({ gen: mine });
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (mine !== seq) return; // a newer request arrived during the debounce
        void run(job, mine);
      }, ENGRAVE_PREVIEW_DEBOUNCE_MS);
    },
    dispose() {
      seq += 1;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      set({ preview: null, status: 'idle', error: null, gen: seq });
    },
  };
});

// Any edit to the job triggers a rebuild (#205). This is the whole "subscribes to
// engraveJobStore" requirement; the panel itself does not have to call `request`.
useEngraveJobStore.subscribe((state, prev) => {
  if (state.job !== prev.job) useEngravePreviewStore.getState().request(state.job);
});
