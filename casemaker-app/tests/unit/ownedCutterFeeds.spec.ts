// #732 — an owned cutter resolves Makera's catalogue rows once the operator has confirmed which
// Makera cutter it is. The cutter in this house's drawer was registered from its printed label
// (`scripts/build-house.ts`), so its materialised `Tool` carries `id: null`: no catalogue row can
// name it, and every job on a material the starting table does not cover is refused at the feeds
// stage. The rules under test are the maintainer decision of 2026-10-28:
//
//   - the suggestion is read from the cutter's own evidence (its printed code, else its shape,
//     tip and metal line) and is offered, never applied;
//   - the operator confirms it once, and the id is STORED on the inventory row (`item.tool.id`);
//   - until it is confirmed the feeds answer is unchanged: the cutter carries no Makera id.
//
// The jobs are the off-bench exercise's own files (`docs/bench/2026-10-27-z1-typical-jobs/jobs/`,
// untouched). The catalogue rows and ids here are HAND-BUILT fixtures in the service's shape —
// no number below is read from Studio's database (`/Fabrication.md` §3, #186).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { catalogueCoverageFor, feedsFor, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { suggestMakeraMatch, withMakeraId } from '@/engine/cnc/registerCutter';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { Tool } from '@/engine/cnc/tool';
import type { InventoryItem } from '@/platform/houseClient';
import type { StockMaterial } from '@/types/engraveJob';

const JOBS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'bench', '2026-10-27-z1-typical-jobs', 'jobs');

/** The material a bench job cuts, from the job file itself. */
function jobMaterial(id: string): StockMaterial {
  const job = JSON.parse(readFileSync(join(JOBS, `${id}.json`), 'utf8')) as { stock: { material: StockMaterial } };
  return job.stock.material;
}

/** The cutter a Tool with every stated field explicit — a label-built possession, `id: null`. */
function ownedTool(over: Partial<Tool> & Pick<Tool, 'name' | 'shape'>): Tool {
  return {
    number: null,
    id: null,
    typeText: '',
    handleDiameter: 3.175,
    tipDiameter: null,
    diameter: null,
    cornerRadius: null,
    angle: null,
    halfAngle: null,
    fluteLength: null,
    shoulderLength: null,
    stickout: null,
    centreCutting: null,
    ...over,
  };
}

/** An inventory row as `scripts/build-house.ts` writes it from the printed label. */
function ownedItem(id: string, tool: Tool, code: string): InventoryItem {
  return {
    id,
    tool,
    origin: null,
    quantity: 1,
    codes: [{ symbology: 'qr', value: code }],
    addedAt: '2026-10-12T00:00:00.000Z',
    notes: null,
    copies: [],
    colletFits: null,
  };
}

// The house's cutters, in the shape `build-house.ts` materialises them: the label's text as the
// name (the ONLY statement of the metal line an `inv:` tool carries), the box code's shape and
// numbers in the fields, and no Makera id anywhere.
const METAL_FLAT_3_175_12 = ownedItem(
  'kz-o-flute-m-3-175-12',
  ownedTool({
    name: 'Single Flute O-Flute Bit for Metal - 1/8" Shank 3.175mm * 12mm',
    typeText: 'Flat End',
    shape: 'flat',
    tipDiameter: 3.175,
    diameter: 3.175,
    cornerRadius: 0,
    fluteLength: 12,
  }),
  'C1-BIT-O-FLUTE-M-3.175-12',
);
const METAL_FLAT_1_3 = ownedItem(
  'kz-o-flute-m-1-3',
  ownedTool({
    name: 'Single Flute O-Flute Bit for Metal - 1/8" Shank 1mm * 3mm',
    typeText: 'Flat End',
    shape: 'flat',
    tipDiameter: 1,
    diameter: 1,
    cornerRadius: 0,
    fluteLength: 3,
  }),
  'C1-BIT-O-FLUTE-M-1-3',
);
const PLAIN_FLAT_3_175_25 = ownedItem(
  'kz-o-flute-3-175-25',
  ownedTool({
    name: 'Single Flute O-Flute Bit - 1/8" Shank 3.175mm * 25mm',
    typeText: 'Flat End',
    shape: 'flat',
    tipDiameter: 3.175,
    diameter: 3.175,
    cornerRadius: 0,
    fluteLength: 25,
  }),
  'C1-BIT-O-FLUTE-3.175-25',
);
const METAL_ENGRAVER_60_01 = ownedItem(
  'kz-engrave-m-60-0-1',
  ownedTool({
    name: 'Single Flute Engraving Bit for Metal - 1/8" Shank 60° * 0.1mm',
    typeText: 'Engraving',
    shape: 'engraving',
    tipDiameter: 0.1,
    diameter: 3.175,
    halfAngle: 30,
  }),
  'C1-BIT-ENGRAVE-M-60-0.1',
);

