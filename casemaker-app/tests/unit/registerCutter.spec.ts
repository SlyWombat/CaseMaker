// Registering a physical cutter (#309, milestone #212) — the pure half.
//
// The three ways a cutter gets into the inventory (scan a box, pick a catalogue row, type it in) all
// end in one `InventoryItem`, and the rules that are easy to get quietly wrong live here rather than
// in the panels: a code names ONE possession, a blank field is `null` and never 0, a clone keeps
// Makera's `id` while its `origin` names the catalogue ROW, and the box-code reading must not let
// one field of a label hide the right candidate row.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  itemFromEntry,
  itemFromForm,
  lengthProblem,
  parseBoxCode,
  quantityOrOne,
  quantityProblem,
  resolveCode,
  specOfTool,
  specProblem,
  toolFromSpec,
} from '@/engine/cnc/registerCutter';
import type { InventoryItem } from '@/platform/houseClient';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';
import { resetSeed, setSeededIds } from '@/utils/id';
import { shapeFromType } from '@/engine/cnc/tool';

const NOW = '2026-10-09T12:00:00.000Z';

/** A catalogue row, as `toolRegistryStore` materialises one: key `cat:<cutterId>`. */
function catalogueRow(over: Partial<ToolLibraryEntry['tool']> & { key?: string }): ToolLibraryEntry {
  const { key, ...tool } = over;
  return {
    key: key ?? 'cat:111111111111',
    tool: {
      number: null,
      id: '131012103804',
      name: '3.175*1*4mm Ball Nose',
      typeText: 'Ball Nose',
      shape: 'ball',
      handleDiameter: 3.175,
      tipDiameter: 1,
      diameter: 3.175,
      cornerRadius: null,
      angle: null,
      halfAngle: null,
      fluteLength: 4,
      shoulderLength: null,
      stickout: null,
      centreCutting: null,
      ...tool,
    },
    provenance: 'catalogue',
  };
}

/** An inventory item, as the service stores one. */
function ownedItem(over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'item-1',
    tool: catalogueRow({}).tool,
    origin: { id: '111111111111', syncedAt: '2026-10-01T00:00:00.000Z' },
    quantity: 1,
    codes: [{ symbology: 'qr', value: 'C1-BIT-BALL-NOSE-1-4' }],
    addedAt: '2026-10-02T00:00:00.000Z',
    notes: null,
    ...over,
  };
}

beforeEach(() => setSeededIds(true));
afterEach(() => resetSeed());

