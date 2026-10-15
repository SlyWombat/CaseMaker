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
  feedCatalogueSnapshot,
  feedsFor,
  setFeedCatalogue,
  type FeedCatalogueRow,
} from '@/engine/cnc/feeds';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
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

// #366 — the snapshot carries WHEN it was synced, so a vendor row can be named as old. The date is
// stamped where the sync writes it (`setFeedCatalogue`), travels with the rows, and shows up in the
// sentences that name the catalogue — the answer's provenance, and Route A's refusal.
describe('the catalogue knows how old it is (#366)', () => {
  it('stamps the sync, carries it, and drops it with the rows', () => {
    expect(feedCatalogueSnapshot().syncedOn).toBeNull();

    setFeedCatalogue([HARDWOOD_ROW], '2026-10-11T09:00:00.000Z');
    expect(feedCatalogueSnapshot().syncedOn).toBe('2026-10-11T09:00:00.000Z');
    expect(feedCatalogueSnapshot().rows).toEqual([HARDWOOD_ROW]);

    // Clearing the catalogue clears its age too: "no catalogue" and "a catalogue from some date"
    // must not be able to disagree.
    clearFeedCatalogue();
    expect(feedCatalogueSnapshot().syncedOn).toBeNull();
  });

  it('names the age in the answer’s provenance, and only when it has one', () => {
    setFeedCatalogue([HARDWOOD_ROW], '2026-10-11T09:00:00.000Z');
    const dated = feedsFor(feedCatalogueSnapshot(), 'hardwood', makeraCutter(), Z1);
    expect(dated.ok).toBe(true);
    if (!dated.ok) throw new Error(dated.reason);
    expect(dated.provenance).toContain('The catalogue was synced 2026-10-11.');

    // The same rows as a BARE array — a worker's structured clone, and every existing caller — is
    // the snapshot with no date: the sentence is exactly what it was before this existed.
    const bare = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
    if (!bare.ok) throw new Error(bare.reason);
    expect(bare.provenance).not.toContain('was synced');
  });

  it('says the DATE alone — an hour is not what tells you a row has gone stale', () => {
    setFeedCatalogue([HARDWOOD_ROW], '2026-10-11T23:59:59.000Z');
    const res = feedsFor(feedCatalogueSnapshot(), 'hardwood', makeraCutter(), Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.provenance).toContain('synced 2026-10-11');
    expect(res.provenance).not.toContain('23:59');
  });

  it('dates the Route A answer, and the Route A refusal that tells you to sync', () => {
    const ALUMINIUM_ROW: FeedCatalogueRow = {
      cutterId: VENDOR_ID,
      material: '6061 Aluminum',
      rpm: 10000,
      feed: 400,
      plungeFeed: 120,
      stepDown: 0.3,
    };
    setFeedCatalogue([ALUMINIUM_ROW], '2026-10-11T09:00:00.000Z');
    const answered = feedsFor(feedCatalogueSnapshot(), 'aluminium-6061', makeraCutter(), Z1);
    if (!answered.ok) throw new Error(answered.reason);
    expect(answered.provenance).toContain('The catalogue was synced 2026-10-11.');

    // No row for THIS cutter: the refusal is the sentence that says "sync the catalogue", so it is
    // the one that most needs to say how long ago anyone did. (A cutter with a vendor id and no row
    // of its own — the no-id cutter below is a different refusal, with no sync to name.)
    const refused = feedsFor(feedCatalogueSnapshot(), 'aluminium-6061', flatEndMill(6, { id: '999999999999' }), Z1);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.reason).toContain('sync the catalogue');
    expect(refused.reason).toContain('The catalogue was synced 2026-10-11.');
  });
});

