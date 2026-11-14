// #1259 step 2 — THE BLANK COMES FROM THE SHOP'S OWN STOCK.
//
// One rule: a recorded stock entry that holds the work is the blank (case 1); nothing recorded
// holds it, so the blank the work needs is recommended (case 2); no stock recorded at all reads as
// case 2 and says so (case 3). Every shelf in these tests is STATED here — the product holds no
// stick of its own.

import { describe, expect, it } from 'vitest';

import {
  proposeBlank,
  shelfItemFor,
  type ProposalContext,
  type WorkShape,
} from '@/engine/cnc/stockProposal';
import type { StockItem } from '@/platform/stockClient';

const item = (
  id: string,
  form: string,
  size: Record<string, number>,
  over: Partial<StockItem> = {},
): StockItem =>
  ({
    id,
    form,
    material: 'hardwood',
    size,
    layers: [],
    quantity: 1,
    reservations: [],
    finish: 'rough',
    notes: null,
    ...over,
  }) as unknown as StockItem;

/** Our stick, as a test shop states it: 36 × 100 × 36 hardwood, planed. */
const STICK = item('stick', 'block', { length: 36, width: 100, thickness: 36 }, { finish: 'finished' });
const TEXT: WorkShape = { kind: 'text', size: { length: 50, width: 10 }, depth: 2 };
const ctx = (shelf: StockItem[], extra: Partial<ProposalContext> = {}): ProposalContext => ({ shelf, ...extra });

