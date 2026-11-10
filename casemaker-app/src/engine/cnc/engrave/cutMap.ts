/**
 * #1179 slice A step 3 — THE PER-PROGRAM CUT MAP: what a program left of the blank, on a 2 mm
 * raster, as DEPTH + FLATNESS.
 *
 * The map is in the STOCK frame (`x0Mm`/`y0Mm` = the stock's min corner; work XY starts at the
 * stock corner, so both are 0) and carries, per cell:
 *
 *  - `depth`: the deepest Z the program cut in that cell, from the stock top (work Z0), quantised
 *    to `stepMm` (0.05 mm): `level = round(depth / 0.05)`, 0 = uncut. RLE `count:level` runs,
 *    row-major.
 *  - `flat`: whether that deepest pass left a FLAT floor — a horizontal cut or a straight plunge.
 *    A ramp's exit is sloped and is never claimed flat. RLE `count:0|1` runs.
 *
 * A cell is CUT when the cutter's swept area (the move's line, grown by the tool radius, and never
 * less than half a cell so a point-sized tool still marks its own cell) reaches the cell centre.
 * Both streams are capped at 4,096 characters; over the cap the whole map is null — never a
 * silently partial grid (the consumer then falls back to the current plan's own footprint).
 *
 * The record's map is CUMULATIVE after each program: the finish-write merges the new program's
 * layer with the newest record for the same job and package (`mergeCutMaps`) — the deepest cut
 * wins, and a flat floor is kept on a tie. That is what a restart needs: one map says everything
 * the blank has been through under this plan.
 */

import { parseGcode } from '@/engine/cnc/gcode';
import type { FinishedCutMap } from '@/platform/locationClient';

export const CUT_MAP_CELL_MM = 2;
export const CUT_MAP_STEP_MM = 0.05;
/** Each stream's own cap; over it the whole map is null. */
export const CUT_MAP_MAX_STREAM = 4096;

export interface CutMapStock {
  /** Stock length along work X, mm. */
  x: number;
  /** Stock width along work Y, mm. */
  y: number;
}

export interface CutMapGrid {
  cols: number;
  rows: number;
  /** Quantised depth level per cell, row-major. */
  levels: number[];
  /** 1 when the deepest pass over the cell left a flat floor. */
  flat: number[];
}

/** `count:value` runs over row-major values; a value of 0 still gets its run. */
export function encodeRuns(values: readonly number[]): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= values.length; i++) {
    if (i === values.length || values[i] !== values[start]) {
      parts.push(`${i - start}:${values[start] ?? 0}`);
      start = i;
    }
  }
  return parts.join(',');
}

/** The inverse of `encodeRuns`; null when the text is not exactly `expected` runs of values. */
export function decodeRuns(data: string, expected: number): number[] | null {
  const out: number[] = [];
  for (const part of data.split(',')) {
    const [countText, valueText] = part.split(':');
    const count = Number(countText);
    const value = Number(valueText);
    if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(value) || value < 0) return null;
    if (out.length + count > expected) return null;
    for (let i = 0; i < count; i++) out.push(value);
  }
  return out.length === expected ? out : null;
}

/** Distance from a point to a segment (mm). */
function pointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Mark every cell the swept line reaches with `level`, keeping the floor flag of the deepest pass. */
function markSegment(
  grid: CutMapGrid,
  from: { x: number; y: number },
  to: { x: number; y: number },
  level: number,
  flat: boolean,
  reach: number,
): void {
  const minX = Math.min(from.x, to.x) - reach;
  const maxX = Math.max(from.x, to.x) + reach;
  const minY = Math.min(from.y, to.y) - reach;
  const maxY = Math.max(from.y, to.y) + reach;
  const firstCol = Math.max(0, Math.floor(minX / CUT_MAP_CELL_MM));
  const lastCol = Math.min(grid.cols - 1, Math.floor(maxX / CUT_MAP_CELL_MM));
  const firstRow = Math.max(0, Math.floor(minY / CUT_MAP_CELL_MM));
  const lastRow = Math.min(grid.rows - 1, Math.floor(maxY / CUT_MAP_CELL_MM));
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = firstCol; col <= lastCol; col++) {
      const cx = (col + 0.5) * CUT_MAP_CELL_MM;
      const cy = (row + 0.5) * CUT_MAP_CELL_MM;
      if (pointToSegment(cx, cy, from.x, from.y, to.x, to.y) > reach) continue;
      const at = row * grid.cols + col;
      const best = grid.levels[at]!;
      if (level > best) {
        grid.levels[at] = level;
        grid.flat[at] = flat ? 1 : 0;
      } else if (level === best && flat) {
        grid.flat[at] = 1;
      }
    }
  }
}

function gridFor(stock: CutMapStock): CutMapGrid {
  const cols = Math.max(1, Math.ceil(stock.x / CUT_MAP_CELL_MM));
  const rows = Math.max(1, Math.ceil(stock.y / CUT_MAP_CELL_MM));
  return { cols, rows, levels: new Array<number>(cols * rows).fill(0), flat: new Array<number>(cols * rows).fill(0) };
}