// Makera's cutter ids, hand-built fixtures in the 12-digit `g_ID` form. `112111313812` is the one
// real id the repository already carries (the built-in `flat-3.175x12-metal`, verbatim from
// TopClamp.nc), and the same physical bit is the house's metal O-flute.
const G_METAL_FLAT_3_175_12 = '112111313812';
const G_METAL_FLAT_1_3 = '112111313801';
const G_PLAIN_FLAT_3_175_25 = '112111313825';
const G_METAL_ENGRAVER_60_01 = '112111313860';

/** A catalogue row in the service's shape — `cutterId` is the row's `g_ID`. */
const row = (cutterId: string, material: string, rpm: number, feed: number, plungeFeed: number, stepDown: number): FeedCatalogueRow => ({
  cutterId,
  material,
  rpm,
  feed,
  plungeFeed,
  stepDown,
});

/** The rows the synced catalogue holds for this house's cutters, as the manifest quotes them. */
const CATALOGUE: readonly FeedCatalogueRow[] = [
  row(G_METAL_FLAT_3_175_12, '6061 Aluminum', 12000, 500, 200, 0.2),
  row(G_METAL_FLAT_3_175_12, 'ABS', 10000, 1000, 300, 1),
  row(G_METAL_FLAT_3_175_12, 'Acrylic', 10000, 1000, 300, 1),
  row(G_METAL_FLAT_1_3, '6061 Aluminum', 12000, 500, 200, 0.2),
  row(G_PLAIN_FLAT_3_175_25, 'ABS', 10000, 1000, 300, 1),
  row(G_PLAIN_FLAT_3_175_25, 'Acrylic', 10000, 1000, 300, 1),
  row(G_METAL_ENGRAVER_60_01, '6061 Aluminum', 12000, 500, 200, 0.2),
];

/** A `cat:` row for the suggestion: the key is the catalogue's UUID, `tool.id` is Makera's g_ID. */
function catalogueEntry(id: string, tool: Tool): ToolLibraryEntry {
  return { key: `cat:fixture-${id}`, tool: { ...tool, id }, provenance: `Makera catalogue ${id}` };
}

const CATALOGUE_ENTRIES: readonly ToolLibraryEntry[] = [
  catalogueEntry(
    G_METAL_FLAT_3_175_12,
    ownedTool({ name: '3.175*12mm Flat End(Metal)', typeText: 'Flat End', shape: 'flat', tipDiameter: 3.175, diameter: 3.175, cornerRadius: 0, fluteLength: 12 }),
  ),
  catalogueEntry(
    G_PLAIN_FLAT_3_175_25,
    ownedTool({ name: '3.175*25mm Flat End', typeText: 'Flat End', shape: 'flat', tipDiameter: 3.175, diameter: 3.175, cornerRadius: 0, fluteLength: 25 }),
  ),
  catalogueEntry(
    G_METAL_FLAT_1_3,
    ownedTool({ name: '1*3mm Flat End(Metal)', typeText: 'Flat End', shape: 'flat', tipDiameter: 1, diameter: 1, cornerRadius: 0, fluteLength: 3 }),
  ),
  catalogueEntry(
    G_METAL_ENGRAVER_60_01,
    ownedTool({ name: '60°*0.1mm Engraving(Metal)', typeText: 'Engraving', shape: 'engraving', tipDiameter: 0.1, diameter: 3.175, halfAngle: 30 }),
  ),
];

/** The same row, after the operator confirmed the match in Manage → Tools. */
function confirmed(item: InventoryItem, cutterId: string): InventoryItem {
  return withMakeraId(item, cutterId);
}