describe('#1259 — proposeBlank', () => {
  it('1. a shelf with one hardwood stick holds a default-size line: case 1, that item, at its own size and finish', () => {
    const p = proposeBlank(TEXT, ctx([STICK]))!;
    expect(p.source).toEqual({ case: 'shelf', itemId: 'stick' });
    expect(p).toMatchObject({ form: 'block', material: 'hardwood', length: 36, width: 100, thickness: 36, finish: 'finished' });
    expect(p.sentence).toBe('From your shelf: hardwood block, 36 × 100 × 36 mm.');
  });

  it('2. a plate holds the line; a mesh too thin for it falls to case 2 with the shelf not empty', () => {
    const plate = item('plate', 'plate', { length: 200, width: 100, thickness: 6 });
    const p = proposeBlank(TEXT, ctx([plate]))!;
    expect(p.source).toEqual({ case: 'shelf', itemId: 'plate' });
    expect(p.sentence).toBe('From your shelf: hardwood plate, 200 × 100 × 6 mm.');
    const mesh: WorkShape = { kind: 'mesh', size: { x: 50, y: 50, z: 20 } };
    const q = proposeBlank(mesh, ctx([plate]))!;
    expect(q.source).toEqual({ case: 'recommended', shelfEmpty: false });
    expect(q.sentence).toBe(
      'Nothing on your shelf holds this. It needs a blank of at least 60 × 60 × 21 mm, hardwood. ' +
        'Sized from the mesh: 50 × 50 × 20 mm, plus 5 mm each side and 1 mm under it.',
    );
  });

  it('3. an empty shelf is case 2 with shelfEmpty, for text, a mesh, a cut-out and a rod', () => {
    const works: WorkShape[] = [
      TEXT,
      { kind: 'mesh', size: { x: 50, y: 50, z: 20 } },
      { kind: 'cutout', length: 60, width: 40 },
      { kind: 'rod', diameter: 20, length: 100 },
    ];
    for (const w of works) {
      const p = proposeBlank(w, ctx([]))!;
      expect(p.source).toEqual({ case: 'recommended', shelfEmpty: true });
      expect(p.sentence.startsWith('No stock is recorded for this shop yet. It needs ')).toBe(true);
    }
    expect(proposeBlank(TEXT, ctx([]))!.sentence).toBe(
      'No stock is recorded for this shop yet. It needs a blank of at least 60 × 20 × 3 mm, hardwood. ' +
        'Sized from the text: 50 × 10 mm, plus 5 mm each side.',
    );
  });

  it('4. two items hold it: less waste wins; equal waste keeps the shelf’s order; the job’s material beats less waste', () => {
    const big = item('big', 'plate', { length: 300, width: 200, thickness: 6 });
    const snug = item('snug', 'plate', { length: 80, width: 40, thickness: 6 });
    expect(proposeBlank(TEXT, ctx([big, snug]))!.source).toEqual({ case: 'shelf', itemId: 'snug' });
    const twinA = item('a', 'plate', { length: 80, width: 40, thickness: 6 });
    const twinB = item('b', 'plate', { length: 80, width: 40, thickness: 6 });
    expect(proposeBlank(TEXT, ctx([twinB, twinA]))!.source).toEqual({ case: 'shelf', itemId: 'b' });
    const ply = item('ply', 'plate', { length: 300, width: 200, thickness: 6 }, { material: 'plywood' as never });
    expect(proposeBlank(TEXT, ctx([snug, ply], { jobMaterial: 'plywood' as never }))!.source).toEqual({ case: 'shelf', itemId: 'ply' });
  });

  it('5. only the turned fit holds: case 1', () => {
    // The need is 60 × 20; a 25 × 70 plate holds it only turned.
    const turned = item('turned', 'plate', { length: 25, width: 70, thickness: 6 });
    expect(proposeBlank(TEXT, ctx([turned]))!.source).toEqual({ case: 'shelf', itemId: 'turned' });
    // …and it is proposed at the item's own length and width, unturned, as the outline rule always did.
    expect(proposeBlank(TEXT, ctx([turned]))).toMatchObject({ length: 25, width: 70 });
  });

  it('6. an item with every unit reserved is not proposed', () => {
    const held = item('held', 'plate', { length: 200, width: 100, thickness: 6 }, {
      reservations: [{ jobId: 'job-1', quantity: 1 }] as never,
    });
    const gone = item('gone', 'plate', { length: 200, width: 100, thickness: 6 }, { quantity: 0 });
    expect(proposeBlank(TEXT, ctx([held, gone]))!.source).toEqual({ case: 'recommended', shelfEmpty: false });
  });

  it('7. a rod need is never met by a plate, and a flat need never by a rod', () => {
    const plate = item('plate', 'plate', { length: 200, width: 100, thickness: 30 });
    const rod = item('rod', 'rod', { diameter: 25, length: 120 });
    const rodWork: WorkShape = { kind: 'rod', diameter: 20, length: 100 };
    expect(proposeBlank(rodWork, ctx([plate]))!.source).toEqual({ case: 'recommended', shelfEmpty: false });
    expect(proposeBlank(rodWork, ctx([plate, rod]))!.source).toEqual({ case: 'shelf', itemId: 'rod' });
    expect(proposeBlank(rodWork, ctx([plate, rod]))!.sentence).toBe('From your shelf: hardwood rod, ⌀25 × 120 mm.');
    expect(proposeBlank(TEXT, ctx([rod]))!.source).toEqual({ case: 'recommended', shelfEmpty: false });
  });

  it('8. a drawing’s old answers hold through the general function', () => {
    const outline: WorkShape = { kind: 'outline', length: 60, width: 60, through: true };
    const p = proposeBlank(outline, ctx([item('fit', 'plate', { length: 72, width: 70, thickness: 9 })]))!;
    expect(p).toMatchObject({ form: 'plate', length: 72, width: 70, thickness: 9 });
    expect(p.sentence).toBe('From your shelf: hardwood plate, 72 × 70 × 9 mm.');
  });

  it('the stop rule: on our location’s own shelf, a default-size line is held by the stick, not by the sheet or the other blocks', () => {
    // Our location's recorded stock as read from its house (2026-11-13): a 1.5 mm plastic sheet that
    // is thin enough to "hold" a shallow line, two other blocks, and the stick.
    const shelf = [
      item('sheet', 'sheet', { length: 25.35, width: 76, thickness: 1.5 }, { material: 'plastic' as never, finish: 'finished' }),
      item('soft', 'block', { length: 100, width: 100, thickness: 100 }, { material: 'softwood' as never }),
      item('plate', 'plate', { length: 120, width: 75, thickness: 50 }),
      STICK,
    ];
    const shallow: WorkShape = { kind: 'text', size: { length: 46.58, width: 10.11 }, depth: 0.5 };
    const p = proposeBlank(shallow, ctx(shelf))!;
    expect(p.source).toEqual({ case: 'shelf', itemId: 'stick' });
    expect(p).toMatchObject({ form: 'block', material: 'hardwood', length: 36, width: 100, thickness: 36, finish: 'finished' });
  });

  it('work that sizes no blank proposes none, and circuit-board stock is only for board work', () => {
    expect(proposeBlank({ kind: 'none' }, ctx([STICK]))).toBeNull();
    const board = item('fr4', 'plate', { length: 200, width: 100, thickness: 1.6 }, { material: 'pcb' as never });
    expect(proposeBlank(TEXT, ctx([board]))!.source).toEqual({ case: 'recommended', shelfEmpty: false });
    const need = {
      form: 'plate' as const, material: 'pcb' as const, length: 70, width: 50, thickness: 1.6, finish: 'rough' as const, sentence: '',
    };
    expect(shelfItemFor(need, null, [STICK, board])?.id).toBe('fr4');
  });
});
