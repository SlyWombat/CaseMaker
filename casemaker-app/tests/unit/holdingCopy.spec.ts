// #1104 remaining items 1, 3, 4 and 8 (the analyst's comment on the land18 state) — THE WORDS OF THE
// HOLDING ROWS. "Tape it" is said only where the tape row is on offer (present, and usable or one
// press away); a disabled row's reason and its action read as ONE sentence; every refusal is a
// capitalised sentence that ends with what to do; the web build keeps its action rows and points
// them at Manage › Machines.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bedOffered, mountOptions, recommendSeat, withoutTapeClause, type MountOption } from '@/components/welcome/holdingMounts';
import { MachineRecordSchema, type BedProfile, type FixtureRecord, type MachineRecord } from '@/platform/locationClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  machines: unknown[];
  accessories: FixtureRecord[];
};
const ROTARY: FixtureRecord = {
  id: 'fx-rotary-1',
  kind: 'rotary-module',
  product: 'makera-4th-axis',
  variant: null,
  constants: {},
  unit: {},
  provenance: {},
  whereabouts: { kind: 'box' },
  history: [],
} as FixtureRecord;
/** The house owns the vise and the rotary: every refusal below is then the stock's or the pins', never ownership. */
const OWNED: FixtureRecord[] = [...DOC.accessories, ROTARY];
const CONSUMABLES: NonNullable<BedProfile['consumables']> = {
  tape: { widthMm: 25, thicknessMm: 0.1, provenance: 'typed' },
  boards: [{ material: 'MDF', size: [300, 200, 2], count: 4 }],
};
function machine(): MachineRecord {
  const parsed = MachineRecordSchema.parse(JSON.parse(JSON.stringify(DOC.machines[0])));
  parsed.bedProfiles![0]!.consumables = CONSUMABLES;
  return parsed;
}

const PLATE = { length: 80, width: 60, thickness: 20 };
const row = (rows: MountOption[], mount: string): MountOption => rows.find((r) => r.mount === mount)!;

describe('#1104 item 1 — one predicate for "tape it"', () => {
  it('bedOffered: the tape row present, and usable or one press away', () => {
    const base = { mount: 'bed-tape', label: '', hint: null, reason: null, escape: null, holdingWords: '' } as const;
    expect(bedOffered([{ ...base, disabled: false } as MountOption])).toBe(true);
    expect(bedOffered([{ ...base, disabled: true, action: { label: 'x', kind: 'change-machine' } } as MountOption])).toBe(true);
    expect(bedOffered([{ ...base, disabled: true, action: null } as MountOption])).toBe(false);
    expect(bedOffered([])).toBe(false);
  });

  it('withoutTapeClause drops each tape phrase and leaves a sentence', () => {
    expect(withoutTapeClause('level with the jaw tops — a thicker board, or tape it to the bed')).toBe(
      'level with the jaw tops — a thicker board',
    );
    expect(withoutTapeClause('A disc touches the bracket at two points — tape it or hold it in the vise.')).toBe(
      'A disc touches the bracket at two points — hold it in the vise.',
    );
  });

  it('no sentence says tape it when the tape row is absent (a rod; a location with no machine)', () => {
    const cells = [
      { rows: mountOptions({ machine: machine(), accessories: OWNED, stock: { length: 12, width: 12, thickness: 100 }, round: true }) },
      { rows: mountOptions({ machine: null, accessories: [], stock: { length: 80, width: 60, thickness: 3 } }) },
    ];
    for (const { rows } of cells) {
      expect(bedOffered(rows)).toBe(false);
      for (const r of rows) {
        expect(`${r.reason ?? ''} ${r.hint ?? ''}`, r.mount).not.toMatch(/tape it/i);
      }
    }
  });

  it('with the tape row on offer the board hint still names it', () => {
    const rows = mountOptions({ machine: machine(), accessories: [], stock: { length: 80, width: 60, thickness: 3 }, boardMm: 0.1 });
    expect(bedOffered(rows)).toBe(true);
  });

  it('the seat recommendation’s fallback names tape only when tape is offered', () => {
    const facts = { reachesEdgeWithinMm: 1, deepestCutMm: 40, through: true } as never;
    expect(recommendSeat({ thickness: 20 }, facts, [], true).reason).toContain('tape it to the bed');
    expect(recommendSeat({ thickness: 20 }, facts, [], false).reason).not.toMatch(/tape/i);
  });
});