describe('parseBoxCode — the printed box code (#377, #378, #379)', () => {
  it('reads the bench cutter’s own box: a 1 mm ball nose with a 4 mm flute', () => {
    expect(parseBoxCode('C1-BIT-BALL-NOSE-1-4')).toEqual({
      shape: 'ball',
      tipDiameter: 1,
      fluteLength: 4,
      includedAngle: null,
      threadSpec: null,
      metal: false,
    });
  });

  it('reads the type word through the `type=` vocabulary, dashes and all', () => {
    expect(parseBoxCode('C1-BIT-FLAT-3.175-12')).toEqual({
      shape: 'flat',
      tipDiameter: 3.175,
      fluteLength: 12,
      includedAngle: null,
      threadSpec: null,
      metal: false,
    });
  });

  it('keeps a length it cannot read as null rather than losing the reading', () => {
    // The mockup's own fixture code: a flat 2 mm whose flute the label does not usefully state.
    expect(parseBoxCode('C1-BIT-FLAT-2-0')).toEqual({
      shape: 'flat',
      tipDiameter: 2,
      fluteLength: null,
      includedAngle: null,
      threadSpec: null,
      metal: false,
    });
  });

  it('is case- and whitespace-insensitive, because a scanner’s case is not part of the code', () => {
    expect(parseBoxCode('  c1-bit-ball-nose-1-4 ')).toEqual({
      shape: 'ball',
      tipDiameter: 1,
      fluteLength: 4,
      includedAngle: null,
      threadSpec: null,
      metal: false,
    });
  });

  it('says nothing about a code that is not the shape it knows', () => {
    expect(parseBoxCode('')).toBeNull();
    expect(parseBoxCode('C1-BIT-FLAT')).toBeNull(); // nothing below the type
    expect(parseBoxCode('SOMETHING-ELSE-1-4')).toBeNull(); // not a box code at all
  });

  // #377 — the first real corn bits. Makera's database files its twenty under the "Corn Bits" group
  // inside category 1, "Flat End", and the box code's two numbers are the same `<tip>-<flute>` every
  // other flat-family code carries, so only the type word was missing.
  it.each([
    ['C1-BIT-CORN-2.0-10.5', 2.0, 10.5],
    ['C1-BIT-CORN-3.0-12', 3.0, 12],
    ['C1-BIT-CORN-0.6-3', 0.6, 3],
    ['C1-BIT-CORN-1-7', 1, 7],
  ])('reads the real corn bit %s as a flat end (#377)', (code, tip, flute) => {
    expect(parseBoxCode(code)).toEqual({
      shape: 'flat',
      tipDiameter: tip,
      fluteLength: flute,
      includedAngle: null,
      threadSpec: null,
      metal: false,
    });
  });

  // #379 — the six real Spiral 'O' single-flute codes. A single-flute "O" end mill is a flat end
  // (Makera files it in the "Single Flute Non Metal" group, family "Flat End"), and the `-M-` token
  // is Makera's "for Metal" line, not a word of the type. The numbers are `<tip>-<flute>` either
  // way, and the last column is the one thing the marker DOES change (#379 review).
  it.each([
    ['C1-BIT-O-FLUTE-2-12', 2, 12, false],
    ['C1-BIT-O-FLUTE-3.175-25', 3.175, 25, false],
    ['C1-BIT-O-FLUTE-3.175-42', 3.175, 42, false],
    ['C1-BIT-O-FLUTE-M-1-3', 1, 3, true],
    ['C1-BIT-O-FLUTE-M-2-8', 2, 8, true],
    ['C1-BIT-O-FLUTE-M-3.175-12', 3.175, 12, true],
  ])('reads the real single-flute code %s as a flat end (#379)', (code, tip, flute, metal) => {
    expect(parseBoxCode(code)).toEqual({
      shape: 'flat',
      tipDiameter: tip,
      fluteLength: flute,
      includedAngle: null,
      threadSpec: null,
      metal,
    });
  });

  // #379 review — the four real drill codes. They read as `<tip>-<flute>` like the flat family, and
  // the sizes are the ones a bench actually drills with: a 1 mm, a 2 mm, a 2.5 mm and a 3 mm bit.
  it.each([
    ['C1-BIT-DRILL-1-10', 1, 10],
    ['C1-BIT-DRILL-2-12', 2, 12],
    ['C1-BIT-DRILL-2.5-12', 2.5, 12],
    ['C1-BIT-DRILL-3-12', 3, 12],
  ])('reads the real drill code %s on the numbers alone (#379 review)', (code, tip, flute) => {
    expect(parseBoxCode(code)).toEqual({
      shape: 'drill',
      tipDiameter: tip,
      fluteLength: flute,
      includedAngle: null,
      threadSpec: null,
      metal: false,
    });
  });

  // #379 review — the six real ball nose codes. The bench cutter's own box is `-1-4` (read at the top
  // of this file); these are the other five, and the three metal-line ones are pinned absolutely
  // because a reading that drops the marker still has to come out 2/6, 1/3 and 3.175/10.
  it.each([
    ['C1-BIT-BALL-NOSE-2-12', 2, 12, false],
    ['C1-BIT-BALL-NOSE-3.175-22', 3.175, 22, false],
    ['C1-BIT-BALL-NOSE-M-1-3', 1, 3, true],
    ['C1-BIT-BALL-NOSE-M-2-6', 2, 6, true],
    ['C1-BIT-BALL-NOSE-M-3.175-10', 3.175, 10, true],
  ])('reads the real ball nose code %s on the numbers alone (#379 review)', (code, tip, flute, metal) => {
    expect(parseBoxCode(code)).toEqual({
      shape: 'ball',
      tipDiameter: tip,
      fluteLength: flute,
      includedAngle: null,
      threadSpec: null,
      metal,
    });
  });

  // #378 — the five real engraving codes (two plain, three on the metal line). An ENGRAVE code is
  // `<angle>-<tip>` and states NO flute: `30-0.3` is a 30° cutter with a 0.3 mm tip. Read as
  // `<tip>-<flute>` — which is what this did when every type shared one reading — it said "a 30 mm
  // tip", a cutter nobody makes, and then matched no catalogue row.
  it.each([
    ['C1-BIT-ENGRAVE-30-0.3', 30, 0.3, false],
    ['C1-BIT-ENGRAVE-30-0.5', 30, 0.5, false],
    ['C1-BIT-ENGRAVE-M-30-0.2', 30, 0.2, true],
    ['C1-BIT-ENGRAVE-M-30-0.3', 30, 0.3, true],
    ['C1-BIT-ENGRAVE-M-60-0.1', 60, 0.1, true],
  ])('reads the real engraving code %s as angle-then-tip, and no flute (#378)', (code, angle, tip, metal) => {
    expect(parseBoxCode(code)).toEqual({
      shape: 'engraving',
      tipDiameter: tip,
      fluteLength: null,
      includedAngle: angle,
      threadSpec: null,
      metal,
    });
  });

  it('states an angle only where the type does: a flat code has none (#378)', () => {
    expect(parseBoxCode('C1-BIT-FLAT-3.175-12')?.includedAngle).toBeNull();
    expect(parseBoxCode('C1-BIT-ENGRAVE-30-0.3')?.includedAngle).toBe(30);
  });

  // #380 — a chamfer code is its type word and ONE number, the included angle: `C1-BIT-CHAMFER-90`,
  // the four 90° chamfer mills in the inventory. It states no tip and no flute at all, which is why a
  // code of two tokens has to be readable.
  it('reads the real chamfer code as an angle alone (#380)', () => {
    expect(parseBoxCode('C1-BIT-CHAMFER-90')).toEqual({
      shape: 'chamfer',
      tipDiameter: null,
      fluteLength: null,
      includedAngle: 90,
      threadSpec: null,
      metal: false,
    });
  });

  it('still refuses a two-token code that names no type it knows (#380)', () => {
    // The gate opened to two tokens so a chamfer's single number is reachable — not so that any two
    // tokens are a reading. The shape is what says whether a lone number is a tip or an angle.
    expect(parseBoxCode('C1-BIT-90')).toBeNull();
    expect(parseBoxCode('C1-BIT-WIDGET-90')).toBeNull();
  });

  // #380 — both real thread codes. THREAD is `<spec>-<flute>`: the token before the last is a thread
  // size, so `boxLength` read `M5` as a null tip and the code came out with one number missing. The
  // cutter's diameter is in neither the code nor its readings; it comes from Makera's thread row.
  it.each([
    ['C1-BIT-THREAD-M5-15', 'M5', 15],
    ['C1-BIT-THREAD-M3-9', 'M3', 9],
  ])('reads the real thread code %s as a spec and a flute (#380)', (code, spec, flute) => {
    expect(parseBoxCode(code)).toEqual({
      shape: 'thread',
      tipDiameter: null,
      fluteLength: flute,
      includedAngle: null,
      threadSpec: spec,
      metal: false,
    });
  });

  it('keeps a thread spec only when the token is one (#380)', () => {
    // The store's thread line runs M1 to M5, so a size with a decimal is a real code too.
    expect(parseBoxCode('C1-BIT-THREAD-M2.5-12')?.threadSpec).toBe('M2.5');
    expect(parseBoxCode('C1-BIT-THREAD-3-12')?.threadSpec).toBeNull();
  });

  it('keeps the metal marker as the only difference from the plain line (#379 review)', () => {
    // The marker rides between the word and the numbers, so the numbers are the same on both lines —
    // and this used to be the whole test: the two readings were equal and the line was lost. It is
    // now the one field that separates them, which is the point: `METAL_ROW` on the row side and this
    // flag on the label side are what keep a metal bit out of a PLA job.
    expect(parseBoxCode('C1-BIT-O-FLUTE-M-1-3')).toEqual({
      shape: 'flat',
      tipDiameter: 1,
      fluteLength: 3,
      includedAngle: null,
      threadSpec: null,
      metal: true,
    });
    expect(parseBoxCode('C1-BIT-O-FLUTE-1-3')).toEqual({
      shape: 'flat',
      tipDiameter: 1,
      fluteLength: 3,
      includedAngle: null,
      threadSpec: null,
      metal: false,
    });
  });

  it('does not read a thread size as the metal marker: the match is exact (#379 review)', () => {
    // `THREAD-M5-15` is one token saying what the thread mill cuts. Taking it for the marker would
    // drop the spec AND claim the metal line for a row that is not on it.
    expect(parseBoxCode('C1-BIT-THREAD-M5-15')?.metal).toBe(false);
    expect(parseBoxCode('C1-BIT-THREAD-M5-15')?.threadSpec).toBe('M5');
  });

  // #379 review — the store's SKU is the box code plus its pack suffix, and the suffix arrived as
  // one of the cutter's numbers: `DRILL-2.5-12-10PCS` came out a 12 mm drill (the pack count read as
  // the flute, the 2.5 as the tip) and `ENGRAVE-30-0.3-10PCS` a 0.3° engraver. A scanned QR value
  // never carries it; a typed SKU does.
  it('drops the store’s pack suffix, so the tail is the cutter’s numbers again (#379 review)', () => {
    expect(parseBoxCode('C1-BIT-DRILL-2.5-12-10PCS')).toEqual({
      shape: 'drill',
      tipDiameter: 2.5,
      fluteLength: 12,
      includedAngle: null,
      threadSpec: null,
      metal: false,
    });
    expect(parseBoxCode('C1-BIT-ENGRAVE-30-0.3-10PCS')).toEqual({
      shape: 'engraving',
      tipDiameter: 0.3,
      fluteLength: null,
      includedAngle: 30,
      threadSpec: null,
      metal: false,
    });
  });

  it('drops the pack suffix before the type word is searched, not after (#379 review)', () => {
    // The suffix is the STORE's token and the tail is read from the end, so a code whose only other
    // number is a tip has nothing left to be a flute: `DRILL-2.5-10PCS` is not a reading at all,
    // where a trailing `10` would have made it "a 2.5 mm drill with a 10 mm flute" — a cutter made
    // out of a pack size.
    expect(parseBoxCode('C1-BIT-DRILL-2.5-10PCS')).toBeNull();
    expect(parseBoxCode('C1-BIT-DRILL-2.5-10')?.fluteLength).toBe(10);
  });

  it('does not read a plain `flute` as an O-flute: engraving stays engraving (#379)', () => {
    expect(shapeFromType('Single Flute Engraving')).toBe('engraving');
    expect(shapeFromType('Two Flute Ball Nose')).toBe('ball');
  });
});

