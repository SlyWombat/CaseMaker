// #1104 — NO DEAD ENDS: every cell of (stock form × machine state) offers an enabled row or every
// disabled row carries one action in place; an impossible seat is HIDDEN, not shown; a rod and a
// tube read as the same round stock. The step's dead-end guard covers a cell with no row at all
// (e.g. a long rod on a machine record that cannot change), which is a sentence, not a silent gap.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isRoundStock } from '@/engine/cnc/stockStart';
import { LEDGE_STEP } from '@/engine/cnc/fixture';
import { mountOptions } from '@/components/welcome/holdingMounts';
import { MachineRecordSchema, type BedProfile, type MachineRecord } from '@/platform/locationClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { machines: unknown[] };

const BOARDS_AND_TAPE: NonNullable<BedProfile['consumables']> = {
  tape: { widthMm: 25, thicknessMm: 0.1, provenance: 'typed' },
  boards: [{ material: 'MDF', size: [300, 200, 2], count: 4 }],
};

function machineWith(consumables: NonNullable<BedProfile['consumables']> | null): MachineRecord {
  const parsed = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  parsed.bedProfiles![0]!.consumables = consumables;
  return parsed;
}

interface Cell {
  name: string;
  form: 'plate' | 'sheet' | 'block' | 'printed-blank' | 'disc' | 'rod' | 'tube';
  stock: { length: number; width: number; thickness: number };
}

const CELLS: Cell[] = [
  { name: 'plate 2 mm', form: 'plate', stock: { length: 80, width: 60, thickness: 2 } },
  { name: 'plate 20 mm', form: 'plate', stock: { length: 80, width: 60, thickness: 20 } },
  { name: 'block 30 mm', form: 'block', stock: { length: 30, width: 30, thickness: 30 } },
  { name: 'disc', form: 'disc', stock: { length: 50, width: 50, thickness: 5 } },
  { name: 'rod 100 mm', form: 'rod', stock: { length: 12, width: 12, thickness: 100 } },
  { name: 'rod 150 mm', form: 'rod', stock: { length: 12, width: 12, thickness: 150 } },
  { name: 'tube 150 mm', form: 'tube', stock: { length: 12, width: 12, thickness: 150 } },
];

function optionsFor(cell: Cell, machine: MachineRecord | null) {
  return mountOptions({
    machine,
    accessories: [],
    stock: cell.stock,
    round: isRoundStock(cell.form),
    disc: cell.form === 'disc',
    tape: null,
  });
}

describe('#1104 the holding matrix has no dead ends', () => {
  const machine = machineWith(BOARDS_AND_TAPE);
  for (const cell of CELLS) {
    for (const [state, record] of [
      ['a machine record', machine],
      ['no machine record', null],
    ] as const) {
      it(`${cell.name} on ${state}: an enabled row, or every disabled row with one action`, () => {
        const rows = optionsFor(cell, record);
        // No impossible seat is offered at all.
        for (const row of rows) {
          if (row.mount === 'block') expect(cell.stock.thickness).toBeGreaterThanOrEqual(LEDGE_STEP);
          if (row.mount === 'bed-tape') expect(isRoundStock(cell.form)).toBe(false);
        }
        // The no-dead-end invariant. A cell with no row at all is the step's guard sentence.
        if (rows.length > 0) {
          expect(rows.some((o) => !o.disabled) || rows.every((o) => o.action !== null)).toBe(true);
        }
      });
    }
  }

  it('a rod and a tube of the same numbers offer the same rows', () => {
    const rod = CELLS.find((c) => c.name === 'rod 150 mm')!;
    const tube = CELLS.find((c) => c.name === 'tube 150 mm')!;
    const shape = (rows: ReturnType<typeof optionsFor>) => rows.map((o) => `${o.mount}:${o.disabled}`);
    expect(shape(optionsFor(tube, machine))).toEqual(shape(optionsFor(rod, machine)));
  });

  it('a 2 mm sheet has no block row; a round stock has no tape row', () => {
    const sheet = CELLS[0]!;
    expect(optionsFor(sheet, machine).some((o) => o.mount === 'block')).toBe(false);
    const rod = CELLS.find((c) => c.name === 'rod 150 mm')!;
    expect(optionsFor(rod, machine).some((o) => o.mount === 'bed-tape')).toBe(false);
  });

  it('a rod past the vise grip has no vise row at all', () => {
    const rod = CELLS.find((c) => c.name === 'rod 150 mm')!;
    const rows = optionsFor(rod, machine);
    expect(rows.some((o) => o.mount === 'ledge' || o.mount === 'board' || o.mount === 'block')).toBe(false);
  });

  it('every refusal is a sentence (capitalised)', () => {
    for (const cell of CELLS) {
      for (const row of optionsFor(cell, machine)) {
        if (row.reason !== null) expect(row.reason.charAt(0)).toBe(row.reason.charAt(0).toUpperCase());
      }
    }
  });
});
