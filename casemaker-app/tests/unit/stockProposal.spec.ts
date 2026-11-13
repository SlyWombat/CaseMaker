// Issue #897 — the stock the work asks for.
//
// The wizard asks what is being cut before it asks for a blank, so the work SIZES the blank: a
// mesh's box, a board's outline, a line's measured extent, each plus its stated margin. The
// operator can change every number; the sentence says where the starting numbers came from. These
// are the engine's rules, without a screen.

import { describe, it, expect } from 'vitest';

import {
  HOUSE_PLATE_THICKNESS_MM,
  WORK_STOCK_SKIN_MM,
  proposeStock,
  proposedThickness,
  shelfPlateFor,
  type WorkShape,
} from '@/engine/cnc/stockProposal';
import { KNOWN_DEFAULTS } from '@/platform/defaultsClient';
import { PCB_BLANK_MARGIN_MM, PCB_STANDARD_THICKNESS_MM } from '@/engine/cnc/stockStart';
import { PROPOSED_TEXT_SIZE_MM, workShapeFor } from '@/components/welcome/workShape';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import type { OperationChoice } from '@/components/welcome/OperationStep';
import type { EngraveJob } from '@/types/engraveJob';
import type { StockItem } from '@/platform/stockClient';

// #1207 — the proposal margin is a shop key now; the tests run at the recommendation.
const WORK_STOCK_MARGIN_MM = KNOWN_DEFAULTS['stock.workMarginMm']!.fallback;

const MESH: WorkShape = { kind: 'mesh', size: { x: 40, y: 30, z: 12 } };
const TEXT: WorkShape = { kind: 'text', size: { length: 50, width: 10 }, depth: 2 };
const BOARD: WorkShape = { kind: 'pcb', outline: { length: 60, width: 40 } };
// #1098 — a drawing (SVG/DXF) read on the question step.
const OUTLINE: WorkShape = { kind: 'outline', length: 60, width: 60, through: true };

describe('#897 — the thickness rule, in one place', () => {
  it('a mesh leaves the stated skin under its box', () => {
    expect(proposedThickness(MESH)).toBe(12 + WORK_STOCK_SKIN_MM);
  });

  it('a line of text leaves the skin under its depth — the cut does not go through the blank', () => {
    expect(proposedThickness(TEXT)).toBe(2 + WORK_STOCK_SKIN_MM);
  });

  it('a board is the standard board thickness', () => {
    expect(proposedThickness(BOARD)).toBe(PCB_STANDARD_THICKNESS_MM);
  });

  it('work that sizes no blank has no thickness', () => {
    expect(proposedThickness({ kind: 'none' })).toBeNull();
  });

  it('#1098 — an outline is worked on the house plate, through cut or not', () => {
    expect(proposedThickness(OUTLINE)).toBe(HOUSE_PLATE_THICKNESS_MM);
    expect(proposedThickness({ ...OUTLINE, through: false })).toBe(HOUSE_PLATE_THICKNESS_MM);
  });
});

