// Makera's catalogue as the tier BELOW measurement (#310). The acceptance this file exists for is
// four sentences from the issue: a catalogue row surfaces with its own source; a measured row beats
// one for the same material and cutter; no catalogue row can put a spindle speed above the machine's
// ceiling; and with no catalogue loaded nothing behaves differently than it did before.
//
// The rows here are Hand-built fixtures in the SERVICE's shape, not vendor data: no number below is
// derived from Studio's database (`/Fabrication.md` §3, #186).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CATALOGUE_MATERIALS,
  FEEDS_TABLE,
  UNMEASURED_FEEDS_TABLE,
  applyMeasurements,
  catalogueMaterialFor,
  clearFeedCatalogue,
  feedCatalogueRows,
  feedsFor,
  setFeedCatalogue,
  type FeedCatalogueRow,
} from '@/engine/cnc/feeds';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';
import { flatEndMill } from '@/engine/cnc/tool';
import { Z1, CLAMP_REFUSE_FRACTION } from '@/engine/cnc/machine';

/** The vendor's id for the 3.175 x 12 mm flat end, which the built-in tier also carries. */
const VENDOR_ID = '112111313812';

/** A tool that IS a Makera cutter: the built-in entry, resolved out of the library. */
function makeraCutter() {
  const entry = TOOL_LIBRARY.find((e) => e.key === 'flat-3.175x12-metal');
  if (!entry) throw new Error('the built-in metal flat end is gone');
  return entry.tool;
}

const HARDWOOD_ROW: FeedCatalogueRow = {
  cutterId: VENDOR_ID,
  material: 'Hardwood',
  rpm: 12000,
  feed: 900,
  plungeFeed: 300,
  stepDown: 1.2,
};

beforeEach(() => clearFeedCatalogue());
afterEach(() => clearFeedCatalogue());

describe('the catalogue snapshot', () => {
  it('starts empty, and set copies rather than holding the caller’s array', () => {
    expect(feedCatalogueRows()).toEqual([]);

    const rows = [HARDWOOD_ROW];
    setFeedCatalogue(rows);
    rows.push({ ...HARDWOOD_ROW, material: 'Softwood' });
    // A snapshot, not a live view: a caller mutating its array must not change what the engine reads.
    expect(feedCatalogueRows()).toEqual([HARDWOOD_ROW]);

    clearFeedCatalogue();
    expect(feedCatalogueRows()).toEqual([]);
  });
});

describe('the vendor material map is exactly two rows', () => {
  it('carries wood and only wood', () => {
    expect(Object.keys(CATALOGUE_MATERIALS).sort()).toEqual(['Hardwood', 'Softwood']);
    expect(catalogueMaterialFor('Hardwood')).toBe('hardwood');
    expect(catalogueMaterialFor('Softwood')).toBe('softwood');
  });

  it('refuses every other vendor name rather than guessing at it', () => {
    // The thirteen Makera materials this app has no stock for, plus names that are wood-ish but
    // are not the vendor's own word: a substring match would read all four of these as hardwood.
    const refused = [
      'MDF', 'PLA', 'ABS', 'PCB', '6061 Aluminum', '7075 Aluminum', 'Bakelite', 'Delrin',
      'Brass', 'Carbon Fiber', 'Acrylic', 'Polycarbonate', 'Copper', 'Epoxy Tooling',
      'Synthetic Stone', 'Hardwood (Oak)', 'hardwood', 'Softwoods', '', 'toString',
    ];
    for (const name of refused) expect(catalogueMaterialFor(name), name).toBeNull();
  });
});

