// #715 (BM-2 of #707) — the bed mounts as the Holding step writes them: the tape's strips, the
// bracket's clamps and their places, the default mount (§3.2), the board under (§3.5), and the
// picture arithmetic the drags are made of. Design: `docs/design/bed-mounts-flow.md` §3.2–3.6.
//
// The pure half of the step, so the numbers and the geometry are pinned without a browser.

import { describe, expect, it } from 'vitest';

import {
  armsAboveStock,
  bedAnchor,
  bedBracketHold,
  bedTapeHold,
  centredStockRect,
  clampLabelFor,
  clampPlacementAtPointer,
  clampRectFor,
  defaultBedBoardMm,
  defaultBedMount,
  jobHasThroughCut,
  preferredBedMount,
  stockPointFromPicture,
  stockRectFor,
  tapeStripRects,
  tapeStrips,
  tapeStripsLine,
  tapeWhereAtPointer,
  tapeWhereWords,
  underWords,
} from '@/components/welcome/holdingMounts';
import { bracketSettings } from '@/engine/cnc/mounts/bracket';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { BedProfile } from '@/platform/locationClient';

/** The house's bed: a sized wasteboard, the vise on the pins, 20 mm tape and four 2 mm boards. */
const WASTEBOARD: BedProfile = {
  id: 'bp-1',
  name: 'Vise on the pins · wasteboard under',
  createdAt: '2026-10-27T09:00:00Z',
  basedOn: null,
  surface: {
    kind: 'wasteboard',
    material: 'MDF',
    length: 300,
    width: 200,
    thickness: 18,
    position: { frontLeft: [20, 30], frame: 'machine' },
    provenance: {},
    scars: [],
    lastResurfacedAt: null,
  },
  datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null },
  placements: [
    { id: 'pl-vise', fixture: 'fx-vise', where: { kind: 'pins', pins: 'vise', anchor: null }, count: null, frame: null, provenance: {} },
  ],
  preferredMounting: [],
  consumables: {
    tape: { widthMm: 20, thicknessMm: 0.1, provenance: 'typed' },
    boards: [{ material: 'MDF', size: [100, 100, 2], count: 4 }],
  },
  history: [],
};

const BARE: BedProfile = {
  ...WASTEBOARD,
  id: 'bp-bare',
  surface: {
    kind: 'bare-bed',
    material: null,
    length: null,
    width: null,
    thickness: null,
    position: null,
    provenance: {},
    scars: [],
    lastResurfacedAt: null,
  },
  placements: [],
};

/** The same bed with the thin bracket fitted at anchor 1. */
const BRACKETED: BedProfile = {
  ...WASTEBOARD,
  id: 'bp-bracket',
  placements: [
    ...WASTEBOARD.placements,
    { id: 'pl-bracket', fixture: 'fx-bracket-thin', where: { kind: 'anchor', anchor: 1, pins: null }, count: null, frame: null, provenance: {} },
  ],
};

const SETTINGS = bracketSettings(null).settings;

