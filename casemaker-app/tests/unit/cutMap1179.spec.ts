// #1179 slice A step 3 — THE PER-PROGRAM CUT MAP, from the analyst's post (comment 6769901997 and
// its depth+flatness update): a 2 mm raster of the blank in the STOCK frame carrying, per cell,
// the deepest Z the program cut below the stock top (quantised to 0.05 mm, level 0 = uncut) and
// whether that deepest pass left a FLAT floor (a horizontal cut or a straight plunge; a ramp's
// exit is sloped and is never claimed flat). Both streams RLE as `count:value`, row-major, each
// capped at 4,096 chars — over the cap the whole map is null, never a silently partial grid.
// The record's map is CUMULATIVE after each program: the merge keeps the deepest cut, and a flat
// floor on a tie.
import { describe, expect, it } from 'vitest';

import {
  CUT_MAP_CELL_MM,
  CUT_MAP_MAX_STREAM,
  CUT_MAP_STEP_MM,
  buildProgramCutMap,
  cutMapFromGrid,
  decodeRuns,
  encodeRuns,
  mergeCutMaps,
} from '@/engine/cnc/engrave/cutMap';

// 20 × 10 mm → 10 × 5 cells; a cell's centre is (col + 0.5) × 2, (row + 0.5) × 2.
const STOCK = { x: 20, y: 10 };
const CELLS = 10 * 5;
const at = (cols: number, col: number, row: number): number => row * cols + col;

describe('#1179 step 3 — the RLE streams', () => {
  it('a zero still gets its run, and the text round-trips', () => {
    const values = [0, 0, 1, 1, 1, 0];
    const data = encodeRuns(values);
    expect(data).toBe('2:0,3:1,1:0');
    expect(decodeRuns(data, 6)).toEqual(values);
  });

  it('rejects malformed runs and counts that overrun the grid', () => {
    expect(decodeRuns('1:0,nope:1', 2)).toBeNull();
    expect(decodeRuns('2:0', 3)).toBeNull();
    expect(decodeRuns('1:-1', 1)).toBeNull();
    expect(decodeRuns('0:0', 1)).toBeNull();
  });
});

