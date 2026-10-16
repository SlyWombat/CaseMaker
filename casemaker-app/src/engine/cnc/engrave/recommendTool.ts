/**
 * Recommend a cutter for an engrave job (#211).
 *
 * The rule: **recommend the largest flat end mill that can cut every enabled label without
 * losing detail.** A larger cutter is stiffer, clears faster and breaks less; the only reason
 * to go smaller is that the text needs it — which is exactly what #201 measures.
 *
 * TRACES WIDEN THE FIELD (#405). A job whose enabled items are all TRACES (a `line` or a
 * `stroke-label` — a line the cutter follows, `#219`) may also be cut by a V-bit, whose groove is a
 * function of depth and so is exactly a single-stroke line. A V-bit stays excluded the moment the
 * job holds a REGION item: opening a glyph needs one cutting width, and a cone's width grows with
 * depth, so the medial-axis V-carve that would lift that refusal stays in #221.
 *
 * This module is PURE: it is handed the per-candidate measurements (`measure`) and never
 * touches Manifold. That is what makes the rule testable without wasm, and it is why the type
 * and the ratio threshold come from #201 rather than being re-declared here — the rule and
 * `engravabilityFindings` must not disagree about what "keeps the detail" means.
 *
 * In the worker (#205) `measure` is `measureLabels(tl, plan, radius, …)` bound to the
 * candidate's own radius, computed once per job edit beside the preview. The candidate list is
 * HANDED IN (#305), not read from a module: the worker is sent the registry snapshot the picker
 * is showing, so the two cannot disagree about which cutters exist. The feed catalogue is handed in
 * the same way and for the same reason (#324): the worker's own copy of it is always empty, and a
 * pre-filter over feeds that resolves against a different table than the panel's is a filter over
 * the wrong numbers.
 *
 * A BROKEN CUTTER IS NOT A CANDIDATE (#415/#442). The operator's own statement about the physical
 * bit outranks every number below: a cutter whose every copy is marked broken is excluded by name
 * before its feeds or its detail are looked at, and a cutter some of whose copies are worn is still
 * a candidate — but it loses a tie on diameter to a fresh one, and the pick carries the worn note
 * (@see conditionNote) so the operator checks it before the cut. The condition table is HANDED IN
 * (`conditions`), never read from `toolCondition`'s own module state, for the reason the feed rows
 * are handed in: this runs in the sim worker, where that state is empty.
 *
 * WHAT THE FEEDS PRE-FILTER ASKS, after #325. A catalogue row can no longer decide it on its own:
 * a vendor number this job cannot use — a `0`, or one past the machine's refusal threshold — is
 * passed over field by field instead of refusing the job, so `feedsFor` answers exactly as it would
 * with no row at all. What is left is the question the starting table and the machine answer:
 * does ANY table have cutting parameters for this cutter and material, and can the machine run
 * them. The rows are still handed in — they are what the same call returns for the program, and the
 * one seam is worth keeping one seam.
 */

