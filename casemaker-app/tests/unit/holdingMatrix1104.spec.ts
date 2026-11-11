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
import { MachineRecordSchema, type BedProfile, type FixtureRecord, type MachineRecord } from '@/platform/locationClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  machines: unknown[];
  accessories: FixtureRecord[];
};
const ROTARY = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'box' },
  history: [],
} as unknown as FixtureRecord;

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

// ── The stated matrix (analyst's item 9): machine state × ownership × stock form × build ─────────
type PinsState = 'no record' | 'nothing on the pins' | 'vise on the pins' | 'rotary on the pins' | 'bracket on the pins';

function machineIn(state: PinsState): MachineRecord | null {
  if (state === 'no record') return null;
  const m = machineWith(BOARDS_AND_TAPE);
  const profile = m.bedProfiles![0]!;
  if (state === 'vise on the pins') return m;
  const base = profile.placements[0]!;
  if (state === 'rotary on the pins') {
    profile.placements = [{ ...base, id: 'pl-rotary', where: { kind: 'pins', pins: 'rotary', anchor: null } }];
  } else if (state === 'nothing on the pins') {
    profile.placements = [];
  } else {
    // The bracket sits at anchor 1 on an otherwise bare bed.
    profile.placements = [{ ...base, id: 'pl-bracket', where: { kind: 'anchor', pins: null, anchor: 1 } } as never];
  }
  return m;
}

const FORMS: Array<{ name: string; form: Cell['form']; stock: Cell['stock'] }> = [
  ...CELLS.map((c) => ({ name: c.name, form: c.form, stock: c.stock })),
  { name: 'sheet 1.5 mm', form: 'sheet', stock: { length: 80, width: 60, thickness: 1.5 } },
  { name: 'printed blank 4 mm', form: 'printed-blank', stock: { length: 80, width: 50, thickness: 4 } },
];

describe('#1104 item 9 — the stated matrix: every cell has an enabled row, a disabled row with an action, or the guard', () => {
  const STATES: PinsState[] = ['no record', 'nothing on the pins', 'vise on the pins', 'rotary on the pins', 'bracket on the pins'];
  for (const state of STATES) {
    for (const owned of [true, false]) {
      for (const drive of [true, false]) {
        for (const f of FORMS) {
          it(`${f.name} · ${state} · ${owned ? 'accessories owned' : 'accessories not owned'} · ${drive ? 'desktop' : 'web'}`, () => {
            const rows = mountOptions({
              machine: machineIn(state),
              accessories: owned ? [...DOC.accessories, ROTARY] : [],
              stock: f.stock,
              round: isRoundStock(f.form),
              disc: f.form === 'disc',
              tape: null,
              canReachMachine: drive,
            });
            // An impossible seat is never a row.
            for (const r of rows) {
              if (r.mount === 'block') expect(f.stock.thickness).toBeGreaterThanOrEqual(LEDGE_STEP);
              if (r.mount === 'bed-tape') expect(isRoundStock(f.form)).toBe(false);
            }
            // The cell has a way forward: an enabled row, a disabled row with its action in place —
            // or NO row at all, which HoldingStep renders as the guard sentence and its two actions
            // (engrave-setup-no-hold; pinned in holdingStep.spec.tsx).
            if (rows.length > 0) {
              const forward = rows.some((r) => !r.disabled) || rows.some((r) => r.disabled && r.action != null);
              expect(forward, JSON.stringify(rows.map((r) => [r.mount, r.disabled, r.action?.kind ?? null]))).toBe(true);
            }
            // Every refusal is a capitalised sentence; the web build never offers the change wizard.
            for (const r of rows) {
              if (r.reason !== null) expect(r.reason.charAt(0), r.reason).toBe(r.reason.charAt(0).toUpperCase());
              if (!drive) expect(r.action?.kind, r.mount).not.toBe('change-machine');
            }
          });
        }
      }
    }
  }
});
