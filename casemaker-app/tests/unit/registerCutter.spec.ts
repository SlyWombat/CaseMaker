// Registering a physical cutter (#309, milestone #212) — the pure half.
//
// The three ways a cutter gets into the inventory (scan a box, pick a catalogue row, type it in) all
// end in one `InventoryItem`, and the rules that are easy to get quietly wrong live here rather than
// in the panels: a code names ONE possession, a blank field is `null` and never 0, a clone keeps
// Makera's `id` while its `origin` names the catalogue ROW, and the provisional box-code reading
// must not let one guessed field hide the right candidate row.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  itemFromEntry,
  itemFromForm,
  parseBoxCode,
  quantityOrOne,
  quantityProblem,
  resolveCode,
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

describe('parseBoxCode — PROVISIONAL (#208 A7: one label known)', () => {
  it('reads the bench cutter’s own box: a 1 mm ball nose with a 4 mm flute', () => {
    expect(parseBoxCode('C1-BIT-BALL-NOSE-1-4')).toEqual({
      shape: 'ball',
      tipDiameter: 1,
      fluteLength: 4,
    });
  });

  it('reads the type word through the `type=` vocabulary, dashes and all', () => {
    expect(parseBoxCode('C1-BIT-FLAT-3.175-12')).toEqual({
      shape: 'flat',
      tipDiameter: 3.175,
      fluteLength: 12,
    });
  });

  it('keeps a length it cannot read as null rather than losing the reading', () => {
    // The mockup's own fixture code: a flat 2 mm whose flute the label does not usefully state.
    expect(parseBoxCode('C1-BIT-FLAT-2-0')).toEqual({
      shape: 'flat',
      tipDiameter: 2,
      fluteLength: null,
    });
  });

  it('is case- and whitespace-insensitive, because a scanner’s case is not part of the code', () => {
    expect(parseBoxCode('  c1-bit-ball-nose-1-4 ')).toEqual({
      shape: 'ball',
      tipDiameter: 1,
      fluteLength: 4,
    });
  });

  it('says nothing about a code that is not the shape it knows', () => {
    expect(parseBoxCode('')).toBeNull();
    expect(parseBoxCode('C1-BIT-FLAT')).toBeNull(); // nothing below the type
    expect(parseBoxCode('SOMETHING-ELSE-1-4')).toBeNull(); // not a box code at all
  });
});

describe('resolveCode — the scan door’s three outcomes', () => {
  const catalogue = [catalogueRow({}), catalogueRow({ key: 'cat:222222222222', tipDiameter: 2 })];

  it('a code the inventory already holds is that item, never a second one', () => {
    const item = ownedItem();
    const got = resolveCode('C1-BIT-BALL-NOSE-1-4', [item], catalogue);
    expect(got).toEqual({ kind: 'owned', item });
  });

  it('matches a stored code case-insensitively — the same box, so the same item', () => {
    const item = ownedItem();
    expect(resolveCode('c1-bit-ball-nose-1-4', [item], catalogue)).toEqual({ kind: 'owned', item });
  });

  it('offers the rows that fit the reading when nothing owns the code', () => {
    const got = resolveCode('C1-BIT-BALL-NOSE-1-4', [], catalogue);
    expect(got.kind).toBe('candidates');
    if (got.kind !== 'candidates') return;
    expect(got.rows.map((r) => r.key)).toEqual(['cat:111111111111']);
    expect(got.prefill).toEqual({ shape: 'ball', tipDiameter: 1, fluteLength: 4 });
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
      prefill: { shape: 'flat', tipDiameter: 3.175, fluteLength: 12 },
    });
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
