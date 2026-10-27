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
import { drillSettings } from '@/engine/cnc/cam/drillBit';
import { getTools } from '@/engine/cnc/toolRegistry';
import { feedCatalogueRows, resolvedFeedsTable } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { inventoryConditions, type ConditionSummary } from '@/engine/cnc/toolCondition';
import { probeResiduals, type ProbeResiduals } from '@/engine/cnc/probePlan';
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import { bedUnderFacts, machineForJob } from '@/platform/bedProfiles';
import { useEngraveJobStore } from './engraveJobStore';
import { useLocationStore } from './locationStore';
import { useSettingsStore } from './settingsStore';
import { shopDefault, useShopDefaultsStore } from './shopDefaultsStore';

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
    /** The registration residuals (#451) — see `run` for why they are read here. */
    residuals?: ProbeResiduals,
  ) => Promise<EngravePreview | null>;
};

const loadClient = async (): Promise<EngravePreviewClient> => {
  if (!featureSim) throw new Error('the job preview is not enabled in this build');
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
  /**
   * §5.7 — where the viewport's design ↔ as-cut slider sits: 0 is the uncut design, `max` is the
   * as-cut preview, `null` means as cut. This is VIEW state, not a job setting: it is read by the
   * scene and the legend only, and setting it never writes `engraveJobStore`, so it cannot dirty
   * the job or trigger a rebuild.
   *
   * It resets to `null` whenever a new preview lands. An edit is the user's newest statement about
   * the job, so the picture it produces is shown finished rather than still scrubbed back to an
   * earlier depth from before the edit.
   */
  scrubStage: number | null;
  setScrubStage: (stage: number | null) => void;
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
      const shopDefaults = useShopDefaultsStore.getState().defaults;
      const preview = await client.engravePreview(
        job,
        getTools(),
        feedCatalogueRows(),
        mine,
        effectiveMargins(job, useSettingsStore.getState().margins),
        inventoryConditions(),
        {
          lostDetailWarnRatio: shopDefault('engrave.lostDetailWarnRatio').value,
          // #434 — the drill point angle (and the other `drill.*` numbers) with their sources, so
          // the preview's depth findings are judged with the point the run would plan.
          drill: drillSettings(shopDefaults),
          // #450 slice 3 — the recommendation's feeds check must use the same table the run does.
          feeds: resolvedFeedsTable().table,
          // #725 W12/W2 — the location's defaults: the bracket's and the clamps' sizes are the
          // house's, and the preview's own checks and picture must use the ones the run will.
          defaults: shopDefaults,
          // #725 B7 — the bed's through-cut facts, resolved HERE like the run store's: the active
          // bed profile lives in the location and the worker cannot read it. Without them a taped
          // cut-out over the wasteboard is refused in the preview's own words, and the panel's
          // blocker (which reads the preview's findings) refuses a job the run would generate.
          bed: bedUnderFacts(machineForJob(useLocationStore.getState().location, job.machineId), shopDefaults, job.breakthrough + 1, {
            length: job.stock.length,
            width: job.stock.width,
          }),
        },
        // §5.4 — the registration band's five residuals, read HERE for the same reason as the
        // margins: the worker cannot see the location, and the band must draw the tolerance the
        // location would use. `probeResiduals` answers the labelled fallbacks when no location is
        // readable, so a web build still draws a band and says where its number came from.
        probeResiduals(),
      );
      if (mine !== seq) return; // superseded by a newer request
      // `preview === null` means the worker saw a newer generation already; keep the last one.
      // §5.7 — a new preview is shown at its as-cut end: the scrub was a view of the old result,
      // and its depth may not even exist in the new one.
      if (preview) set({ preview, status: 'ready', scrubStage: null });
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
    scrubStage: null,
    setScrubStage(stage) {
      set({ scrubStage: stage });
    },
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
      set({ preview: null, status: 'idle', error: null, gen: seq, scrubStage: null });
    },
  };
});

// Any edit to the job triggers a rebuild (#205). This is the whole "subscribes to
// engraveJobStore" requirement; the panel itself does not have to call `request`.
useEngraveJobStore.subscribe((state, prev) => {
  if (state.job !== prev.job) useEngravePreviewStore.getState().request(state.job);
});