describe('#715 the tape’s lines (§3.4)', () => {
  it('the strips are ceil((width − 2 × inset) / tape width): two for the badge', () => {
    const tape = { width: 20, inset: 2 };
    expect(tapeStrips(tape, { width: 38.1 })).toBe(2);
    expect(tapeStrips(tape, { width: 80 })).toBe(4);
    expect(tapeStrips(tape, { width: 20 })).toBe(1);
    expect(tapeStripsLine(bedTapeHold(WASTEBOARD, null), { width: 38.1 })).toBe(
      'two strips of the 20 mm tape, 2 mm in from every edge',
    );
    expect(tapeStripsLine(bedTapeHold(WASTEBOARD, null), { width: 80 })).toBe(
      'four strips of the 20 mm tape, 2 mm in from every edge',
    );
  });

  it('the tape starts from the house roll, and a taped job keeps its own hold', () => {
    expect(bedTapeHold(WASTEBOARD, null)).toEqual({
      width: 20,
      thickness: 0.1,
      inset: 2,
      where: null,
      squareTo: 'front',
      source: 'default',
    });
    const own = { ...bedTapeHold(WASTEBOARD, null), where: { x: 40, y: 30 }, source: 'saved' as const };
    expect(bedTapeHold(WASTEBOARD, own)).toEqual(own);
    // A copy, not the same object: a write through one can never mutate the job's.
    expect(bedTapeHold(WASTEBOARD, own)).not.toBe(own);
    // No record at all: Makera's roll and the typed thickness.
    expect(bedTapeHold(null, null).width).toBe(20);
  });

  it('the position reads the middle of the bed, or the corner it was dragged to', () => {
    expect(tapeWhereWords(bedTapeHold(WASTEBOARD, null))).toBe('the middle of the bed');
    expect(tapeWhereWords({ ...bedTapeHold(WASTEBOARD, null), where: { x: 40, y: 30.5 } })).toBe(
      'X 40 · Y 30.5 mm on the bed',
    );
  });

  it('what is under the part is the record’s, in the record’s words', () => {
    expect(underWords(WASTEBOARD)).toBe('wasteboard under');
    expect(underWords(BARE)).toBe('bare bed');
    expect(underWords(null)).toBeNull();
  });
});

describe('#715 the bracket’s lines (§3.6)', () => {
  it('a new bracket job starts on the Makera kit’s thin bracket at anchor 1 with two clamps', () => {
    const hold = bedBracketHold({ length: 100, width: 60, thickness: 6 }, null, null);
    expect(hold.anchor).toBe(1);
    expect(hold.variant).toBe('thin');
    expect(hold.clamps).toEqual([
      { edge: 'back', at: 22.5 },
      { edge: 'back', at: 77.5 },
    ]);
    expect(hold.source).toBe('default');
  });

  it('the clamp’s landmark sentence is the obstacle label’s, one owner', () => {
    expect(clampLabelFor({ length: 100, width: 60, thickness: 6 }, { edge: 'back', at: 22.5 }, SETTINGS)).toBe(
      'the clamp on the back edge, 15 mm in from the left-hand corner',
    );
    expect(clampLabelFor({ length: 100, width: 60, thickness: 6 }, { edge: 'right', at: 30 }, SETTINGS)).toBe(
      'the clamp on the right edge, 22.5 mm in from the front corner',
    );
  });

  it('the arms above the stock are the bracket’s height less the plate and the board under it', () => {
    expect(armsAboveStock({ thickness: 6 }, 0, SETTINGS)).toBe(4);
    expect(armsAboveStock({ thickness: 6 }, 2, SETTINGS)).toBe(2);
    expect(armsAboveStock({ thickness: 12 }, 0, SETTINGS)).toBeLessThanOrEqual(0);
  });
});

