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
import { proposedMaterialFor } from '@/components/welcome/workShape';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

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
      'Nothing on your shelf holds this. It needs a blank of at least 60 × 60 × 21 mm. ' +
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
      'No stock is recorded for this shop yet. It needs a blank of at least 60 × 20 × 3 mm. ' +
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

  it('#1263 — pieces of more than one material hold the work and the job states none: no proposal, the holding pieces least waste first', () => {
    // Our location's recorded stock as read from its house: a 1.5 mm plastic sheet that is thin
    // enough to "hold" a shallow line, two other blocks, and the stick.
    const shelf = [
      item('sheet', 'sheet', { length: 25.35, width: 76, thickness: 1.5 }, { material: 'plastic' as never, finish: 'finished' }),
      item('soft', 'block', { length: 100, width: 100, thickness: 100 }, { material: 'softwood' as never }),
      item('plate', 'plate', { length: 120, width: 75, thickness: 50 }),
      STICK,
    ];
    const shallow: WorkShape = { kind: 'text', size: { length: 46.58, width: 10.11 }, depth: 0.5 };
    const p = proposeBlank(shallow, ctx(shelf))!;
    expect(p.source).toEqual({ case: 'several', itemIds: ['sheet', 'stick', 'plate', 'soft'] });
    expect(p.material).toBeNull();
    expect(p.sentence).toBe(
      "Several pieces on your shelf hold this. Pick one, or choose the material and enter the piece's size.",
    );
    // The same shelf and a job that STATES hardwood: only hardwood pieces count; the stick has the least waste.
    const q = proposeBlank(shallow, ctx(shelf, { jobMaterial: 'hardwood' as never }))!;
    expect(q.source).toEqual({ case: 'shelf', itemId: 'stick' });
    expect(q).toMatchObject({ form: 'block', material: 'hardwood', length: 36, width: 100, thickness: 36, finish: 'finished' });
  });

  it('#1263 — a shelf of two hardwood pieces proposes the smaller; one piece is that piece; three softwood and one hardwood, none holding the work, asks for the size only', () => {
    const big = item('big', 'plate', { length: 300, width: 200, thickness: 20 });
    const small = item('small', 'plate', { length: 80, width: 40, thickness: 20 });
    expect(proposeBlank(TEXT, ctx([big, small]))!.source).toEqual({ case: 'shelf', itemId: 'small' });
    expect(proposeBlank(TEXT, ctx([STICK]))!.source).toEqual({ case: 'shelf', itemId: 'stick' });
    const tiny = (id: string, material: string) => item(id, 'plate', { length: 10, width: 10, thickness: 3 }, { material: material as never });
    const p = proposeBlank(TEXT, ctx([tiny('a', 'softwood'), tiny('b', 'softwood'), tiny('c', 'softwood'), tiny('d', 'hardwood')]))!;
    expect(p.source).toEqual({ case: 'recommended', shelfEmpty: false });
    expect(p.material).toBeNull(); // asked, not preselected: no counting of stock
  });

  it('9. a job that states a material is held only by stock of that material: brass on the hardwood stick is case 2', () => {
    const p = proposeBlank(TEXT, ctx([STICK], { jobMaterial: 'brass' as never }))!;
    expect(p.source).toEqual({ case: 'recommended', shelfEmpty: false });
    expect(p.material).toBe('brass');
    expect(p.sentence).toBe(
      'Nothing on your shelf holds this in brass. It needs a blank of at least 60 × 20 × 3 mm, brass. ' +
        'Sized from the text: 50 × 10 mm, plus 5 mm each side.',
    );
    // …and a brass item on the same shelf does hold it.
    const brass = item('brass', 'plate', { length: 80, width: 40, thickness: 6 }, { material: 'brass' as never });
    expect(proposeBlank(TEXT, ctx([STICK, brass], { jobMaterial: 'brass' as never }))!.source).toEqual({ case: 'shelf', itemId: 'brass' });
  });

  it('10. an untouched demo job on a shelf of one aluminium plate: case 1, and the job takes aluminium', () => {
    const plate = item('al', 'plate', { length: 200, width: 100, thickness: 6 }, { material: 'aluminium-6061' as never });
    const p = proposeBlank(TEXT, ctx([plate]))!;
    expect(p.source).toEqual({ case: 'shelf', itemId: 'al' });
    expect(proposedMaterialFor(p, defaultEngraveJob())).toBe('aluminium-6061');
    // With nothing on the shelf the default material stands.
    const q = proposeBlank(TEXT, ctx([]))!;
    expect(proposedMaterialFor(q, defaultEngraveJob())).toBeNull(); // no stock, no stated material: not chosen
  });

  it('11. the pocket floor’s body is a shop setting: at the recommendation nothing moves; at 10 mm the need and the shelf’s minimum both move by 4', () => {
    const pocket: WorkShape = { kind: 'pocket', length: 60, width: 40, depth: 10 };
    const thin = item('thin', 'plate', { length: 200, width: 100, thickness: 17 });
    const base = proposeBlank(pocket, ctx([]))!;
    expect(base.thickness).toBe(16); // 10 deep + the recommended 6 under the floor
    expect(proposeBlank(pocket, ctx([thin]))!.source).toEqual({ case: 'shelf', itemId: 'thin' });
    const ten = ctx([thin], { pocketFloorBodyMm: 10 });
    const moved = proposeBlank(pocket, { ...ten, shelf: [] })!;
    expect(moved.thickness).toBe(20); // 4 more
    // The shelf's own minimum moved by the same 4: a 17 mm plate no longer holds it.
    expect(proposeBlank(pocket, ten)!.source).toEqual({ case: 'recommended', shelfEmpty: false });
    expect(proposeBlank(pocket, ctx([item('ok', 'plate', { length: 200, width: 100, thickness: 20 })], { pocketFloorBodyMm: 10 }))!.source).toEqual({ case: 'shelf', itemId: 'ok' });
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
