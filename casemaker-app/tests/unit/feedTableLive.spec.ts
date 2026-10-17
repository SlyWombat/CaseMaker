// The feeds table, LIVE (#450 slice 3): the compiled starting rows now live in the location, and
// `feedsFor` resolves against the table the service served — the installed one on the main thread,
// the compiled fallback only where no location service answered. The same specimen both sides read
// (`fixtures/feed-table.json`) is the seed, so the two tables must be the same table, value for
// value. The service's half of the seed is `src-tauri/src/feeds.rs`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FEEDS_TABLE,
  UNMEASURED_FEEDS_TABLE,
  entriesFromStoredRows,
  feedsFor,
  resolvedFeedsTable,
  setLocatedFeedTable,
  type FeedCatalogueRow,
  type FeedsEntry,
  type StoredFeedRow,
} from '@/engine/cnc/feeds';
import { feedProblem } from '@/platform/feedClient';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';

const HERE = dirname(fileURLToPath(import.meta.url));
const SPECIMEN = JSON.parse(readFileSync(join(HERE, 'fixtures', 'feed-table.json'), 'utf8')) as {
  good: StoredFeedRow[];
};

/** The service's seeded table: the shared specimen's good rows. */
const GOOD = SPECIMEN.good;

/** The vendor's id for the 3.175 x 12 mm flat end, which the built-in tier also carries. */
const VENDOR_ID = '112111313812';

/** A tool that IS a Makera cutter: the built-in entry, resolved out of the library. */
function makeraCutter() {
  const entry = TOOL_LIBRARY.find((e) => e.key === 'flat-3.175x12-metal');
  if (!entry) throw new Error('the built-in metal flat end is gone');
  return entry.tool;
}

/** A cutter that lands in a row's range, on the row's OWN edge (#405). */
function cutterFor(row: FeedsEntry) {
  const mid = (row.minDiameter + row.maxDiameter) / 2;
  return (row.edge ?? 'flat') === 'v'
    ? flatEndMill(mid, { shape: 'engraving', typeText: 'Engraving', tipDiameter: mid, diameter: 3.175, halfAngle: 15, angle: 30 })
    : flatEndMill(mid);
}

/** One stored flat row, for the tests that need a table other than the seeds. */
function storedRow(
  patch: Omit<Partial<StoredFeedRow>, 'params'> & { params?: Partial<StoredFeedRow['params']> } = {},
): StoredFeedRow {
  const base: StoredFeedRow = {
    material: 'softwood',
    edge: null,
    minDiameter: 0.8,
    maxDiameter: 3.2,
    params: { rpm: 12000, feed: 500, plungeFeed: 200, stepDown: 0.5, stepOverFraction: 0.45, peckFraction: 1.0, air: true },
    source: 'chosen',
    provenance: 'A shop row, chosen on the bench.',
  };
  return { ...base, ...patch, params: { ...base.params, ...patch.params } };
}

beforeEach(() => setLocatedFeedTable(null));
afterEach(() => setLocatedFeedTable(null));

describe('the seeded table is the compiled table (#450 slice 3)', () => {
  it('converts the service’s ten rows into exactly UNMEASURED_FEEDS_TABLE, byte for byte', () => {
    const converted = entriesFromStoredRows(GOOD);
    expect(converted).toHaveLength(UNMEASURED_FEEDS_TABLE.length);
    // Key order matters for "byte for byte", so compare the serialized forms too: an extra `edge:
    // null` on every flat row, or a params key in another order, would be a table the client and
    // the service spell differently even though both are valid.
    expect(JSON.stringify(converted)).toBe(JSON.stringify(UNMEASURED_FEEDS_TABLE));
    expect(converted).toEqual(UNMEASURED_FEEDS_TABLE);
    // Every seeded row is still labelled unmeasured, in its own words.
    for (const row of converted) expect(row.status).toBe('unmeasured');
  });

  it('resolves every row the compiled table resolves, with the same numbers', () => {
    setLocatedFeedTable(GOOD);
    expect(resolvedFeedsTable().from).toBe('location');
    for (const row of UNMEASURED_FEEDS_TABLE) {
      const cutter = cutterFor(row);
      const installed = feedsFor([], row.material, cutter, Z1);
      const compiled = feedsFor([], row.material, cutter, Z1, undefined, UNMEASURED_FEEDS_TABLE);
      expect(installed, `${row.material} ${row.edge ?? 'flat'} ${row.minDiameter}-${row.maxDiameter}`).toEqual(compiled);
    }
  });
});

