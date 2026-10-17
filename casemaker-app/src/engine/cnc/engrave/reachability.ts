/**
 * Which cutter can reach what, as NUMBERS (#410).
 *
 * #211's `recommendTool` already answers "which ONE cutter should I use", and it answers it well:
 * the largest flat that keeps every item intact, or the smallest one as a compromise. What it does
 * not say — because nothing needed it until a job arrived that no single cutter can cut — is HOW
 * MUCH of each item each cutter reaches. This module is that table, and it is what decides whether
 * a job wants one program or two (#410's rest machining): tool 1 takes what it can at full depth,
 * and tool 2 exists because some region was left, so the size of that region is the decision.
 *
 * ONE MEASUREMENT PASS, TWO ANSWERS. The per-item rows are the exact `LabelEngravability` rows
 * `recommendTool` was about to use, captured as it asks for them. So the table and the
 * recommendation can never disagree about a cutter — and a candidate `recommendTool` excludes
 * before measuring (`not-flat`, `no-feeds`, `broken`, and since #455 `no-catalogue-row`: the
 * catalogue lists the cutter, and not for this material) is reported here as excluded, with the
 * reason, rather than silently missing from the table.
 *
 * PURE, like `recommendTool`: it is handed the measurement seam and touches no Manifold itself.
 * That is what lets the rule be tested without wasm, and it is why the caller binds `measure` to
 * `measureLabels` — this module never decides what "reachable" means, it reads #201's answer.
 */

import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { isVTraceTool } from '@/engine/cnc/tool';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { LOST_DETAIL_RATIO_FALLBACK, type LabelEngravability } from '@/workers/sim/engraveGeometry';
import type { EngraveJob } from '@/types/engraveJob';
import { findItem, itemName, recommendTool, type ToolCandidate, type ToolRecommendation } from './recommendTool';

/** One item, as every cutter sees it. */
export interface ReachRow {
  itemId: string;
  /** How the item is named in a sentence or a table row — the SAME namer `recommendTool` uses. */
  name: string;
  /** The item's own cut depth below the top face, mm. */
  depth: number;
  /** Ideal area of the item, mm². */
  glyphArea: number;
  /** The area a cutter of this radius can actually open, mm². */
  openedArea: number;
  /**
   * Share of the item this cutter reaches, 0…1 — `openedArea / glyphArea`, or 1 when the item has
   * no area at all (an empty profile is not a failure of reach).
   */
  ratio: number;
  /**
   * True when the cutter reaches NONE of this item: the opening came out empty. That is #201's
   * `item-empty` error, and it is the case two-tool rest machining cannot rescue — a second, finer
   * cutter might, which is why the row carries the area rather than only the verdict.
   */
  empty: boolean;
  /** Characters lost entirely (labels only; an imported outline has no glyphs to lose). */
  emptyChars: string[];
}

/** One cutter's column of the table. */
export interface CutterReach {
  key: string;
  /** The cutter's own name from the library, e.g. `TiN Coating Corn Bit - 1/8" Shank 2mm * 10.5mm`. */
  name: string;
  /** Cutting diameter, mm (`cuttingDiameter`), or 0 when the tool states neither. */
  diameter: number;
  /** How the cutter is shaped — the reason a V-bit is excluded from a region job, not just `not-flat`. */
  shape: string | null;
  /**
   * True when the cutter is a cone the trace path takes (`isVTraceTool`) — a V-bit, not a ball
   * nose. It is what lets a table row say why a V-bit was dropped in the #486 words ("a V-bit is
   * not a rest cutter here"), instead of the generic `not-flat` phrase that has to cover both.
   */
  vTrace: boolean;
  /**
   * Why this cutter was dropped WITHOUT being measured, if it was. A V-bit on a region job is
   * reported here: the cone's width grows with depth, so it is refused by name rather than measured
   * as if it were a flat of its tip diameter (#405).
   */
  excluded: ToolCandidate['excluded'] | null;
  /**
   * The catalogue's own sentence when the catalogue is why this cutter was dropped (#455) —
   * "Makera's catalogue lists TiN Coating Corn Bit … for PCB or Carbon Fiber, not PLA…" — else null.
   * Kept apart from `excluded` so a caller can print the vendor's words about the material. This is
   * also what the CLI's reach table and the run sheet show: a headless run carries no catalogue at
   * all, so the table is the only place its reason can appear when one IS loaded.
   */
  excludedNote: string | null;
  /** One row per item, in the job's own item order. Empty when the cutter was excluded. */
  rows: ReachRow[];
  /** The largest share of any single item this cutter reaches, 0…1. The "best it can do". */
  bestRatio: number;
  /** The smallest share of any single item, 0…1. 0 when it reaches nothing anywhere. */
  worstRatio: number;
  /** True when every item survives at `LOST_DETAIL_RATIO_FALLBACK` with no character lost — #201's bar. */
  qualifies: boolean;
}

