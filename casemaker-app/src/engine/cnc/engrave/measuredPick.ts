/**
 * #766 D — WHAT A MEASURED PICK IS AN ANSWER FOR, and how it is written back.
 *
 * The Design panel draws at once with the #211 rule's answer and then asks the sim worker for the
 * MEASURED one in the background (`smartPick` + `evaluatePlan`). Two questions follow from that,
 * and both are answered here so the main thread and the worker cannot disagree:
 *
 *   - WHICH JOB a measured pick answers. The search's answer is a cut PLAN, not a cutter, and it
 *     depends on the job's geometry and on the context it was measured in (the tool list, the
 *     catalogue, the bench's conditions, the shop's numbers) — but not on which cutter the job
 *     currently NAMES, nor on its setups, its name or the provenance stamps beside them. Writing
 *     the answer into the job (`applyCutterPlanToJob`) changes exactly those fields, so the panel
 *     must keep the answer it just applied as CURRENT rather than treat its own write as an edit
 *     that staled the search. `measureFingerprint` is the content a measure can see;
 *     `smartPickKey` adds the context a verdict can see.
 *
 *   - THE CUTTER-MEASURE CACHE ACROSS EDITS. `planEvaluate`'s per-cutter measures are keyed on
 *     `measureFingerprint`, so a rename, a cutter choice, a setup change — anything a measure
 *     cannot see — keeps every cutter's measured rows. Only a change to the job's own geometry
 *     (a label's text, a shape's ring, the stock, the mount) re-measures.
 *
 * The fingerprint is computed with the package's own `jobFingerprint` over a stripped view, so a
 * job and its clone hash exactly as they would for a frozen package: one canonicaliser, not two.
 */

import type { EngraveJob, FieldSource } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import { programHash } from '@/engine/cnc/programHash';
import { jobSetups, pureGoalObject } from './jobSetup';
import { jobFingerprint } from './package';

/**
 * The job a MEASURE can see: everything a cutter's rows are computed from, with the plan, the
 * name and the provenance stamps replaced by constants.
 *
 * `setups` is dropped whole. Every measure this view is keyed for (`measureEngraving`,
 * `raisedTextMeasure` → `supportingFloors`/`colourBoundaryFor`) reads the job's ITEMS, its stock
 * and its workholding — never a setup's tool list, which is what `setups` adds to the document
 * (#419/#472). Dropping it is what lets the panel write a rest pair into the job without
 * re-measuring either cutter.
 *
 * `sources.tool` is dropped for the same reason `fingerprintView` strips the stock's measured
 * flatness (#627): applying a recommendation stamps `tool: 'computed'`, and that stamp is the
 * software's own write, not a change to the blank. The container is dropped when it would empty,
 * so a job that has only ever had its tool stamped fingerprints as the job with no provenance.
 */
export function measureJobView(job: EngraveJob): EngraveJob {
  const view: EngraveJob = { ...job, name: '', toolKey: '' };
  delete view.tool;
  delete view.setups;
  delete view.facing;
  if (view.sources !== undefined) {
    const sources = { ...view.sources };
    delete sources.tool;
    if (Object.keys(sources).length === 0) delete view.sources;
    else view.sources = sources;
  }
  return view;
}

/** The job content that can change what any candidate cutter MEASURES. */
export function measureFingerprint(job: EngraveJob): string {
  return jobFingerprint(measureJobView(job));
}

/** The context a search verdict depends on besides the job — the caller's four snapshots. */
export interface PickContext {
  tools: readonly ToolLibraryEntry[];
  catalogue: readonly FeedCatalogueRow[];
  conditions?: ReadonlyMap<string, ConditionSummary> | null;
  /** The engrave shop defaults the run would use (a plain record; `feeds` included). */
  shop?: unknown;
}

/**
 * The identity of a measured pick: the geometry a cutter is measured against, the cutters
 * themselves, and the context that decides which of them may be tried. Equal keys mean the same
 * answer, so the panel may reuse it and `planEvaluate`'s caches may answer every measure.
 */
export function smartPickKey(job: EngraveJob, ctx: PickContext): string {
  const conditions =
    ctx.conditions === undefined || ctx.conditions === null ? null : [...ctx.conditions.keys()].sort();
  return programHash(
    JSON.stringify([
      measureFingerprint(job),
      ctx.tools.map((t) => [t.key, t.tool]),
      ctx.catalogue.length,
      conditions,
      ctx.shop ?? null,
    ]),
  );
}

/** One cutter of a candidate plan: its key, and the item ids it owns (`[]` = rest over earlier work). */
export interface PlanCutter {
  key: string;
  items: readonly string[];
}

/** A candidate plan: cutters in cut order. */
export interface CutterPlanLike {
  cutters: readonly PlanCutter[];
}

/**
 * Write a candidate plan into a clone of the job the way the CLI and the evaluator do (#760/#762):
 * the first cutter is the job's tool, and one setup carries the cut order (`tools`) and which items
 * each owns (`toolItems`). One cutter is still one program.
 *
 * The setup is written for a single cutter too — not skipped — so applying a one-cutter answer over
 * an earlier rest pair REMOVES the rest rather than leaving it in the job. `planEvaluate`'s
 * evaluator calls this for every plan it scores, which is what makes the app, the CLI and the
 * evaluator judge the same program.
 */
export function applyCutterPlanToJob(job: EngraveJob, plan: CutterPlanLike): EngraveJob {
  const applied: EngraveJob = structuredClone(job);
  const first = plan.cutters[0];
  if (first === undefined) return applied;
  applied.toolKey = first.key;
  // #766 fix — A PURE GOAL JOB GETS NO SETUP. Its derived setup is empty BY DESIGN (#535): the
  // goal mesh is the setup's one program, and `pureGoalObject` only recognises the job while it
  // states NO setups. Writing one made the generator validate the goal as an ordinary item that
  // the setup does not list ("Setup 1 assigns an item that is not in it: g1") and refused every
  // plan, so wolf, photo-relief and mouse-shell jobs that #762 generated stopped generating.
  if (pureGoalObject(job) !== null) return applied;
  // EVERY plan is written through the setup path — one cutter included. The legacy single-tool
  // document validates its `toolKey` against the built-in registry (`jobTool`), which by design
  // does not hold the location's `inv:` cutters; the setup path resolves each cutter from the
  // caller's own list (the same seam the CLI and the sim worker use).
  const setup = jobSetups(applied)[0]!;
  applied.setups = [
    {
      ...setup,
      tools: plan.cutters.map((c) => c.key),
      toolItems: Object.fromEntries(plan.cutters.map((c) => [c.key, [...c.items]])),
    },
  ];
  return applied;
}

/** The provenance a pick's write-back states, by default "the software chose it". */
export type PickSource = FieldSource;