describe('#897 — the proposed blank', () => {
  it('a mesh gets its box plus the margin each side, on the house material', () => {
    const p = proposeStock(MESH)!;
    expect(p).toMatchObject({
      form: 'plate',
      material: 'hardwood',
      length: 40 + 2 * WORK_STOCK_MARGIN_MM,
      width: 30 + 2 * WORK_STOCK_MARGIN_MM,
      thickness: 12 + WORK_STOCK_SKIN_MM,
      finish: 'rough',
    });
    expect(p.sentence).toBe(
      `Sized from the mesh: 40 × 30 × 12 mm, plus ${WORK_STOCK_MARGIN_MM} mm each side and ${WORK_STOCK_SKIN_MM} mm under it.`,
    );
  });

  it('a board gets its outline plus the import’s own scrap, at 1.6 mm, in copper-clad', () => {
    const p = proposeStock(BOARD)!;
    expect(p).toMatchObject({
      material: 'pcb',
      length: 60 + 2 * PCB_BLANK_MARGIN_MM,
      width: 40 + 2 * PCB_BLANK_MARGIN_MM,
      thickness: PCB_STANDARD_THICKNESS_MM,
    });
    expect(p.sentence).toContain('Sized from the board');
    expect(p.sentence).toContain(`${PCB_BLANK_MARGIN_MM} mm each side`);
  });

  it('a board already laid on a blank keeps that blank — its items are placed on it', () => {
    const p = proposeStock({ ...BOARD, laidOn: { length: 100, width: 60 } })!;
    expect(p).toMatchObject({ material: 'pcb', length: 100, width: 60, thickness: PCB_STANDARD_THICKNESS_MM });
    expect(p.sentence).toContain('laid on the 100 × 60 mm blank');
  });

  it('a line of text gets its measured extent plus the margin each side', () => {
    const p = proposeStock(TEXT)!;
    expect(p).toMatchObject({
      length: 50 + 2 * WORK_STOCK_MARGIN_MM,
      width: 10 + 2 * WORK_STOCK_MARGIN_MM,
      thickness: 2 + WORK_STOCK_SKIN_MM,
    });
    expect(p.sentence).toContain('Sized from the text: 50 × 10 mm');
  });

  it('work that sizes no blank proposes nothing', () => {
    expect(proposeStock({ kind: 'none' })).toBeNull();
  });

  it('#1098 — an outline gets its extent plus the margin each side, on the house plate', () => {
    const p = proposeStock(OUTLINE)!;
    expect(p).toMatchObject({
      form: 'plate',
      material: 'hardwood',
      length: 60 + 2 * WORK_STOCK_MARGIN_MM,
      width: 60 + 2 * WORK_STOCK_MARGIN_MM,
      thickness: HOUSE_PLATE_THICKNESS_MM,
      finish: 'rough',
    });
    expect(p.sentence).toBe(`Sized from the outline: 60 × 60 mm, plus ${WORK_STOCK_MARGIN_MM} mm each side.`);
  });

  it('#1098 — a pocket outline proposes the same plate: the pocket bites into it', () => {
    expect(proposeStock({ ...OUTLINE, through: false })).toMatchObject({
      length: 70,
      width: 70,
      thickness: HOUSE_PLATE_THICKNESS_MM,
    });
  });
});

describe('#897 — the work, in the terms a blank is sized from', () => {
  const job = (): EngraveJob => defaultEngraveJob();

  it('a mesh target gives its own box', () => {
    const choice: OperationChoice = {
      type: 'surface',
      target: {
        id: 't1',
        name: 'part.stl',
        format: 'stl',
        sha256: 'a'.repeat(64),
        size: { x: 40, y: 30, z: 12 },
        position: { x: 0, y: 0, z: 0 },
        rotation: 0,
        role: 'goal',
        enabled: true,
      },
    };
    expect(workShapeFor(choice, job())).toEqual(MESH);
  });

  it('a board gives its outline and the blank it was laid on', () => {
    const base = job();
    const choice: OperationChoice = { type: 'pcb', imported: true, board: { length: 60, width: 40 } };
    expect(workShapeFor(choice, base)).toEqual({
      ...BOARD,
      laidOn: { length: base.stock.length, width: base.stock.width },
    });
  });

  it('a line of text is measured at the size the proposal starts from', () => {
    const shape = workShapeFor({ type: 'engrave', text: 'Hi', depth: 2, font: DEFAULT_FONT_ID }, job());
    expect(shape.kind).toBe('text');
    if (shape.kind === 'text') {
      expect(shape.depth).toBe(2);
      expect(shape.size.length).toBeGreaterThan(0);
      expect(shape.size.width).toBeGreaterThan(0);
      // The proposed size is the cap height the line is laid out for; the blank follows it.
      expect(PROPOSED_TEXT_SIZE_MM).toBeGreaterThan(0);
    }
  });

  it('#1098 — a drawing proposes its own extent; only Cut it out asks for a through blank', () => {
    const outline = {
      format: 'svg' as const,
      sourceName: 'coaster.svg',
      contours: [[[0, 0], [1, 0], [1, 1]]] as [number, number][][],
      fillRule: 'NonZero' as const,
      width: 60,
      height: 60,
      notes: [],
    };
    const cut = workShapeFor({ type: 'outline', outline, use: 'profile' }, job());
    expect(cut).toEqual({ kind: 'outline', length: 60, width: 60, through: true });
    const pocket = workShapeFor({ type: 'outline', outline, use: 'pocket', depth: 2 }, job());
    expect(pocket).toEqual({ kind: 'outline', length: 60, width: 60, through: false, depthMm: 2 });
  });

  it('an empty line, a missing file or no choice sizes nothing', () => {
    expect(workShapeFor(null, job())).toEqual({ kind: 'none' });
    expect(workShapeFor({ type: 'engrave', text: '   ', depth: 1, font: DEFAULT_FONT_ID }, job())).toEqual({
      kind: 'none',
    });
    expect(workShapeFor({ type: 'surface', target: null }, job())).toEqual({ kind: 'none' });
    expect(workShapeFor({ type: 'pcb', imported: false }, job())).toEqual({ kind: 'none' });
    expect(workShapeFor({ type: 'pocket' }, job())).toEqual({ kind: 'none' });
  });

  it('a rod in the chuck is sized by its own start, not by the goal’s box', () => {
    const rod = {
      ...job(),
      stock: { ...job().stock, shape: 'cylinder' as const, diameter: 20, length: 20, width: 20, thickness: 100 },
    };
    expect(workShapeFor({ type: 'pocket' }, rod)).toEqual({ kind: 'none' });
  });
});