/**
 * The map from a finished grid: encodes both streams and applies the cap — over it the whole map is
 * null. Exported so the layer builder and `mergeCutMaps` share one encoder, and so a test can hold a
 * grid the parser would take thousands of lines to make.
 */
export function cutMapFromGrid(grid: CutMapGrid): FinishedCutMap | null {
  const depth = encodeRuns(grid.levels);
  const flat = encodeRuns(grid.flat);
  if (depth.length > CUT_MAP_MAX_STREAM || flat.length > CUT_MAP_MAX_STREAM) return null;
  return {
    cellMm: CUT_MAP_CELL_MM,
    cols: grid.cols,
    rows: grid.rows,
    x0Mm: 0,
    y0Mm: 0,
    stepMm: CUT_MAP_STEP_MM,
    flat: { encoding: 'rle', data: flat },
    depth: { encoding: 'rle', data: depth },
  };
}

/**
 * One program's layer, as a finished cut map. The tool path is read with the shared interpreter:
 * cutting moves in the work frame below the stock top. A horizontal cut and a straight plunge leave
 * a flat floor; a ramp does not. `toolRadius` (from the run's context) widens the cut cells; without
 * it the tool is treated as no wider than a cell.
 */
export function buildProgramCutMap(input: {
  nc: string;
  stock: CutMapStock;
  toolRadius?: number;
}): FinishedCutMap | null {
  const stock = input.stock;
  if (!(stock.x > 0) || !(stock.y > 0)) return null;
  const reach = Math.max(input.toolRadius ?? 0, CUT_MAP_CELL_MM / 2);
  const grid = gridFor(stock);
  const { events } = parseGcode(input.nc);
  let spindle = false;
  let turned = false;
  for (const ev of events) {
    if (ev.kind === 'move' && ev.a !== null) {
      // A program that TURNS the fourth axis has no flat stock frame: a 2D map would be a false
      // claim about where the wood is. The record carries no map rather than a wrong one.
      turned = true;
      continue;
    }
    if (ev.kind === 'spindle') {
      spindle = ev.state !== 'off';
      continue;
    }
    if (ev.kind !== 'move' || ev.mode !== 'cut' || ev.frame !== 'work' || !spindle) continue;
    const [fx, fy, fz] = ev.from;
    const [tx, ty, tz] = ev.to;
    if (fx === null || fy === null || fz === null || tx === null || ty === null || tz === null) continue;
    const lowZ = Math.min(fz, tz);
    if (!(lowZ < 0)) continue;
    const level = Math.round(-lowZ / CUT_MAP_STEP_MM);
    if (level <= 0) continue;
    // A flat floor comes from a horizontal pass (both ends at the same Z) or a straight plunge.
    const horizontal = fz === tz;
    const plunge = fx === tx && fy === ty;
    markSegment(grid, { x: fx, y: fy }, { x: tx, y: ty }, level, horizontal || plunge, reach);
  }
  return turned ? null : cutMapFromGrid(grid);
}

function sameGrid(a: FinishedCutMap, b: FinishedCutMap): boolean {
  return (
    a.cellMm === b.cellMm &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.x0Mm === b.x0Mm &&
    a.y0Mm === b.y0Mm &&
    a.stepMm === b.stepMm
  );
}

/**
 * The cumulative map: `next`'s deepest cut over `previous`'s. A tie keeps a flat floor. A grid that
 * no longer matches (the stock changed) starts over from `next`; `next` null is null — the record
 * states no map rather than a partial one.
 */
export function mergeCutMaps(
  previous: FinishedCutMap | null | undefined,
  next: FinishedCutMap | null,
): FinishedCutMap | null {
  if (next === null) return null;
  if (previous === null || previous === undefined || !sameGrid(previous, next)) return next;
  const first = decodeRuns(previous.depth.data, previous.cols * previous.rows);
  const firstFlat = decodeRuns(previous.flat.data, previous.cols * previous.rows);
  const second = decodeRuns(next.depth.data, next.cols * next.rows);
  const secondFlat = decodeRuns(next.flat.data, next.cols * next.rows);
  if (first === null || firstFlat === null || second === null || secondFlat === null) return next;
  const levels: number[] = [];
  const flat: number[] = [];
  for (let i = 0; i < first.length; i++) {
    const a = first[i]!;
    const b = second[i]!;
    if (b > a) {
      levels.push(b);
      flat.push(secondFlat[i]!);
    } else if (b === a) {
      levels.push(a);
      flat.push(Math.max(firstFlat[i]!, secondFlat[i]!));
    } else {
      levels.push(a);
      flat.push(firstFlat[i]!);
    }
  }
  const depth = encodeRuns(levels);
  const flatText = encodeRuns(flat);
  if (depth.length > CUT_MAP_MAX_STREAM || flatText.length > CUT_MAP_MAX_STREAM) return null;
  return {
    ...next,
    flat: { encoding: 'rle', data: flatText },
    depth: { encoding: 'rle', data: depth },
  };
}
