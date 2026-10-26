/**
 * Recommend a cutter for an engrave job (#211).
 *
 * The rule: **recommend the largest flat end mill that can cut every enabled label without
 * losing detail.** A larger cutter is stiffer, clears faster and breaks less; the only reason
 * to go smaller is that the text needs it — which is exactly what #201 measures.
 *
 * TRACES AND REGIONS TAKE A V-BIT (#405, #221). A job whose enabled items are all TRACES (a `line`
 * or a `stroke-label` — a line the cutter follows, `#219`) may be cut by a V-bit, whose groove is a
 * function of depth and so is exactly a single-stroke line. Since #221 a region item may take one
 * too: the V-carve pockets the design at the item's depth with the tip as the cutter, and the
 * design is correct at the COLOUR PLANE (`tipRadius + (depth − film)·tanHalf`). The cone is not
 * measured against a glyph as if it were a flat disc; it qualifies for the region by that model,
 * and the panel states the plane, the floor inset and the effective pitch beside the requested one.
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
 *
 * "ARE THERE NUMBERS" IS NOT "IS IT FOR THIS MATERIAL" (#455). The starting table will answer a
 * plastic job for any flat cutter, and that is how a corn bit the catalogue lists only for PCB and
 * carbon fibre was picked as a PLA badge's rest cutter and broke on PETG. Before feeds are asked,
 * the catalogue is asked what it LISTS this cutter for ({@link catalogueStandingFor}): a cutter the
 * catalogue lists and does not list for this material is excluded by name with 'no-catalogue-row',
 * and the sentence carries the vendor's own material words. A rest pair's second tool is chosen from
 * candidates that survived this same filter (`reachability.ts`'s `finerThan`, `restPass`), so the
 * pair inherits the rule without its own copy of it. An owned cutter with no catalogue twin is NOT
 * excluded — the catalogue cannot vouch for it and cannot veto it — it carries an honest note
 * instead, and a hand-picked cutter that the catalogue does not recommend still cuts: the pick
 * names the warning (`selectedNote`) rather than blocking the program.
 */

import {
  catalogueCoverageFor,
  catalogueStandingFor,
  feedsFor,
  type FeedCatalogueRow,
  type FeedsEntry,
} from '@/engine/cnc/feeds';
import { jobMachine } from '@/engine/cnc/calibration';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { cuttingForTrace, statedCuttingSize } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { conditionRank, type ConditionSummary } from '@/engine/cnc/toolCondition';
import type { EngraveAnyItem, EngraveJob, EngravePrimitive, StockMaterial } from '@/types/engraveJob';
import { cutterRefusedOnMaterial } from './cutterMaterial';
import { primitiveLabel, primitiveReducesToRegion } from './partPlan';
import { lostDetailRatioFrom, type LabelEngravability } from '@/workers/sim/engraveGeometry';

/**
 * Why a tool was dropped before measuring (#211: flat-ends only, and only cutters that exist;
 * #442: and only cutters that are not marked broken; #455: and only cutters the catalogue lists
 * for this material, when it lists the cutter at all; #699: and only cutters whose record states
 * a cutting size; #699b: and only cutters one of the job's OWN checks accepts — a metal-line
 * cutter on a blank that is not metal is refused by the program itself).
 */
export type ToolExclusion =
  | 'not-flat'
  | 'no-feeds'
  | 'broken'
  | 'no-catalogue-row'
  | 'unknown-size'
  | 'metal-line';