describe('the vendor material map is exact, name by name (#310, #347)', () => {
  it('carries every vendor name this app has a material for — and only those', () => {
    // #347 widened this from two rows to the eight materials the app can name: the wood it always
    // had, plus the two plastics and the four metals a machine profile declares.
    expect(Object.keys(CATALOGUE_MATERIALS).sort()).toEqual([
      '6061 Aluminum',
      '7075 Aluminum',
      'ABS',
      'Acrylic',
      'Brass',
      'Copper',
      'Hardwood',
      'Softwood',
    ]);
    expect(catalogueMaterialFor('Hardwood')).toBe('hardwood');
    expect(catalogueMaterialFor('Softwood')).toBe('softwood');
    // The two aluminium alloys are SEPARATE materials, so one alloy's row can never answer a job in
    // the other (#347): this is the whole reason `aluminium` is not one key.
    expect(catalogueMaterialFor('6061 Aluminum')).toBe('aluminium-6061');
    expect(catalogueMaterialFor('7075 Aluminum')).toBe('aluminium-7075');
  });

  it('refuses every other vendor name rather than guessing at it', () => {
    // The vendor names this app has no material for, plus names that are nearly the vendor's own
    // word: a substring match would read `Hardwood (Oak)` as hardwood and both aluminium names as
    // each other's.
    const refused = [
      'MDF', 'PLA', 'PCB', 'Bakelite', 'Delrin', 'Carbon Fiber', 'Polycarbonate',
      'Epoxy Tooling', 'Synthetic Stone', 'Hardwood (Oak)', 'Softwood (Pine)', 'hardwood',
      'Softwoods', '6061 aluminum', 'Aluminum 6061', 'aluminium-6061', '', 'toString',
      '__proto__', 'constructor',
    ];
    for (const name of refused) expect(catalogueMaterialFor(name), name).toBeNull();
  });

  it('maps every vendor name to a material that exists, and never two names to one material', () => {
    // The map's two failure modes, both silent: a value that is not a `StockMaterial` (a typo the
    // `Record` type already refuses, re-checked on the built object), and two vendor rows collapsing
    // onto one material — which is what makes the FIRST matching row win, in metal, without saying so.
    const labels = new Set(Object.keys(MATERIAL_LABELS));
    const materials = Object.values(CATALOGUE_MATERIALS);
    for (const material of materials) expect(labels.has(material), material).toBe(true);
    expect(new Set(materials).size).toBe(materials.length);
  });
});

