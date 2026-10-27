/**
 * #699 — "Why?" after the grouping: the catalogue rows are one line, and every reason the operator
 * cannot act on draws nothing.
 *
 * The panel's own render is covered by `engravePanel.spec.tsx`; this pins the rule it renders, so a
 * new exclusion cannot quietly join the wall.
 */

import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_GROUP_THRESHOLD,
  groupRejections,
  isActionableRejection,
  shouldGroupCatalogueRows,
} from '@/components/panels/recommendationRejections';
import type { ToolCandidate, ToolExclusion } from '@/engine/cnc/engrave/recommendTool';

function candidate(key: string, excluded?: ToolExclusion): ToolCandidate {
  return {
    key,
    diameter: 1,
    qualifies: false,
    worst: null,
    reachKnown: true,
    reachOk: true,
    condition: null,
    ...(excluded === undefined ? {} : { excluded }),
  };
}

describe('#699 the rejections the panel lists', () => {
  it('counts broken, no-feeds, no-catalogue-row, unknown-size, metal-line and job-shape as actionable', () => {
    expect(isActionableRejection(candidate('a', 'broken'))).toBe(true);
    expect(isActionableRejection(candidate('a', 'no-feeds'))).toBe(true);
    expect(isActionableRejection(candidate('a', 'no-catalogue-row'))).toBe(true);
    expect(isActionableRejection(candidate('a', 'unknown-size'))).toBe(true);
    // #699b — the job's own material refusal: the operator can acknowledge it or change the stock.
    expect(isActionableRejection(candidate('a', 'metal-line'))).toBe(true);
    // #702 — the job's own shape refusal: change the operation, the stock, or the bit.
    expect(isActionableRejection(candidate('a', 'job-shape'))).toBe(true);
    // A ball nose cannot become a flat end, and a cutter that got through is not a rejection.
    expect(isActionableRejection(candidate('a', 'not-flat'))).toBe(false);
    expect(isActionableRejection(candidate('a'))).toBe(false);
  });

  it('groups only when the catalogue list is a wall', () => {
    expect(shouldGroupCatalogueRows(0)).toBe(false);
    expect(shouldGroupCatalogueRows(1)).toBe(false);
    expect(shouldGroupCatalogueRows(CATALOGUE_GROUP_THRESHOLD)).toBe(false);
    expect(shouldGroupCatalogueRows(CATALOGUE_GROUP_THRESHOLD + 1)).toBe(true);
    expect(shouldGroupCatalogueRows(41)).toBe(true);
  });

  it('collects the catalogue rows into one group and keeps the other reasons individual', () => {
    const groups = groupRejections([
      candidate('corn-1', 'no-catalogue-row'),
      candidate('ball', 'not-flat'),
      candidate('broken-1', 'broken'),
      candidate('chamfer', 'unknown-size'),
      candidate('corn-2', 'no-catalogue-row'),
      candidate('wet', 'no-feeds'),
      candidate('metal', 'metal-line'),
      candidate('shape', 'job-shape'),
      candidate('ok'),
    ]);
    expect(groups.noCatalogueRow.map((c) => c.key)).toEqual(['corn-1', 'corn-2']);
    expect(groups.individual.map((c) => c.key)).toEqual(['broken-1', 'chamfer', 'wet', 'metal', 'shape']);
    // Nothing is lost from the list: a qualifying or not-flat row is simply not a rejection.
    expect(groups.noCatalogueRow.length + groups.individual.length).toBe(7);
  });
});