import { feedsFor, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { jobMachine } from '@/engine/cnc/calibration';
import { cuttingDiameter, cuttingForTrace } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { conditionRank, type ConditionSummary } from '@/engine/cnc/toolCondition';
import type { EngraveAnyItem, EngraveJob } from '@/types/engraveJob';
import { LOST_DETAIL_RATIO, type LabelEngravability } from '@/workers/sim/engraveGeometry';

/**
 * Why a tool was dropped before measuring (#211: flat-ends only, and only cutters that exist;
 * #442: and only cutters that are not marked broken).
 */
export type ToolExclusion = 'not-flat' | 'no-feeds' | 'broken';

export interface ToolCandidate {
  key: string;
  /** Cutting diameter, mm (`cuttingDiameter`) — and 0 when the tool states neither, even if excluded. */
  diameter: number;
  qualifies: boolean;
  /** Worst label for this cutter: the lowest ratio, and any characters lost. Null if unmeasured. */
  worst: { labelId: string; ratio: number; emptyChars: number } | null;
  reachKnown: boolean;
  reachOk: boolean;
  /**
   * The copies this cutter is held as, summarised (#415), or null when the list knows of no
   * possession of it — a catalogue row, a built-in, or a bench whose inventory has not loaded.
   * Null is NOT "worn": it ranks as an unstated condition and carries no note.
   */
  condition: ConditionSummary | null;
  /** Why it was excluded before measuring, if it was: 'not-flat' | 'no-feeds' | 'broken'. */
  excluded?: ToolExclusion;
}

export interface ToolRecommendation {
  key: string | null;
  compromise: boolean;
  /** One sentence, shown in the panel. */
  reason: string;
  /**
   * The warning a pick of this cutter should carry, or null (#415/#442): its only usable copy is
   * worn, or every usable copy is. Kept apart from `reason` because it is a different claim —
   * `reason` says why this cutter, this says check it before you cut — and a caller that prints
   * only the reason would otherwise be printing a recommendation with no caution in it.
   */
  conditionNote: string | null;
  /** Every tool considered, for the "why?" disclosure. */
  candidates: ToolCandidate[];
}

/** Reach below which the cutter body would foul the stock: the shoulder if known, else the flute. */
function reachOf(entry: ToolLibraryEntry): number | null {
  return entry.tool.shoulderLength ?? entry.tool.fluteLength;
}

/**
 * Deterministic diameter formatting for a reason sentence: 1 -> "1.0", 3.175 -> "3.175".
 * Exported so the run sheet's reachability table spells a diameter the way this module's own
 * sentences do — one cutter has one name on one sheet (#410).
 */
export function fmtDiameter(d: number): string {
  return Number.isInteger(d) ? d.toFixed(1) : String(d);
}

/** A candidate's condition rank: unstated conditions rank as `null` does (#415). */
function rankOf(c: ToolCandidate): number {
  return conditionRank(c.condition?.best ?? null);
}

/**
 * Largest diameter wins; ties go to the better-kept copy, then a known reach, then by key for
 * determinism (#211, #442). Condition is a TIEBREAK and not a priority: a bigger cutter that keeps
 * the detail is still preferred to a fresh small one — it cuts stiffer and clears faster, and a
 * slightly worn end mill still cuts — but between two cutters of one diameter, the bench prefers
 * the one it has not worn out.
 */
function byBestForRecommendation(a: ToolCandidate, b: ToolCandidate): number {
  if (a.diameter !== b.diameter) return b.diameter - a.diameter;
  if (rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b);
  if (a.reachKnown !== b.reachKnown) return a.reachKnown ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** The compromise pick is the SMALLEST cutter; condition then key break ties for determinism. */
function bySmallest(a: ToolCandidate, b: ToolCandidate): number {
  if (a.diameter !== b.diameter) return a.diameter - b.diameter;
  if (rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b);
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function qualifyingReason(pick: ToolCandidate): string {
  // An unknown reach is not a refusal — the cutter is still recommended — but it is stated,
  // because a length nobody recorded cannot be checked against the holder gate.
  // "every item" (#214), not "every label": a job may contain only shapes.
  return pick.reachKnown
    ? 'Largest cutter that keeps every item intact.'
    : 'Largest cutter that keeps every item intact (reach not recorded).';
}

/**
 * The item (label, shape or combined shape) a measurement row names, if the job still has it
 * (#214/#215). Exported so `reachability.ts` prints item names the same way this module's own
 * sentences do — one namer, so a report and a recommendation cannot describe one item differently.
 */
export function findItem(job: EngraveJob, id: string): EngraveAnyItem | undefined {
  return (
    job.labels.find((l) => l.id === id) ??
    job.shapes.find((s) => s.id === id) ??
    (job.combined ?? []).find((c) => c.id === id) ??
    (job.vectors ?? []).find((v) => v.id === id)
  );
}

/** A short human name for the worst item, without assuming it is a label (#214/#215). Exported with {@link findItem}. */
export function itemName(item: EngraveAnyItem): string {
  if (!('kind' in item)) return `"${item.text}"`;
  switch (item.kind) {
    case 'rect':
      return `the ${item.width}×${item.height} mm rectangle`;
    case 'circle':
      return `the ⌀${item.diameter} mm circle`;
    case 'slot':
      return `the ${item.length}×${item.width} mm slot`;
    case 'polygon':
      return `the ${item.points.length}-point polygon`;
    case 'border':
      return `the ${item.width} mm border`;
    case 'frame':
      return `the ${item.width} mm frame`;
    case 'cutaway':
      return `the cut-away with ${item.islands.length} island${item.islands.length === 1 ? '' : 's'}`;
    // Imported vector outline (#217), now a member of `EngraveAnyItem`. An outline imported from a
    // PROJECT file carries the name the file gave it (#410: a PrusaSlicer volume's name), and that
    // name is what the operator sees on the part — so it wins over a size this module could state.
    case 'vector':
      return item.name !== undefined && item.name !== ''
        ? `"${item.name}"`
        : `the imported outline ${item.width}×${item.height} mm`;
  }
}

/**
 * "Which items lose what", naming the worst item.
 *
 * NOTE (#211): the issue also asks this sentence to carry "the smallest cap height that would
 * let it qualify". That needs a re-measure at a larger cap height — `suggestCapHeight`'s
 * `measureAt` — which the fixed `measure(toolKey) => LabelEngravability[]` signature does not
 * carry. Rather than scale the ratio (which #201's review rejected as physically baseless),
 * the cap-height suggestion is omitted here and flagged on the issue; #205's worker can add
 * it when the signature gains a re-measure hook.
 */
function compromiseReason(job: EngraveJob, pick: ToolCandidate): string {
  const worst = pick.worst;
  if (!worst) {
    return `No cutter you have keeps every item intact; the smallest (${fmtDiameter(pick.diameter)} mm) is the closest.`;
  }
  const item = findItem(job, worst.labelId);
  const name = item ? itemName(item) : `item ${worst.labelId}`;
  // A cap height only exists for a label (#214).
  const at = item && !('kind' in item) ? ` at ${item.size} mm` : '';
  const lost = Math.round((1 - worst.ratio) * 100);
  // Whole characters are a label-only loss; a shape has no glyphs to lose one at a time.
  const isLabel = item === undefined || !('kind' in item);
  const chars =
    isLabel && worst.emptyChars > 0
      ? ` and loses ${worst.emptyChars} character${worst.emptyChars === 1 ? '' : 's'} entirely`
      : '';
  return `No cutter you have can cut ${name}${at} without losing detail: the ${fmtDiameter(pick.diameter)} mm cutter loses ${lost} % of it${chars}.`;
}

/**
 * Why nothing was picked. The broken clause is ADDED to the base sentence rather than replacing it
 * (#442): a cutter marked broken is one reason among the others, and saying "everything that would
 * qualify is broken" when a V-bit was also refused for the job's regions would be a claim the
 * candidate list does not support.
 */
function noCandidateReason(toolCount: number, brokenCount: number): string {
  if (toolCount === 0) return 'There are no cutters in the tool list to recommend from.';
  const base =
    'No cutter in the list is a flat end mill (or, for a trace-only job, a V-bit) with cutting parameters for this material.';
  return brokenCount === 0
    ? base
    : `${base} ${brokenCount} other cutter${brokenCount === 1 ? '' : 's'} ${brokenCount === 1 ? 'is' : 'are'} marked broken.`;
}

/**
 * The rule. See the module doc for the premise; the acceptance tests are `recommendTool.spec.ts`.
 *
 * `measure(toolKey)` returns #201's `LabelEngravability[]` for that cutter, one row per enabled
 * engrave. It is called only for candidates that survive the two pre-filters (flat, feeds), so
 * a ball-nose in the list is never measured — it can never be recommended.
 *
 * `catalogue` is the caller's Makera rows, for the feeds pre-filter below — on the worker's side of
 * the boundary they have to be handed in (#324), exactly as `tools` are (#305). Since #325 a row
 * cannot make that filter exclude anything by itself (the module doc says why); it is handed in
 * because it is the same set of rows the program is generated from, and one seam is worth keeping.
 *
 * `conditions` is the caller's own inventory summaries by registry key (#442,
 * `toolCondition.inventoryConditions`), handed in for the third time and the same reason: the tool
 * choice runs in the sim worker, where `toolCondition`'s module map is empty. Omitted means the
 * caller knows of no possession (the web build with no service, `recommendTool.spec.ts`'s pure
 * cases) — every cutter then ranks as an unstated condition, and none is excluded as broken.
 */
export function recommendTool(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  measure: (toolKey: string) => LabelEngravability[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
): ToolRecommendation {
  // The deepest cut is over every enabled item — a shape or combined shape can be the deepest
  // thing in the job (#214/#215), and the reach test below must see it.
  const deepest = ([...job.labels, ...job.shapes, ...(job.combined ?? [])] as EngraveAnyItem[])
    .filter((item) => item.enabled)
    .reduce((max, item) => Math.max(max, item.depth), 0);
  // #405 — a job whose enabled items are all TRACES (its region lists are empty) may take a V-bit;
  // one that holds a region item may not (opening a glyph needs a single cutting width). Traces live
  // in their own list (#219), so "has a region" is any enabled item in the four region lists — an
  // imported vector outline (#217) included.
  const hasRegions = ([...job.labels, ...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])] as EngraveAnyItem[]).some(
    (item) => item.enabled,
  );

  const candidates: ToolCandidate[] = tools.map((entry) => {
    const tool = entry.tool;
    const diameter = cuttingDiameter(tool) ?? 0;
    const reach = reachOf(entry);
    const reachKnown = reach !== null;
    // An unknown reach cannot be shown to foul, so it stays OK (the note above carries it).
    const reachOk = reach === null || deepest <= reach;
    const condition = conditions?.get(entry.key) ?? null;
    const base = { key: entry.key, diameter, worst: null, reachKnown, reachOk, condition } as const;

    const usable = cuttingForTrace(tool);
    if (!usable.ok) return { ...base, qualifies: false, excluded: 'not-flat' as const };
    // A V-bit is a trace-only cutter: its width is a function of depth, so a region item (a glyph to
    // open) cannot be cut by one and it is excluded by the same name a non-flat cutter always was.
    if (usable.tool.shape === 'v' && hasRegions) {
      return { ...base, qualifies: false, excluded: 'not-flat' as const };
    }
    // #442 — a cutter the operator has marked broken, copy by copy, is out before its feeds are
    // looked at and before it is measured: whether the catalogue has a row for a bit is not a
    // question worth answering for a bit that is not in a condition to cut. Everything else — a
    // worn copy, an unstated one — is still a candidate, ranked and noted below.
    if (condition !== null && condition.usable === 0) {
      return { ...base, qualifies: false, excluded: 'broken' as const };
    }
    // #347 — the JOB's machine. The profile only supplies the clamp ceilings here, which no
    // calibration touches, so this needs no saved frame to be right.
    if (!feedsFor(catalogue, job.stock.material, tool, jobMachine(job)).ok) {
      return { ...base, qualifies: false, excluded: 'no-feeds' as const };
    }

    const rows = measure(entry.key);
    let worst: ToolCandidate['worst'] = null;
    let ratioOk = true;
    for (const row of rows) {
      if (!(row.ratio >= LOST_DETAIL_RATIO) || row.emptyChars.length > 0) ratioOk = false;
      const lost = row.emptyChars.length;
      if (
        worst === null ||
        row.ratio < worst.ratio ||
        (row.ratio === worst.ratio && lost > worst.emptyChars) ||
        (row.ratio === worst.ratio && lost === worst.emptyChars && row.labelId < worst.labelId)
      ) {
        worst = { labelId: row.labelId, ratio: row.ratio, emptyChars: lost };
      }
    }

    return { ...base, qualifies: ratioOk && reachOk, worst };
  });

  const eligible = candidates.filter((c) => c.excluded === undefined);

  const qualifying = eligible.filter((c) => c.qualifies);
  if (qualifying.length > 0) {
    const pick = [...qualifying].sort(byBestForRecommendation)[0]!;
    return {
      key: pick.key,
      compromise: false,
      reason: qualifyingReason(pick),
      conditionNote: pick.condition?.note ?? null,
      candidates,
    };
  }

  if (eligible.length > 0) {
    const pick = [...eligible].sort(bySmallest)[0]!;
    return {
      key: pick.key,
      compromise: true,
      reason: compromiseReason(job, pick),
      conditionNote: pick.condition?.note ?? null,
      candidates,
    };
  }

  const broken = candidates.filter((c) => c.excluded === 'broken').length;
  return { key: null, compromise: false, reason: noCandidateReason(tools.length, broken), conditionNote: null, candidates };
}
