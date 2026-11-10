// #1179 slice A step 3 — THE PER-SETUP CUT MAP, as the analyst's 2026-11-10 ruling (comment
// 6775024844) shaped it:
//
// 1. One map per setup/face — depths measured from that face's top, that setup's frame; side 1 and
//    side 2 never merge.
// 2. A map is never silently partial. Each setup's entry is `complete` or `unknown`; once `unknown`
//    it stays unknown for that setup until the blank is replaced (a later program must not restart
//    a fresh layer that then reads as the whole map).
// 3. No cap that drops the map: when a setup's map would exceed the record's budget it COARSENS
//    (2 → 4 → 8 mm; a cell keeps the deepest depth, and is flat only when its children agree);
//    only an 8 mm map that still does not fit makes the state `unknown`, with the reason stated.
// 4. Merging is within the same job, setup and placement only — a different package of the same
//    job on the same setup merges normally (same blank, same face).
//
// The real 19-program tray package's numbers drove these bounds: side 1's map is 96.5 % of the
// 4,096-character stream at program 10, and the cross-face merge was what overflowed. Here the
// package's shape is synthesised (the licensed NC is not a repo fixture); the real package is
// measured against this build and reported separately.
import { describe, expect, it } from 'vitest';

import {
  CUT_MAP_CELL_MM,
  CUT_MAP_MAX_STREAM,
  CUT_MAP_STEP_MM,
  buildProgramCutMap,
  coarsenGrid,
  decodeRuns,
  encodeRuns,
  fitCutMapGrid,
  mergeFaceCutMaps,
  mergeSetupCutMaps,
  type CutMapGrid,
  type CutMapFit,
} from '@/engine/cnc/engrave/cutMap';
import type { FinishedCutMap, FinishedSetupCutMap } from '@/platform/locationClient';

// 20 × 10 mm → 10 × 5 cells; a cell's centre is (col + 0.5) × 2, (row + 0.5) × 2.
const STOCK = { x: 20, y: 10 };
const CELLS = 10 * 5;
const at = (cols: number, col: number, row: number): number => row * cols + col;

/** The map of one NC program (fails loudly when the builder says unknown). */
function layerOf(nc: string, stock = STOCK): FinishedCutMap {
  const fit = buildProgramCutMap({ nc, stock });
  if (fit.kind !== 'map') throw new Error(`expected a map: ${fit.reason}`);
  return fit.map;
}

/** A grid from row-major arrays. */
function grid(cols: number, rows: number, levels: number[], flat?: number[]): CutMapGrid {
  return { cols, rows, levels, flat: flat ?? levels.map(() => 0) };
}

function mapOf(fit: CutMapFit): FinishedCutMap {
  if (fit.kind !== 'map') throw new Error(`expected a map: ${fit.reason}`);
  return fit.map;
}

const complete = (setupIndex: number, map: FinishedCutMap): FinishedSetupCutMap => ({
  setupIndex,
  state: 'complete',
  map,
});