describe('#732 an owned cutter carries no Makera id until it is confirmed', () => {
  it.each([
    ['j01-topclamp-alu', METAL_FLAT_3_175_12],
    ['j04-metal-disc-text', METAL_FLAT_1_3],
    ['j17-faceplate-alu', METAL_FLAT_3_175_12],
  ])('%s is refused on aluminium, exactly as the bench manifest records', (jobId, item) => {
    const material = jobMaterial(jobId);
    const refused = feedsFor(CATALOGUE, material, item.tool, Z1);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('an owned cutter with no Makera id must not reach a catalogue row');
    expect(refused.reason).toContain("matched by Makera's own cutter id");
    expect(refused.reason).toContain('which this cutter does not carry');
  });

  it('j05 (two-colour laminate, plastic) is refused for the same reason', () => {
    const material = jobMaterial('j05-two-colour-sign');
    expect(material).toBe('plastic');
    const refused = feedsFor(CATALOGUE, material, PLAIN_FLAT_3_175_25.tool, Z1);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('an owned cutter with no Makera id must not reach a catalogue row');
    expect(refused.reason).toContain('which this cutter does not carry');
  });

  it('j15 (acrylic) is refused for the same reason until the id is confirmed', () => {
    const material = jobMaterial('j15-acrylic-keychain');
    expect(material).toBe('acrylic');
    const refused = feedsFor(CATALOGUE, material, PLAIN_FLAT_3_175_25.tool, Z1);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('an owned cutter with no Makera id must not reach a catalogue row');
    expect(refused.reason).toContain('which this cutter does not carry');
  });
});

describe('#732 a confirmed Makera id resolves the owned cutter from the catalogue', () => {
  it('j01 (Top Clamp, 6061): Makera’s aluminium row answers once the match is saved', () => {
    const material = jobMaterial('j01-topclamp-alu');
    const res = feedsFor(CATALOGUE, material, confirmed(METAL_FLAT_3_175_12, G_METAL_FLAT_3_175_12).tool, Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.rpm).toBe(12000);
    expect(res.params.feed).toBe(500);
    expect(res.params.plungeFeed).toBe(200);
    expect(res.params.stepDown).toBe(0.2);
    expect(res.catalogue?.cutterId).toBe(G_METAL_FLAT_3_175_12);
    expect(res.provenance).toContain('aluminium-6061');
    expect(res.sources.rpm).toBe('catalogue');
    expect(res.sources.feed).toBe('catalogue');
  });

  it('j04 (metal disc, 1 mm): the 1 mm cutter’s own row answers', () => {
    const material = jobMaterial('j04-metal-disc-text');
    const res = feedsFor(CATALOGUE, material, confirmed(METAL_FLAT_1_3, G_METAL_FLAT_1_3).tool, Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.stepDown).toBe(0.2);
    expect(res.catalogue?.cutterId).toBe(G_METAL_FLAT_1_3);
  });

  it('j17 (faceplate, 6061): the same bit as j01 answers on its aluminium row', () => {
    const material = jobMaterial('j17-faceplate-alu');
    const res = feedsFor(CATALOGUE, material, confirmed(METAL_FLAT_3_175_12, G_METAL_FLAT_3_175_12).tool, Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.feed).toBe(500);
    expect(res.catalogue?.cutterId).toBe(G_METAL_FLAT_3_175_12);
  });

  it('j05 (two-colour laminate): the plain O-flute takes Makera’s plastic row — an app mapping, labelled', () => {
    const material = jobMaterial('j05-two-colour-sign');
    const res = feedsFor(CATALOGUE, material, confirmed(PLAIN_FLAT_3_175_25, G_PLAIN_FLAT_3_175_25).tool, Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.rpm).toBe(10000);
    expect(res.params.feed).toBe(1000);
    expect(res.params.stepDown).toBe(1);
    // `plastic` is the app's own word; the row is ABS or acrylic standing in, and the sentence says so.
    expect(res.provenance).toContain('row standing in');
    expect(res.provenance).toContain('a mapping this app makes');
  });

  it('j15 (acrylic): the same bit takes Makera’s acrylic row directly — no mapping', () => {
    const material = jobMaterial('j15-acrylic-keychain');
    expect(material).toBe('acrylic');
    const res = feedsFor(CATALOGUE, material, confirmed(PLAIN_FLAT_3_175_25, G_PLAIN_FLAT_3_175_25).tool, Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.feed).toBe(1000);
    expect(res.provenance).not.toContain('standing in');
  });
});

