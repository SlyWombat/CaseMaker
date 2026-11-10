/**
 * #1179 slice B — WHERE THE TOP IS MEASURED ON A BLANK THAT HAS BEEN CUT.
 *
 * The maintainer's restatement (2026-11-10): "Don't assume there is material outside the waste
 * band, the blank may be the perfect size." So the candidate points are not a ring around the part;
 * they are points whose DEPTH IS KNOWN:
 *  - the UNCUT TOP — no finished program cuts near it, d = 0;
 *  - a FLAT FLOOR — a finished program's own moves give its depth: the deepest cutting move within
 *    that program's cutter radius is the floor there, and the cell is flat when every cutting move
 *    within the cutter radius + the probe tip radius + 1 mm sits at that depth ± 0.02 mm.
 * A touch's reading + the point's depth is the IMPLIED top; the executor takes the highest implied
 * level two touches agree on. A single reading is never the top.
 *
 * With no finished program of the package recorded (today's tray: the package was regenerated), the
 * candidate set is "outside today's package footprint" with d = 0, and the record says the earlier
 * cuts are unknown. The mount's obstacles and a 3 mm edge margin are excluded everywhere; the
 * points are spread as far apart as the candidates allow.
 */
import { buildSwathIndex } from '@/engine/cnc/engrave/liveSwath';

/** The candidate raster's pitch, mm. */
export const CUT_BLANK_PITCH_MM = 1;
/** The margin kept clear of the stock's edges, mm (#1179 B1). */
export const CUT_BLANK_EDGE_MARGIN_MM = 3;
/** A floor is flat when every nearby cutting move is at its depth ± this, mm (the analyst's 0.02). */
export const CUT_BLANK_FLAT_MM = 0.02;
/** The most spread candidates the choice offers (the executor touches three, five without a pair). */
export const CUT_BLANK_MAX_POINTS = 5;
/** The extra reach past a cutter's radius that a floor must be clear of other depths, mm. */
export const CUT_BLANK_FLAT_REACH_MM = 1;

export interface StockRaster {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  pitchMm: number;
  nx: number;
  ny: number;
}

/** One program of the frozen package. Only a FINISHED program's floor is known. */
export interface CutProgramInput {
  nc: string;
  /** The program's cutter RADIUS, mm (or the labelled fallback when its cutter is unknown). */
  cutterRadiusMm: number;
  /** True when this program is among the machine's finished programs for THIS package. */
  finished: boolean;
}

/** A mount obstacle in the plan's work XY, as the registration already carries it. */
export interface CutBlankObstacle {
  min: [number, number];
  max: [number, number];
}

/** One candidate touch point, with the depth it is expected to sit at below the stock top. */
export interface SurfacePointCandidate {
  x: number;
  y: number;
  depthMm: number;
}

/** The stock top as a raster of cell centres. `nx·ny` cells, row-major (y then x). */
export function stockRaster(
  stock: { xMin: number; yMin: number; xMax: number; yMax: number },
  pitchMm: number = CUT_BLANK_PITCH_MM,
): StockRaster {
  const pitch = pitchMm > 0 ? pitchMm : CUT_BLANK_PITCH_MM;
  const nx = Math.max(1, Math.ceil((stock.xMax - stock.xMin) / pitch));
  const ny = Math.max(1, Math.ceil((stock.yMax - stock.yMin) / pitch));
  return { ...stock, pitchMm: pitch, nx, ny };
}

const cellX = (raster: StockRaster, i: number): number => raster.xMin + (i + 0.5) * raster.pitchMm;
const cellY = (raster: StockRaster, j: number): number => raster.yMin + (j + 0.5) * raster.pitchMm;

/** 2D distance from a point to the segment a–b, mm. */
function distanceToSegment2d(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** One cutting move in the work frame: its XY line and the depth it cuts to. */
interface CutMove {
  a: { x: number; y: number };
  b: { x: number; y: number };
  /** Depth below the stock top, mm (a move above the top counts as 0). */
  depthMm: number;
}

function movesOf(program: CutProgramInput): CutMove[] {
  const moves: CutMove[] = [];
  for (const segment of buildSwathIndex(program.nc).segments) {
    if (!segment.cut) continue;
    moves.push({
      a: { x: segment.from.x, y: segment.from.y },
      b: { x: segment.to.x, y: segment.to.y },
      depthMm: Math.max(0, -Math.min(segment.from.z, segment.to.z)),
    });
  }
  return moves;
}

/** The raster cells a move's disc of radius `reach` can affect, as index bounds. */
function boundsOf(raster: StockRaster, a: { x: number; y: number }, b: { x: number; y: number }, reach: number) {
  return {
    i0: Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - raster.xMin) / raster.pitchMm)),
    i1: Math.min(raster.nx - 1, Math.ceil((Math.max(a.x, b.x) + reach - raster.xMin) / raster.pitchMm)),
    j0: Math.max(0, Math.floor((Math.min(a.y, b.y) - reach - raster.yMin) / raster.pitchMm)),
    j1: Math.min(raster.ny - 1, Math.ceil((Math.max(a.y, b.y) + reach - raster.yMin) / raster.pitchMm)),
  };
}

