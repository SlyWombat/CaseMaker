// Facing's own cutter (#432 slice 2): the default rule, and the refusals it makes.
//
// Pure — the tool list and the catalogue are handed in exactly as the worker receives them, so
// every case is a function of two plain arrays.

import { describe, it, expect } from 'vitest';
import { chooseFacingTool } from '@/engine/cnc/engrave/facingTool';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';

function entry(key: string, tool: Tool): ToolLibraryEntry {
  return { key, tool, provenance: 'spec' };
}

const FLAT_1 = entry('flat-1.0', flatEndMill(1, { number: 1, name: '1 mm flat (assumed)' }));
const FLAT_3 = entry('user:wide', flatEndMill(3.175, { number: 2, name: '3.175 mm flat' }));
const METAL = entry('flat-3.175x12-metal', flatEndMill(3.175, { number: 1, id: '112111313812', name: '3.175*12mm Flat End(Metal)' }));
const BALL = entry('user:ball', flatEndMill(2, { name: '2 mm ball', shape: 'ball' }));
const THREAD = entry('user:thread', flatEndMill(4, { name: '4 mm thread mill', shape: 'thread' }));
const VBIT = entry('user:v', flatEndMill(3.175, { name: 'V-bit', shape: 'engraving', typeText: 'V-Bit', halfAngle: 30 }));

const row = (cutterId: string, material: string): FeedCatalogueRow => ({
  cutterId,
  material,
  rpm: 12000,
  feed: 500,
  plungeFeed: 200,
  stepDown: 0.4,
});

describe('#432 chooseFacingTool — the default rule', () => {
  it('picks the largest flat end mill, and only a flat one', () => {
    const pick = chooseFacingTool([FLAT_1, BALL, VBIT, FLAT_3], [], 'softwood');
    expect(pick.entry?.key).toBe('user:wide');
    // A ball nose and a V-bit are not flat bottoms; they never win whatever their size.
    expect(chooseFacingTool([FLAT_1, BALL, VBIT], [], 'softwood').entry?.key).toBe('flat-1.0');
  });

  it('breaks an equal-diameter tie on the key, so the same shop picks the same cutter twice', () => {
    const twin = entry('user:ztwin', flatEndMill(3.175, { name: '3.175 mm flat (twin)' }));
    expect(chooseFacingTool([FLAT_3, twin], [], 'softwood').entry?.key).toBe('user:wide');
    expect(chooseFacingTool([twin, FLAT_3], [], 'softwood').entry?.key).toBe('user:wide');
  });

  it('never defaults to the metal line on a non-metal blank, and does on metal', () => {
    expect(chooseFacingTool([METAL, FLAT_1], [], 'softwood').entry?.key).toBe('flat-1.0');
    expect(chooseFacingTool([METAL, FLAT_1], [], 'aluminium-6061').entry?.key).toBe('flat-3.175x12-metal');
  });

  it('refuses when only metal-line flats exist, naming the line', () => {
    const pick = chooseFacingTool([METAL], [], 'softwood');
    expect(pick.entry).toBeNull();
    expect(pick.reason).toMatch(/for Metal/);
  });

  it('refuses an empty list, and a list with no flat at all', () => {
    expect(chooseFacingTool([], [], 'softwood').reason).toMatch(/no flat end mill/);
    expect(chooseFacingTool([BALL, VBIT], [], 'softwood').reason).toMatch(/no flat end mill/);
  });

  it('a catalogue that says nothing does not veto', () => {
    expect(chooseFacingTool([FLAT_1, FLAT_3], [], 'softwood').entry?.key).toBe('user:wide');
  });

  it('drops a cutter the catalogue lists for other materials, and says so in the vendor’s words', () => {
    const wide = { ...FLAT_3, tool: { ...FLAT_3.tool, id: 'CUT-WIDE' } };
    const rows = [row('CUT-WIDE', '6061 Aluminum')];
    // Listed only for aluminium: excluded from a plastic blank, so the smaller flat wins.
    expect(chooseFacingTool([FLAT_1, wide], rows, 'softwood').entry?.key).toBe('flat-1.0');
    // Every flat excluded: the refusal quotes the catalogue's own sentence.
    const pick = chooseFacingTool([wide], rows, 'softwood');
    expect(pick.entry).toBeNull();
    expect(pick.reason).toMatch(/catalogue recommends/);
    expect(pick.reason).toMatch(/6061 Aluminum/);
    // The same cutter is the pick on the material the catalogue lists it for.
    expect(chooseFacingTool([FLAT_1, wide], rows, 'aluminium-6061').entry?.key).toBe('user:wide');
  });
});

describe('#432 chooseFacingTool — an explicit pick', () => {
  it('is honoured even when the catalogue does not recommend it for the material', () => {
    const wide = { ...FLAT_3, tool: { ...FLAT_3.tool, id: 'CUT-WIDE' } };
    const rows = [row('CUT-WIDE', '6061 Aluminum')];
    expect(chooseFacingTool([FLAT_1, wide], rows, 'softwood', 'user:wide').entry?.key).toBe('user:wide');
  });

  it('still has to be a flat end mill, and has to exist', () => {
    expect(chooseFacingTool([THREAD, FLAT_1], [], 'softwood', 'user:thread').reason).toMatch(/not a flat end mill/);
    expect(chooseFacingTool([FLAT_1], [], 'softwood', 'user:missing').reason).toMatch(/not in the tool list/);
  });
});