describe('#1179 — the RLE streams', () => {
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

describe('#1179 — one program’s layer', () => {
  it('encodes a horizontal cut at its own depth, flat', () => {
    const nc = 'S12000\nM3\nG0 X5 Y5\nG1 Z-1 F100\nG1 X15 Y5 F300\nM5\n';
    const map = layerOf(nc);
    expect(map.cellMm).toBe(CUT_MAP_CELL_MM);
    expect(map.stepMm).toBe(CUT_MAP_STEP_MM);
    expect(map.cols).toBe(10);
    expect(map.rows).toBe(5);
    expect(map.x0Mm).toBe(0);
    expect(map.y0Mm).toBe(0);
    const depth = decodeRuns(map.depth.data, CELLS)!;
    const flat = decodeRuns(map.flat.data, CELLS)!;
    expect(depth[at(10, 5, 2)]).toBe(20);
    expect(flat[at(10, 5, 2)]).toBe(1);
    expect(depth[at(10, 0, 0)]).toBe(0);
    expect(flat[at(10, 0, 0)]).toBe(0);
  });

  it('a ramp is not flat at its deepest cell', () => {
    const nc = 'S12000\nM3\nG0 X5 Y5\nG1 Z-1 F100\nG1 X15 Y5 Z-2 F300\nM5\n';
    const map = layerOf(nc);
    const depth = decodeRuns(map.depth.data, CELLS)!;
    const flat = decodeRuns(map.flat.data, CELLS)!;
    expect(depth[at(10, 7, 2)]).toBe(40);
    expect(flat[at(10, 7, 2)]).toBe(0);
  });

  it('a straight plunge alone is a flat floor', () => {
    const map = layerOf('S12000\nM3\nG0 Z0\nG0 X10 Y5\nG1 Z-1.5 F100\nM5\n');
    const depth = decodeRuns(map.depth.data, CELLS)!;
    const flat = decodeRuns(map.flat.data, CELLS)!;
    expect(depth[at(10, 4, 2)]).toBe(30);
    expect(flat[at(10, 4, 2)]).toBe(1);
  });

  it('the tool’s radius widens the cut', () => {
    const nc = 'S12000\nM3\nG0 Z0\nG0 X10 Y5\nG1 Z-1 F100\nM5\n';
    const narrow = layerOf(nc);
    const wide = mapOf(buildProgramCutMap({ nc, stock: STOCK, toolRadius: 3 }));
    const cutCells = (map: FinishedCutMap): number => decodeRuns(map.flat.data, CELLS)!.filter((v) => v !== 0).length;
    expect(cutCells(narrow)).toBe(2);
    expect(cutCells(wide)).toBeGreaterThan(4);
  });

  it('a cut above the stock top, or with the spindle off, marks nothing', () => {
    for (const nc of ['S12000\nM3\nG0 X10 Y5\nG1 X15 Y5 Z1 F100\nM5\n', 'S12000\nM5\nG0 X10 Y5\nG1 Z-2 F100\n']) {
      const map = layerOf(nc);
      expect(decodeRuns(map.depth.data, CELLS)!.every((v) => v === 0)).toBe(true);
      expect(decodeRuns(map.flat.data, CELLS)!.every((v) => v === 0)).toBe(true);
    }
  });

  it('the tray grid is 80 × 63 cells', () => {
    const map = layerOf('S12000\nM3\nG0 Z0\nG0 X80 Y63\nG1 Z-1 F100\nM5\n', { x: 160, y: 126 });
    expect(map.cols).toBe(80);
    expect(map.rows).toBe(63);
    expect(decodeRuns(map.depth.data, 80 * 63)).not.toBeNull();
  });

  it('a program that turns the fourth axis states UNKNOWN, never no map', () => {
    const fit = buildProgramCutMap({ nc: 'S12000\nM3\nG0 X10 Y5\nG1 Z-1 A90 F100\nM5\n', stock: STOCK });
    expect(fit.kind).toBe('unknown');
    if (fit.kind === 'unknown') expect(fit.reason).toMatch(/fourth axis/);
  });

  it('a stock with no area states UNKNOWN, never no map', () => {
    for (const stock of [{ x: 0, y: 10 }, { x: 20, y: 0 }]) {
      const fit = buildProgramCutMap({ nc: 'M3\nG1 Z-1\n', stock });
      expect(fit.kind).toBe('unknown');
    }
  });
});

describe('#1179 — coarsening, never dropping the map', () => {
  it('halves the grid, keeps the deepest child, and is flat only when the children agree', () => {
    // Left pair agrees (both 3, flat); right pair disagrees (5 vs 1) and one is non-flat.
    const coarse = coarsenGrid(grid(4, 1, [3, 3, 5, 1], [1, 1, 1, 0]));
    expect(coarse.cols).toBe(2);
    expect(coarse.rows).toBe(1);
    expect(coarse.levels).toEqual([3, 5]);
    // The left pair is uniform and all flat; the right pair disagrees in depth AND flatness.
    expect(coarse.flat).toEqual([1, 0]);
  });

  it('a pair that agrees in depth but not in flatness is not flat', () => {
    const coarse = coarsenGrid(grid(2, 1, [4, 4], [1, 0]));
    expect(coarse.levels).toEqual([4]);
    expect(coarse.flat).toEqual([0]);
  });

  it('an over-budget map coarsens to 4 mm and keeps the deepest cell', () => {
    // 4,200 cells alternating 0/1 at 2 mm is over the budget; at 4 mm every cell takes the deeper
    // child (1) and the children disagree, so nothing is claimed flat.
    const cols = 4_200;
    const levels = Array.from({ length: cols }, (_, i) => i % 2);
    const fit = fitCutMapGrid(grid(cols, 1, levels));
    const map = mapOf(fit);
    expect(map.cellMm).toBe(4);
    expect(map.cols).toBe(2_100);
    expect(decodeRuns(map.depth.data, 2_100)!.every((v) => v === 1)).toBe(true);
    expect(decodeRuns(map.flat.data, 2_100)!.every((v) => v === 0)).toBe(true);
  });

  it('an 8 mm overflow goes UNKNOWN with the reason stated', () => {
    // A checkerboard at the 8 mm scale: it cannot compress at any pitch under the test's budget.
    const cols = 32;
    const rows = 8;
    const levels = Array.from({ length: cols * rows }, (_, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      return (Math.floor(col / 8) + Math.floor(row / 8)) % 2;
    });
    const fit = fitCutMapGrid(grid(cols, rows, levels), { budget: 12 });
    expect(fit.kind).toBe('unknown');
    if (fit.kind === 'unknown') expect(fit.reason).toMatch(/8 mm/);
  });

  it('the encoder still refuses a stream over the budget it was given', () => {
    // The record's own cap stays 4,096; the fit is only ever attempted against it.
    expect(CUT_MAP_MAX_STREAM).toBe(4096);
  });
});

describe('#1179 — merging, within one face only', () => {
  const shallow = mapOf(fitCutMapGrid(grid(2, 1, [10, 10], [0, 1])));
  const deep = mapOf(fitCutMapGrid(grid(2, 1, [20, 10], [0, 0])));
  const deeper = mapOf(fitCutMapGrid(grid(2, 1, [10, 20], [1, 0])));

  it('the deepest cut wins and a tie keeps a flat floor', () => {
    const merged = mapOf(mergeFaceCutMaps(shallow, deeper));
    expect(decodeRuns(merged.depth.data, 2)).toEqual([10, 20]);
    expect(decodeRuns(merged.flat.data, 2)).toEqual([1, 0]);
  });

  it('a finer layer merges into a coarser map without changing its pitch', () => {
    // Both cover 8 mm: the coarse map is 2 cells at 4 mm, the fine one 4 cells at 2 mm.
    const coarse = mapOf(fitCutMapGrid(grid(2, 1, [4, 8]), { cellMm: 4 }));
    const fine = mapOf(fitCutMapGrid(grid(4, 1, [10, 10, 10, 10])));
    const merged = mapOf(mergeFaceCutMaps(coarse, fine));
    expect(merged.cellMm).toBe(4);
    expect(decodeRuns(merged.depth.data, 2)).toEqual([10, 10]);
  });

  it('two setups never merge, and carrying side 2 leaves side 1 untouched', () => {
    const side1 = [complete(1, shallow)];
    const withSide2 = mergeSetupCutMaps(side1, [complete(2, deep)]);
    expect(withSide2.map((e) => e.setupIndex)).toEqual([1, 2]);
    expect(withSide2[0]).toEqual(side1[0]);
    // A later side-2 program merges into side 2 only.
    const again = mergeSetupCutMaps(withSide2, [complete(2, deeper)]);
    expect(again[0]).toBe(withSide2[0]);
    // Side 2's own cumulative: [20,10] over [10,20] keeps the deeper of each cell.
    expect(decodeRuns(again[1]!.map!.depth.data, 2)).toEqual([20, 20]);
  });

  it('UNKNOWN sticks: a later complete program does not clear it', () => {
    const unknown: FinishedSetupCutMap = { setupIndex: 1, state: 'unknown', unknownReason: 'a cut map could not be read' };
    const merged = mergeSetupCutMaps([unknown], [complete(1, shallow)]);
    expect(merged).toEqual([unknown]);
    // And a still-later program keeps it too.
    expect(mergeSetupCutMaps(merged, [complete(1, deep)])).toEqual([unknown]);
  });

  it('a merge failure goes UNKNOWN with its reason, and stays so', () => {
    const otherFrame: FinishedCutMap = { ...shallow, x0Mm: 5 };
    const failed = mergeSetupCutMaps([complete(1, shallow)], [complete(1, otherFrame)]);
    expect(failed[0]!.state).toBe('unknown');
    expect(failed[0]!.unknownReason).toMatch(/frame/);
    expect(mergeSetupCutMaps(failed, [complete(1, deep)])[0]!.state).toBe('unknown');
  });

  it('a program that merges normally from another package of the same job still merges', () => {
    // The package key is not part of the cut map's identity: same job + setup + blank.
    const merged = mergeSetupCutMaps([complete(1, shallow)], [complete(1, deep)]);
    expect(merged[0]!.state).toBe('complete');
    expect(decodeRuns(merged[0]!.map!.depth.data, 2)).toEqual([20, 10]);
  });
});

describe('#1179 — the package shape (two faces, both complete)', () => {
  it('side 1 and side 2 each keep their own complete map', () => {
    const cut = (xs: number[]): string =>
      `S12000\nM3\nG0 Z0\n${xs.map((x) => `G0 X${x} Y5\nG1 Z-1 F100`).join('\n')}\nM5\n`;
    const side1a = layerOf(cut([5, 9]));
    const side1b = layerOf(cut([13, 17]));
    const side2 = layerOf(cut([5, 17]));
    let entries = mergeSetupCutMaps([], [complete(1, side1a)]);
    entries = mergeSetupCutMaps(entries, [complete(1, side1b)]);
    const side1AfterOwn = entries[0]!.map!;
    entries = mergeSetupCutMaps(entries, [complete(2, side2)]);
    expect(entries.map((e) => [e.setupIndex, e.state])).toEqual([
      [1, 'complete'],
      [2, 'complete'],
    ]);
    // Side 2's programs never touch side 1's streams.
    expect(entries[0]!.map).toBe(side1AfterOwn);
    expect(entries[0]!.map!.depth.data).toBe(side1AfterOwn.depth.data);
    expect(entries[1]!.map!.depth.data).toBe(side2.depth.data);
  });
});