const radiusOf = (program: CutProgramInput, fallbackRadiusMm: number): number =>
  Number.isFinite(program.cutterRadiusMm) && program.cutterRadiusMm >= 0 ? program.cutterRadiusMm : Math.max(0, fallbackRadiusMm);

/**
 * The finished programs' floor: per cell, the deepest cutting move within that program's cutter
 * radius, mm below the stock top (0 = untouched).
 */
export function depthRaster(
  raster: StockRaster,
  programs: readonly CutProgramInput[],
  fallbackRadiusMm: number,
): Float32Array {
  const depth = new Float32Array(raster.nx * raster.ny);
  for (const program of programs) {
    if (!program.finished) continue;
    const reach = radiusOf(program, fallbackRadiusMm);
    for (const move of movesOf(program)) {
      const { i0, i1, j0, j1 } = boundsOf(raster, move.a, move.b, reach);
      for (let j = j0; j <= j1; j++) {
        const y = cellY(raster, j);
        for (let i = i0; i <= i1; i++) {
          if (depth[j * raster.nx + i]! >= move.depthMm) continue;
          if (distanceToSegment2d(cellX(raster, i), y, move.a, move.b) <= reach + 1e-9) {
            depth[j * raster.nx + i] = move.depthMm;
          }
        }
      }
    }
  }
  return depth;
}

/**
 * The flat-floor mask: 1 where the cell's own floor depth is the only depth within reach — every
 * finished cutting move within (its cutter's radius + the probe tip radius + 1 mm) sits at the
 * cell's deepest depth ± {@link CUT_BLANK_FLAT_MM}. An untouched cell (no move within the cutter
 * radius) is flat when nothing within the reach cuts deeper than 0 ± the tolerance (i.e. nothing
 * cuts at all nearby).
 */
export function flatFloorMask(
  raster: StockRaster,
  programs: readonly CutProgramInput[],
  fallbackRadiusMm: number,
  tipRadiusMm: number,
  depth: Float32Array = depthRaster(raster, programs, fallbackRadiusMm),
): Uint8Array {
  const nearMin = new Float32Array(raster.nx * raster.ny).fill(Infinity);
  const nearMax = new Float32Array(raster.nx * raster.ny).fill(-Infinity);
  for (const program of programs) {
    if (!program.finished) continue;
    const reach = radiusOf(program, fallbackRadiusMm) + Math.max(0, tipRadiusMm) + CUT_BLANK_FLAT_REACH_MM;
    for (const move of movesOf(program)) {
      const { i0, i1, j0, j1 } = boundsOf(raster, move.a, move.b, reach);
      for (let j = j0; j <= j1; j++) {
        const y = cellY(raster, j);
        for (let i = i0; i <= i1; i++) {
          const at = j * raster.nx + i;
          if (distanceToSegment2d(cellX(raster, i), y, move.a, move.b) > reach + 1e-9) continue;
          if (move.depthMm < nearMin[at]!) nearMin[at] = move.depthMm;
          if (move.depthMm > nearMax[at]!) nearMax[at] = move.depthMm;
        }
      }
    }
  }
  const flat = new Uint8Array(raster.nx * raster.ny);
  for (let at = 0; at < flat.length; at++) {
    const near = nearMax[at]!;
    if (near === -Infinity) {
      flat[at] = 1;
      continue;
    }
    const own = depth[at]!;
    flat[at] = near - own <= CUT_BLANK_FLAT_MM + 1e-9 && own - nearMin[at]! <= CUT_BLANK_FLAT_MM + 1e-9 ? 1 : 0;
  }
  return flat;
}

/**
 * The union of EVERY program's cutting path, grown by its cutter radius + 1 mm (the fallback grow
 * when a cutter is unknown) — the "outside today's package footprint" set the unknown-cuts case
 * uses.
 */