describe('a catalogue row supplies the four numbers Makera states', () => {
  it('answers a wood job in the vendor’s own cutter, with the source stamped per field', () => {
    setFeedCatalogue([HARDWOOD_ROW]);
    const res = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
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
    const res = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.stepOver).toBeCloseTo(0.45 * 3.175, 10);
    expect(res.params.peck).toBeCloseTo(3.175, 10);
    expect(res.params.air).toBe(true);
  });

  it('is keyed on the cutter, not on the diameter: the same geometry with no vendor id gets nothing', () => {
    setFeedCatalogue([HARDWOOD_ROW]);
    const anonymous = flatEndMill(3.175); // identical geometry, `id: null`
    const res = feedsFor(feedCatalogueRows(), 'hardwood', anonymous, Z1);
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
    const res = feedsFor(feedCatalogueRows(), 'mdf', makeraCutter(), Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.catalogue).toBeNull();
    expect(res.params.feed).toBe(500);
  });

  it('is not applied to a cutter the table does not cover — the tier does not widen coverage', () => {
    // A 6 mm Makera cutter: the catalogue may well have rows for it, and the app still refuses,
    // because every wood row of the starting table stops at 3.2 mm.
    setFeedCatalogue([{ ...HARDWOOD_ROW, cutterId: '999999999999', rpm: 10000, feed: 1000 }]);
    const res = feedsFor(feedCatalogueRows(), 'hardwood', flatEndMill(6, { id: '999999999999' }), Z1);
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
    const res = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1, undefined, tableWithMeasuredFeed());
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
    const res = feedsFor(feedCatalogueRows(), 'softwood', makeraCutter(), Z1, undefined, tableWithMeasuredFeed());
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
    const res = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.rpm).toBe(Z1.maxRpm);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'rpm-clamped' });
    // +15 %, inside the 50 % refusal band, which is why this one is a clamp and not a refusal.
    expect(15000 / Z1.maxRpm - 1).toBeLessThan(CLAMP_REFUSE_FRACTION);

    // #325 — and the label follows the CLAMP, not the row: Makera said 15 000, the 13 000 is the
    // machine's limit, so this field is not Makera's (decision 28). The fields the clamp did not
    // touch are still the vendor's.
    expect(res.sources.rpm).toBe('computed');
    expect(res.sources.feed).toBe('catalogue');
    expect(res.params.feed).toBe(900);
  });

  it('passes over a row far past the ceiling and cuts the starting table’s number instead (#325)', () => {
    // It used to REFUSE the job ("rpm 24000 RPM is more than 50 % above the Z1's 13000 RPM ceiling")
    // — a tier above the starting table vetoing a job the starting table would have cut. The row
    // does not get to do that: the field is passed over and the diagnostic names it.
    setFeedCatalogue([{ ...HARDWOOD_ROW, rpm: 24000 }]);
    const res = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.rpm).toBe(12000); // the hardwood 1.6-3.2 starting row
    expect(res.sources.rpm).toBe('computed');
    // Per FIELD, not per row: the other three numbers are still Makera's.
    expect(res.params.feed).toBe(900);
    expect(res.sources.feed).toBe('catalogue');
    expect(res.catalogue).toEqual({ ...HARDWOOD_ROW, rpm: 24000 });
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'catalogue-ignored' });
    expect(res.diagnostics[0]!.message).toContain('24000 RPM');
    expect(res.diagnostics[0]!.message).toContain('refuses');
    // And the one sentence the panel shows says so out loud, since no screen renders the
    // diagnostic yet (#317).
    expect(res.provenance).toContain('Not used for this job');
    expect(res.provenance).toContain('spindle speed');
  });

  it('clamps a feed above 1 200 mm/min', () => {
    setFeedCatalogue([{ ...HARDWOOD_ROW, feed: 1500 }]);
    const res = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.feed).toBe(Z1.maxCutFeed);
    expect(res.sources.feed).toBe('computed'); // the ceiling is the machine's, not Makera's
  });

  it('still refuses a job override that leaves an uncut spine (#191), catalogue or not', () => {
    setFeedCatalogue([HARDWOOD_ROW]);
    const res = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1, { stepOver: 2.0 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('#191');
  });
});

// #325 — the tier above the default YIELDS where it cannot answer, field by field. The failure this
// describe prevents is one a user meets as a REFUSAL of a job that cut fine yesterday: before the
// sync, `feedsFor` never saw the row at all.
describe('a row this job cannot use falls through to the starting table (#325)', () => {
  it('falls through a zero feed, and names the number it passed over', () => {
    const zeroFeed = { ...HARDWOOD_ROW, feed: 0 };
    setFeedCatalogue([zeroFeed]);
    const res = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
    // Before #325 this was `ok: false` — "cutting feed must be > 0, got 0 mm/min" — for a job the
    // same app generated happily before the sync. Studio writes `0` in a column it never filled.
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);

    expect(res.params.feed).toBe(400); // the hardwood 1.6-3.2 starting row
    expect(res.sources.feed).toBe('computed');
    // The rest of the row is untouched: this is per FIELD, not "the row is bad".
    expect(res.params.rpm).toBe(12000);
    expect(res.sources.rpm).toBe('catalogue');
    expect(res.params.plungeFeed).toBe(300);
    expect(res.params.stepDown).toBe(1.2);

    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'catalogue-ignored' });
    expect(res.diagnostics[0]!.message).toContain('0 mm/min');
    expect(res.diagnostics[0]!.message).toContain('not a positive number');
    expect(res.diagnostics[0]!.message).toContain('400 mm/min');
  });

  it('still answers nothing at all when every number in the row is unusable', () => {
    setFeedCatalogue([{ ...HARDWOOD_ROW, rpm: 0, feed: -1, plungeFeed: 0, stepDown: 0 }]);
    const res = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);
    // The panel reads `catalogue` to decide between "Makera's numbers" and "computed", and a row
    // that supplied none of them is not this job's catalogue answer.
    expect(res.catalogue).toBeNull();
    expect(new Set(Object.values(res.sources))).toEqual(new Set(['computed']));
    expect(res.provenance).toContain('Starting value');
    expect(res.diagnostics).toHaveLength(4);
    for (const d of res.diagnostics) {
      expect(d).toMatchObject({ severity: 'warning', code: 'catalogue-ignored' });
    }
  });

  it('leaves the refusals for values someone ASSERTED alone: an override still refuses', () => {
    // The asymmetry is the point: a vendor table does not get to assert for the user, and the user
    // still may not assert an uncuttable number. Same for the starting table, whose own values are
    // non-positive never. `cncFeeds.spec.ts` pins the override half in full.
    setFeedCatalogue([HARDWOOD_ROW]);
    const res = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1, { feed: 0 });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('cutting feed must be > 0');
  });
});