export interface ToolCandidate {
  key: string;
  /** The cutting size the record STATES (`statedCuttingSize`), and 0 when it states none. */
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
  /**
   * Why it was excluded before measuring, if it was: 'not-flat' | 'no-feeds' | 'broken' |
   * 'no-catalogue-row' | 'unknown-size' | 'metal-line'.
   */
  excluded?: ToolExclusion;
  /**
   * The job's OWN reason for refusing this cutter (#699b), in the panel's "Why?" words, when
   * `excluded === 'metal-line'`: "on Makera's \"for Metal\" line, and this job cuts PLA". The
   * engine and the panel read the same check (`cutterRefusedOnMaterial`), so the row cannot
   * disagree with the finding the program raises. Undefined for every other exclusion.
   */
  refusal?: string;
  /**
   * The catalogue's own sentence about this cutter and the job's material (#455), or null/absent
   * when it has nothing to add. When `excluded === 'no-catalogue-row'` it is the exclusion's reason
   * ("Makera's catalogue lists TiN Coating Corn Bit for PCB or Carbon Fiber, not PLA…"); on a
   * qualifying cutter it is the labelled nearest-plastic mapping, or the honest note that no
   * catalogue row can name an owned cutter. Optional so a hand-built candidate in a test stays a
   * candidate, exactly as `condition` is.
   */
  catalogueNote?: string | null;
  /**
   * True when this candidate is a V-bit on a job that holds a REGION item — a V-carve (#221).
   * The cone is not measured against the glyphs as a flat disc: the design is correct at the
   * colour plane, so the candidate qualifies by that model. Optional for the same reason as
   * `condition` and `catalogueNote`.
   */
  vCarve?: boolean;
}

/**
 * #221 — why a V-bit is the cutter on a region job, in the panel's "Why?" list and its
 * recommendation sentence. One constant so the panel, the CLI and the run sheet cannot describe
 * the strategy differently: the design is not the tip, it is the cone's width at the colour plane.
 */
export const V_BIT_CARVE_SENTENCE =
  'V-carve — the design is cut at the colour plane, so the groove width there is the design';

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
  /**
   * The catalogue's own sentence about the PICK and the job's material (#455): a labelled
   * nearest-plastic mapping ("its ABS row standing in — a mapping this app makes"), or the note
   * that no catalogue row can name this cutter. Null when the catalogue has nothing to add — an
   * unsynced catalogue, or a row of the material's own. Not folded into `reason` for the
   * `conditionNote` reason: "why this cutter" and "what Makera actually lists it for" are
   * different claims.
   */
  catalogueNote: string | null;
  /**
   * The warning the job's OWN cutter carries when it was named by hand and the catalogue does not
   * recommend it for this material (#455), or null. The rule warns, it does not block: the job
   * still generates with this cutter, and this sentence says what the catalogue lists it for and
   * that the decision is now the operator's.
   */
  selectedNote: string | null;
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
  // #221 — a V-carve qualifies on its colour-plane model, not on a glyph-opening measurement.
  if (pick.vCarve) {
    return pick.reachKnown
      ? `${V_BIT_CARVE_SENTENCE}.`
      : `${V_BIT_CARVE_SENTENCE} (reach not recorded).`;
  }
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

/**
 * The enabled primitives that become a region (`toPartPlan`'s rule, #435): a vertical box or
 * cylinder. Cone and sphere are refused by name and an X/Y primitive is not a pocket, so neither
 * may influence the cutter choice or the V-carve strategy.
 */
