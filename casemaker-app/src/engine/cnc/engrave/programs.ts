/**
 * The job's PROGRAMS (#419 J3): which setups it is cut in, what each one cuts, and with which tool.
 *
 * A program is ONE setup cut with ONE tool — one `.nc`, one verifier report, one FNV key. This
 * module is the derivation from the job document to that list, kept apart from the generator so the
 * same reading is available to anything that wants to know "how many programs is this job" without
 * building a toolpath (`job.id`'s reservation, the run plan, the package's hash, a test).
 *
 * THE ITEM SET IS THE SETUP'S. A job that states `setups[]` cuts exactly the items each setup lists
 * (J2 made the stored record authoritative). A job that does not is the one setup it has always
 * meant — `jobSetups` derives it, so the legacy path and the stored path meet here rather than in
 * the generator's control flow.
 *
 * ONE TOOL PER SETUP, FOR NOW. `JobSetup.tools` is a list because the model allows a setup to use
 * more than one cutter, but WHICH ITEMS each cutter takes is #410's assignment and does not exist
 * yet: a setup naming a second tool would cut every one of its items twice, once per tool. So the
 * derivation refuses that shape rather than guessing (see `setupToolProblems`) — the program list
 * is one per (setup, tool) exactly while each setup names one tool, which is the whole of J3 that
 * can be honest today.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { Tool } from '@/engine/cnc/tool';
import { jobSetups } from './jobSetup';

/** One program, before it is cut: a setup, the items it cuts, and the cutter. */
export interface JobProgramRef {
  /** 1-based, the way the operator counts setups on screen ("Setup 2"). */
  setupIndex: number;
  setupId: string;
  toolKey: string;
  /** The setup's items, in document order, as it listed them. */
  itemIds: readonly string[];
}

/**
 * Every setup's programs, in cut order. A setup with no tool named falls back to `job.toolKey`
 * (the legacy reading: the document's cutter is the one every cut uses) — `setupToolProblems`
 * reports the empty case so the fallback is never silent.
 */
export function setupPrograms(job: EngraveJob): JobProgramRef[] {
  return jobSetups(job).map((setup, i) => ({
    setupIndex: i + 1,
    setupId: setup.id,
    toolKey: setup.tools[0] ?? job.toolKey,
    itemIds: setup.itemIds,
  }));
}

/**
 * The job as ONE setup sees it: only that setup's items, and that setup's cutter.
 *
 * The lists are filtered by id; everything else — the stock, the workholding, the margins, the
 * facing pass, the override — belongs to the job and is shared, which is why a program is honestly
 * "the job, cut one setup at a time" rather than a second job.
 *
 * The result carries no `setups[]`: it is a single-setup document, and letting the sub-job keep the
 * list would make anything that re-read `jobSetups` walk the whole job again from inside one of its
 * own programs.
 *
 * `tool` is the cutter the caller already resolved for this program, and it is written as the
 * sub-job's materialised `tool` — the same escape hatch a job uses for a cutter the library does not
 * hold. Without it, every reader of the sub-job (`validateJob`'s `tool-missing`, the jaw reach, the
 * stroke-merge check) would look the setup's key up in the WORKER's empty registry and refuse a
 * program the caller can perfectly well cut.
 */
export function jobForSetup(job: EngraveJob, ref: JobProgramRef, tool?: Tool | null): EngraveJob {
  const ids = new Set(ref.itemIds);
  const keep = <T extends { id: string }>(items: readonly T[] | undefined): T[] | undefined =>
    items === undefined ? undefined : items.filter((item) => ids.has(item.id));
  const { setups: _setups, ...rest } = job;
  return {
    ...rest,
    toolKey: ref.toolKey,
    ...(tool !== undefined && tool !== null ? { tool } : {}),
    labels: job.labels.filter((item) => ids.has(item.id)),
    shapes: job.shapes.filter((item) => ids.has(item.id)),
    ...(job.combined !== undefined ? { combined: keep(job.combined) } : {}),
    ...(job.traces !== undefined ? { traces: keep(job.traces) } : {}),
    ...(job.vectors !== undefined ? { vectors: keep(job.vectors) } : {}),
    ...(job.drills !== undefined ? { drills: keep(job.drills) } : {}),
    ...(job.threads !== undefined ? { threads: keep(job.threads) } : {}),
  } as EngraveJob;
}