describe('a catalogue row supplies the four numbers Makera states', () => {
  it('answers a wood job in the vendor’s own cutter, with the source stamped per field', () => {
    setFeedCatalogue([HARDWOOD_ROW]);
    const res = feedsFor('hardwood', makeraCutter(), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);

    expect(res.catalogue).toEqual(HARDWOOD_ROW);
    expect(res.params.rpm).toBe(12000);
    expect(res.params.feed).toBe(900);
    expect(res.params.plungeFeed).toBe(300);
    expect(res.params.stepDown).toBe(1.2);

    // The panel renders these: four fields named as Makera's, and nothing else claimed for them.
    expect(res.sources.rpm).toBe('catalogue');
    expect(res.sources.feed).toBe('catalogue');
    expect(res.sources.plungeFeed).toBe('catalogue');
    expect(res.sources.stepDown).toBe('catalogue');
    expect(res.sources.stepOver).toBe('computed');
    expect(res.sources.peck).toBe('computed');
    expect(res.sources.air).toBe('computed');

    expect(res.provenance).toContain("Makera's catalogue");
    expect(res.provenance).toContain('nothing here has been cut on this machine');
    // It is NOT the starting table's provenance, which is what the panel showed before #310.
    expect(res.provenance).not.toContain('Starting value');
  });

  it('leaves step-over, peck and air to this app — the vendor’s step-over is its own operation’s', () => {
    // Makera states a step-over of 63 % of the tip diameter for a flat end in wood, which our
    // contour-parallel sweep would refuse outright (#191). So it is not in the catalogue's row at
    // all, and the app's own 45 % stands even when the catalogue answered.
    setFeedCatalogue([HARDWOOD_ROW]);
    const res = feedsFor('hardwood', makeraCutter(), Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.stepOver).toBeCloseTo(0.45 * 3.175, 10);
    expect(res.params.peck).toBeCloseTo(3.175, 10);
    expect(res.params.air).toBe(true);
  });

  it('is keyed on the cutter, not on the diameter: the same geometry with no vendor id gets nothing', () => {
    setFeedCatalogue([HARDWOOD_ROW]);
    const anonymous = flatEndMill(3.175); // identical geometry, `id: null`
    const res = feedsFor('hardwood', anonymous, Z1);
    if (!res.ok) throw new Error(res.reason);
    const row = FEEDS_TABLE.find(
      (e) => e.material === 'hardwood' && 3.175 >= e.minDiameter && 3.175 <= e.maxDiameter,
    );
    if (!row) throw new Error('no hardwood row covers 3.175 mm');
    expect(res.catalogue).toBeNull();
    expect(res.sources.rpm).toBe('computed');
    expect(res.params.rpm).toBe(row.params.rpm);
  });

  it('is not applied to a material whose vendor name is not wood, even for the right cutter', () => {
    // A row that exists in the snapshot and can never be read: the map refuses MDF, so a job in
    // `mdf` with this cutter keeps the starting values. This is the PLA/MDF half of the issue.
    setFeedCatalogue([{ ...HARDWOOD_ROW, material: 'MDF' }]);
    const res = feedsFor('mdf', makeraCutter(), Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.catalogue).toBeNull();
    expect(res.params.feed).toBe(500);
  });

  it('is not applied to a cutter the table does not cover — the tier does not widen coverage', () => {
    // A 6 mm Makera cutter: the catalogue may well have rows for it, and the app still refuses,
    // because every wood row of the starting table stops at 3.2 mm.
    setFeedCatalogue([{ ...HARDWOOD_ROW, cutterId: '999999999999', rpm: 10000, feed: 1000 }]);
    const res = feedsFor('hardwood', flatEndMill(6, { id: '999999999999' }), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('6 mm');
  });
});

describe('a measured row wins over a catalogue row (#310’s precedence)', () => {
  /** The same table the app ships, with one coupon's verdict folded in — the #248 path. */
  function tableWithMeasuredFeed() {
    const readback = applyMeasurements(UNMEASURED_FEEDS_TABLE, [
      {
        material: 'hardwood',
        diameter: 3.175,
        parameter: 'feed',
        value: 333,
        on: '2026-10-09',
        coupon: 'test-coupon',
      },
    ]);
    expect(readback.applied).toHaveLength(1);
    return readback.table;
  }

  it('answers alone, and the panel says so per field', () => {
    setFeedCatalogue([HARDWOOD_ROW]);
    const res = feedsFor('hardwood', makeraCutter(), Z1, undefined, tableWithMeasuredFeed());
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);

    // The measured field is the coupon's, and the row is not even offered the catalogue's numbers.
    expect(res.catalogue).toBeNull();
    expect(res.params.feed).toBe(333);
    expect(res.sources.feed).toBe('measured');
    // Fields this coupon did NOT settle are still starting values — a measured ROW is not seven
    // measured fields (#248), and the catalogue does not get to fill the gap either.
    expect(res.sources.rpm).toBe('computed');
    expect(res.params.rpm).toBe(12000);
    expect(res.provenance).toContain('Measured on a coupon');
    expect(res.provenance).toContain('test-coupon');
  });

  it('still takes the catalogue for a material the coupon did NOT measure', () => {
    setFeedCatalogue([
      { ...HARDWOOD_ROW, material: 'Softwood', feed: 950, rpm: 11000 },
    ]);
    const res = feedsFor('softwood', makeraCutter(), Z1, undefined, tableWithMeasuredFeed());
    if (!res.ok) throw new Error(res.reason);
    expect(res.catalogue).not.toBeNull();
    expect(res.params.feed).toBe(950);
    expect(res.params.rpm).toBe(11000);
    expect(res.sources.feed).toBe('catalogue');
  });
});

