/**
 * #1179 slice A step 3 — THE PER-SETUP CUT MAP: what the blank has been through, per FACE.
 *
 * The analyst's ruling (comment 6775024844, 2026-11-10) shaped this module:
 *
 * 1. ONE MAP PER SETUP/FACE. A face's depths are measured from that face's top and its XY is that
 *    setup's frame; side 1 and side 2 never merge.
 * 2. A MAP IS NEVER SILENTLY PARTIAL. Each setup's entry is `complete` (every finished program of
 *    that setup merged in) or `unknown` (something could not be merged); once `unknown` it stays
 *    unknown for that setup until the blank is replaced — a later program never restarts a fresh
 *    layer that then reads as the whole map.
 * 3. NO CAP THAT DROPS THE MAP. When a setup's map would exceed the record's budget it COARSENS —
 *    2 → 4 → 8 mm; a coarse cell keeps the deepest depth and is flat only when its children agree —
 *    and the stored pitch travels with the map. Only a map that still does not fit at 8 mm becomes
 *    `unknown`, and the record states why.
 * 4. Merging is within the same job, setup and placement only (the caller drops the previous list
 *    when the blank is not the same one); a different package of the same job on the same setup
 *    merges normally.
 *
 * Geometry, unchanged from the measured design: the map is in the STOCK frame (`x0Mm`/`y0Mm` = the
 * stock's min corner; work XY starts at the stock corner, so both are 0) and carries, per cell, the
 * deepest level the programs cut below the face top (quantised to `stepMm`, 0 = uncut) and whether
 * the deepest pass left a FLAT floor (a horizontal cut or a straight plunge; a ramp's exit is
 * sloped and is never claimed flat). Both streams are RLE `count:value`, row-major; the record's
 * per-stream budget is `CUT_MAP_MAX_STREAM`.
 *
 * The REAL 19-program tray package (`m1trayF-banded2`, 160 × 126) is what fixed the bounds: side
 * 1's map is 96.5 % of the budget by its tenth program, and it was the cross-face merge that
 * overflowed — the failure this per-face + coarsening shape exists to stop.
 */

import { parseGcode } from '@/engine/cnc/gcode';
import type { FinishedCutMap, FinishedSetupCutMap } from '@/platform/locationClient';

export const CUT_MAP_CELL_MM = 2;
/** The pitches a map may be STORED at, coarsest last (the ruling's 2 → 4 → 8 mm). */
export const CUT_MAP_PITCHES = [2, 4, 8] as const;
export const CUT_MAP_STEP_MM = 0.05;
/** The record's per-stream budget; over it the map coarsens, and at the last pitch goes unknown. */
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

/** A fitted map, or the stated reason a face cannot be mapped at all. */
export type CutMapFit = { kind: 'map'; map: FinishedCutMap } | { kind: 'unknown'; reason: string };

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

/**
 * Halve the grid: each coarse cell keeps the DEEPEST child's level, and is FLAT only when every
 * child agrees — the same level, and every one a flat floor. A coarse cell over a step or over a
 * sloped patch is therefore never claimed flat (a conservative floor for the consumer).
 */
export function coarsenGrid(grid: CutMapGrid): CutMapGrid {
  const cols = Math.ceil(grid.cols / 2);
  const rows = Math.ceil(grid.rows / 2);
  const levels = new Array<number>(cols * rows).fill(0);
  const flat = new Array<number>(cols * rows).fill(0);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      let deepest = 0;
      let uniform = true;
      let allFlat = true;
      let first: number | null = null;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const c = col * 2 + dx;
          const r = row * 2 + dy;
          if (c >= grid.cols || r >= grid.rows) continue;
          const at = r * grid.cols + c;
          const level = grid.levels[at]!;
          if (first === null) first = level;
          else if (level !== first) uniform = false;
          if (level > deepest) deepest = level;
          if (grid.flat[at] !== 1) allFlat = false;
        }
      }
      levels[row * cols + col] = deepest;
      flat[row * cols + col] = uniform && allFlat ? 1 : 0;
    }
  }
  return { cols, rows, levels, flat };
}