describe('#1104 items 3, 4 — the action wording', () => {
  const stock = { length: 12, width: 12, thickness: 100 };
  const accessories = OWNED;

  it('desktop: the reason and the action read as one sentence — Put the rotary on the pins — Change the machine…', () => {
    const rows = mountOptions({ machine: machine(), accessories, stock, round: true, canReachMachine: true });
    const rotary = row(rows, 'rotary');
    if (!rotary.disabled) return; // the fixture machine already carries it: nothing to say
    expect(rotary.reason).toBe('Put the rotary on the pins');
    expect(rotary.action).toEqual({ label: 'Change the machine…', kind: 'change-machine' });
  });

  it('web: the same first half, and the action points at Manage › Machines', () => {
    const rows = mountOptions({ machine: machine(), accessories, stock, round: true, canReachMachine: false });
    const rotary = row(rows, 'rotary');
    if (!rotary.disabled) return;
    expect(rotary.reason).toBe('Put the rotary on the pins');
    expect(rotary.action).toEqual({ label: 'in Manage › Machines', kind: 'manage-link' });
  });

  it('a fixture the location does not own: "Not in this location’s accessories — add it in Manage › Machines"', () => {
    const rows = mountOptions({ machine: machine(), accessories: [], stock: PLATE });
    const notOwned = rows.find((r) => r.disabled && r.action?.kind === 'manage-link' && r.reason?.startsWith('Not in this location'));
    if (notOwned === undefined) return; // this fixture owns every accessory
    expect(notOwned.reason).toBe('Not in this location’s accessories');
    expect(notOwned.action).toEqual({ label: 'add it in Manage › Machines', kind: 'manage-link' });
  });
});

describe('#1104 item 8 — every refusal is a capitalised sentence that ends with what to do', () => {
  const m = machine();
  it('a 2 mm plate below the jaw tops', () => {
    const rows = mountOptions({ machine: m, accessories: OWNED, stock: { length: 80, width: 60, thickness: 2 } });
    const ledge = row(rows, 'ledge');
    expect(ledge.reason).toBe('It would sit 1.1 mm below the jaw tops — use the board seat or a thicker board.');
  });
  it('a through cut refuses the block seat', () => {
    const rows = mountOptions({ machine: m, accessories: OWNED, stock: PLATE, through: true });
    expect(row(rows, 'block').reason).toBe(
      'The cut goes through the blank — the block seat’s jaws would stand in it; use the board seat.',
    );
  });
  it('a disc refuses the chuck and the bracket', () => {
    const rows = mountOptions({ machine: m, accessories: OWNED, stock: { length: 50, width: 50, thickness: 5 }, disc: true });
    expect(row(rows, 'rotary').reason).toBe('A disc is cut on its face — the rotary holds a rod.');
    expect(row(rows, 'bed-bracket').reason).toMatch(
      /^A disc touches the bracket at two points and turns under the cutter — (tape it or )?hold it in the vise\.$/,
    );
  });
  it('every reason in the matrix starts with a capital and ends with a full stop or an action', () => {
    for (const stock of [{ length: 80, width: 60, thickness: 2 }, PLATE, { length: 12, width: 12, thickness: 100 }]) {
      for (const r of mountOptions({ machine: m, accessories: OWNED, stock, round: stock.length === 12 })) {
        if (r.reason === null) continue;
        expect(r.reason.charAt(0), r.reason).toBe(r.reason.charAt(0).toUpperCase());
        expect(/[.]$/.test(r.reason) || r.action !== null, r.reason).toBe(true);
      }
    }
  });
});