describe('a stored row reaches feedsFor', () => {
  it('takes effect in place of the compiled row, and says so in its provenance', () => {
    const mine = storedRow({
      material: 'pla',
      minDiameter: 0.8,
      maxDiameter: 1.6,
      params: { rpm: 9000, feed: 321, stepDown: 0.4 },
      provenance: 'Chosen on this shop’s own machine, 2026-10-17.',
    });
    setLocatedFeedTable([mine]);

    const res = feedsFor([], 'pla', flatEndMill(1.0), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.rpm).toBe(9000);
    expect(res.params.feed).toBe(321);
    expect(res.params.plungeFeed).toBe(200);
    expect(res.params.stepDown).toBe(0.4);
    expect(res.params.stepOver).toBeCloseTo(0.45, 10);
    expect(res.entry.provenance).toBe('Chosen on this shop’s own machine, 2026-10-17.');
    expect(res.entry.status).toBe('unmeasured'); // `chosen` is not `measured`
    expect(res.sources.rpm).toBe('computed');
  });

  it('does not answer for a material the stored table leaves out', () => {
    // The table REPLACES the compiled one; it is not merged over it. A shop that keeps only PLA
    // rows gets no softwood answer rather than the compiled softwood row behind its back.
    setLocatedFeedTable([storedRow({ material: 'pla', minDiameter: 0.8, maxDiameter: 1.6 })]);
    const res = feedsFor([], 'softwood', flatEndMill(1.0), Z1);
    expect(res.ok).toBe(false);
  });

  it('puts the compiled fallback back when there is no table to install', () => {
    setLocatedFeedTable(GOOD);
    expect(resolvedFeedsTable().from).toBe('location');

    setLocatedFeedTable(null);
    expect(resolvedFeedsTable()).toMatchObject({ from: 'fallback', table: FEEDS_TABLE });
    expect(resolvedFeedsTable().label).toContain('compiled');

    // An EMPTY table is the no-service answer too: the document omits an empty table, so "states
    // no rows" cannot mean "refuse every job" (an import of an older export would do exactly that).
    setLocatedFeedTable([]);
    expect(resolvedFeedsTable().from).toBe('fallback');
    const res = feedsFor([], 'softwood', flatEndMill(1.0), Z1);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.entry).toEqual(UNMEASURED_FEEDS_TABLE[0]);
  });
});

describe('a row the table cannot use is refused before it is installed', () => {
  it('is refused by the client’s rule', () => {
    // The same specimen case `feedTable.spec.ts` holds; repeated here because THIS slice is the one
    // that installs served rows, and `store/feedTableStore.ts` refuses before calling the install.
    expect(feedProblem({ ...GOOD[0], minDiameter: 3.2, maxDiameter: 1.6 })).toContain('backwards');
    expect(feedProblem({ ...GOOD[0], params: { ...GOOD[0]!.params, rpm: 0 } })).not.toBeNull();
  });
});

describe('the catalogue-only fractions come from the table (#450 slice 3)', () => {
  const ALUMINIUM_ROW: FeedCatalogueRow = {
    cutterId: VENDOR_ID,
    material: '6061 Aluminum',
    rpm: 10000,
    feed: 400,
    plungeFeed: 120,
    stepDown: 0.3,
  };

  it('reads the flat row that would answer this diameter, not a compiled 0.45 / 1.0', () => {
    setLocatedFeedTable([storedRow({ params: { stepOverFraction: 0.5, peckFraction: 0.75 } })]);
    const res = feedsFor([ALUMINIUM_ROW], 'aluminium-6061', makeraCutter(), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    // 3.175 mm falls inside the stored 0.8-3.2 band.
    expect(res.params.stepOver).toBeCloseTo(0.5 * 3.175, 10);
    expect(res.params.peck).toBeCloseTo(0.75 * 3.175, 10);
    // And the sentence says which of the row's numbers are the app's.
    expect(res.provenance).toContain('0.5 × cutter step-over');
    expect(res.provenance).toContain('0.75 × cutter-diameter peck');
  });
});