describe('#732 a V-bit with a confirmed Makera id uses Makera’s engraving rows (j14)', () => {
  it('j14 (dog tag, 6061): the refusal names the missing id, not a false claim about cones', () => {
    const material = jobMaterial('j14-dog-tag');
    const refused = feedsFor(CATALOGUE, material, METAL_ENGRAVER_60_01.tool, Z1);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('an owned V-bit with no Makera id must not reach a catalogue row');
    expect(refused.reason).toContain('V-bit');
    expect(refused.reason).toContain("matched by Makera's own cutter id");
    // The bench run (2026-10-27) recorded the false half of this sentence. Makera's catalogue is
    // keyed by `g_ID` and states the same four numbers for every cutter, cones included (#405's
    // `CATALOGUE_FIELDS`); there is no cone-shaped hole in it to name.
    expect(refused.reason).not.toContain("never a cone's");
    expect(refused.reason).not.toContain("states a flat end mill's numbers");
  });

  it('j14: the engraver’s confirmed id resolves Makera’s 6061 engraving row', () => {
    const material = jobMaterial('j14-dog-tag');
    const res = feedsFor(CATALOGUE, material, confirmed(METAL_ENGRAVER_60_01, G_METAL_ENGRAVER_60_01).tool, Z1);
    if (!res.ok) throw new Error(res.reason);
    expect(res.params.rpm).toBe(12000);
    expect(res.params.feed).toBe(500);
    expect(res.params.plungeFeed).toBe(200);
    expect(res.params.stepDown).toBe(0.2);
    expect(res.catalogue?.cutterId).toBe(G_METAL_ENGRAVER_60_01);
    expect(res.sources.rpm).toBe('catalogue');
    expect(res.sources.feed).toBe('catalogue');
  });
});

describe('#732 the suggestion reads the cutter’s own evidence and never applies itself', () => {
  it('suggests catalogue rows by the label’s shape and tip, the same line first', () => {
    const suggestion = suggestMakeraMatch(METAL_FLAT_3_175_12, CATALOGUE_ENTRIES);
    if (suggestion === null) throw new Error('the metal O-flute carries a readable box code');
    expect(suggestion.from).toBe('code');
    expect(suggestion.code).toBe('C1-BIT-O-FLUTE-M-3.175-12');
    // Both 3.175 flats fit; the one on the metal line is offered first.
    expect(suggestion.matches.map((m) => m.cutterId)).toEqual([G_METAL_FLAT_3_175_12, G_PLAIN_FLAT_3_175_25]);
    expect(suggestion.matches[0]?.sameLine).toBe(true);
    expect(suggestion.matches[1]?.sameLine).toBe(false);
  });

  it('falls back to the record’s own shape and tip when it carries no readable code', () => {
    const typed = { ...METAL_FLAT_1_3, codes: [] };
    const suggestion = suggestMakeraMatch(typed, CATALOGUE_ENTRIES);
    if (suggestion === null) throw new Error('the tool record states a shape and a tip');
    expect(suggestion.from).toBe('tool');
    expect(suggestion.matches.map((m) => m.cutterId)).toEqual([G_METAL_FLAT_1_3]);
  });

  it('suggests an engraver on its tip and shape — its angle need not narrow the list', () => {
    const suggestion = suggestMakeraMatch(METAL_ENGRAVER_60_01, CATALOGUE_ENTRIES);
    if (suggestion === null) throw new Error('the engraver carries a readable box code');
    expect(suggestion.matches.map((m) => m.cutterId)).toEqual([G_METAL_ENGRAVER_60_01]);
  });

  it('says nothing when the record states neither a shape nor a tip', () => {
    const blank = ownedItem('kz-blank', ownedTool({ name: 'unknown cutter', shape: 'unknown' }), 'not a code');
    expect(suggestMakeraMatch(blank, CATALOGUE_ENTRIES)).toBeNull();
  });

  it('does not suggest an owned row that already carries a confirmed id', () => {
    expect(suggestMakeraMatch(confirmed(METAL_FLAT_3_175_12, G_METAL_FLAT_3_175_12), CATALOGUE_ENTRIES)).toBeNull();
  });
});

describe('#732 the confirmation is what the feeds read next', () => {
  it('a confirmed id makes the coverage the catalogue’s, not the cutter’s absence', () => {
    const before = catalogueCoverageFor(CATALOGUE, 'aluminium-6061', METAL_FLAT_3_175_12.tool);
    expect(before).toEqual({ kind: 'unlisted', why: 'no-vendor-id' });

    const after = catalogueCoverageFor(CATALOGUE, 'aluminium-6061', confirmed(METAL_FLAT_3_175_12, G_METAL_FLAT_3_175_12).tool);
    expect(after.kind).toBe('covered');
    if (after.kind !== 'covered') throw new Error('expected a covered row');
    expect(after.row.cutterId).toBe(G_METAL_FLAT_3_175_12);
  });
});
