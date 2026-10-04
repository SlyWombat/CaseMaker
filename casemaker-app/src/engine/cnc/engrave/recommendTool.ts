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
 * candidate's own radius, computed once per job edit beside the preview. The candidate list
 * is the picker's list (`TOOL_LIBRARY` today, the local inventory once #212 exists).
 */

import { feedsFor } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { cuttingRadiusForSweep } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';
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
  return pick.reachKnown
    ? 'Largest cutter that keeps every label intact.'
    : 'Largest cutter that keeps every label intact (reach not recorded).';
}

/**
 * "Which labels lose what", naming the worst label.
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
    return `No cutter you have keeps every label intact; the smallest (${fmtDiameter(pick.diameter)} mm) is the closest.`;
  }
  const label = job.labels.find((l) => l.id === worst.labelId);
  const name = label ? `"${label.text}"` : `label ${worst.labelId}`;
  const at = label ? ` at ${label.size} mm` : '';
  const lost = Math.round((1 - worst.ratio) * 100);
  const chars =
    worst.emptyChars > 0
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
  const deepest = job.labels
    .filter((l) => l.enabled)
    .reduce((max, l) => Math.max(max, l.depth), 0);

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
