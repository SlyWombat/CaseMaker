// #491 — the case colour vocabulary and the one-off migration of the label import's note.
//
// The colour is the copy's: `{ colour, label? }` on a box. The migration reads `Case: yellow.` (or
// `Case: yellow + orange.` with the variant split) from the notes and assigns it to the physical
// copies, creating the copy entries the inventory did not have. It never guesses and never touches
// the note.

import { describe, expect, it } from 'vitest';
import {
  caseColourOnly,
  caseColourWord,
  caseSwatch,
  copyCaseSummary,
  distinctCases,
  parseCaseNote,
} from '@/engine/cnc/caseColour';
import { migrateCaseNote, type MigratableItem } from '@/engine/cnc/caseNoteMigration';
import type { ToolCopy } from '@/engine/cnc/toolCondition';

const copy = (id: string, condition: ToolCopy['condition'], where: ToolCopy['whereabouts']): ToolCopy => ({
  id,
  condition,
  whereabouts: where,
  runtimeWarnMinutes: null,
  notes: null,
  runtimeMinutes: null,
});

const item = (patch: Partial<MigratableItem> = {}): MigratableItem => ({
  id: 'inv-1',
  quantity: 1,
  notes: null,
  copies: [],
  ...patch,
});

describe('#491 the case colour vocabulary', () => {
  it('prints the operator’s word, and maps only the palette it knows to a swatch', () => {
    expect(caseColourWord('yellow')).toBe('Yellow case');
    expect(caseColourWord('yellow ')).toBe('Yellow case');
    expect(caseSwatch('yellow')).toBe('#d8b52a');
    expect(caseSwatch('YELLOW')).toBe('#d8b52a');
    expect(caseSwatch('magenta')).toBeNull();
    expect(caseSwatch(null)).toBeNull();
    expect(caseColourOnly('yellow base, clear tube')).toBe('yellow');
  });

  it('summarises only the copies that state a case, one entry per distinct colour', () => {
    const copies = [
      copy('a', 'new', { kind: 'box', case: { colour: 'yellow', label: 'yellow base, clear tube' } }),
      copy('b', 'used', { kind: 'box', case: { colour: 'Yellow', label: null } }),
      copy('c', 'worn', { kind: 'box', case: { colour: 'orange', label: null } }),
      copy('d', 'new', { kind: 'box' }),
      copy('e', 'new', { kind: 'machine', machineId: 'm-1' }),
    ];
    expect(distinctCases(copies)).toEqual([
      { colour: 'yellow', count: 2, label: 'yellow base, clear tube' },
      { colour: 'orange', count: 1, label: null },
    ]);
    expect(copyCaseSummary(copies)).toBe('3 copies: yellow, orange');
    expect(copyCaseSummary([copy('a', 'new', { kind: 'box' })])).toBeNull();
  });

  it('reads the note the label import has always written, including the variant split', () => {
    expect(parseCaseNote('Case: yellow. Makera SKU.')).toEqual({ colours: ['yellow'], counts: [null] });
    expect(parseCaseNote('Case: yellow + orange. Two physical variants: 2× yellow with collar; 2× orange.')).toEqual({
      colours: ['yellow', 'orange'],
      counts: [2, 2],
    });
    expect(parseCaseNote('Case: yellow + orange.')).toEqual({ colours: ['yellow', 'orange'], counts: [null, null] });
    expect(parseCaseNote('no case note')).toBeNull();
    expect(parseCaseNote(null)).toBeNull();
  });
});

describe('#491 migrating the note onto the copies', () => {
  it('creates one uncoloured-condition copy per box and leaves the note intact', () => {
    const before = item({ quantity: 3, notes: 'Case: yellow. Makera C1. Label CN: 玉米刀.' });
    const result = migrateCaseNote(before);
    expect(result.changed).toBe(true);
    expect(result.item.notes).toBe(before.notes);
    expect(result.item.copies).toHaveLength(3);
    for (const c of result.item.copies) {
      expect(c).toMatchObject({
        condition: null,
        whereabouts: { kind: 'box', case: { colour: 'yellow', label: null } },
      });
    }
    expect(result.reason).toContain('yellow');
  });

  it('keeps the operator’s conditions, and a machine copy never takes a case', () => {
    const result = migrateCaseNote(
      item({
        quantity: 3,
        notes: 'Case: green. Makera C2.',
        copies: [
          copy('spindle', 'worn', { kind: 'machine', machineId: 'm-1' }),
          copy('boxed', 'used', { kind: 'box' }),
        ],
      }),
    );
    expect(result.changed).toBe(true);
    expect(result.item.copies[0]).toEqual(
      copy('spindle', 'worn', { kind: 'machine', machineId: 'm-1' }),
    );
    expect(result.item.copies[1]).toMatchObject({
      id: 'boxed',
      condition: 'used',
      whereabouts: { kind: 'box', case: { colour: 'green', label: null } },
    });
    // The third physical copy is created; the machine copy held its slot without taking a case.
    expect(result.item.copies[2]).toMatchObject({
      condition: null,
      whereabouts: { kind: 'box', case: { colour: 'green', label: null } },
    });
  });

  it('follows a multi-colour note only when it says how many of each', () => {
    const exact = migrateCaseNote(
      item({
        id: 'kz-chamfer-90',
        quantity: 4,
        notes:
          'Case: yellow + orange. Makera C1-BIT-CHAMFER-90. Two physical variants under one code (#381): ' +
          '2× yellow with collar, ≈40 mm overall; 2× orange, ≈51 mm overall (ruler photo, ±2 mm).',
      }),
    );
    expect(exact.changed).toBe(true);
    expect(
      exact.item.copies.map((c) =>
        c.whereabouts.kind === 'box' ? c.whereabouts.case?.colour : null,
      ),
    ).toEqual(['yellow', 'yellow', 'orange', 'orange']);

    const vagueInput = item({ quantity: 2, notes: 'Case: yellow + orange. Makera X.' });
    const vague = migrateCaseNote(vagueInput);
    expect(vague.changed).toBe(false);
    expect(vague.item).toBe(vagueInput);
    expect(vague.reason).toContain('do not say how many');
  });

  it('is idempotent and never overwrites a case somebody already stated', () => {
    const first = migrateCaseNote(item({ quantity: 2, notes: 'Case: yellow. Makera X.' }));
    const second = migrateCaseNote(first.item);
    expect(second.changed).toBe(false);
    expect(second.item.copies).toEqual(first.item.copies);

    const stated = migrateCaseNote(
      item({
        quantity: 1,
        notes: 'Case: yellow. Makera X.',
        copies: [copy('a', 'new', { kind: 'box', case: { colour: 'blue', label: 'blue lid' } })],
      }),
    );
    expect(stated.changed).toBe(false);
    expect(stated.item.copies[0]!.whereabouts).toMatchObject({
      kind: 'box',
      case: { colour: 'blue' },
    });
  });

  it('leaves an item with no case note exactly as it was', () => {
    const before = item({ quantity: 1, notes: 'In service: Z1. Makera X.' });
    const result = migrateCaseNote(before);
    expect(result).toEqual({ item: before, changed: false, reason: null });
  });
});
