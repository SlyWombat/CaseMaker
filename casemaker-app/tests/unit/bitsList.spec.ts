/**
 * #1172 Part A — the bits list's own facts, out of the component.
 *
 * The header counts what the operator OWNS (the inventory), not every row the app knows; the Have
 * column says what the pieces are, in the operator's words, never assuming an undescribed piece is
 * good (#1149); and the search finds the case colour and the place as well as the cutter's numbers.
 */
import { describe, expect, it } from 'vitest';
import type { InventoryItem } from '@/platform/houseClient';
import { haveWords, ownedCounts, possessionSearchText } from '@/components/manage/bitsList';

function item(over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'inv-1',
    tool: {
      number: null,
      id: null,
      name: '1 mm ball',
      typeText: 'Ball Nose',
      shape: 'ball',
      diameter: 1,
      tipDiameter: 1,
      handleDiameter: 3.175,
      fluteLength: 4,
      shoulderLength: null,
      stickout: null,
      flutes: 2,
      material: null,
      coating: null,
      notes: null,
    },
    origin: null,
    quantity: 2,
    codes: [],
    addedAt: '2026-11-01T00:00:00.000Z',
    notes: null,
    copies: [],
    colletFits: null,
    ...over,
  } as InventoryItem;
}

const machineName = (id: string): string => (id === 'm1' ? 'Zoomba' : id);

describe('#1172 — the bits list facts', () => {
  it('counts kinds, pieces, broken and lost over the OWNED rows', () => {
    const counts = ownedCounts([
      item({ id: 'a', quantity: 3, copies: [{ id: 'c1', condition: 'broken', whereabouts: { kind: 'box', case: null }, runtimeWarnMinutes: null, notes: null, runtimeMinutes: null }] }),
      item({ id: 'b', quantity: 2, copies: [{ id: 'c2', condition: 'lost', whereabouts: { kind: 'box', case: null }, runtimeWarnMinutes: null, notes: null, runtimeMinutes: null }] }),
    ]);
    expect(counts).toEqual({ kinds: 2, pieces: 5, broken: 1, lost: 1 });
  });

  it('says what the pieces are: good, worn, broken, lost, in a machine, unknown', () => {
    const copy = (id: string, condition: InventoryItem['copies'][number]['condition'], machine?: string) => ({
      id,
      condition,
      whereabouts: machine === undefined ? ({ kind: 'box', case: null } as const) : ({ kind: 'machine', machineId: machine } as const),
      runtimeWarnMinutes: null,
      notes: null,
      runtimeMinutes: null,
    });
    expect(haveWords(item({ copies: [copy('1', 'new'), copy('2', 'used')] }), machineName)).toBe('2 good');
    expect(haveWords(item({ copies: [copy('1', 'used'), copy('2', 'broken')] }), machineName)).toBe('1 good · 1 broken');
    // Nothing usable: the zero is said, then what became of it.
    expect(haveWords(item({ quantity: 1, copies: [copy('1', 'lost')] }), machineName)).toBe('0 · lost');
    expect(haveWords(item({ copies: [copy('1', 'used'), copy('2', null, 'm1')] }), machineName)).toBe('1 good · 1 in Zoomba');
    // A piece nobody described is UNKNOWN, never good.
    expect(haveWords(item({ copies: [] }), machineName)).toBe('2 unknown');
  });

  it('finds a row by its case colour, the words on the case, and the place it is kept', () => {
    const text = possessionSearchText(
      item({
        notes: 'box A · row 1',
        copies: [
          {
            id: 'c1',
            condition: 'used',
            whereabouts: { kind: 'box', case: { colour: 'yellow', label: 'yellow base, clear tube' } },
            runtimeWarnMinutes: null,
            notes: null,
            runtimeMinutes: null,
          },
        ],
      }),
    );
    expect(text).toContain('yellow');
    expect(text).toContain('clear tube');
    expect(text).toContain('box a · row 1');
  });
});