describe('no catalogue loaded is exactly the old behaviour', () => {
  it('every row of the table resolves as it did, unstamped', () => {
    for (const row of FEEDS_TABLE) {
      const diameter = (row.minDiameter + row.maxDiameter) / 2;
      // The row's OWN edge (#405): the V row's numbers are a cone's, so a flat end mill built to
      // its diameter would resolve against a different row — or none.
      const cutter =
        (row.edge ?? 'flat') === 'v'
          ? flatEndMill(diameter, { shape: 'engraving', typeText: 'Engraving', tipDiameter: diameter, diameter: 3.175, halfAngle: 15, angle: 30 })
          : flatEndMill(diameter);
      const res = feedsFor(feedCatalogueRows(), row.material, cutter, Z1);
      expect(res.ok, `${row.material} ${row.edge ?? 'flat'} ${diameter}`).toBe(true);
      if (!res.ok) continue;
      expect(res.catalogue).toBeNull();
      expect(res.provenance).toBe(row.provenance);
      expect(new Set(Object.values(res.sources))).toEqual(new Set(['computed']));
      expect(res.diagnostics).toEqual([]);
    }
  });

  it('a cleared catalogue forgets a row that was loaded a moment ago', () => {
    setFeedCatalogue([HARDWOOD_ROW]);
    const loaded = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(loaded.catalogue).not.toBeNull();

    clearFeedCatalogue();
    const cleared = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
    if (!cleared.ok) throw new Error(cleared.reason);
    expect(cleared.catalogue).toBeNull();
    expect(cleared.params.feed).toBe(400); // the hardwood 1.6-3.2 row, not the fixture's 900
    expect(cleared.sources.feed).toBe('computed');
    expect(cleared.provenance).toContain('Starting value');
  });
});