/** Encode a grid at `cellMm`; null when either stream is over the budget. */
function encodeGrid(grid: CutMapGrid, cellMm: number, budget: number): FinishedCutMap | null {
  const depth = encodeRuns(grid.levels);
  const flat = encodeRuns(grid.flat);
  if (depth.length > budget || flat.length > budget) return null;
  return {
    cellMm,
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
 * Fit a grid into the record's budget, coarsening 2 → 4 → 8 mm as needed. `cellMm` is the pitch the
 * grid is ALREADY at (a merged map starts from its stored pitch and never refines); `budget` exists
 * so a test can drive the loop with small numbers — production always uses the record's 4,096.
 */
export function fitCutMapGrid(
  grid: CutMapGrid,
  opts: { cellMm?: number; budget?: number } = {},
): CutMapFit {
  const budget = opts.budget ?? CUT_MAP_MAX_STREAM;
  let pitch = opts.cellMm ?? CUT_MAP_CELL_MM;
  let current = grid;
  for (;;) {
    const map = encodeGrid(current, pitch, budget);
    if (map !== null) return { kind: 'map', map };
    if (pitch >= CUT_MAP_PITCHES[CUT_MAP_PITCHES.length - 1]!) {
      return { kind: 'unknown', reason: 'the map does not fit the record even at 8 mm cells' };
    }
    pitch *= 2;
    current = coarsenGrid(current);
  }
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
 * One program's layer on its face. The tool path is read with the shared interpreter: cutting moves
 * in the work frame below the face top (work Z0). A horizontal cut and a straight plunge leave a
 * flat floor; a ramp does not. `toolRadius` (from the run's context) widens the cut cells; without
 * it the tool is treated as no wider than a cell.
 *
 * A program that TURNS the fourth axis, or a stock with no area, cannot be described by a face map:
 * the result is `unknown` with the reason — never a silent absence (the ruling's point 2).
 */
export function buildProgramCutMap(input: {
  nc: string;
  stock: CutMapStock;
  toolRadius?: number;
}): CutMapFit {
  const stock = input.stock;
  if (!(stock.x > 0) || !(stock.y > 0)) {
    return { kind: 'unknown', reason: 'the stock states no length or width, so there is no face to map' };
  }
  const reach = Math.max(input.toolRadius ?? 0, CUT_MAP_CELL_MM / 2);
  const grid = gridFor(stock);
  const { events } = parseGcode(input.nc);
  let spindle = false;
  let turned = false;
  for (const ev of events) {
    if (ev.kind === 'move' && ev.a !== null) {
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
  if (turned) {
    return { kind: 'unknown', reason: 'a program turns the fourth axis, so the face cannot be mapped' };
  }
  return fitCutMapGrid(grid);
}

/** A stored map as a grid at its own pitch, or at a coarser one (never finer). */
function gridAtPitch(map: FinishedCutMap, pitch: number): CutMapGrid | null {
  const cells = map.cols * map.rows;
  const levels = decodeRuns(map.depth.data, cells);
  const flat = decodeRuns(map.flat.data, cells);
  if (levels === null || flat === null) return null;
  let grid: CutMapGrid = { cols: map.cols, rows: map.rows, levels, flat };
  let at = map.cellMm;
  while (at < pitch) {
    grid = coarsenGrid(grid);
    at *= 2;
  }
  return grid;
}

/**
 * Merge two maps of the SAME face and placement. The finer map is coarsened to the coarser pitch
 * first; the merge keeps the deepest cut, and a flat floor on a tie. A map that cannot be read, or
 * maps that do not share a frame or a grid, are `unknown` with the reason — never a partial merge.
 * The fitted result may coarsen further when the merged streams overflow the budget.
 */
export function mergeFaceCutMaps(previous: FinishedCutMap, next: FinishedCutMap): CutMapFit {
  if (previous.x0Mm !== next.x0Mm || previous.y0Mm !== next.y0Mm) {
    return { kind: 'unknown', reason: 'the two maps are not in the same frame' };
  }
  const pitch = Math.max(previous.cellMm, next.cellMm);
  const a = gridAtPitch(previous, pitch);
  const b = gridAtPitch(next, pitch);
  if (a === null || b === null) return { kind: 'unknown', reason: 'a cut map could not be read' };
  if (a.cols !== b.cols || a.rows !== b.rows) {
    return { kind: 'unknown', reason: 'the two maps do not share a grid' };
  }
  const levels: number[] = [];
  const flat: number[] = [];
  for (let i = 0; i < a.levels.length; i++) {
    const p = a.levels[i]!;
    const n = b.levels[i]!;
    if (n > p) {
      levels.push(n);
      flat.push(b.flat[i]!);
    } else if (n === p) {
      levels.push(p);
      flat.push(Math.max(a.flat[i]!, b.flat[i]!));
    } else {
      levels.push(p);
      flat.push(a.flat[i]!);
    }
  }
  return fitCutMapGrid({ cols: a.cols, rows: a.rows, levels, flat }, { cellMm: pitch });
}

/**
 * Merge one program's face entries into the record's previous entries (the caller has already
 * dropped the previous list when the blank is not the same one).
 *
 * `unknown` STICKS: a setup that could not be completed stays unknown — with its first reason —
 * and a later program never restarts a fresh map that would read as the whole face. Setups not
 * mentioned by this program are carried forward unchanged, so the newest record describes the
 * whole blank.
 */
export function mergeSetupCutMaps(
  previous: readonly FinishedSetupCutMap[],
  next: readonly FinishedSetupCutMap[],
): FinishedSetupCutMap[] {
  const bySetup = new Map<number, FinishedSetupCutMap>();
  for (const entry of previous) bySetup.set(entry.setupIndex, entry);
  for (const entry of next) {
    const prior = bySetup.get(entry.setupIndex);
    if (prior === undefined) {
      bySetup.set(entry.setupIndex, entry);
      continue;
    }
    if (prior.state === 'unknown') {
      bySetup.set(entry.setupIndex, prior);
      continue;
    }
    if (entry.state === 'unknown') {
      bySetup.set(entry.setupIndex, entry);
      continue;
    }
    if (prior.map === undefined || entry.map === undefined) {
      bySetup.set(entry.setupIndex, {
        setupIndex: entry.setupIndex,
        state: 'unknown',
        unknownReason: 'a cut map entry carried no map',
      });
      continue;
    }
    const merged = mergeFaceCutMaps(prior.map, entry.map);
    bySetup.set(
      entry.setupIndex,
      merged.kind === 'map'
        ? { setupIndex: entry.setupIndex, state: 'complete', map: merged.map }
        : { setupIndex: entry.setupIndex, state: 'unknown', unknownReason: merged.reason },
    );
  }
  return [...bySetup.values()].sort((a, b) => a.setupIndex - b.setupIndex);
}
