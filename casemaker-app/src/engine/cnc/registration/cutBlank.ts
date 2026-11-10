/**
 * #1179 slice B — WHERE THE TOP IS MEASURED ON A BLANK THAT HAS BEEN CUT.
 *
 * The maintainer's restatement (2026-11-10): "Don't assume there is material outside the waste
 * band, the blank may be the perfect size." So the candidate points are not a ring around the part;
 * they are points whose DEPTH IS KNOWN:
 *  - the UNCUT TOP — no finished program cuts near it, d = 0;
 *  - a FLAT FLOOR — a finished FLAT END MILL's own moves give its depth: the deepest cutting move
 *    within that program's cutter radius is the floor there, and the cell is flat when every
 *    cutting move within the cutter radius + the probe tip radius + 1 mm sits at that depth
 *    ± 0.02 mm. A floor is only flat under a FLAT cutter (the analyst, 2026-11-10): under a ball,
 *    bull or V the surface between passes is scalloped and shallower than the tip's Z, so two
 *    passes at one Z would pass the depth test and the probe would read a cusp. A cell a non-flat
 *    cutter reaches is CUT — never top, never a floor candidate.
 * A touch's reading + the point's depth is the IMPLIED top; the executor takes the highest implied
 * level two touches agree on. A single reading is never the top.
 *
 * With no finished program of the package recorded (today's tray: the package was regenerated), the
 * candidate set is "outside today's package footprint" with d = 0, and the record says the earlier
 * cuts are unknown. The mount's obstacles and a 3 mm edge margin are excluded everywhere; the
 * points are spread as far apart as the candidates allow.
 */
import { buildSwathIndex } from '@/engine/cnc/engrave/liveSwath';
import type { ToolShape } from '@/engine/cnc/tool';
import { decodeRuns } from '@/engine/cnc/engrave/cutMap';
import type { FinishedCutMap } from '@/platform/locationClient';

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
  /**
   * The cutter's shape. Only `'flat'` leaves a flat floor between passes; any other shape (and an
   * unnameable cutter, `'unknown'`) makes the surface it leaves scalloped — cut, never a floor.
   */
  shape: ToolShape;
}

/** A flat end mill is the only cutter whose finished floor the raster can call flat. */
const isFlatCutter = (program: CutProgramInput): boolean => program.shape === 'flat';

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
 * The finished FLAT programs' floor: per cell, the deepest cutting move within that program's
 * cutter radius, mm below the stock top (0 = untouched). A non-flat program's cuts are not a floor
 * — {@link cutMask} says which cells they reach.
 */
