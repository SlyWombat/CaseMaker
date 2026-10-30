/**
 * The engrave preview state (#205). Holds the latest `EngravePreview`, a status, and debounces
 * a rebuild on every job edit.
 *
 * #766 D — IT ALSO HOLDS THE MEASURED CUTTER PICK, BEHIND THE PREVIEW. The preview draws at once
 * with the #211 rule's answer, which the panel labels 'provisional — measuring…'; a second, slower
 * debounce (`ENGRAVE_PICK_DEBOUNCE_MS`) asks the sim worker for the MEASURED answer
 * (`smartPick`/`evaluatePlan`), and a completed search replaces the provisional one. Every edit
 * supersedes a running search (the same generation number the preview requests carry), and the
 * answers for job contents this run has already measured are kept in `picks`, so returning to a
 * content — in particular the write-back of an answer into the job, which changes no geometry a
 * measure can see — shows the measured answer again without another search.
 *
 * Deliberately its own store, NOT `jobStore.nodes` and not the `EngraveJob` document: the
 * preview is derived geometry (mesh buffers), not job data, and `jobStore.nodes` is enumerated
 * by export, `FloatersBanner` and `PartsMenu` — a preview mesh there would leak into exported
 * STLs. It holds no wasm handle either: meshes arrive as transferred ArrayBuffers. The measured
 * pick is plain data for the same reason.
 *
 * The client is reached by a dynamic `import()` behind `featureSim` (#343) (as `simStore.ts`
 * does), so a build with the flag off contains neither the sim client nor its worker.
 */

import { featureSim } from '@/platform/features';
import { create } from 'zustand';
import type { EngraveJob, EngraveMargins } from '@/types/engraveJob';
import type { EngravePreview } from '@/workers/sim/engravePreview';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { EngravePickSummary } from '@/workers/sim/smartPickRun';
import { drillSettings } from '@/engine/cnc/cam/drillBit';
import { getTools } from '@/engine/cnc/toolRegistry';
import { feedCatalogueRows, resolvedFeedsTable } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { inventoryConditions, type ConditionSummary } from '@/engine/cnc/toolCondition';
import { probeResiduals, type ProbeResiduals } from '@/engine/cnc/probePlan';
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import { measureFingerprint, smartPickKey } from '@/engine/cnc/engrave/measuredPick';
import { bedUnderFacts, machineForJob } from '@/platform/bedProfiles';
import { useEngraveJobStore } from './engraveJobStore';
import { useLocationStore } from './locationStore';
import { useSettingsStore } from './settingsStore';
import { shopDefault, useShopDefaultsStore } from './shopDefaultsStore';

export type EngravePreviewStatus = 'idle' | 'loading' | 'ready' | 'error';

/** #766 D — where the measured pick stands: no search, running, answered, or failed. */
export type EngravePickStatus = 'idle' | 'measuring' | 'ready' | 'error';

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
  /**
   * #766 D — the measured cutter pick. Optional so a preview-only fake (and a build without the
   * search) still satisfies this type; the real client always has it.
   */
  engraveSmartPick?: (
    job: EngraveJob,
    tools: readonly ToolLibraryEntry[],
    catalogue: readonly FeedCatalogueRow[],
    gen: number,
    conditions: ReadonlyMap<string, ConditionSummary>,
    shop: EngraveShopOpts,
  ) => Promise<EngravePickSummary | null>;
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

/**
 * #766 D — how long the job must be quiet before the measured search starts, ms. The preview's
 * 150 ms would start a search on every keystroke; the search costs seconds, so it waits for a
 * full second of quiet, and any edit before then replaces the pending run.
 */
export const ENGRAVE_PICK_DEBOUNCE_MS = 1000;

