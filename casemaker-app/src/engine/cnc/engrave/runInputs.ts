/**
 * #581 — WHAT A GENERATE READ, as a small stamp the run compares against the next Generate.
 *
 * #577 proved the simulation and the oracle are deterministic: two Generates on the SAME inputs
 * cannot disagree. So when their verdicts differ, an input moved — and the run could only say
 * "the job or the machine frame changed", which is both vague and, for four of these keys, wrong
 * (a feed table or a synced catalogue moving never set the stale mark at all).
 *
 * The stamp is one short FNV hash per input, built from the SAME snapshot `engraveRunStore.run()`
 * already hands the worker. It is never parsed and never stored in the job document — it exists to
 * be COMPARED, so that a disagreement can name the input that changed.
 *
 * What is deliberately left out of each hash:
 *
 *  - `margins.source` — a label ('default' / 'job'), not a number;
 *  - a calibration's `measuredAt` and `source` — a fresh read of the SAME frame is not a different
 *    machine;
 *  - a shop default's `source` / `setAt` — where a number came from, not what the program does
 *    with it (the default's own `setAt` moves on every re-measure);
 *  - a condition's `note` — words, not a pick.
 *
 * Those exclusions are what keep the stamp honest: anything that moves it changed the program.
 */

import { canonicalJson, jobFingerprint } from './package';
import { programHash } from '@/engine/cnc/programHash';
import type { EngraveJob, EngraveMargins } from '@/types/engraveJob';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { FeedCatalogueRow, FeedsEntry } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { SurfacePostFit } from './surfaceSpread';

/**
 * The inputs in reading order — the order `changedInputs` reports them, so the FIRST one named is
 * the most specific thing that moved (a job edit before a shop-default edit, and so on).
 */
export const RUN_INPUT_ORDER = [
  'job',
  'margins',
  'machine',
  'shop',
  'feeds',
  'catalogue',
  'cutters',
  'surface',
] as const;

export type EngraveInputKey = (typeof RUN_INPUT_ORDER)[number];

/** One opaque string per input; equal stamps mean the input did not change. */
export type EngraveRunInputs = Readonly<Record<EngraveInputKey, string>>;

/** The input in words, for a sentence: "the job changed since it was generated". */
export const INPUT_LABELS: Readonly<Record<EngraveInputKey, string>> = {
  job: 'the job',
  margins: 'the depth margins',
  machine: 'the machine frame',
  shop: 'the shop defaults',
  feeds: 'the feed table',
  catalogue: 'the feed catalogue',
  cutters: 'the cutter list',
  surface: 'the fitted surface frame',
};

export function inputLabel(key: EngraveInputKey): string {
  return INPUT_LABELS[key];
}

/**
 * The sentence a stale result gets: the input that moved, when it is known. A caller with no run —
 * a script, a hand-built view — keeps the generic sentence, which is still true whenever the reason
 * is unknown.
 */
export function staleSentence(reason: EngraveInputKey | null | undefined): string {
  return reason === null || reason === undefined
    ? 'the job or the machine frame changed since it was generated'
    : `${inputLabel(reason)} changed since it was generated`;
}

/** Every input whose stamp differs, in `RUN_INPUT_ORDER`. Empty when nothing moved. */
export function changedInputs(before: EngraveRunInputs, after: EngraveRunInputs): EngraveInputKey[] {
  return RUN_INPUT_ORDER.filter((key) => before[key] !== after[key]);
}

function hashOf(value: unknown): string {
  return programHash(canonicalJson(value));
}

/** The values `run()` read for this Generate — the ones it handed the worker, by reference. */
export interface RunInputSources {
  job: EngraveJob;
  margins: EngraveMargins;
  calibration: MachineCalibration | null;
  /** The location's defaults document, as the run read it. */
  shopDefaults: ShopDefaults | null;
  /** `resolvedFeedsTable().table` at run time. */
  feeds: readonly FeedsEntry[];
  /** `feedCatalogueRows()` at run time. */
  catalogue: readonly FeedCatalogueRow[];
  tools: readonly ToolLibraryEntry[];
  conditions: ReadonlyMap<string, ConditionSummary>;
  /** The fitted tilt a Cut-step re-post used, or null for a flat post. */
  surface: SurfacePostFit | null;
}

export function runInputs(sources: RunInputSources): EngraveRunInputs {
  return {
    job: jobFingerprint(sources.job),
    margins: `${sources.margins.boundaryMargin}|${sources.margins.zTolerance}`,
    machine: machineKey(sources.calibration),
    shop: shopKey(sources.shopDefaults),
    feeds: hashOf(sources.feeds),
    catalogue: hashOf(sources.catalogue),
    cutters: cuttersKey(sources.tools, sources.conditions),
    surface: surfaceKey(sources.surface),
  };
}

/** The machine's FRAME, not its reading: `measuredAt`/`source` do not describe the machine. */
export function machineKey(calibration: MachineCalibration | null): string {
  if (calibration === null) return 'none';
  return hashOf({
    machineId: calibration.machineId,
    frame: calibration.frame,
    softEndstop: calibration.softEndstop,
  });
}

/**
 * Every default's VALUE, keyed — the worker resolves thread/drill/finish/rest/bracket numbers from
 * this same document, so any value the program reads is in here. The entries' sources and reading
 * times are not: re-measuring a default to the same number does not change the program.
 */
export function shopKey(defaults: ShopDefaults | null): string {
  if (defaults === null) return 'none';
  const values = Object.entries(defaults)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => [key, entry.value] as const);
  return hashOf(values);
}

/** The cutter list plus each item's pick-relevant condition; the note text is words. */
export function cuttersKey(tools: readonly ToolLibraryEntry[], conditions: ReadonlyMap<string, ConditionSummary>): string {
  const condition = [...conditions.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, summary]) => [id, summary.best, summary.usable] as const);
  return hashOf({ tools, conditions: condition });
}

/** The fitted plane a re-post used, or `flat` — the same two states `generated.surface` has. */
export function surfaceKey(surface: SurfacePostFit | null): string {
  if (surface === null) return 'flat';
  const { offset, slopeX, slopeY } = surface.plane;
  return `${offset}|${slopeX}|${slopeY}|${surface.z0}`;
}