/** The table, the recommendation, and the two-tool split it implies. */
export interface Reachability {
  /** Every cutter the picker would offer, in the order it was handed over. */
  cutters: CutterReach[];
  /** The item ids and names, in the job's own order — the table's columns. */
  items: { id: string; name: string }[];
  /**
   * #211's answer, computed from the SAME rows. `key: null` when no cutter is eligible at all.
   * `compromise: true` means none keeps every item intact and the smallest was picked instead.
   */
  recommendation: ToolRecommendation;
  /**
   * How much of the whole design each cutter reaches, as a share of the design's total area, and
   * keyed by tool key. This is the number that decides the two-tool split: tool 1's share is what
   * it clears, and 1 − tool 2's share is what NOTHING reaches (`item-detail-lost`, in numbers).
   */
  totalShare: Map<string, number>;
}

/** The item order the table is built in: every enabled region item, by list and by index. */
function enabledItems(job: EngraveJob): { id: string; name: string; depth: number }[] {
  const out: { id: string; name: string; depth: number }[] = [];
  // The same four lists `recommendTool` measures, in the same order, so a row's column matches the
  // row a finding is about (labels, then shapes, then combined, then imported vectors — #214/#215/#217).
  const lists: { id: string; enabled: boolean; depth: number }[][] = [
    job.labels,
    job.shapes,
    job.combined ?? [],
    job.vectors ?? [],
  ];
  for (const list of lists) {
    for (const item of list) {
      if (!item.enabled) continue;
      const found = findItem(job, item.id);
      out.push({ id: item.id, name: found ? itemName(found) : item.id, depth: item.depth });
    }
  }
  return out;
}

/**
 * Measure every cutter against every item, and return the table.
 *
 * `measure(key)` is #201's `LabelEngravability[]` for that cutter — in the worker and the CLI,
 * `measureLabels(tl, toPartPlan(job), radius, job.edgeMargin, …)` bound to the candidate's radius.
 * It is called EXACTLY ONCE per candidate that reaches the measurement stage, and its rows are
 * captured here, so the table costs no more wasm than the recommendation already did.
 *
 * `conditions` is handed straight to `recommendTool` (#442) — the table's own columns are about
 * reach, but which cutters are in the table at all is the recommendation's answer, and a broken
 * cutter has to be excluded in both places or the two would disagree about the bench.
 */