describe('resolveCode — the scan door’s three outcomes', () => {
  const catalogue = [catalogueRow({}), catalogueRow({ key: 'cat:222222222222', tipDiameter: 2 })];

  it('a code the inventory already holds is that item, never a second one', () => {
    const item = ownedItem();
    const got = resolveCode('C1-BIT-BALL-NOSE-1-4', [item], catalogue);
    expect(got).toEqual({ kind: 'owned', item });
  });

  it('matches a stored code exactly, which is the service’s own duplicate rule (#311 review)', () => {
    // The service compares codes byte for byte, so a lowercase retype that matched here would be
    // offered as "one you have" and then registered as a second item there. The label is the
    // source: a scanner types it as printed, and whitespace is the one thing a scanner adds.
    const item = ownedItem();
    expect(resolveCode(' C1-BIT-BALL-NOSE-1-4 ', [item], catalogue)).toEqual({ kind: 'owned', item });
    expect(resolveCode('c1-bit-ball-nose-1-4', [item], catalogue).kind).not.toBe('owned');
  });

  it('offers the rows that fit the reading when nothing owns the code', () => {
    const got = resolveCode('C1-BIT-BALL-NOSE-1-4', [], catalogue);
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.rows.map((r) => r.key)).toEqual(['cat:111111111111']);
    expect(got.prefill).toEqual({
      shape: 'ball',
      tipDiameter: 1,
      fluteLength: 4,
      includedAngle: null,
      threadSpec: null,
      metal: false,
    });
  });

  it('ignores the flute: the same tip with a different stated flute is still offered', () => {
    // The one label that is known states a 4 mm flute and the catalogue row agrees — but the flute
    // is the field the reading is LEAST sure of (#208 A7), so a disagreement there must not hide a
    // row. This is the failure that is not recoverable: an empty list leaves the user no way back.
    const other = [catalogueRow({ fluteLength: 6 })];
    const got = resolveCode('C1-BIT-BALL-NOSE-1-4', [], other);
    expect(got.kind).toBe('candidates');
  });

  it('does not offer a row whose tip the catalogue does not state', () => {
    // A candidate is a claim that this row FITS a 1 mm tip. A row stating no tip at all cannot be
    // claimed for a label that states one.
    const loose = [catalogueRow({ tipDiameter: null })];
    expect(resolveCode('C1-BIT-BALL-NOSE-1-4', [], loose).kind).toBe('unknown');
  });

  it('narrows by shape alone when the label stated no tip to narrow by', () => {
    const rows = [
      catalogueRow({ key: 'cat:aaaa11111111', tipDiameter: 1 }),
      catalogueRow({ key: 'cat:bbbb22222222', shape: 'flat' }),
    ];
    const got = resolveCode('C1-BIT-BALL-NOSE-X-4', [], rows);
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.rows.map((r) => r.key)).toEqual(['cat:aaaa11111111']);
  });

  it('does not narrow by a shape word it could not read', () => {
    const flat = [catalogueRow({ key: 'cat:333333333333', shape: 'flat', tipDiameter: 1 })];
    const got = resolveCode('C1-BIT-WEIRD-1-4', [], flat);
    expect(got.kind).toBe('candidates');
  });

  it('only considers catalogue rows: a box code names a Makera cutter, not a built-in', () => {
    const got = resolveCode('C1-BIT-FLAT-3.175-12', [], TOOL_LIBRARY);
    expect(got.kind).toBe('unknown');
  });

  it('hands the Type door the numbers when the code was read but nothing fits', () => {
    const got = resolveCode('C1-BIT-FLAT-3.175-12', [], []);
    expect(got).toEqual({
      kind: 'unknown',
      prefill: {
        shape: 'flat',
        tipDiameter: 3.175,
        fluteLength: 12,
        includedAngle: null,
        threadSpec: null,
        metal: false,
      },
    });
  });

  it('hands an engraving code’s angle along, and no imagined 30 mm tip (#378)', () => {
    // The reading is the only thing the user has to check the box against, so `describeReading`
    // builds its sentence from THIS value — "engraving cutter, 30 mm tip" was the sentence before.
    const got = resolveCode('C1-BIT-ENGRAVE-30-0.3', [], []);
    expect(got).toEqual({
      kind: 'unknown',
      prefill: {
        shape: 'engraving',
        tipDiameter: 0.3,
        fluteLength: null,
        includedAngle: 30,
        threadSpec: null,
        metal: false,
      },
    });
  });

  it('hands a chamfer code’s angle along, and no tip it never stated (#380)', () => {
    // Two tokens, six fields: the whole of a chamfer code is one number, and the door has to say
    // "chamfer mill, 90°" rather than treat the pair as a tip and a flute.
    const got = resolveCode('C1-BIT-CHAMFER-90', [], []);
    expect(got).toEqual({
      kind: 'unknown',
      prefill: {
        shape: 'chamfer',
        tipDiameter: null,
        fluteLength: null,
        includedAngle: 90,
        threadSpec: null,
        metal: false,
      },
    });
  });

  // #379 review — nothing about a cutter's dimensions says which product line it is, and `ToolSchema`
  // has no field for one, so Makera's `(Metal)` row name is the only place a row states it. The
  // reading carries the flag and the candidates put the SAME line first, which is what keeps a bit
  // ground for aluminium from being offered as the one to fit for PLA.
  const lines = [
    catalogueRow({
      key: 'cat:222222222222',
      name: '3.175*25mm Flat End',
      shape: 'flat',
      tipDiameter: 3.175,
      fluteLength: 25,
    }),
    catalogueRow({
      key: 'cat:333333333333',
      name: '3.175*12mm Flat End(Metal)',
      shape: 'flat',
      tipDiameter: 3.175,
      fluteLength: 12,
    }),
  ];

  it('offers the metal-line row ahead of the plain one when the box carries the marker (#379 review)', () => {
    // The two real 3.175 single-flute codes sit one `-M-` apart on the shelf, and both rows fit the
    // reading. The marker is the only thing that says which one is in the user's hand.
    const got = resolveCode('C1-BIT-O-FLUTE-M-3.175-12', [], lines);
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.rows.map((r) => r.key)).toEqual(['cat:333333333333']);
  });

  it('offers the plain row ahead of the metal one when the box says nothing (#379 review)', () => {
    const got = resolveCode('C1-BIT-O-FLUTE-3.175-25', [], lines);
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.rows.map((r) => r.key)).toEqual(['cat:222222222222']);
  });

  it('still offers the other line rather than nothing, when that is all there is (#379 review)', () => {
    // Ahead of, never instead of. A catalogue that does not carry the line, or a row whose name does
    // not state one, must not leave the user with an empty panel: this is the same rule that keeps
    // the flute from narrowing anything (an empty list has no way back).
    const plainOnly = [lines[0]!];
    const got = resolveCode('C1-BIT-O-FLUTE-M-3.175-12', [], plainOnly);
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.rows.map((r) => r.key)).toEqual(['cat:222222222222']);
  });

  it('has no prefill when there was nothing to read', () => {
    expect(resolveCode('not a code', [], [])).toEqual({ kind: 'unknown', prefill: null });
    expect(resolveCode('   ', [], [])).toEqual({ kind: 'unknown', prefill: null });
  });
});