describe('#715 the default mount (§3.2) and the board under (§3.5)', () => {
  it('the bed’s anchor, when it carries the bracket', () => {
    expect(bedAnchor(WASTEBOARD)).toBeNull();
    expect(bedAnchor(BRACKETED)).toBe(1);
  });

  it('sheet ≤ 3 mm on tape; a plate on the bracket only when the bed carries one; else tape', () => {
    expect(defaultBedMount(WASTEBOARD, { thickness: 3.81 }, 'plate')).toBe('bed-tape');
    expect(defaultBedMount(BRACKETED, { thickness: 6 }, 'plate')).toBe('bed-bracket');
    expect(defaultBedMount(BRACKETED, { thickness: 2 }, 'sheet')).toBe('bed-tape');
  });

  it('a preferred mounting naming this stock wins, among those the bed carries', () => {
    const prefers = (stock: string, manner: 'tape' | 'corner+clamps'): BedProfile => ({
      ...BRACKETED,
      preferredMounting: [{ stock, mount: { placement: manner === 'tape' ? null : 'pl-bracket', manner } }],
    });
    // A 6 mm plate the profile prefers on tape: tape, though the thickness alone would bracket it.
    expect(preferredBedMount(prefers('plate|block', 'tape'), { thickness: 6 }, 'plate')).toBe('bed-tape');
    expect(defaultBedMount(prefers('plate|block', 'tape'), { thickness: 6 }, 'plate')).toBe('bed-tape');
    // A 2 mm sheet the profile prefers in the bracket: the bracket.
    expect(defaultBedMount(prefers('sheet<=3mm', 'corner+clamps'), { thickness: 2 }, 'sheet')).toBe('bed-bracket');
    // A class this build cannot read matches nothing, and the fallback decides.
    expect(preferredBedMount(prefers('blank<opening&taller-than-ledge', 'corner+clamps'), { thickness: 6 }, 'plate')).toBeNull();
    // A preferred bracket on a bed that carries none is not offered.
    expect(preferredBedMount({ ...WASTEBOARD, preferredMounting: [{ stock: 'plate', mount: { placement: 'pl-bracket', manner: 'corner+clamps' } }] }, { thickness: 6 }, 'plate')).toBeNull();
  });

  it('the board under is the thinnest house board thick enough for the breakthrough', () => {
    expect(defaultBedBoardMm(WASTEBOARD, 1.3)).toBe(2);
    expect(defaultBedBoardMm(WASTEBOARD, 2.5)).toBeNull();
    expect(defaultBedBoardMm(null, 1.3)).toBeNull();
  });

  it('through work is a through shape, a cut-out, or a through drill — enabled only', () => {
    const job = defaultEngraveJob();
    expect(jobHasThroughCut(job)).toBe(false);
    const through = {
      kind: 'rect' as const,
      id: 'sh-tag',
      name: 'Tag',
      width: 40,
      height: 30,
      cornerRadius: 3,
      position: { x: 40, y: 30 },
      rotation: 0,
      depth: 2,
      through: true,
      enabled: true,
    };
    expect(jobHasThroughCut({ ...job, shapes: [through] })).toBe(true);
    expect(jobHasThroughCut({ ...job, shapes: [{ ...through, enabled: false }] })).toBe(false);
    expect(
      jobHasThroughCut({
        ...job,
        shapes: [],
        cutouts: [{ kind: 'cutout', id: 'c1', name: 'Tag', enabled: true, of: through.id, side: 'outside', inset: 0, tabs: { count: 2, width: 4, height: 1 } }],
      }),
    ).toBe(true);
    const drill = { kind: 'drill' as const, id: 'd1', position: { x: 10, y: 10 }, rotation: 0, depth: 2, enabled: true, through: true };
    expect(jobHasThroughCut({ ...job, shapes: [], drills: [drill] })).toBe(true);
    expect(jobHasThroughCut({ ...job, shapes: [], drills: [{ ...drill, enabled: false }] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// The picture's arithmetic — the same mapping the drawing uses.

const RECT = { x: 50, y: 60, w: 240, h: 144 }; // the Tray's 100 × 60 stock at 2.4 px/mm, the mockup's

describe('#715 a point on the picture is a place in the work frame', () => {
  it('maps from the front-left corner, X right and Y back', () => {
    expect(stockPointFromPicture({ x: 0, y: 0, w: 200, h: 100 }, { length: 100, width: 50 }, 50, 50)).toEqual({ x: 25, y: 25 });
    // The front edge is the bottom of the picture: py at its bottom is Y 0.
    expect(stockPointFromPicture(RECT, { length: 100, width: 60 }, 50, 204)).toEqual({ x: 0, y: 0 });
  });

  it('a clamp dragged near the back edge stays on it; near the right edge it crosses over', () => {
    expect(clampPlacementAtPointer(RECT, { length: 100, width: 60 }, 170, 70)).toEqual({ edge: 'back', at: 50 });
    expect(clampPlacementAtPointer(RECT, { length: 100, width: 60 }, 282, 120)).toEqual({ edge: 'right', at: 35 });
    // Beyond the stock's back-left corner the centre stops at the edge's start, which still
    // leaves half the clamp hanging past the end — the mount check that refuses it.
    expect(clampPlacementAtPointer(RECT, { length: 100, width: 60 }, 30, 50)).toEqual({ edge: 'back', at: 0 });
  });

  it('the tape’s stock follows the pointer and stays on the surface', () => {
    const surface = { length: 300, width: 200, frontLeft: [20, 30] as [number, number] };
    const frame = { x: 30, y: 24, w: 240, h: 160 };
    expect(tapeWhereAtPointer(frame, { length: 76.2, width: 38.1 }, surface, 150, 104)).toEqual({ x: 131.9, y: 110.95 });
    // Dragged past the front-left corner: the stock stops at the surface's own corner.
    expect(tapeWhereAtPointer(frame, { length: 76.2, width: 38.1 }, surface, 30, 184)).toEqual({ x: 20, y: 30 });
  });

  it('the stock’s rect is centred by default and at its place when dragged', () => {
    const surface = { length: 300, width: 200, frontLeft: [20, 30] as [number, number] };
    const frame = { x: 30, y: 24, w: 300, h: 200 };
    const centred = stockRectFor(frame, { length: 76.2, width: 38.1 }, surface, null);
    expect(centred.w).toBeCloseTo(76.2, 6);
    expect(centred.x + centred.w / 2).toBeCloseTo(frame.x + frame.w / 2, 6);
    const moved = stockRectFor(frame, { length: 76.2, width: 38.1 }, surface, { x: 40, y: 30 });
    expect(moved.x).toBeCloseTo(30 + 20, 6);
    expect(moved.y).toBeCloseTo(24 + 200 - 38.1, 6);
  });

  it('the strips lie along the length, inside the stock, the last trimmed', () => {
    const stockRect = { x: 0, y: 0, w: 200, h: 100 };
    const strips = tapeStripRects(stockRect, { length: 100, width: 50 }, { width: 20, inset: 2 });
    expect(strips).toHaveLength(3);
    for (const s of strips) {
      expect(s.x).toBeCloseTo(4, 6);
      expect(s.w).toBeCloseTo(192, 6);
    }
    // Y runs back from the front (the bottom of the picture): the first strip is nearest it.
    expect(strips[0]!.y + strips[0]!.h).toBeCloseTo(100 - 4, 6);
    // The last strip is trimmed to stop 2 mm short of the back edge.
    expect(strips[2]!.y).toBeCloseTo(4, 6);
  });

  it('a clamp’s rect reaches its reach onto the stock', () => {
    const stockRect = { x: 100, y: 100, w: 200, h: 120 }; // 100 × 60 stock at 2 px/mm
    const back = clampRectFor(stockRect, { length: 100, width: 60 }, { width: 15, length: 30, reach: 8 }, { edge: 'back', at: 20 });
    expect(back.x).toBeCloseTo(100 + (20 - 7.5) * 2, 6);
    expect(back.y + back.h).toBeCloseTo(100 + 120 - (60 - 8) * 2, 6);
    const right = clampRectFor(stockRect, { length: 100, width: 60 }, { width: 15, length: 30, reach: 8 }, { edge: 'right', at: 20 });
    expect(right.x).toBeCloseTo(100 + (100 - 8) * 2, 6);
    // The clamp is centred on `at`: its near side (toward the front) is at − 7.5 mm.
    expect(right.y + right.h).toBeCloseTo(100 + 120 - (20 - 7.5) * 2, 6);
  });

  it('the centred rect keeps the stock’s aspect inside its frame', () => {
    const rect = centredStockRect({ x: 0, y: 0, w: 100, h: 100 }, { length: 76.2, width: 38.1 }, 0.6);
    expect(rect.w / rect.h).toBeCloseTo(2, 6);
    expect(rect.w).toBeLessThanOrEqual(60);
  });
});