function cuttablePrimitives(job: EngraveJob): EngravePrimitive[] {
  return (job.primitives ?? []).filter((p) => p.enabled && primitiveReducesToRegion(p));
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
  // #221 — a V-carve has no glyph ratio to lose; it is closest only because its reach or its
  // feeds kept it from qualifying outright, and the sentence has to say what it actually does.
  if (pick.vCarve) {
    return (
      `No cutter you have keeps every item intact; the ${fmtDiameter(pick.diameter)} mm V-bit is ` +
      'the closest, cutting the design at the colour plane.'
    );
  }
  const worst = pick.worst;
  if (!worst) {
    return `No cutter you have keeps every item intact; the smallest (${fmtDiameter(pick.diameter)} mm) is the closest.`;
  }
  const item = findItem(job, worst.labelId);
  const primitive = item === undefined ? (job.primitives ?? []).find((p) => p.id === worst.labelId) : undefined;
  const name = item ? itemName(item) : primitive ? primitiveLabel(primitive) : `item ${worst.labelId}`;
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
 *
 * The catalogue's own answer gets the same treatment (#455), and it changes the BASE sentence: when
 * a cutter was dropped because the catalogue lists it for other materials, "no cutter has cutting
 * parameters for this material" would be false — the starting table answers a PLA job happily. What
 * is true is that nothing can be RECOMMENDED for the material, and the catalogue's sentences say
 * which cutters and why.
 *
 * The job's own gates get the same clause (#699b), and the same base rule: when the whole list is
 * on the metal line there is no material refusal to describe — the job's own check is what refused
 * every one of them.
 */
function noCandidateReason(
  toolCount: number,
  brokenCount: number,
  unknownSizeCount: number,
  catalogueNotes: readonly string[],
  metalLineCount: number,
  material: StockMaterial,
): string {
  if (toolCount === 0) return 'There are no cutters in the tool list to recommend from.';
  // #699 — when every cutter fell for the same missing number, saying "no flat end mill or V-bit
  // has cutting parameters" would misdescribe the list: the list may be all cones.
  const allSizeless = unknownSizeCount > 0 && unknownSizeCount === toolCount;
  // #699b — the whole house on the metal line is a MATERIAL fact, not a detail clause: the base
  // sentence must not claim the list lacks flat end mills when it is full of them.
  const allMetalLine = metalLineCount > 0 && metalLineCount === toolCount;
  const base = allMetalLine
    ? `Every cutter in the list is on Makera's "for Metal" line, and this job cuts ${MATERIAL_LABELS[material]}.`
    : allSizeless
      ? 'No cutter in the list states a cutting diameter.'
      : catalogueNotes.length > 0
        ? 'No cutter in the list can be recommended for this material.'
        : 'No cutter in the list is a flat end mill — or, on a trace-only or region job, a V-bit — with cutting parameters for this material.';
  const sizeless =
    unknownSizeCount === 0 || allSizeless
      ? ''
      : ` ${unknownSizeCount} cutter${unknownSizeCount === 1 ? '' : 's'} ${unknownSizeCount === 1 ? 'states' : 'state'} no cutting diameter.`;
  const metalLine =
    metalLineCount === 0 || allMetalLine
      ? ''
      : ` ${metalLineCount} cutter${metalLineCount === 1 ? '' : 's'} ${metalLineCount === 1 ? 'is' : 'are'} on Makera's "for Metal" line, which this ${MATERIAL_LABELS[material]} job refuses.`;
  const broken =
    brokenCount === 0
      ? ''
      : ` ${brokenCount} other cutter${brokenCount === 1 ? '' : 's'} ${brokenCount === 1 ? 'is' : 'are'} marked broken.`;
  return base + sizeless + catalogueClause(catalogueNotes) + metalLine + broken;
}

/**
 * The catalogue's own words, added to the no-pick reason (#455). One cutter's sentence reads as
 * itself; several are all listed, because a shop whose every bit is a corn bit needs to know that
 * every one of them was ruled out, not only the first.
 */
function catalogueClause(notes: readonly string[]): string {
  if (notes.length === 0) return '';
  return notes.length === 1
    ? ` The catalogue's own answer rules it out: ${notes[0]}`
    : ` The catalogue's own answer rules ${notes.length} cutters out: ${notes.join(' ')}`;
}

/**
 * The caution the job's OWN cutter carries when it was named by hand and the catalogue does not
 * recommend it for this material (#455), or null.
 *
 * "Picking one by hand must warn by name" — this is the by-name half, and it is a WARNING, not a
 * refusal: the job's toolKey is the operator's assertion, and the engine still generates the
 * program with it. What the sentence adds is the catalogue's own material list and the fact that
 * the decision is now the operator's, the same shape `conditionNote` has for a worn bit.
 */
function handPickedNote(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
): string | null {
  const entry = tools.find((e) => e.key === job.toolKey);
  if (!entry) return null;
  const standing = catalogueStandingFor(
    catalogueCoverageFor(catalogue, job.stock.material, entry.tool),
    job.stock.material,
    entry.tool.name,
  );
  if (standing.recommend || standing.note === null) return null;
  return (
    `${standing.note} This job names it by hand, so it still cuts if you run it — check the bit ` +
    `and the feeds first.`
  );
}

/**
 * Does this job hold any enabled REGION item? Traces live in their own list (#219), so this is any
 * enabled item in the four region lists — a label, a shape, a combined shape or an imported vector
 * outline (#217). Exported for the panel's V-carve note: it and the recommendation must agree about
 * whether the selected V-bit is cutting a region or tracing a line.
 */
export function hasRegionItems(job: EngraveJob): boolean {
  return (
    ([...job.labels, ...job.shapes, ...(job.combined ?? []), ...(job.vectors ?? [])] as EngraveAnyItem[]).some(
      (item) => item.enabled,
    ) || cuttablePrimitives(job).length > 0
  );
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
  lostDetailWarnRatio: number | null = null,
  /**
   * #450 slice 3 — the table the feeds check resolves against, when the caller has the location's
   * (`resolvedFeedsTable().table`; a worker receives it as `EngraveShopOpts.feeds`). Absent: the
   * compiled starting table, which is what a no-service build runs on.
   */
  table?: readonly FeedsEntry[],
): ToolRecommendation {
  // The bar a cutter has to clear is #201's own (engraveGeometry's `LOST_DETAIL_RATIO_FALLBACK`
  // unless the caller sends the shop's `engrave.lostDetailWarnRatio`, #451). Passing it here rather
  // than letting this module keep a second copy is what stops the recommendation and the findings
  // from qualifying the same cutter at two different ratios.
  const bar = lostDetailRatioFrom(lostDetailWarnRatio);
  // The deepest cut is over every enabled item — a shape or combined shape can be the deepest
  // thing in the job (#214/#215), and the reach test below must see it.
  const deepest = cuttablePrimitives(job).reduce(
    (max, primitive) => Math.max(max, primitive.depth),
    ([...job.labels, ...job.shapes, ...(job.combined ?? [])] as EngraveAnyItem[])
      .filter((item) => item.enabled)
      .reduce((max, item) => Math.max(max, item.depth), 0),
  );
  // #405/#221 — a job whose enabled items are all TRACES (its region lists are empty) may take a
  // V-bit as a trace tool; one that holds a region item may take it as a V-CARVE. The list is
  // shared with the panel (`hasRegionItems`) so the two cannot disagree about which strategy the
  // job is in.
  const hasRegions = hasRegionItems(job);

  const candidates: ToolCandidate[] = tools.map((entry) => {
    const tool = entry.tool;
    // #699 — the size a recommendation can state, not `cuttingDiameter`'s fallback to a shank.
    const statedSize = statedCuttingSize(tool);
    const diameter = statedSize ?? 0;
    const reach = reachOf(entry);
    const reachKnown = reach !== null;
    // An unknown reach cannot be shown to foul, so it stays OK (the note above carries it).
    const reachOk = reach === null || deepest <= reach;
    const condition = conditions?.get(entry.key) ?? null;
    const base = { key: entry.key, diameter, worst: null, reachKnown, reachOk, condition } as const;

    const usable = cuttingForTrace(tool);
    if (!usable.ok) return { ...base, qualifies: false, excluded: 'not-flat' as const };
    // #699 — A CUTTER THAT CANNOT STATE ITS CUTTING SIZE IS NEVER THE COMPUTED PICK. A chamfer
    // with no tip is a point in the geometry, but a recommendation's job is to name the width the
    // cut will be; a V-carve's groove at the colour plane IS its width, so "unknown" is not a
    // default an operator can accept without checking. The cutter stays in the list and is named
    // in Why?, so a hand pick remains possible (#455's warning rule).
    if (statedSize === null) return { ...base, qualifies: false, excluded: 'unknown-size' as const };
    // #221 — a V-bit on a region job IS the cutter, not a `not-flat` exclusion. The V-carve
    // pockets the floor at the item's depth with the tip, and the design is correct at the colour
    // plane. It is not measured as a flat disc against the glyph, because a cone has no single
    // width to measure against; the model itself is the qualification.
    const vCarve = usable.tool.shape === 'v' && hasRegions;
    // #442 — a cutter the operator has marked broken, copy by copy, is out before its feeds are
    // looked at and before it is measured: whether the catalogue has a row for a bit is not a
    // question worth answering for a bit that is not in a condition to cut. Everything else — a
    // worn copy, an unstated one — is still a candidate, ranked and noted below.
    if (condition !== null && condition.usable === 0) {
      return { ...base, qualifies: false, excluded: 'broken' as const };
    }
    // #699b — A CUTTER ONE OF THE JOB'S OWN GATES REFUSES IS NEVER THE COMPUTED PICK. Makera's
    // "for Metal" line is refused on a blank that is not metal (#572): the program raises
    // `tool-metal-line` as an error and will not run, so handing that cutter back as the default
    // pick is a dead end — exactly the k3 walk, where the house's metal 1 mm flat won a tie with
    // the plain one and Generate then refused it on PLA. The predicate is the SAME one the
    // program uses (`cutterRefusedOnMaterial`), so this filter and the finding cannot disagree;
    // and the operator's double-confirmed override (#572) keeps the cutter in the list, because
    // the job's gate allows it then.
    if (cutterRefusedOnMaterial(tool, job.stock.material, job.metalLineOverride)) {
      return {
        ...base,
        qualifies: false,
        excluded: 'metal-line' as const,
        refusal: `on Makera's "for Metal" line, and this job cuts ${MATERIAL_LABELS[job.stock.material]}`,
      };
    }
    // #455 — what the catalogue LISTS this cutter for, before what numbers exist. A cutter the
    // catalogue lists and does not list for this material is out by name, with the vendor's own
    // material words in `catalogueNote`; an owned cutter it cannot name stays in with the note. The
    // rest-pair's second tool comes from these same survivors (`finerThan`), so the rule covers it
    // without a second copy.
    const catalogueStanding = catalogueStandingFor(
      catalogueCoverageFor(catalogue, job.stock.material, tool),
      job.stock.material,
      tool.name,
    );
    if (!catalogueStanding.recommend) {
      return {
        ...base,
        qualifies: false,
        excluded: 'no-catalogue-row' as const,
        catalogueNote: catalogueStanding.note,
      };
    }
    // #347 — the JOB's machine. The profile only supplies the clamp ceilings here, which no
    // calibration touches, so this needs no saved frame to be right.
    if (!feedsFor(catalogue, job.stock.material, tool, jobMachine(job), undefined, table).ok) {
      return {
        ...base,
        qualifies: false,
        excluded: 'no-feeds' as const,
        catalogueNote: catalogueStanding.note,
      };
    }

    // #221 — the V-carve is qualified by its own model, not by a flat-disc measurement. Its
    // `worst` stays null (there is no glyph-opening ratio to state for a cone), so the panel prints
    // the V-carve sentence instead of "not measured". Reach still gates it: a cutter whose shoulder
    // cannot clear the deepest cut is not a candidate, cone or not.
    if (vCarve) {
      return {
        ...base,
        qualifies: reachOk,
        worst: null,
        catalogueNote: catalogueStanding.note,
        vCarve: true,
      };
    }

    const rows = measure(entry.key);
    let worst: ToolCandidate['worst'] = null;
    let ratioOk = true;
    for (const row of rows) {
      if (!(row.ratio >= bar) || row.emptyChars.length > 0) ratioOk = false;
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

    return { ...base, qualifies: ratioOk && reachOk, worst, catalogueNote: catalogueStanding.note };
  });

  const eligible = candidates.filter((c) => c.excluded === undefined);
  // #455 — the caution the job's own (hand-picked) cutter must carry, independent of what the
  // recommendation picked. Computed before the returns so every outcome carries it.
  const selectedNote = handPickedNote(job, tools, catalogue);

  const qualifying = eligible.filter((c) => c.qualifies);
  if (qualifying.length > 0) {
    const pick = [...qualifying].sort(byBestForRecommendation)[0]!;
    return {
      key: pick.key,
      compromise: false,
      reason: qualifyingReason(pick),
      conditionNote: pick.condition?.note ?? null,
      catalogueNote: pick.catalogueNote ?? null,
      selectedNote,
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
      catalogueNote: pick.catalogueNote ?? null,
      selectedNote,
      candidates,
    };
  }

  const broken = candidates.filter((c) => c.excluded === 'broken').length;
  const unknownSize = candidates.filter((c) => c.excluded === 'unknown-size').length;
  const metalLine = candidates.filter((c) => c.excluded === 'metal-line').length;
  // The catalogue's refusals, in the order the cutters were listed, for the no-pick sentence.
  const catalogueNotes = candidates
    .filter((c) => c.excluded === 'no-catalogue-row')
    .map((c) => c.catalogueNote)
    .filter((note): note is string => note !== null && note !== undefined);
  return {
    key: null,
    compromise: false,
    reason: noCandidateReason(
      tools.length,
      broken,
      unknownSize,
      catalogueNotes,
      metalLine,
      job.stock.material,
    ),
    conditionNote: null,
    catalogueNote: null,
    selectedNote,
    candidates,
  };
}