describe('itemFromEntry — a catalogue row registered as owned', () => {
  it('keeps Makera’s id on the copied definition and names the ROW in origin', () => {
    const entry = catalogueRow({});
    const item = itemFromEntry(entry, { quantity: 2, code: { symbology: 'qr', value: 'X' }, now: NOW });
    expect(item.tool.id).toBe('131012103804'); // the definition stays Makera's (not the g_ID)
    expect(item.origin).toEqual({ id: '111111111111', syncedAt: null }); // the ROW's cutterId
    expect(item.tool).not.toBe(entry.tool); // a copy: editing ours cannot rewrite the catalogue's
    expect(item.quantity).toBe(2);
    expect(item.codes).toEqual([{ symbology: 'qr', value: 'X' }]);
    expect(item.addedAt).toBe(NOW);
  });

  it('stamps the sync the row came from when the service reported one', () => {
    const health = { catalogueSyncedAt: '2026-10-01T00:00:00.000Z' } as never;
    const item = itemFromEntry(catalogueRow({}), { quantity: 1, now: NOW, health });
    expect(item.origin).toEqual({ id: '111111111111', syncedAt: '2026-10-01T00:00:00.000Z' });
  });

  it('leaves origin null for a row that is nobody’s catalogue', () => {
    const item = itemFromEntry(catalogueRow({ key: 'user:mytool' }), { quantity: 1, now: NOW });
    expect(item.origin).toBeNull();
  });

  it('carries no code and no notes as null rather than empty', () => {
    const item = itemFromEntry(catalogueRow({}), { quantity: 1, now: NOW });
    expect(item.codes).toEqual([]);
    expect(item.notes).toBeNull();
  });

  it('trims notes, and a blank one is null', () => {
    expect(itemFromEntry(catalogueRow({}), { quantity: 1, now: NOW, notes: '  ' }).notes).toBeNull();
    expect(itemFromEntry(catalogueRow({}), { quantity: 1, now: NOW, notes: ' spare ' }).notes).toBe(
      'spare',
    );
  });
});

