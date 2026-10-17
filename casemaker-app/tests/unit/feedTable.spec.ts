// The feeds table (#450 slice 1): the row schema both sides agree on, and the ONE cross-row rule —
// no two rows that share a material and an edge may overlap or repeat a diameter range, because
// `entryFor` (`engine/cnc/feeds.ts:757`) takes the FIRST match. The service's half is
// `src-tauri/src/feeds.rs`, and both read the same specimen, `fixtures/feed-table.json`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  effectiveEdge,
  feedProblem,
  feedTableProblem,
  FeedsTableSchema,
} from '@/platform/feedClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECIMEN = JSON.parse(readFileSync(join(HERE, 'fixtures', 'feed-table.json'), 'utf8')) as {
  good: unknown[];
  refused: Array<{ why: string; rows: unknown[]; zodOnly?: boolean }>;
};

const GOOD = SPECIMEN.good;
/** A softwood flat row — the shape every refusal case patches. */
const ROW = GOOD[0] as Record<string, unknown>;
const PARAMS = ROW.params as Record<string, unknown>;

describe('the feeds table (#450), against the shared specimen', () => {
  it('parses every good row, and the table as a whole', () => {
    expect(feedTableProblem(GOOD)).toBeNull();
    const rows = FeedsTableSchema.parse(GOOD);
    expect(rows).toHaveLength(11);
    // An absent edge reads as flat; the two V rows are the cones.
    expect(rows.filter((r) => effectiveEdge(r) === 'v').map((r) => r.id)).toEqual([
      'feed-pla-v-0.3-0.5',
      'feed-petg-v-0.3-0.5',
    ]);
    // An absent note and setAt are null, not missing; the numbers are the row's own.
    expect(rows[0]!.note).toBeNull();
    expect(rows[0]!.setAt).toBeNull();
    expect(rows[0]!.params).toEqual({
      rpm: 12000,
      feed: 500,
      plungeFeed: 200,
      stepDown: 0.5,
      stepOverFraction: 0.45,
      peckFraction: 1,
      air: true,
    });
    // The corn row carries its note and its cut-back step-over.
    const corn = rows.find((r) => r.id === 'feed-pla-flat-0.5-0.8')!;
    expect(corn.note).toContain('corn cutter');
    expect(corn.params.stepOverFraction).toBe(0.4);
  });

  it('refuses every table the specimen marks refused', () => {
    for (const c of SPECIMEN.refused) {
      expect(feedTableProblem(c.rows), c.why).not.toBeNull();
    }
  });

  it('accepts touching ranges, and refuses an overlap and a duplicate range', () => {
    const row = (patch: Record<string, unknown>) => ({ ...ROW, ...patch });
    // Touching at 1.6 — the boundary convention `feeds.ts:174-177` relies on — is the table's shape.
    expect(
      feedTableProblem([
        row({ id: 'a', material: 'softwood', minDiameter: 0.8, maxDiameter: 1.6 }),
        row({ id: 'b', material: 'softwood', minDiameter: 1.6, maxDiameter: 3.2 }),
      ]),
    ).toBeNull();
    // An overlap makes the answer depend on row order, so it is refused.
    expect(
      feedTableProblem([
        row({ id: 'a', material: 'softwood', minDiameter: 0.8, maxDiameter: 2.0 }),
        row({ id: 'b', material: 'softwood', minDiameter: 1.6, maxDiameter: 3.2 }),
      ]),
    ).toContain('overlap');
    // The same range twice, and the same POINT range twice, are both one row said twice.
    expect(
      feedTableProblem([
        row({ id: 'a', material: 'softwood', minDiameter: 0.8, maxDiameter: 1.6 }),
        row({ id: 'b', material: 'softwood', minDiameter: 0.8, maxDiameter: 1.6 }),
      ]),
    ).toContain('both cover');
    expect(
      feedTableProblem([
        row({ id: 'a', material: 'softwood', minDiameter: 1.0, maxDiameter: 1.0 }),
        row({ id: 'b', material: 'softwood', minDiameter: 1.0, maxDiameter: 1.0 }),
      ]),
    ).not.toBeNull();
    // A different edge, or a different material, is a different row: no conflict.
    expect(feedTableProblem([row({ id: 'a' }), row({ id: 'b', edge: 'v' })])).toBeNull();
    expect(feedTableProblem([row({ id: 'a' }), row({ id: 'b', material: 'pla' })])).toBeNull();
    // One id, one row.
    expect(
      feedTableProblem([row({ id: 'a' }), row({ id: 'a', minDiameter: 1.6, maxDiameter: 3.2 })]),
    ).toContain('appears twice');
  });

  it('refuses a row the table cannot use, field by field', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['no material', { material: ' ' }],
      ['a material this build does not know', { material: 'unobtainium' }],
      ['a diameter at zero', { minDiameter: 0 }],
      ['diameters inside out', { minDiameter: 3.2, maxDiameter: 1.6 }],
      ['a zero rpm', { params: { ...PARAMS, rpm: 0 } }],
      ['a negative feed', { params: { ...PARAMS, feed: -1 } }],
      ['a chosen row with no date', { source: 'chosen', setAt: null }],
      ['no provenance', { provenance: '  ' }],
      ['a provenance past the sentence limit', { provenance: 'x'.repeat(401) }],
      ['a note past the sentence limit', { note: 'x'.repeat(401) }],
      ['a note with a control character', { note: 'line\nbreak' }],
      ['an id with a slash', { id: 'a/b' }],
      ['a missing maxDiameter', { maxDiameter: undefined }],
    ];
    for (const [why, patch] of cases) {
      expect(feedProblem({ ...ROW, ...patch }), why).not.toBeNull();
    }
  });

  it('exposes the refusal text a form would show', () => {
    expect(feedProblem({ ...ROW, minDiameter: 3.2, maxDiameter: 1.6 })).toContain('backwards');
    expect(feedTableProblem('not a list')).not.toBeNull();
  });
});