export function depthRaster(
  raster: StockRaster,
  programs: readonly CutProgramInput[],
  fallbackRadiusMm: number,
): Float32Array {
  const depth = new Float32Array(raster.nx * raster.ny);
  for (const program of programs) {
    if (!program.finished || !isFlatCutter(program)) continue;
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
 * The cells a finished program's cutter reaches. `nonFlatOnly` keeps just the cutters whose floor
 * is not flat (ball, bull, V, and an unnameable cutter): those cells are CUT and can never be a
 * check point for the uncut top or a floor.
 */
export function cutMask(
  raster: StockRaster,
  programs: readonly CutProgramInput[],
  fallbackRadiusMm: number,
  nonFlatOnly = false,
): Uint8Array {
  const mask = new Uint8Array(raster.nx * raster.ny);
  for (const program of programs) {
    if (!program.finished) continue;
    if (nonFlatOnly && isFlatCutter(program)) continue;
    const reach = radiusOf(program, fallbackRadiusMm);
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
  probe: ProbeBody,
  depth: Float32Array = depthRaster(raster, programs, fallbackRadiusMm),
): Uint8Array {
  // Two reaches: the tip's (a shallow touch) and the body's (a touch deeper than the tip's length,
  // when the body's diameter is recorded). A deep cell with no body number is never a candidate.
  const tipRadius = Math.max(0, probe.tipRadiusMm);
  const bodyRadius = probe.bodyDiameterMm !== null && probe.bodyDiameterMm !== undefined && probe.bodyDiameterMm > 0
    ? probe.bodyDiameterMm / 2
    : null;
  const near = (reachRadius: number) => {
    const min = new Float32Array(raster.nx * raster.ny).fill(Infinity);
    const max = new Float32Array(raster.nx * raster.ny).fill(-Infinity);
    for (const program of programs) {
      if (!program.finished) continue;
      const reach = radiusOf(program, fallbackRadiusMm) + reachRadius + CUT_BLANK_FLAT_REACH_MM;
      for (const move of movesOf(program)) {
        const { i0, i1, j0, j1 } = boundsOf(raster, move.a, move.b, reach);
        for (let j = j0; j <= j1; j++) {
          const y = cellY(raster, j);
          for (let i = i0; i <= i1; i++) {
            const at = j * raster.nx + i;
            if (distanceToSegment2d(cellX(raster, i), y, move.a, move.b) > reach + 1e-9) continue;
            if (move.depthMm < min[at]!) min[at] = move.depthMm;
            if (move.depthMm > max[at]!) max[at] = move.depthMm;
          }
        }
      }
    }
    return { min, max };
  };
  const byTip = near(tipRadius);
  const byBody = bodyRadius === null ? null : near(bodyRadius);
  // A cell a non-flat cutter reaches is CUT: its true surface is a scallop shallower than the
  // tip's Z, so no depth test can call it flat — whatever the moves' own Z values say.
  const nonFlatReached = cutMask(raster, programs, fallbackRadiusMm, true);
  const flat = new Uint8Array(raster.nx * raster.ny);
  for (let at = 0; at < flat.length; at++) {
    if (nonFlatReached[at] === 1) {
      flat[at] = 0;
      continue;
    }
    const own = depth[at]!;
    const deep = probe.tipLengthMm !== null && probe.tipLengthMm !== undefined && own > probe.tipLengthMm + 1e-9;
    const chosen = deep ? (byBody === null ? null : byBody) : byTip;
    if (chosen === null) {
      // The body would enter this floor and its size is not recorded: not a candidate.
      flat[at] = 0;
      continue;
    }
    const nearMax = chosen.max[at]!;
    if (nearMax === -Infinity) {
      flat[at] = 1;
      continue;
    }
    flat[at] =
      nearMax - own <= CUT_BLANK_FLAT_MM + 1e-9 && own - chosen.min[at]! <= CUT_BLANK_FLAT_MM + 1e-9 ? 1 : 0;
  }
  return flat;
}

/** The probe's entering geometry (#1179 B): the tip, and the body a deep floor is entered by. */
export interface ProbeBody {
  tipRadiusMm: number;
  tipLengthMm?: number | null;
  bodyDiameterMm?: number | null;
}

/**
 * The union of EVERY program's cutting path, grown by its cutter radius + 1 mm (the fallback grow
 * when a cutter is unknown) — the "outside today's package footprint" set the unknown-cuts case
 * uses. `extraReachMm` grows it further: the analyst's rule (2026-11-10) is the probe tip's radius
 * as well, so a check point never sits half over a pocket the tip enters.
 */
export function cutFootprintMask(
  raster: StockRaster,
  programs: readonly CutProgramInput[],
  fallbackRadiusMm: number,
  extraReachMm = 0,
): Uint8Array {
  const extra = Math.max(0, extraReachMm);
  const mask = new Uint8Array(raster.nx * raster.ny);
  for (const program of programs) {
    const reach = Number.isFinite(program.cutterRadiusMm) && program.cutterRadiusMm >= 0
      ? program.cutterRadiusMm + 1 + extra
      : Math.max(0, fallbackRadiusMm) + 1 + extra;
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

/**
 * #1179 stage 2 — THE CANDIDATES FROM THE RECORD'S CUT MAP (E's per-setup map, the analyst's
 * fields comment 6776457695). The map is the blank's own measured state for THIS face: the stored
 * pitch (`cellMm`, 2 normally and coarsened to 4 or 8), a depth level per cell (`level × stepMm`,
 * 0 = uncut) and a flat bit per cell (a horizontal cut or a straight plunge; a ramp is never a
 * flat floor). Only flat cells are candidates — the uncut top (level 0) first, then the floors;
 * the probe body's rule filters the deep floors exactly as the package-raster path does.
 *
 * `null` when the map's streams do not decode: the caller then takes the unknown-cuts footprint
 * path rather than trusting a map it could not read.
 */
export function cutBlankCandidatesFromMap(input: {
  map: FinishedCutMap;
  probe: ProbeBody;
  obstacles: readonly CutBlankObstacle[];
  edgeMarginMm?: number;
}): { points: SurfacePointCandidate[]; floorsRestricted: string | null } | null {
  const { map } = input;
  const count = map.cols * map.rows;
  const levels = decodeRuns(map.depth.data, count);
  const flatBits = decodeRuns(map.flat.data, count);
  if (levels === null || flatBits === null) return null;
  const margin = input.edgeMarginMm ?? CUT_BLANK_EDGE_MARGIN_MM;
  const tipLengthKnown = input.probe.tipLengthMm !== null && input.probe.tipLengthMm !== undefined;
  const bodyKnown =
    input.probe.bodyDiameterMm !== null && input.probe.bodyDiameterMm !== undefined && input.probe.bodyDiameterMm > 0;
  const xEnd = map.x0Mm + map.cols * map.cellMm;
  const yEnd = map.y0Mm + map.rows * map.cellMm;
  const top: Cell[] = [];
  const floor: Cell[] = [];
  for (let j = 0; j < map.rows; j++) {
    const y = map.y0Mm + (j + 0.5) * map.cellMm;
    if (y < map.y0Mm + margin || y > yEnd - margin) continue;
    for (let i = 0; i < map.cols; i++) {
      const x = map.x0Mm + (i + 0.5) * map.cellMm;
      if (x < map.x0Mm + margin || x > xEnd - margin) continue;
      if (input.obstacles.some((o) => x >= o.min[0] && x <= o.max[0] && y >= o.min[1] && y <= o.max[1])) continue;
      const at = j * map.cols + i;
      // A cell that is not flat (a ramp's exit, a scallop the map could not vouch for) is never a
      // check point: the probe would read a slope, not a level.
      if (flatBits[at] !== 1) continue;
      const depthMm = Math.round(levels[at]! * map.stepMm * 1000) / 1000;
      const cell = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, depthMm: 0 };
      if (depthMm <= CUT_BLANK_FLAT_MM) top.push(cell);
      else floor.push({ ...cell, depthMm });
    }
  }
  const deepest = floor.reduce((max, cell) => Math.max(max, cell.depthMm), 0);
  const floorsRestricted = !tipLengthKnown
    ? 'the probe’s body/tip length is not recorded, so only the uncut top was used as a check point'
    : !bodyKnown && deepest > input.probe.tipLengthMm! + 1e-9
      ? `the probe’s body diameter is not recorded, so floors deeper than the tip’s ${input.probe.tipLengthMm} mm were not used as check points`
      : null;
  const usableFloor = !tipLengthKnown
    ? []
    : bodyKnown
      ? floor
      : floor.filter((cell) => cell.depthMm <= input.probe.tipLengthMm! + 1e-9);
  const centre = { x: map.x0Mm + (map.cols * map.cellMm) / 2, y: map.y0Mm + (map.rows * map.cellMm) / 2, depthMm: 0 };
  const chosen = [...spread(top, CUT_BLANK_MAX_POINTS, centre)];
  if (chosen.length < CUT_BLANK_MAX_POINTS) {
    chosen.push(...spread(usableFloor, CUT_BLANK_MAX_POINTS - chosen.length, centre));
  }
  return { points: chosen.map((cell) => ({ x: cell.x, y: cell.y, depthMm: cell.depthMm })), floorsRestricted };
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
  /** The probe's entering geometry: its tip, and the body a deep floor is entered by. */
  probe: ProbeBody;
  fallbackRadiusMm: number;
  /**
   * #1179 B (analyst) — a LATER setup: the programs given are the registered setup's own, and the
   * earlier setups' cuts are not recorded for this face (their frames face the other way). Nothing
   * is claimed known: the selection takes the unknown path over this setup's own footprint.
   */
  earlierCutsUnknown?: boolean;
  obstacles: readonly CutBlankObstacle[];
  edgeMarginMm?: number;
}): { points: SurfacePointCandidate[]; earlierCutsKnown: boolean; floorsRestricted: string | null } {
  const { raster, programs, obstacles } = input;
  const margin = input.edgeMarginMm ?? CUT_BLANK_EDGE_MARGIN_MM;
  const earlierCutsKnown = input.earlierCutsUnknown !== true && programs.some((program) => program.finished);
  const depth = earlierCutsKnown ? depthRaster(raster, programs, input.fallbackRadiusMm) : null;
  // #1179 B (analyst) — a floor deeper than the tip's length is entered by the probe's BODY: it is
  // only a candidate when the body's diameter is recorded. An unrecorded tip length keeps to the
  // uncut top, and the note says the floor points were not used.
  const tipLengthKnown = input.probe.tipLengthMm !== null && input.probe.tipLengthMm !== undefined;
  const bodyKnown = input.probe.bodyDiameterMm !== null && input.probe.bodyDiameterMm !== undefined && input.probe.bodyDiameterMm > 0;
  const deepest = depth === null ? 0 : depth.reduce((max, d) => (d > max ? d : max), 0);
  const floorsRestricted = !earlierCutsKnown
    ? null
    : !tipLengthKnown
      ? 'the probe’s body/tip length is not recorded, so only the uncut top was used as a check point'
      : !bodyKnown && tipLengthKnown && deepest > input.probe.tipLengthMm! + 1e-9
        ? `the probe’s body diameter is not recorded, so floors deeper than the tip’s ${input.probe.tipLengthMm} mm were not used as check points`
        : null;
  const flat = earlierCutsKnown && tipLengthKnown
    ? flatFloorMask(raster, programs, input.fallbackRadiusMm, input.probe, depth ?? undefined)
    : null;
  // No recorded tip length: the floors are not offered (the note says so), but the UNCUT TOP still
  // is — the cells the finished programs have not reached. With earlier cuts unknown, every given
  // program's footprint is excluded instead (those cuts may or may not have happened).
  const outside = earlierCutsKnown
    ? tipLengthKnown
      ? null
      : cutFootprintMask(raster, programs.filter((program) => program.finished), input.fallbackRadiusMm, input.probe.tipRadiusMm)
    : cutFootprintMask(raster, programs, input.fallbackRadiusMm, input.probe.tipRadiusMm);
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
    floorsRestricted,
  };
}