export function cutFootprintMask(
  raster: StockRaster,
  programs: readonly CutProgramInput[],
  fallbackRadiusMm: number,
  fallbackGrowMm: number = Math.max(0, fallbackRadiusMm) + 1,
): Uint8Array {
  const mask = new Uint8Array(raster.nx * raster.ny);
  for (const program of programs) {
    const reach = Number.isFinite(program.cutterRadiusMm) && program.cutterRadiusMm >= 0
      ? program.cutterRadiusMm + 1
      : Math.max(0, fallbackGrowMm);
    for (const move of movesOf(program)) {
      const { i0, i1, j0, j1 } = boundsOf(raster, move.a, move.b, reach);
      for (let j = j0; j <= j1; j++) {
        const y = cellY(raster, j);
        for (let i = i0; i <= i1; i++) {
          const at = j * raster.nx + i;
          if (mask[at] === 1) continue;
          if (distanceToSegment2d(cellX(raster, i), y, move.a, move.b) <= reach + 1e-9) mask[at] = 1;
        }
      }
    }
  }
  return mask;
}

interface Cell {
  x: number;
  y: number;
  depthMm: number;
}

const dist = (a: Cell, b: Cell): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Farthest-point sampling from the stock's centre: spread the points as far as the cells allow. */
function spread(cells: readonly Cell[], max: number, centre: Cell): Cell[] {
  const chosen: Cell[] = [];
  const pool = [...cells];
  while (chosen.length < max && pool.length > 0) {
    let bestAt = -1;
    let bestDistance = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const cell = pool[i]!;
      const distance = chosen.length === 0 ? dist(cell, centre) : Math.min(...chosen.map((c) => dist(cell, c)));
      if (distance > bestDistance) {
        bestDistance = distance;
        bestAt = i;
      }
    }
    const [cell] = pool.splice(bestAt, 1);
    if (cell !== undefined) chosen.push(cell);
  }
  return chosen;
}

/**
 * The candidates for a blank that has been cut (#1179 B, restated):
 *  - with finished programs recorded: flat cells whose depth is known — the UNCUT top (d = 0)
 *    first, then flat floors;
 *  - with none recorded: cells outside today's package footprint, d = 0, and the caller records
 *    that the earlier cuts are unknown.
 * Obstacles and the edge margin are excluded; up to {@link CUT_BLANK_MAX_POINTS} spread points.
 */
export function cutBlankCandidates(input: {
  raster: StockRaster;
  programs: readonly CutProgramInput[];
  tipRadiusMm: number;
  fallbackRadiusMm: number;
  obstacles: readonly CutBlankObstacle[];
  edgeMarginMm?: number;
}): { points: SurfacePointCandidate[]; earlierCutsKnown: boolean } {
  const { raster, programs, obstacles } = input;
  const margin = input.edgeMarginMm ?? CUT_BLANK_EDGE_MARGIN_MM;
  const earlierCutsKnown = programs.some((program) => program.finished);
  const depth = earlierCutsKnown ? depthRaster(raster, programs, input.fallbackRadiusMm) : null;
  const flat = earlierCutsKnown ? flatFloorMask(raster, programs, input.fallbackRadiusMm, input.tipRadiusMm, depth ?? undefined) : null;
  const outside = earlierCutsKnown ? null : cutFootprintMask(raster, programs, input.fallbackRadiusMm);
  const top: Cell[] = [];
  const floor: Cell[] = [];
  for (let j = 0; j < raster.ny; j++) {
    const y = cellY(raster, j);
    if (y < raster.yMin + margin || y > raster.yMax - margin) continue;
    for (let i = 0; i < raster.nx; i++) {
      const x = cellX(raster, i);
      if (x < raster.xMin + margin || x > raster.xMax - margin) continue;
      const at = j * raster.nx + i;
      if (obstacles.some((o) => x >= o.min[0] && x <= o.max[0] && y >= o.min[1] && y <= o.max[1])) continue;
      const cell = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, depthMm: 0 };
      if (depth !== null && flat !== null) {
        if (flat[at] === 0) continue;
        const d = depth[at]!;
        if (d <= CUT_BLANK_FLAT_MM) top.push(cell);
        else floor.push({ ...cell, depthMm: d });
      } else if (outside !== null && outside[at] === 0) {
        top.push(cell);
      }
    }
  }
  const centre = { x: (raster.xMin + raster.xMax) / 2, y: (raster.yMin + raster.yMax) / 2, depthMm: 0 };
  // Uncut top first; floors fill what the top cannot.
  const chosen = [...spread(top, CUT_BLANK_MAX_POINTS, centre)];
  if (chosen.length < CUT_BLANK_MAX_POINTS) chosen.push(...spread(floor, CUT_BLANK_MAX_POINTS - chosen.length, centre));
  return {
    points: chosen.map((c) => ({ x: c.x, y: c.y, depthMm: c.depthMm })),
    earlierCutsKnown,
  };
}
