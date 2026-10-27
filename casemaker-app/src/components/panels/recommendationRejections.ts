/**
 * #699 — the cutter list's rejected rows, grouped for "Why?".
 *
 * The recommendation has always kept every candidate; the panel decides what is worth a line. A
 * rejection is ACTIONABLE when the operator can do something about it: replace a broken copy,
 * change the material, choose another bit, state a cutter's size, or — #699b — answer the job's own
 * refusal (a metal-line bit on a plastic blank can be acknowledged by the operator, or the stock
 * changed). `not-flat` is not: a ball nose cannot become a flat end.
 *
 * #699 — THE CATALOGUE ROWS ARE ONE LINE, NOT FORTY. A catalogue with no PLA row for most of a
 * house's bits produced 43 rows whose only difference was the vendor's material list; the wall
 * buried the two rejections the operator could act on. They share one sentence with a count; every
 * other reason keeps its own row, because each names a different cutter and fix.
 *
 * Pure, so the grouping is pinned without rendering the panel.
 */

import type { ToolCandidate } from '@/engine/cnc/engrave/recommendTool';

export type ActionableExclusion =
  | 'broken'
  | 'no-feeds'
  | 'no-catalogue-row'
  | 'unknown-size'
  | 'metal-line'
  | 'job-shape';

/** A rejection the operator can act on, and the shape its row needs. */
export type ActionableRejection = ToolCandidate & { excluded: ActionableExclusion };

export function isActionableRejection(c: ToolCandidate): c is ActionableRejection {
  return (
    c.excluded === 'broken' ||
    c.excluded === 'no-feeds' ||
    c.excluded === 'no-catalogue-row' ||
    c.excluded === 'unknown-size' ||
    c.excluded === 'metal-line' ||
    c.excluded === 'job-shape'
  );
}

export interface RejectionGroups {
  /** Every cutter the catalogue lists only for other materials: one line with a count. */
  noCatalogueRow: NoCatalogueRow[];
  /** Everything else that is actionable, in the candidate order the list was built in. */
  individual: Individual[];
}

type NoCatalogueRow = ToolCandidate & { excluded: 'no-catalogue-row' };
type Individual = ToolCandidate & {
  excluded: 'broken' | 'no-feeds' | 'unknown-size' | 'metal-line' | 'job-shape';
};

const isNoCatalogueRow = (c: ToolCandidate): c is NoCatalogueRow => c.excluded === 'no-catalogue-row';
const isIndividual = (c: ToolCandidate): c is Individual =>
  c.excluded === 'broken' ||
  c.excluded === 'no-feeds' ||
  c.excluded === 'unknown-size' ||
  c.excluded === 'metal-line' ||
  c.excluded === 'job-shape';

export function groupRejections(candidates: readonly ToolCandidate[]): RejectionGroups {
  return {
    noCatalogueRow: candidates.filter(isNoCatalogueRow),
    individual: candidates.filter(isIndividual),
  };
}

/**
 * Is the catalogue list long enough to be a WALL? One or two of them are still worth their own
 * rows — each carries the catalogue's own materials sentence, which is the actionable part — but
 * the k3 house turned 41 of them into a list with one distinction repeated 41 times. Above this
 * many, one line with the count, and the individual sentences give way.
 */
export const CATALOGUE_GROUP_THRESHOLD = 3;

export function shouldGroupCatalogueRows(count: number): boolean {
  return count > CATALOGUE_GROUP_THRESHOLD;
}