describe('itemFromForm — the Type door', () => {
  const blank = {
    name: 'My 2 mm flat',
    shape: 'flat' as const,
    tipDiameter: '',
    handleDiameter: '',
    fluteLength: '',
    shoulderLength: '',
    quantity: '',
    notes: '',
  };

  it('a blank length is null, never 0', () => {
    const item = itemFromForm(blank, NOW);
    expect(item.tool.tipDiameter).toBeNull();
    expect(item.tool.handleDiameter).toBeNull();
    expect(item.tool.fluteLength).toBeNull();
    expect(item.tool.shoulderLength).toBeNull();
    expect(item.tool.stickout).toBeNull();
  });

  it('a typed-in cutter came from no Makera table and no catalogue row', () => {
    const item = itemFromForm(blank, NOW);
    expect(item.tool.id).toBeNull();
    expect(item.tool.number).toBeNull();
    expect(item.origin).toBeNull();
    expect(item.codes).toEqual([]);
  });

  it('reads the fields it was given', () => {
    const item = itemFromForm(
      { ...blank, tipDiameter: '2', handleDiameter: '3.175', fluteLength: '12', shoulderLength: '18' },
      NOW,
    );
    expect(item.tool.tipDiameter).toBe(2);
    expect(item.tool.handleDiameter).toBe(3.175);
    expect(item.tool.fluteLength).toBe(12);
    expect(item.tool.shoulderLength).toBe(18);
  });

  it('a flat end mill’s diameter IS its cutting diameter, and its corner is square', () => {
    const item = itemFromForm({ ...blank, tipDiameter: '2', handleDiameter: '3.175' }, NOW);
    expect(item.tool.diameter).toBe(2);
    expect(item.tool.cornerRadius).toBe(0);
  });

  it('every other shape carries the shank as its diameter, and no corner radius claim', () => {
    const item = itemFromForm(
      { ...blank, shape: 'ball', tipDiameter: '1', handleDiameter: '3.175' },
      NOW,
    );
    expect(item.tool.diameter).toBe(3.175);
    expect(item.tool.cornerRadius).toBeNull();
  });

  // #334 — `diameter` is the SHANK for every non-flat shape (`Tool.diameter`), so a ball nose typed
  // with a tip and no shank must not be given the tip as a shank: that is a claim the user never
  // made, and the sweep's holder reasoning (#314) reads it as one.
  it('a ball nose with a tip and no shank has no diameter — the tip is not a shank (#334)', () => {
    const item = itemFromForm({ ...blank, shape: 'ball', tipDiameter: '1' }, NOW);
    expect(item.tool.diameter).toBeNull();
    expect(item.tool.tipDiameter).toBe(1);
    expect(item.tool.handleDiameter).toBeNull();
  });

  it('a flat end mill with a tip alone has that tip as its diameter', () => {
    const item = itemFromForm({ ...blank, shape: 'flat', tipDiameter: '1' }, NOW);
    expect(item.tool.diameter).toBe(1);
  });

  it('records the shape in the vocabulary the parser reads back', () => {
    for (const shape of ['flat', 'ball', 'tapered-ball', 'engraving', 'chamfer', 'drill', 'thread', 'bull'] as const) {
      const item = itemFromForm({ ...blank, shape }, NOW);
      expect(shapeFromType(item.tool.typeText)).toBe(shape);
    }
  });

  it('a blank quantity is one; it never writes a zero', () => {
    expect(itemFromForm(blank, NOW).quantity).toBe(1);
  });
});