export function reachabilityFor(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  measure: (key: string) => LabelEngravability[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  lostDetailWarnRatio: number | null = null,
): Reachability {
  const measured = new Map<string, LabelEngravability[]>();
  const recommendation = recommendTool(
    job,
    tools,
    catalogue,
    (key) => {
      const rows = measure(key);
      measured.set(key, rows);
      return rows;
    },
    conditions,
    lostDetailWarnRatio,
  );

  const items = enabledItems(job);

  const cutters: CutterReach[] = recommendation.candidates.map((candidate) => {
    const entry = tools.find((t) => t.key === candidate.key);
    const rows = measured.get(candidate.key) ?? [];
    const cells: ReachRow[] = items.map((item) => {
      const row = rows.find((r) => r.labelId === item.id);
      // A row absent from the measurement is an ITEM that could not be evaluated — a profile with no
      // area at all. `measureLabels` reports such an item as ratio 1 and area 0, so a genuinely
      // missing row means the plan never held the item; treat it as no area and reach 1, exactly as
      // the measurement itself would, rather than as a reach failure nothing caused.
      return {
        itemId: item.id,
        name: item.name,
        depth: item.depth,
        glyphArea: row?.glyphArea ?? 0,
        openedArea: row?.openedArea ?? 0,
        ratio: row?.ratio ?? 1,
        empty: row !== undefined && row.glyphArea > 0 && row.openedArea === 0,
        emptyChars: (row?.emptyChars ?? []).map((c) => c.char),
      };
    });
    const ratios = cells.map((c) => c.ratio);
    return {
      key: candidate.key,
      name: entry?.tool.name ?? candidate.key,
      diameter: candidate.diameter,
      shape: entry?.tool.shape ?? null,
      vTrace: entry === undefined ? false : isVTraceTool(entry.tool),
      excluded: candidate.excluded ?? null,
      excludedNote: candidate.excluded === 'no-catalogue-row' ? (candidate.catalogueNote ?? null) : null,
      rows: cells,
      bestRatio: ratios.length === 0 ? 0 : Math.max(...ratios),
      worstRatio: ratios.length === 0 ? 0 : Math.min(...ratios),
      qualifies: candidate.qualifies,
    };
  });

  // The design's total area is the same for every cutter (it is the ITEMS' area, which no radius
  // touches), so it is read off the first cutter that was actually measured — and each cutter's
  // share of it is its opened area over that total, not the mean of its ratios, which would let a
  // 0.2 mm² full stop outvote a 900 mm² title.
  //
  // "MEASURED" is the load-bearing word, and `rows.length > 0` is NOT it: an EXCLUDED cutter still
  // gets a cell per item — zeroed, because nothing was measured against it — so a ball nose that
  // sorts first in the list would answer this with a total of 0 mm² and every cutter's share of the
  // design would read 0 %. The first MEASURED cutter is the one whose cells carry the items' areas.
  const totalArea = (cutters.find((c) => c.excluded === null && c.rows.length > 0)?.rows ?? []).reduce(
    (sum, r) => sum + r.glyphArea,
    0,
  );
  const totalShare = new Map<string, number>();
  for (const cutter of cutters) {
    const opened = cutter.rows.reduce((sum, r) => sum + r.openedArea, 0);
    totalShare.set(cutter.key, totalArea === 0 ? 0 : opened / totalArea);
  }

  return { cutters, items, recommendation, totalShare };
}

/** A cutter's share of the whole design, 0…1 — the reading of {@link Reachability.totalShare}. */
export function shareOf(reach: Reachability, key: string): number {
  return reach.totalShare.get(key) ?? 0;
}

/** The items `key` reaches NONE of — `item-empty`'s list, per cutter. Empty when it was not measured. */
export function untouchedBy(reach: Reachability, key: string): ReachRow[] {
  const cutter = reach.cutters.find((c) => c.key === key);
  return (cutter?.rows ?? []).filter((r) => r.empty);
}

/**
 * The items NO measured cutter reaches — the design's own unreachable detail.
 *
 * This is the distinction that decides what to DO about a 0 % row. An item nothing reaches cannot
 * be cut by any program this bench can run, so leaving it enabled is a hard `item-empty` refusal
 * for a fact no cutter choice can change; it is a report, and the job has to carry on without it.
 * An item the CHOSEN cutter misses is a different sentence — "use a finer cutter" — and is not
 * this list.
 *
 * Only cutters that were actually measured count. An excluded cutter (`not-flat`, `no-feeds`) may
 * well reach the item; it is simply not a candidate, and claiming "nothing reaches this" on the
 * strength of a cutter nobody measured would be a number invented out of an absence.
 */
export function untouchedByAll(reach: Reachability): { row: ReachRow; cutters: number }[] {
  const measured = reach.cutters.filter((c) => c.excluded === null && c.rows.length > 0);
  if (measured.length === 0) return [];
  return reach.items
    .map((item) => {
      const cells = measured.map((c) => c.rows.find((r) => r.itemId === item.id));
      const row = cells.find((c) => c !== undefined && c.glyphArea > 0);
      if (row === undefined || !cells.every((c) => c === undefined || c.openedArea === 0)) return null;
      return { row, cutters: measured.length };
    })
    .filter((v): v is { row: ReachRow; cutters: number } => v !== null);
}

/** One row of a "which cutter reaches what" table, for a run sheet or a panel: `%` per item. */
export interface ReachTableRow {
  key: string;
  name: string;
  diameter: number;
  /** Why it was not measured, in words, or null when it was. */
  excluded: string | null;
  /** Per-item share, 0…1, in `Reachability.items` order. `null` when the cutter was not measured. */
  shares: (number | null)[];
  /** Share of the design's whole area, 0…1. */
  total: number;
  qualifies: boolean;
}

/**
 * #486 — the sentence a table cell (and the CLI's up-front note) uses for a V-bit named as a
 * SECOND cutter on a job whose items are regions. The rest pass is area-based: it asks what a
 * narrower flat disc can open that the first could not, and a cone's width is a function of depth,
 * so a V-bit was never measured as a rest cutter at all. The operation it would be is a V-carve.
 */
export const V_BIT_REST_SENTENCE = 'a V-bit is not a rest cutter here; the second program would be a V-carve (#221)';

/** Why a cutter was dropped before measuring, in one phrase, for a table cell. */
function exclusionWords(
  excluded: ToolCandidate['excluded'] | null,
  note: string | null,
  vTrace: boolean,
): string | null {
  if (excluded === 'not-flat') {
    // The `not-flat` class covers a ball nose, a bull nose and a V-bit. Only the V-bit on a region
    // job has the #486 answer; the rest keep the generic phrase, which already names the case.
    return vTrace ? V_BIT_REST_SENTENCE : 'not a flat end mill (or a V-bit on a job with regions)';
  }
  if (excluded === 'no-feeds') return 'no cutting parameters for this material';
  if (excluded === 'broken') return 'every copy of it is marked broken';
  // #455 — the catalogue's own sentence has the vendor's material words in it, which is exactly
  // what "not recommended" must say. The generic phrase is only for a note that somehow is not
  // there, and a caller reading it still learns the reason class.
  if (excluded === 'no-catalogue-row') return note ?? 'the catalogue lists no row for it in this material';
  return null;
}

/**
 * The table's rows, in the order handed over, for anything that has to PRINT it. Kept here rather
 * than in each renderer so the run sheet and the panel cannot disagree about what a row says.
 */
export function reachTable(reach: Reachability): ReachTableRow[] {
  return reach.cutters.map((cutter) => ({
    key: cutter.key,
    name: cutter.name,
    diameter: cutter.diameter,
    excluded: exclusionWords(cutter.excluded, cutter.excludedNote, cutter.vTrace),
    shares: cutter.excluded === null ? cutter.rows.map((r) => r.ratio) : cutter.rows.map(() => null),
    total: reach.totalShare.get(cutter.key) ?? 0,
    qualifies: cutter.qualifies,
  }));
}

/**
 * The SMALLEST cutter that reaches strictly more of the design than `key` does, or null when
 * nothing does — the second tool of a rest-machining pair (#410).
 *
 * "More" is the area-weighted share, not the worst item: a finer cutter that lifts a 900 mm² title
 * from 0.71 to 0.98 has earned a second program, and one that only rescues a 2 mm² full stop has
 * not. Ties go to the smaller diameter, so the pair is the largest useful first tool and the
 * smallest useful second — the order the stiffness argument wants.
 */
export function finerThan(reach: Reachability, key: string): CutterReach | null {
  const base = reach.cutters.find((c) => c.key === key);
  if (!base) return null;
  const baseShare = reach.totalShare.get(key) ?? 0;
  const better = reach.cutters.filter(
    (c) => c.excluded === null && c.key !== key && (reach.totalShare.get(c.key) ?? 0) > baseShare + 1e-9,
  );
  if (better.length === 0) return null;
  return better.reduce((a, b) => (b.diameter < a.diameter ? b : a));
}

/** Re-exported so a report can say what "intact" meant without importing the geometry worker. */
export { LOST_DETAIL_RATIO_FALLBACK };
