/**
 * Recommend a cutter for an engrave job (#211).
 *
 * The rule: **recommend the largest flat end mill that can cut every enabled label without
 * losing detail.** A larger cutter is stiffer, clears faster and breaks less; the only reason
 * to go smaller is that the text needs it — which is exactly what #201 measures.
 *
 * This module is PURE: it is handed the per-candidate measurements (`measure`) and never
 * touches Manifold. That is what makes the rule testable without wasm, and it is why the type
 * and the ratio threshold come from #201 rather than being re-declared here — the rule and
 * `engravabilityFindings` must not disagree about what "keeps the detail" means.
 *
 * In the worker (#205) `measure` is `measureLabels(tl, plan, radius, …)` bound to the
 * candidate's own radius, computed once per job edit beside the preview. The candidate list is
 * HANDED IN (#305), not read from a module: the worker is sent the registry snapshot the picker
 * is showing, so the two cannot disagree about which cutters exist.
 */

import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { cuttingRadiusForSweep } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveAnyItem, EngraveJob } from '@/types/engraveJob';
import { LOST_DETAIL_RATIO, type LabelEngravability } from '@/workers/sim/engraveGeometry';

/** Why a tool was dropped before measuring (#211: flat-ends only, and only cutters that exist). */
export type ToolExclusion = 'not-flat' | 'no-feeds';

export interface ToolCandidate {
  key: string;
  /** Cutting diameter, mm. Best-effort (`tipDiameter ?? diameter`) even when excluded. */
  diameter: number;
  qualifies: boolean;
  /** Worst label for this cutter: the lowest ratio, and any characters lost. Null if unmeasured. */
  worst: { labelId: string; ratio: number; emptyChars: number } | null;
  reachKnown: boolean;
  reachOk: boolean;
  /** Why it was excluded before measuring, if it was: 'not-flat' | 'no-feeds'. */
  excluded?: ToolExclusion;
}

export interface ToolRecommendation {
  key: string | null;
  compromise: boolean;
  /** One sentence, shown in the panel. */
  reason: string;
  /** Every tool considered, for the "why?" disclosure. */
  candidates: ToolCandidate[];
}

/** Reach below which the cutter body would foul the stock: the shoulder if known, else the flute. */
function reachOf(entry: ToolLibraryEntry): number | null {
  return entry.tool.shoulderLength ?? entry.tool.fluteLength;
}

/** Deterministic diameter formatting for a reason sentence: 1 -> "1.0", 3.175 -> "3.175". */
function fmtDiameter(d: number): string {
  return Number.isInteger(d) ? d.toFixed(1) : String(d);
}

/** Largest diameter wins; ties go to a known reach, then by key for determinism (#211). */
function byBestForRecommendation(a: ToolCandidate, b: ToolCandidate): number {
  if (a.diameter !== b.diameter) return b.diameter - a.diameter;
  if (a.reachKnown !== b.reachKnown) return a.reachKnown ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** The compromise pick is the SMALLEST cutter; key breaks ties for determinism. */
function bySmallest(a: ToolCandidate, b: ToolCandidate): number {
  if (a.diameter !== b.diameter) return a.diameter - b.diameter;
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

/** The item (label, shape or combined shape) a measurement row names, if the job still has it (#214/#215). */
function findItem(job: EngraveJob, id: string): EngraveAnyItem | undefined {
  return (
    job.labels.find((l) => l.id === id) ??
    job.shapes.find((s) => s.id === id) ??
    (job.combined ?? []).find((c) => c.id === id) ??
    (job.vectors ?? []).find((v) => v.id === id)
  );
}

/** A short human name for the worst item, without assuming it is a label (#214/#215). */
function itemName(item: EngraveAnyItem): string {
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
    // Imported vector outline (#217), now a member of `EngraveAnyItem`.
    case 'vector':
      return `the imported outline ${item.width}×${item.height} mm`;
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

function noCandidateReason(toolCount: number): string {
  return toolCount === 0
    ? 'There are no cutters in the tool list to recommend from.'
    : 'No cutter in the list is a flat end mill with cutting parameters for this material.';
}

/**
 * The rule. See the module doc for the premise; the acceptance tests are `recommendTool.spec.ts`.
 *
 * `measure(toolKey)` returns #201's `LabelEngravability[]` for that cutter, one row per enabled
 * engrave. It is called only for candidates that survive the two pre-filters (flat, feeds), so
 * a ball-nose in the list is never measured — it can never be recommended.
 */
export function recommendTool(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  measure: (toolKey: string) => LabelEngravability[],
): ToolRecommendation {
  // The deepest cut is over every enabled item — a shape or combined shape can be the deepest
  // thing in the job (#214/#215), and the reach test below must see it.
  const deepest = ([...job.labels, ...job.shapes, ...(job.combined ?? [])] as EngraveAnyItem[])
    .filter((item) => item.enabled)
    .reduce((max, item) => Math.max(max, item.depth), 0);

  const candidates: ToolCandidate[] = tools.map((entry) => {
    const tool = entry.tool;
    const diameter = tool.tipDiameter ?? tool.diameter ?? 0;
    const reach = reachOf(entry);
    const reachKnown = reach !== null;
    // An unknown reach cannot be shown to foul, so it stays OK (the note above carries it).
    const reachOk = reach === null || deepest <= reach;
    const base = { key: entry.key, diameter, worst: null, reachKnown, reachOk } as const;

    const radius = cuttingRadiusForSweep(tool);
    if (!radius.ok) return { ...base, qualifies: false, excluded: 'not-flat' as const };
    if (!feedsFor(job.stock.material, tool, Z1).ok) {
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

    return { ...base, diameter: radius.radius * 2, qualifies: ratioOk && reachOk, worst };
  });

  const eligible = candidates.filter((c) => c.excluded === undefined);

  const qualifying = eligible.filter((c) => c.qualifies);
  if (qualifying.length > 0) {
    const pick = [...qualifying].sort(byBestForRecommendation)[0]!;
    return { key: pick.key, compromise: false, reason: qualifyingReason(pick), candidates };
  }

  if (eligible.length > 0) {
    const pick = [...eligible].sort(bySmallest)[0]!;
    return { key: pick.key, compromise: true, reason: compromiseReason(job, pick), candidates };
  }

  return { key: null, compromise: false, reason: noCandidateReason(tools.length), candidates };
}