// #334 — a typed 0 or negative is a typo, not an unknown. It used to become null silently, which
// read a slip of the finger as "not stated"; now the form is refused with a sentence, the way a bad
// quantity is, and only a blank box is the honest null.
describe('lengthProblem / specProblem — a typed length that cannot be one', () => {
  const spec = {
    name: 'My 2 mm flat',
    shape: 'flat' as const,
    tipDiameter: '',
    handleDiameter: '',
    fluteLength: '',
    shoulderLength: '',
  };

  it('is silent about a blank and about a length above 0', () => {
    expect(lengthProblem('')).toBeNull();
    expect(lengthProblem('  ')).toBeNull();
    expect(lengthProblem('0.5')).toBeNull();
    expect(specProblem({ ...spec, fluteLength: '12' })).toBeNull();
  });

  it('refuses a -3 flute with a sentence naming the box, rather than nulling it', () => {
    expect(lengthProblem('-3')).toContain('above 0');
    expect(lengthProblem('0')).toContain('above 0');
    expect(lengthProblem('abc')).not.toBeNull();
    const why = specProblem({ ...spec, fluteLength: '-3' });
    expect(why).not.toBeNull();
    expect(why).toContain('flute');
    expect(why).toContain('above 0');
  });

  it('a nameless cutter is refused first', () => {
    expect(specProblem({ ...spec, name: '  ', tipDiameter: '-1' })).toBe('a cutter needs a name');
  });
});

