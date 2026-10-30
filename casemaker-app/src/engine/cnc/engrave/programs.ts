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
 * ONE PROGRAM PER (SETUP, TOOL). `JobSetup.tools` is the ordered cut chain, and #472's
 * `toolItems` says which of the setup's items each cutter owns. A setup that names no map gets the
 * reading every pre-#472 document already had: the first cutter owns every item, and a later
 * cutter is a REST pass — the generator measures what the previous program left instead of walking
 * the item list again (the CLI route's behaviour, #410). With a map (#746) each cutter cuts the
 * items it owns; the rest pass still exists, but only for a cutter assigned NONE, and its geometry
 * is the measured rest of the items the EARLIER cutter owns (the only items it could have left
 * unfinished). A cutter assigned items is never a rest pass, so it is never handed another
 * cutter's geometry, and #486's V-bit rest refusal never applies to it.
 *
 * A later ref's `itemIds` are the items the operator assigned to that cutter, and they ARE the
 * program's cut geometry: a later cutter cuts its own items as themselves — a through vector stays
 * through, a bore stays a bore, a cut-out keeps its outline. (Before #746 a later ref's items were
 * re-planned as "rest of …" pockets of the first cutter's design.) A later ref with NO items is
 * #472's rest program, whose geometry is the measured rest of the earlier cutter's work.
 *
 * CUT-OUTS POST LAST, ACROSS THE SETUP'S CUTTERS. A cut-out releases the part it names, so cutting
 * one while another program still has material to remove works on a part held only by its tabs (or,
 * with no tabs, on a loose one). Within a program the CAM already posts profiles after every other
 * operation class; across programs the split happens here: a multi-cutter setup's ordinary work is
 * emitted in tool order, then every cut-out in tool order. An owner that also owns early items is
 * therefore SPLIT into its early program and a final cut-out-only program on the same cutter — the
 * operator still changes to that cutter once, and the cut-out is still the last thing it does. A
 * one-cutter setup is not split: its single program already cuts its cut-outs last.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { Tool } from '@/engine/cnc/tool';
import { jobSetups, setupTools, toolItemsFor } from './jobSetup';

/** One program, before it is cut: a setup, the items it cuts, and the cutter. */
export interface JobProgramRef {
  /** 1-based, the way the operator counts setups on screen ("Setup 2"). */
  setupIndex: number;
  setupId: string;
  toolKey: string;
  /** The setup items assigned to this cutter, in the setup's own document order. */
  itemIds: readonly string[];
}

/**
 * Every setup's programs, in cut order: one per tool, each carrying the items that tool owns.
 * Cut-outs are moved to the end of their setup's list (and an owner that also has early items gets
 * a second, cut-out-only ref), so no program cuts one before every other program has finished.
 */
export function setupPrograms(job: EngraveJob): JobProgramRef[] {
  const cutoutIds = new Set((job.cutouts ?? []).map((cutout) => cutout.id));
  return jobSetups(job).flatMap((setup, i) => {
    const refs: JobProgramRef[] = setupTools(setup, job).map((toolKey, toolIndex) => ({
      setupIndex: i + 1,
      setupId: setup.id,
      toolKey,
      itemIds: toolItemsFor(setup, toolKey, toolIndex),
    }));
    // A one-cutter setup cuts its own cut-outs last inside its program (the CAM's operation order),
    // so there is nothing to move. A setup with no cut-outs keeps its refs exactly as they were.
    if (refs.length <= 1) return refs;
    if (!refs.some((ref) => ref.itemIds.some((id) => cutoutIds.has(id)))) return refs;
    const early: JobProgramRef[] = [];
    const late: JobProgramRef[] = [];
    for (const ref of refs) {
      const cutouts = ref.itemIds.filter((id) => cutoutIds.has(id));
      const others = ref.itemIds.filter((id) => !cutoutIds.has(id));
      // A rest-only ref (no items) stays in the early list: it has no cut-out to move, and it must
      // finish the earlier cutter's work before the part is released.
      if (others.length > 0 || cutouts.length === 0) early.push({ ...ref, itemIds: others });
      if (cutouts.length > 0) late.push({ ...ref, itemIds: cutouts });
    }
    return [...early, ...late];
  });
}

/** What the reference walk needs of any item a program can name. */
interface ReferenceItem {
  id: string;
  kind?: string;
  around?: string;
  outer?: string;
  islands?: readonly string[];
  of?: string;
}

/** The items one item names: a frame's `around`, a cutaway's outer and islands, a cut-out's/chamfer's `of`. */
function referencesOf(item: ReferenceItem): string[] {
  const out: string[] = [];
  if (item.kind === 'frame' && typeof item.around === 'string') out.push(item.around);
  if (item.kind === 'cutaway') {
    if (typeof item.outer === 'string') out.push(item.outer);
    for (const island of item.islands ?? []) out.push(island);
  }
  if (typeof item.of === 'string') out.push(item.of);
  return out;
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
  /**
   * #669 — A PROGRAM KEEPS THE OUTLINES ITS ITEMS NAME. A chamfer follows a rim the item names,
   * and that item is often cut in ANOTHER program (a cut-out profiles with a flat end mill; a
   * chamfer needs a cone — the two can never share one). Without the rim's outline the sub-job's
   * chamfer would be a broken reference, so a named item the program does NOT own arrives as a
   * CONSTRUCTION copy: referenceable, never cut. The same rule keeps a cut-out's `of` resolvable
   * across a setup split, and #746 extends it to every other item a program's own items name:
   * a frame's `around`, and a cutaway's `outer` and `islands` (a construction label island is
   * how a raised-text panel is written). Operands may be labels, shapes, combined items or
   * vectors — `findItem`'s whole set.
   */
  const referenced = new Set<string>();
  for (const c of job.cutouts ?? []) if (ids.has(c.id) && c.of !== 'stock-inset') referenced.add(c.of);
  for (const c of job.chamfers ?? []) if (ids.has(c.id) && c.of !== undefined) referenced.add(c.of);
  for (const c of job.combined ?? []) {
    if (!ids.has(c.id)) continue;
    if (c.kind === 'frame') referenced.add(c.around);
    else if (c.kind === 'cutaway') {
      referenced.add(c.outer);
      for (const island of c.islands) referenced.add(island);
    }
  }
  // #766 fix — THE REFERENCES ARE TRANSITIVE. A cutaway that arrives as a CONSTRUCTION COPY
  // (another program owns it; this one only names it) keeps its OWN references with it: an inlay's
  // male plug is a cutaway whose islands name further cutaways and rings, and dropping the outer
  // ring made the copy a broken reference — "Cutaway 'male plug' references '…-ring-outer', which
  // is not in the job" — which refused every plan of j11's male plug under the search.
  const byId = new Map<string, ReferenceItem>();
  const all: readonly ReferenceItem[] = [
    ...job.labels,
    ...job.shapes,
    ...(job.combined ?? []),
    ...(job.vectors ?? []),
    ...(job.cutouts ?? []),
    ...(job.chamfers ?? []),
  ];
  for (const item of all) byId.set(item.id, item);
  const queue = [...referenced];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const item = byId.get(id);
    if (item === undefined) continue; // a missing reference is reported, not invented
    for (const next of referencesOf(item)) {
      if (next === 'stock-inset' || referenced.has(next)) continue;
      referenced.add(next);
      queue.push(next);
    }
  }
  const referenceOnly = <T extends { id: string }>(list: readonly T[] | undefined): T[] =>
    (list ?? [])
      .filter((item) => referenced.has(item.id) && !ids.has(item.id))
      .map((item) => ({ ...item, construction: true }));

  return {
    ...rest,
    toolKey: ref.toolKey,
    ...(tool !== undefined && tool !== null ? { tool } : {}),
    labels: [...job.labels.filter((item) => ids.has(item.id)), ...referenceOnly(job.labels)],
    shapes: [...job.shapes.filter((item) => ids.has(item.id)), ...referenceOnly(job.shapes)],
    ...(job.combined !== undefined
      ? { combined: [...(keep(job.combined) ?? []), ...referenceOnly(job.combined)] }
      : {}),
    ...(job.traces !== undefined ? { traces: keep(job.traces) } : {}),
    ...(job.vectors !== undefined
      ? { vectors: [...(keep(job.vectors) ?? []), ...referenceOnly(job.vectors)] }
      : {}),
    ...(job.drills !== undefined ? { drills: keep(job.drills) } : {}),
    ...(job.threads !== undefined ? { threads: keep(job.threads) } : {}),
    // #435 — a primitive is cut only by the setup that owns it, like every other item.
    ...(job.primitives !== undefined ? { primitives: keep(job.primitives) } : {}),
    // #218 — the cut-out list is cutting work too: a program that does not own the item must not
    // cut its outline, and the program that owns it must.
    ...(job.cutouts !== undefined ? { cutouts: keep(job.cutouts) } : {}),
    // #669 — a chamfer rides with the cut whose edge it breaks; the finding `chamfer-order`
    // compares the programs' order for one.
    ...(job.chamfers !== undefined ? { chamfers: keep(job.chamfers) } : {}),
  } as EngraveJob;
}