export interface EngravePreviewState {
  /** The most recent successful preview; kept on screen while a newer one builds. */
  preview: EngravePreview | null;
  status: EngravePreviewStatus;
  error: string | null;
  /** The generation of the newest request; a result from an older one is dropped. */
  gen: number;
  /**
   * #766 D — the measured cutter pick for `measuredJob`, or null while none is current. The panel
   * shows it in place of the rule answer once `measuredStatus` is 'ready'.
   */
  measured: EngravePickSummary | null;
  /** `measureFingerprint` of the job content the measured pick answers (see `measuredPick.ts`). */
  measuredJob: string | null;
  measuredStatus: EngravePickStatus;
  measuredError: string | null;
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
  /**
   * #766 D — the measured pick for exactly this job, resolving with the answer: the current one,
   * the one already in flight, or a search started NOW (a Generate pressed before the debounce
   * fired must not fall back to the rule's provisional answer). Resolves null when there is no
   * answer — a preview-only client, an error, or an edit that superseded the run.
   */
  measureNow: (job: EngraveJob) => Promise<EngravePickSummary | null>;
  /** Cancel any pending rebuild and forget the preview. */
  dispose: () => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pickTimer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

/** #766 D — measured answers by `smartPickKey`, kept across edits that cannot stale them. */
const picks = new Map<string, EngravePickSummary>();
/** The search currently running, if any: a second request for the same key joins it. */
let inflight: { key: string; promise: Promise<EngravePickSummary | null> } | null = null;

/** The the caller's snapshots the preview build and the measured search share (#305/#324/#442/#451). */
interface PreviewInputs {
  tools: readonly ToolLibraryEntry[];
  catalogue: readonly FeedCatalogueRow[];
  margins: EngraveMargins;
  conditions: ReadonlyMap<string, ConditionSummary>;
  shop: EngraveShopOpts;
  residuals: ProbeResiduals;
}

function previewInputs(job: EngraveJob): PreviewInputs {
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
  return {
    tools: getTools(),
    catalogue: feedCatalogueRows(),
    margins: effectiveMargins(job, useSettingsStore.getState().margins),
    conditions: inventoryConditions(),
    shop: {
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
    residuals: probeResiduals(),
  };
}

export const useEngravePreviewStore = create<EngravePreviewState>()((set, get) => {
  async function run(job: EngraveJob, mine: number): Promise<void> {
    // Keep the last preview on screen while the new one builds — only the status changes, so
    // the stock never disappears mid-keystroke (acceptance).
    set({ status: 'loading', error: null });
    try {
      const client = await clientLoader();
      const inputs = previewInputs(job);
      const preview = await client.engravePreview(
        job,
        inputs.tools,
        inputs.catalogue,
        mine,
        inputs.margins,
        inputs.conditions,
        inputs.shop,
        inputs.residuals,
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

  /**
   * #766 D — the measured search for `job`, under generation `mine`. A cached answer is applied
   * without a worker call; a run already in flight for the same key is joined; otherwise the
   * worker runs `smartPick`. `jobFingerprintNow` is the content the answer is recorded against
   * (the search's own `jobKey` also states the context it measured in).
   */
  async function runPick(job: EngraveJob, mine: number, jobFingerprintNow: string): Promise<EngravePickSummary | null> {
    if (!canMeasure(job)) {
      if (mine === seq) set({ measuredStatus: 'idle' });
      return null;
    }
    let inputs: PreviewInputs;
    let key: string;
    try {
      inputs = previewInputs(job);
      key = smartPickKeyFor(job, inputs);
    } catch (e) {
      if (mine === seq) set({ measuredStatus: 'error', measuredError: e instanceof Error ? e.message : String(e) });
      return null;
    }
    if (mine !== seq) return null;
    const cached = picks.get(key);
    if (cached !== undefined) {
      set({ measured: cached, measuredJob: jobFingerprintNow, measuredStatus: 'ready', measuredError: null });
      return cached;
    }
    if (inflight !== null && inflight.key === key) return inflight.promise;
    const promise = (async (): Promise<EngravePickSummary | null> => {
      try {
        const client = await clientLoader();
        if (client.engraveSmartPick === undefined) {
          // A preview-only client (a test, or a build without the search): leave the rule answer.
          if (mine === seq) set({ measuredStatus: 'idle' });
          return null;
        }
        const summary = await client.engraveSmartPick(job, inputs.tools, inputs.catalogue, mine, inputs.conditions, inputs.shop);
        if (summary === null) {
          // Superseded inside the worker; a newer request owns the state (or the rule stands).
          if (mine === seq) set({ measuredStatus: 'idle' });
          return null;
        }
        picks.set(summary.jobKey, summary);
        if (mine === seq && summary.jobKey === key) {
          set({ measured: summary, measuredJob: jobFingerprintNow, measuredStatus: 'ready', measuredError: null });
        }
        return summary;
      } catch (e) {
        if (mine === seq) set({ measuredStatus: 'error', measuredError: e instanceof Error ? e.message : String(e) });
        return null;
      } finally {
        if (inflight !== null && inflight.key === key) inflight = null;
      }
    })();
    inflight = { key, promise };
    return promise;
  }

  return {
    preview: null,
    status: 'idle',
    error: null,
    gen: 0,
    measured: null,
    measuredJob: null,
    measuredStatus: 'idle',
    measuredError: null,
    scrubStage: null,
    setScrubStage(stage) {
      set({ scrubStage: stage });
    },
    request(job) {
      const mine = ++seq;
      // #766 D — the measured answer is current only while the job content a measure can see is
      // unchanged. Applying the answer itself (toolKey, setups, `sources.tool`) is such a
      // non-change, so the panel keeps showing the measured plan it just wrote into the job
      // instead of flashing back to the rule's provisional one.
      const jobFingerprintNow = measureFingerprint(job);
      const kept = get().measured !== null && get().measuredJob === jobFingerprintNow;
      const measurable = canMeasure(job);
      set({
        gen: mine,
        ...(kept
          ? {}
          : {
              measured: null,
              measuredJob: null,
              measuredStatus: measurable ? ('measuring' as const) : ('idle' as const),
              measuredError: null,
            }),
      });
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (mine !== seq) return; // a newer request arrived during the debounce
        void run(job, mine);
      }, ENGRAVE_PREVIEW_DEBOUNCE_MS);
      if (pickTimer !== null) clearTimeout(pickTimer);
      pickTimer = null;
      if (!kept && measurable) {
        pickTimer = setTimeout(() => {
          pickTimer = null;
          if (mine !== seq) return;
          void runPick(job, mine, jobFingerprintNow);
        }, ENGRAVE_PICK_DEBOUNCE_MS);
      }
    },
    async measureNow(job) {
      // The CURRENT generation, not a new one: an edit must supersede this run, and the preview
      // for this generation may already be in flight (or its timer pending) — neither is stale.
      const mine = seq;
      const jobFingerprintNow = measureFingerprint(job);
      const state = get();
      if (state.measured !== null && state.measuredJob === jobFingerprintNow) return state.measured;
      if (pickTimer !== null) {
        clearTimeout(pickTimer);
        pickTimer = null;
      }
      return runPick(job, mine, jobFingerprintNow);
    },
    dispose() {
      seq += 1;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pickTimer !== null) {
        clearTimeout(pickTimer);
        pickTimer = null;
      }
      set({
        preview: null,
        status: 'idle',
        error: null,
        gen: seq,
        measured: null,
        measuredJob: null,
        measuredStatus: 'idle',
        measuredError: null,
        scrubStage: null,
      });
    },
  };
});

/**
 * #766 D — whether the measured search can answer for this job AT ALL.
 *
 * The search judges a plan as ONE setup: `applyCutterPlanToJob` writes the whole cut order into
 * setup 0, which is exactly what the CLI's no-cutter path does (it only runs when the job states
 * no setups). A job with several saved setups is therefore not a shape the search can answer
 * for — judging it would collapse the others — so the rule's provisional answer simply stands,
 * unlabelled. A single-setup (or setup-less, rotary included) job is measurable.
 */
function canMeasure(job: EngraveJob): boolean {
  return (job.setups?.length ?? 0) <= 1;
}

/** The pick key for these inputs — the store's own copy of the worker's `smartPickKey` call. */
function smartPickKeyFor(job: EngraveJob, inputs: PreviewInputs): string {
  return smartPickKey(job, {
    tools: inputs.tools,
    catalogue: inputs.catalogue,
    conditions: inputs.conditions,
    shop: inputs.shop,
  });
}

// Any edit to the job triggers a rebuild (#205). This is the whole "subscribes to
// engraveJobStore" requirement; the panel itself does not have to call `request`.
useEngraveJobStore.subscribe((state, prev) => {
  if (state.job !== prev.job) useEngravePreviewStore.getState().request(state.job);
});