// #335 — the Yours-row editor writes the same six fields over an EXISTING tool, and what it has no
// box for stays what it was.
describe('toolFromSpec / specOfTool — the editor’s round trip', () => {
  it('keeps the measurements the form has no box for', () => {
    const base = { ...catalogueRow({}).tool, stickout: 22, centreCutting: true, angle: 30 };
    const next = toolFromSpec({ ...specOfTool(base), shoulderLength: '14' }, base);
    expect(next.shoulderLength).toBe(14);
    expect(next.stickout).toBe(22);
    expect(next.centreCutting).toBe(true);
    expect(next.angle).toBe(30);
    // And `diameter` follows the rule, not the base: a ball nose's is the shank.
    expect(next.diameter).toBe(3.175);
  });

  it('shows a null as a blank box and reads a blank box back as null', () => {
    const base = { ...catalogueRow({}).tool, shoulderLength: null };
    const spec = specOfTool(base);
    expect(spec.shoulderLength).toBe('');
    expect(spec.tipDiameter).toBe('1');
    expect(toolFromSpec(spec, base)).toEqual(base);
  });
});

describe('quantityOrOne', () => {
  it('reads a count, and a blank field is one', () => {
    expect(quantityOrOne('')).toBe(1);
    expect(quantityOrOne('  ')).toBe(1);
    expect(quantityOrOne('3')).toBe(3);
  });

  it('refuses 0 by leaving it for the form rather than silently turning it into one', () => {
    expect(quantityOrOne('0')).toBe(0);
    expect(quantityOrOne('1.5')).toBe(0);
    expect(quantityOrOne('abc')).toBe(0);
  });
});

describe('quantityProblem', () => {
  it('is silent about everything the service accepts, blank included', () => {
    expect(quantityProblem('')).toBeNull();
    expect(quantityProblem('  ')).toBeNull();
    expect(quantityProblem('2')).toBeNull();
  });

  it('says what is wrong with a count the service would refuse, and is the SAME rule', () => {
    for (const refused of ['0', '1.5', 'abc', '-1']) {
      expect(quantityProblem(refused)).not.toBeNull();
      expect(quantityOrOne(refused)).toBeLessThanOrEqual(0);
    }
  });
});
