// #1179 slice A step 3 — THE CUT MAP: 2 mm stock-frame raster, depth quantised to 0.05 mm, flat
// floors marked, two RLE streams capped at 4,096 chars each (over the cap the whole map is null),
// and a cumulative merge that keeps the deepest cut per cell.
import { describe, expect, it } from 'vitest';

import {
  CUT_MAP_STEP_MM,
  buildProgramCutMap,
  cutMapFromGrid,
  decodeRuns,
  encodeRuns,
  mergeCutMaps,
  type CutMapGrid,
} from '@/engine/cnc/engrave/cutMap';

/** A program of `lines`, with the boilerplate every engrave program carries. */
function program(...lines: string[]): string {
  return ['G90 G21', 'T1 M6', 'M3', ...lines, 'G0 Z5', 'M5', 'M2'].join('\n');
}

const STOCK = { x: 20, y: 10 }; // 10 × 5 cells at 2 mm

function gridFrom(map: ReturnType<typeof buildProgramCutMap>): CutMapGrid {
  if (map === null) throw new Error('no map');
  const levels = decodeRuns(map.depth.data, map.cols * map.rows);
  const flat = decodeRuns(map.flat.data, map.cols * map.rows);
  if (levels === null || flat === null) throw new Error('bad streams');
  return { cols: map.cols, rows: map.rows, levels, flat };
}

describe('#1179 the cut map', () => {
  it('a horizontal cut marks its own row at the quantised depth, with a flat floor', () => {
    const map = buildProgramCutMap({
      nc: program('G0 X2 Y1', 'G0 Z1', 'G1 Z-1 F600', 'G1 X18 Y1 F600'),
      stock: STOCK,
    });
    expect(map).toMatchObject({ cellMm: 2, cols: 10, rows: 5, x0Mm: 0, y0Mm: 0, stepMm: CUT_MAP_STEP_MM });
    const grid = gridFrom(map);
    const row0 = grid.levels.slice(0, 10);
    expect(row0.every((level) => level === Math.round(1 / CUT_MAP_STEP_MM))).toBe(true);
    expect(grid.flat.slice(0, 10).every((flat) => flat === 1)).toBe(true);
    expect(grid.levels.slice(10).every((level) => level === 0)).toBe(true);
  });

  it('the tool radius widens the cells the pass reaches', () => {
    const nc = program('G0 X2 Y1', 'G0 Z1', 'G1 Z-1 F600', 'G1 X18 Y1 F600');
    const thin = gridFrom(buildProgramCutMap({ nc, stock: STOCK }));
    const wide = gridFrom(buildProgramCutMap({ nc, stock: STOCK, toolRadius: 2 }));
    // Row 1's centres are 2 mm off the line: unreached by a point tool, reached by a 2 mm radius.
    // (Column 4 is the first whose centre is directly beside the line, not past its end.)
    expect(thin.levels[10 + 4]).toBe(0);
    expect(wide.levels[10 + 4]).toBeGreaterThan(0);
  });

  it('a ramp is cut to its deepest end but is never a flat floor', () => {
    const map = buildProgramCutMap({
      nc: program('G0 X2 Y1', 'G0 Z1', 'G1 Z-1 F600', 'G1 X18 Y1 Z-2 F600'),
      stock: STOCK,
    });
    const grid = gridFrom(map);
    // The ramp's deepest cell is at the far end (level 40) and its floor is sloped.
    expect(grid.levels[9]).toBe(Math.round(2 / CUT_MAP_STEP_MM));
    expect(grid.flat[9]).toBe(0);
  });

  it('a program that turns the A axis has no flat map', () => {
    expect(
      buildProgramCutMap({
        nc: program('G0 X2 Y1', 'G0 Z1', 'G1 Z-1 F600', 'G1 X18 Y1 A90 F600'),
        stock: STOCK,
      }),
    ).toBeNull();
  });

  it('the two streams are RLE and round-trip', () => {
    expect(encodeRuns([0, 0, 0, 1, 1, 2])).toBe('3:0,2:1,1:2');
    expect(decodeRuns('3:0,2:1,1:2', 6)).toEqual([0, 0, 0, 1, 1, 2]);
    expect(decodeRuns('3:0,2:1', 6)).toBeNull();
    expect(decodeRuns('7:0', 6)).toBeNull();
    expect(decodeRuns('0:1,6:0', 6)).toBeNull();
    expect(decodeRuns('6:-1', 6)).toBeNull();
  });

  it('a tray-sized grid is 80 × 63, and a stream over the cap nulls the whole map', () => {
    const tray: CutMapGrid = {
      cols: 80,
      rows: 63,
      // Alternating depths: one run per cell — 5,040 runs, far over the 4,096-character cap.
      levels: Array.from({ length: 80 * 63 }, (_, i) => (i % 2 === 0 ? 1 : 2)),
      flat: new Array<number>(80 * 63).fill(1),
    };
    expect(cutMapFromGrid(tray)).toBeNull();
    expect(cutMapFromGrid({ ...tray, levels: new Array<number>(80 * 63).fill(0) })).toMatchObject({
      cols: 80,
      rows: 63,
    });
  });

  it('the merge keeps the deepest cut per cell and a flat floor on a tie', () => {
    const first = cutMapFromGrid(
      {
        cols: 3,
        rows: 1,
        levels: [10, 4, 2],
        flat: [1, 0, 1],
      },
    )!;
    const second = cutMapFromGrid(
      {
        cols: 3,
        rows: 1,
        levels: [10, 8, 1],
        flat: [0, 1, 0],
      },
    )!;
    const merged = gridFrom(mergeCutMaps(first, second));
    expect(merged.levels).toEqual([10, 8, 2]); // a tie, the new deeper cut, the old deeper cut
    expect(merged.flat).toEqual([1, 1, 1]); // tie keeps the flat floor; neither deeper cut is lowered
    // A different grid starts over rather than mixing frames.
    const other = cutMapFromGrid({ cols: 4, rows: 1, levels: [1, 1, 1, 1], flat: [0, 0, 0, 0] })!;
    expect(mergeCutMaps(first, other)).toBe(other);
    // A null new map is null: no partial grid.
    expect(mergeCutMaps(first, null)).toBeNull();
  });
});