// #1098 item 5 — an outline takes the smallest shelf plate that holds it.
const plate = (id: string, l: number, w: number, t: number, over: Partial<StockItem> = {}): StockItem =>
  ({
    id,
    material: 'hardwood',
    form: 'plate',
    size: { length: l, width: w, thickness: t },
    layers: [],
    quantity: 1,
    reservations: [],
    notes: null,
    ...over,
  }) as unknown as StockItem;

describe('#1098 — an outline takes the smallest shelf plate that holds it', () => {
  const extent = { length: 60, width: 60 };
  it('prefers the smallest area that holds extent + the margin each side, then the thinnest', () => {
    const shelf = [plate('big', 300, 200, 6), plate('fit', 72, 70, 9), plate('fit-thin', 72, 70, 6), plate('small', 60, 60, 12)];
    expect(shelfPlateFor(extent, 0, null, shelf)?.id).toBe('fit-thin');
  });

  it('holds the drawing turned either way', () => {
    expect(shelfPlateFor(extent, 0, null, [plate('turned', 80, 70, 12)])?.id).toBe('turned');
    expect(shelfPlateFor({ length: 100, width: 60 }, 0, null, [plate('turned', 72, 112, 12)])?.id).toBe('turned');
  });

  it('a pocket needs its depth plus the skin; a cut-out needs no thickness', () => {
    const shelf = [plate('thin', 80, 80, 3), plate('thick', 80, 80, 12)];
    expect(shelfPlateFor(extent, 0, null, shelf)?.id).toBe('thin');
    expect(shelfPlateFor(extent, 4 + WORK_STOCK_SKIN_MM, null, shelf)?.id).toBe('thick');
  });

  it('the job’s material is preferred when one is set; used-up and held plates are skipped', () => {
    const shelf = [plate('ply', 72, 72, 6, { material: 'plywood' as never }), plate('hard', 90, 90, 6)];
    expect(shelfPlateFor(extent, 0, 'hardwood' as never, shelf)?.id).toBe('hard');
    expect(shelfPlateFor(extent, 0, null, [plate('gone', 72, 72, 6, { quantity: 0 })])).toBeNull();
    expect(
      shelfPlateFor(extent, 0, null, [plate('held', 72, 72, 6, { reservations: [{ jobId: 'job-1', quantity: 1 }] as never })]),
    ).toBeNull();
  });

  it('the proposal is that blank, in its real size, with the shelf sentence', () => {
    const p = proposeStock(OUTLINE, { shelf: [plate('fit', 72, 70, 9)] })!;
    expect(p).toMatchObject({ form: 'plate', length: 72, width: 70, thickness: 9 });
    expect(p.sentence).toBe('From your shelf: hardwood plate, 72 × 70 × 9 mm.');
  });

  it('no shelf plate fits: the default thickness, which is a shop setting', () => {
    const p = proposeStock(OUTLINE, { shelf: [plate('tiny', 20, 20, 9)], plateThicknessMm: 15 })!;
    expect(p).toMatchObject({ length: 70, width: 70, thickness: 15 });
    expect(p.sentence).toBe(`Sized from the outline: 60 × 60 mm, plus ${WORK_STOCK_MARGIN_MM} mm each side.`);
    expect(proposeStock(OUTLINE)!.thickness).toBe(HOUSE_PLATE_THICKNESS_MM);
  });
});