describe('#1179 step 3 — one program’s map', () => {
  it('encodes a horizontal cut at its own depth, flat', () => {
    // A plunge at (5,5) to −1, then a horizontal pass to (15,5): both leave a flat floor at −1.
    const nc = 'S12000\nM3\nG0 X5 Y5\nG1 Z-1 F100\nG1 X15 Y5 F300\nM5\n';
    const map = buildProgramCutMap({ nc, stock: STOCK });
    expect(map).not.toBeNull();
    expect(map!.cellMm).toBe(CUT_MAP_CELL_MM);
    expect(map!.stepMm).toBe(CUT_MAP_STEP_MM);
    expect(map!.cols).toBe(10);
    expect(map!.rows).toBe(5);
    expect(map!.x0Mm).toBe(0);
    expect(map!.y0Mm).toBe(0);
    const depth = decodeRuns(map!.depth.data, CELLS)!;
    const flat = decodeRuns(map!.flat.data, CELLS)!;
    // The cell the cut crosses (col 5, row 2 — centre (11,5)) is cut 1 mm deep and flat.
    expect(depth[at(10, 5, 2)]).toBe(20);
    expect(flat[at(10, 5, 2)]).toBe(1);
    // The stock's corner cell is untouched.
    expect(depth[at(10, 0, 0)]).toBe(0);
    expect(flat[at(10, 0, 0)]).toBe(0);
  });

  it('a ramp is not flat at its deepest cell', () => {
    // From (5,5,−1) down to (15,5,−2): the deepest end sets the cell's level, and a sloped exit
    // is never claimed flat.
    const nc = 'S12000\nM3\nG0 X5 Y5\nG1 Z-1 F100\nG1 X15 Y5 Z-2 F300\nM5\n';
    const map = buildProgramCutMap({ nc, stock: STOCK })!;
    const depth = decodeRuns(map.depth.data, CELLS)!;
    const flat = decodeRuns(map.flat.data, CELLS)!;
    expect(depth[at(10, 7, 2)]).toBe(40);
    expect(flat[at(10, 7, 2)]).toBe(0);
  });

  it('a straight plunge alone is a flat floor', () => {
    const nc = 'S12000\nM3\nG0 Z0\nG0 X10 Y5\nG1 Z-1.5 F100\nM5\n';
    const map = buildProgramCutMap({ nc, stock: STOCK })!;
    const depth = decodeRuns(map.depth.data, CELLS)!;
    const flat = decodeRuns(map.flat.data, CELLS)!;
    expect(depth[at(10, 4, 2)]).toBe(30);
    expect(flat[at(10, 4, 2)]).toBe(1);
  });

  it('the tool’s radius widens the cut', () => {
    const nc = 'S12000\nM3\nG0 Z0\nG0 X10 Y5\nG1 Z-1 F100\nM5\n';
    const narrow = buildProgramCutMap({ nc, stock: STOCK })!;
    const wide = buildProgramCutMap({ nc, stock: STOCK, toolRadius: 3 })!;
    const narrowFlat = decodeRuns(narrow.flat.data, CELLS)!;
    const wideFlat = decodeRuns(wide.flat.data, CELLS)!;
    const cutCells = (values: number[]): number => values.filter((v) => v !== 0).length;
    // Without a radius the reach is half a cell: the point (10,5) sits between two cell centres
    // (9,5) and (11,5), so both are marked; a 3 mm radius reaches cells on every side.
    expect(cutCells(narrowFlat)).toBe(2);
    expect(cutCells(wideFlat)).toBeGreaterThan(4);
  });

  it('a cut above the stock top, or with the spindle off, marks nothing', () => {
    const above = buildProgramCutMap({ nc: 'S12000\nM3\nG0 X10 Y5\nG1 X15 Y5 Z1 F100\nM5\n', stock: STOCK })!;
    const stopped = buildProgramCutMap({ nc: 'S12000\nM5\nG0 X10 Y5\nG1 Z-2 F100\n', stock: STOCK })!;
    for (const map of [above, stopped]) {
      expect(decodeRuns(map.depth.data, CELLS)!.every((v) => v === 0)).toBe(true);
      expect(decodeRuns(map.flat.data, CELLS)!.every((v) => v === 0)).toBe(true);
    }
  });

  it('the tray grid is 80 × 63 cells', () => {
    const map = buildProgramCutMap({ nc: 'S12000\nM3\nG0 Z0\nG0 X80 Y63\nG1 Z-1 F100\nM5\n', stock: { x: 160, y: 126 } })!;
    expect(map.cols).toBe(80);
    expect(map.rows).toBe(63);
    expect(decodeRuns(map.depth.data, 80 * 63)).not.toBeNull();
  });

  it('a program that turns the fourth axis states no map at all', () => {
    const nc = 'S12000\nM3\nG0 X10 Y5\nG1 Z-1 A90 F100\nM5\n';
    expect(buildProgramCutMap({ nc, stock: STOCK })).toBeNull();
  });

  it('a stock with no area states no map', () => {
    expect(buildProgramCutMap({ nc: 'M3\nG1 Z-1\n', stock: { x: 0, y: 10 } })).toBeNull();
    expect(buildProgramCutMap({ nc: 'M3\nG1 Z-1\n', stock: { x: 20, y: 0 } })).toBeNull();
  });
});

describe('#1179 step 3 — the cap and the cumulative merge', () => {
  /** A grid whose alternating stream is far over the cap (one run per cell). */
  function overCapMap(): ReturnType<typeof cutMapFromGrid> {
    const cols = 4_200;
    const levels = Array.from({ length: cols }, (_, i) => (i % 2 === 0 ? 0 : 1));
    return cutMapFromGrid({ cols, rows: 1, levels, flat: levels.map(() => 0) });
  }

  it('over the stream cap the whole map is null', () => {
    expect(CUT_MAP_MAX_STREAM).toBe(4096);
    expect(encodeRuns(Array.from({ length: 4_200 }, (_, i) => (i % 2 === 0 ? 0 : 1))).length).toBeGreaterThan(CUT_MAP_MAX_STREAM);
    expect(overCapMap()).toBeNull();
  });

  it('merges cumulatively: the deepest cut wins, and a tie keeps a flat floor', () => {
    const first = cutMapFromGrid({ cols: 2, rows: 1, levels: [20, 20], flat: [0, 1] })!;
    const next = cutMapFromGrid({ cols: 2, rows: 1, levels: [10, 20], flat: [1, 0] })!;
    const merged = mergeCutMaps(first, next)!;
    expect(decodeRuns(merged.depth.data, 2)).toEqual([20, 20]);
    // Cell 0: the first pass is deeper, so its non-flat floor stands. Cell 1: a tie — the flat
    // floor from the first pass is kept.
    expect(decodeRuns(merged.flat.data, 2)).toEqual([0, 1]);
  });

  it('a changed grid starts over, and a null layer is null', () => {
    const previous = cutMapFromGrid({ cols: 2, rows: 1, levels: [20, 0], flat: [0, 0] })!;
    const next = cutMapFromGrid({ cols: 3, rows: 1, levels: [0, 1, 0], flat: [0, 1, 0] })!;
    expect(mergeCutMaps(previous, next)).toBe(next);
    expect(mergeCutMaps(previous, null)).toBeNull();
  });
});
