/**
 * #835 — ONE SETUP'S WORK, AS A JOB THE MEASURED SEARCH CAN ANSWER.
 *
 * The search judges a plan as ONE setup (`engravePreviewStore`'s `canMeasure`, `planEvaluate`'s
 * coarse refusal), so a multi-setup job has no measured answer for a cutter one of its setups
 * names and the bench no longer holds — and the finding keeps refusing. The answer for every
 * setup is the answer a single-setup job already gets: measure the work THAT setup does and write
 * the plan back into that setup only.
 *
 * This module is the seam: which keys are dead, what that setup's work looks like as a job, and
 * the write-back that leaves every other setup alone. It is PURE — no store, no worker. The
 * caller measures with its own `smartPick` (the app's worker call, the CLI's evaluator), which is
 * what keeps the top rule "cutters are picked by simulated outcome" in both realms.
 */

import type { EngraveJob, JobSetup } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { toolForIn } from '@/engine/cnc/toolRegistry';
import { isSideGoal, jobSetups, jobTargetObjects, sideSetupIdOf } from './jobSetup';
import type { PlanCutter } from './measuredPick';

/** The keys a setup names that the caller's library does not hold, in use order. */
export function deadSetupKeys(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  setupIndex: number,
): string[] {
  const setup = jobSetups(job)[setupIndex];
  if (setup === undefined) return [];
  const seen = new Set<string>();
  return (setup.tools ?? []).filter((key) => {
    if (seen.has(key)) return false;
    seen.add(key);
    return toolForIn(tools, key) === null;
  });
}

/** Every setup with at least one dead key, in run order. */
export function setupsWithDeadCutters(job: EngraveJob, tools: readonly ToolLibraryEntry[]): number[] {
  return jobSetups(job)
    .map((_setup, index) => index)
    .filter((index) => deadSetupKeys(job, tools, index).length > 0);
}

/**
 * The setup's own work as a single-setup job: its items, its side goal, its mount, and its FIRST
 * cutter as the job's named cutter — so the measured plan prefers a plan that keeps it, exactly
 * as a single-setup job's own key is kept. Null when the setup cuts nothing: a measurement of no
 * work has no answer to give, and the caller's own refusal (if any) still stands.
 */
export function setupWorkJob(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  setupIndex: number,
): EngraveJob | null {
  const setups = jobSetups(job);
  const setup = setups[setupIndex];
  if (setup === undefined) return null;
  const ids = new Set(setup.itemIds);
  const keep = <T extends { id: string }>(items: readonly T[] | undefined): T[] | undefined =>
    items === undefined ? undefined : items.filter((item) => ids.has(item.id));
  const goal = jobTargetObjects(job).find((t) => isSideGoal(t) && sideSetupIdOf(job, t) === setup.id) ?? null;
  const first = (setup.tools ?? [])[0];
  const namedTool = first === undefined ? null : toolForIn(tools, first);
  const sub: EngraveJob = {
    ...job,
    labels: keep(job.labels) ?? [],
    shapes: keep(job.shapes) ?? [],
    combined: keep(job.combined),
    traces: keep(job.traces),
    vectors: keep(job.vectors),
    drills: keep(job.drills),
    threads: keep(job.threads),
    primitives: keep(job.primitives),
    cutouts: keep(job.cutouts),
    chamfers: keep(job.chamfers),
    targetObject: goal ?? undefined,
    targetObjects: undefined,
    setups: [{ ...setup }],
    // The job's own snapshot describes setup 0's cutter; a later setup's key resolves from the
    // caller's list. A dead first key leaves no snapshot, and the search answers freely.
    toolKey: first ?? job.toolKey,
    tool: first === undefined || first === job.toolKey ? (job.tool ?? null) : namedTool,
    substitution: undefined,
  };
  const items =
    (sub.labels?.length ?? 0) +
    (sub.shapes?.length ?? 0) +
    (sub.combined?.length ?? 0) +
    (sub.traces?.length ?? 0) +
    (sub.vectors?.length ?? 0) +
    (sub.drills?.length ?? 0) +
    (sub.threads?.length ?? 0) +
    (sub.primitives?.length ?? 0) +
    (sub.cutouts?.length ?? 0) +
    (sub.chamfers?.length ?? 0);
  if (items === 0 && goal === null) return null;
  return sub;
}

/**
 * Write a measured plan INTO one setup: its cut order and who owns which item. Every other setup
 * is untouched. Setup 0 also mirrors the job's own keys (`toolKey`/`tool`), because the document's
 * legacy pair describes setup 0.
 */
export function writeSetupPlan(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  setupIndex: number,
  cutters: readonly PlanCutter[],
): EngraveJob {
  const setups = jobSetups(job);
  const setup = setups[setupIndex];
  if (setup === undefined || cutters.length === 0) return job;
  const written: JobSetup = {
    ...setup,
    tools: cutters.map((c) => c.key),
    toolItems: Object.fromEntries(cutters.map((c) => [c.key, [...c.items]])),
  };
  const next: EngraveJob = { ...job, setups: setups.map((s, i) => (i === setupIndex ? written : s)) };
  if (setupIndex === 0) {
    next.toolKey = cutters[0]!.key;
    next.tool = toolForIn(tools, cutters[0]!.key);
  }
  return next;
}

/**
 * The plan's cutter that takes over a dead key's work — the one the substitution sentence names as
 * what is "used instead". The items the plan says it owns decide first; failing that a dead FIRST
 * key is answered by the plan's program-1 cutter, and a dead later (rest) key by the plan's rest
 * cutter — the same reading `EngravePanel` has always used for a setup's rest pass.
 */
export function replacementCutter(
  cutters: readonly PlanCutter[],
  setup: JobSetup,
  deadKey: string,
): PlanCutter {
  const first = (setup.tools ?? [])[0];
  if (cutters.length === 0) throw new Error('a plan with no cutters has no replacement');
  // The cutter that took the dead key's own items, when the plan says who owns them.
  const owned = new Set(setup.toolItems?.[deadKey] ?? []);
  const taker = owned.size === 0 ? undefined : cutters.find((c) => c.items.some((id) => owned.has(id)));
  if (taker !== undefined) return taker;
  return deadKey === first ? cutters[0]! : (cutters[1] ?? cutters[0]!);
}