// #347, Route A — the ONE place the catalogue widens coverage, and it is by MATERIAL, never by
// cutter: a material the starting table has no row for AT ALL (the metals, ABS, Acrylic, which a
// machine profile declares) is cut on the vendor's own numbers for that exact cutter and material.
// The job's own row then STANDS ALONE, so what the tier above does to an unusable number — pass it
// over and let the starting table answer (#325) — is not available here: there is nothing
// underneath, and the job is refused with the reason.
//
// The four numbers below are hand-built fixtures in the service's shape, like the rest of this file.
describe('a material the starting table has no row for is answered by the catalogue alone (#347)', () => {
  const ALUMINIUM_ROW: FeedCatalogueRow = {
    cutterId: VENDOR_ID,
    material: '6061 Aluminum',
    rpm: 10000,
    feed: 400,
    plungeFeed: 120,
    stepDown: 0.3,
  };

  it('answers a 6061 job from the vendor’s row, with our step-over, peck and air', () => {
    setFeedCatalogue([ALUMINIUM_ROW]);
    // No row of the starting table carries this material — the whole premise of Route A.
    expect(FEEDS_TABLE.some((e) => e.material === 'aluminium-6061')).toBe(false);

    const res = feedsFor(feedCatalogueRows(), 'aluminium-6061', makeraCutter(), Z1);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.reason);

    // The vendor's four numbers, as-is…
    expect(res.params.rpm).toBe(10000);
    expect(res.params.feed).toBe(400);
    expect(res.params.plungeFeed).toBe(120);
    expect(res.params.stepDown).toBe(0.3);
    expect(res.sources.rpm).toBe('catalogue');
    expect(res.sources.feed).toBe('catalogue');
    expect(res.sources.plungeFeed).toBe('catalogue');
    expect(res.sources.stepDown).toBe('catalogue');
    // …and this app's three decisions, unchanged.
    expect(res.params.stepOver).toBeCloseTo(0.45 * 3.175, 10);
    expect(res.params.peck).toBeCloseTo(3.175, 10);
    expect(res.params.air).toBe(true);
    expect(res.sources.stepOver).toBe('computed');
    expect(res.sources.peck).toBe('computed');
    expect(res.sources.air).toBe('computed');

    // A vendor's starting point, NOT a measurement: nothing has been cut on this machine.
    expect(res.entry.status).toBe('unmeasured');
    expect(res.entry.material).toBe('aluminium-6061');
    expect(res.provenance).toContain("Makera's catalogue");
    expect(res.provenance).toContain('no row in the starting table');
    expect(res.provenance).toContain('the whole answer');
    expect(res.diagnostics).toEqual([]);
  });

  it('refuses with the missing row named when the catalogue has none for that cutter', () => {
    setFeedCatalogue([]);
    const res = feedsFor(feedCatalogueRows(), 'aluminium-6061', makeraCutter(), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    // The reason has to be actionable: which material, which cutter, and what to do about it.
    expect(res.reason).toContain('Aluminium 6061');
    expect(res.reason).toContain("Makera's catalogue has no row");
    expect(res.reason).toContain('sync the catalogue');
  });

  it('refuses a cutter with no vendor id, because no row of theirs can name it', () => {
    setFeedCatalogue([ALUMINIUM_ROW]);
    const res = feedsFor(feedCatalogueRows(), 'aluminium-6061', flatEndMill(3.175), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain("matched by Makera's own cutter id");
  });

  it('never lets one alloy answer the other: a 7075 row is not a 6061 row', () => {
    // Why `aluminium` is not one key. With a single key the first row of the two would have answered
    // both alloys, and the job would have been cut with another alloy's numbers — silently.
    setFeedCatalogue([{ ...ALUMINIUM_ROW, material: '7075 Aluminum' }]);
    const res = feedsFor(feedCatalogueRows(), 'aluminium-6061', makeraCutter(), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('Aluminium 6061');
  });

  it('REFUSES a vendor number this job cannot use — there is no starting row to fall to (#325 contrast)', () => {
    setFeedCatalogue([{ ...ALUMINIUM_ROW, feed: 0 }]);
    const res = feedsFor(feedCatalogueRows(), 'aluminium-6061', makeraCutter(), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('which this job cannot use');
    expect(res.reason).toContain('not a positive number');
    expect(res.reason).toContain('no row for Aluminium 6061');
  });

  it('refuses an rpm far past the ceiling the same way, rather than clamping it', () => {
    // 24 000 RPM is past the Z1's refusal band, so it is not a number this job can be cut with. On a
    // material WITH a starting row that row would answer instead (#325); here the job stops.
    setFeedCatalogue([{ ...ALUMINIUM_ROW, rpm: 24000 }]);
    const res = feedsFor(feedCatalogueRows(), 'aluminium-6061', makeraCutter(), Z1);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected a refusal');
    expect(res.reason).toContain('24000 RPM');
    expect(res.reason).toContain('refuses');
  });

  it('leaves the wood path exactly as it was: a catalogue row is added to, not substituted for', () => {
    setFeedCatalogue([ALUMINIUM_ROW, HARDWOOD_ROW]);
    const res = feedsFor(feedCatalogueRows(), 'aluminium-7075', makeraCutter(), Z1);
    expect(res.ok).toBe(false); // no 7075 row in this snapshot
    const wood = feedsFor(feedCatalogueRows(), 'hardwood', makeraCutter(), Z1);
    if (!wood.ok) throw new Error(wood.reason);
    expect(wood.params.feed).toBe(900); // HARDWOOD_ROW still answers wood
    expect(wood.provenance).not.toContain('no row in the starting table');
  });
});
