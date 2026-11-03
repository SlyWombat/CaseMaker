// #M1R §3.4 — THE HOUSE STOCK IS THE SHELF'S. `proposedStockFor` reads the location's shelf for the
// house's planed hardwood stick and names the entry; the hard-coded 36 × 100 × 36 is the fallback
// only when the shelf has no such entry, and the fallback sentence says so (the "location.json, never
// a constant" rule).

import { describe, expect, it } from 'vitest';
import { StockItemSchema, type StockItem } from '@/platform/stockClient';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { houseStockProposal, proposedStockFor, shelfHouseStockProposal } from '@/components/welcome/workShape';
import type { StockProposal } from '@/engine/cnc/stockProposal';

/** The k3 shelf's M1 stick, as E's entry states it (36 × 100 × 36, hardwood, planed). */
const STICK: StockItem = StockItemSchema.parse({
  id: 'stock-m1-hardwood-stick',
  material: 'hardwood',
  form: 'block',
  size: { length: 36, width: 100, thickness: 36 },
  finish: 'finished',
  flatness: 'flat',
  conductive: false,
  quantity: 4,
  source: 'purchased',
  addedAt: '2026-11-01T00:00:00.000Z',
});

const PLA: StockItem = StockItemSchema.parse({
  ...STICK,
  id: 'stock-pla-sheet',
  material: 'pla',
  form: 'sheet',
  finish: 'printed',
});

const proposal = (p: StockProposal | null): StockProposal => {
  if (p === null) throw new Error('expected a proposal');
  return p;
};

describe('the house stock comes from the shelf (#M1R §3.4)', () => {
  it('reads the shelf’s planed hardwood block and names the entry', () => {
    const p = proposal(shelfHouseStockProposal([PLA, STICK]));
    expect(p).toMatchObject({ form: 'block', material: 'hardwood', length: 36, width: 100, thickness: 36, finish: 'finished' });
    expect(p.sentence).toContain('stock-m1-hardwood-stick');
    expect(p.sentence).toContain('36 × 36 × 100 mm hardwood block');
  });

  it('falls back to the constant — stated — only when the shelf has no such entry', () => {
    expect(shelfHouseStockProposal([PLA])).toBeNull();
    expect(shelfHouseStockProposal([])).toBeNull();
    const fallback = proposal(proposedStockFor({ kind: 'none' }, defaultEngraveJob(), null, []));
    expect(fallback).toEqual(houseStockProposal());
    expect(fallback.sentence).toContain('The house’s stock');
  });

  it('proposes the shelf entry for a job that does not size its own blank, and leaves the work’s own alone', () => {
    const fromShelf = proposal(proposedStockFor({ kind: 'none' }, defaultEngraveJob(), null, [STICK]));
    expect(fromShelf.sentence).toContain('stock-m1-hardwood-stick');
    // The work's own blank (a mesh's box) is not overruled by the house's stick.
    const mesh = proposal(
      proposedStockFor({ kind: 'mesh', size: { x: 20, y: 30, z: 5 } }, defaultEngraveJob(), {
        form: 'block',
        material: 'pla',
        length: 20,
        width: 30,
        thickness: 5,
        finish: 'printed',
        sentence: 'the mesh’s box',
      }, [STICK]),
    );
    expect(mesh.sentence).toBe('the mesh’s box');
  });
});