describe('the machine still has the last word', () => {
  it('clamps a 15 000 RPM row to the Z1’s 13 000, and says so', () => {
    setFeedCatalogue([{ ...HARDWOOD_ROW, rpm: 15000 }]);
    const res = feedsFor('hardwood', makeraCutter(), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.rpm).toBe(Z1.maxRpm);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'rpm-clamped' });
    // +15 %, inside the 50 % refusal band, which is why this one is a clamp and not a refusal.
    expect(15000 / Z1.maxRpm - 1).toBeLessThan(CLAMP_REFUSE_FRACTION);
  });

  it('refuses a catalogue row far past the ceiling rather than cutting at a made-up speed', () => {
    setFeedCatalogue([{ ...HARDWOOD_ROW, rpm: 24000 }]);
    const res = feedsFor('hardwood', makeraCutter(), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('24000');
  });

  it('clamps a feed above 1 200 mm/min', () => {
    setFeedCatalogue([{ ...HARDWOOD_ROW, feed: 1500 }]);
    const res = feedsFor('hardwood', makeraCutter(), Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.feed).toBe(Z1.maxCutFeed);
  });

  it('still refuses a job override that leaves an uncut spine (#191), catalogue or not', () => {
    setFeedCatalogue([HARDWOOD_ROW]);
    const res = feedsFor('hardwood', makeraCutter(), Z1, { stepOver: 2.0 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('#191');
  });
});

describe('no catalogue loaded is exactly the old behaviour', () => {
  it('every row of the table resolves as it did, unstamped', () => {
    for (const row of FEEDS_TABLE) {
      const diameter = (row.minDiameter + row.maxDiameter) / 2;
      const res = feedsFor(row.material, flatEndMill(diameter), Z1);
      expect(res.ok, `${row.material} ${diameter}`).toBe(true);
      if (!res.ok) continue;
      expect(res.catalogue).toBeNull();
      expect(res.provenance).toBe(row.provenance);
      expect(new Set(Object.values(res.sources))).toEqual(new Set(['computed']));
      expect(res.diagnostics).toEqual([]);
    }
  });

  it('a cleared catalogue forgets a row that was loaded a moment ago', () => {
    setFeedCatalogue([HARDWOOD_ROW]);
    const loaded = feedsFor('hardwood', makeraCutter(), Z1);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(loaded.catalogue).not.toBeNull();

    clearFeedCatalogue();
    const cleared = feedsFor('hardwood', makeraCutter(), Z1);
    if (!cleared.ok) throw new Error(cleared.reason);
    expect(cleared.catalogue).toBeNull();
    expect(cleared.params.feed).toBe(400); // the hardwood 1.6-3.2 row, not the fixture's 900
    expect(cleared.sources.feed).toBe('computed');
    expect(cleared.provenance).toContain('Starting value');
  });
});
