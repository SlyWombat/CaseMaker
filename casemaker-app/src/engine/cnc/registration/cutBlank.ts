/**
 * #1179 slice B — WHERE THE TOP IS MEASURED ON A BLANK THAT HAS BEEN CUT.
 *
 * The restart's registration finds the top on wood no program cut. This module is the pure side:
 *  - the package's CUT FOOTPRINT — every program's cutting moves (the app's own G-code parse), each
 *    grown by that program's cutter radius + 1 mm;
 *  - the PART'S PLACED SILHOUETTE — the goal's work mesh rasterised by the coverage sampler and
 *    grown by the largest owned cutter diameter + 1 mm (the analyst's ruling);
 *  - the TIERED choice of touch points: tier 1 is outside the part AND outside the package's cut
 *    (the waste band), tier 2 is outside the cut only. Two touches come from tier 1 when it has a
 *    pair at least {@link CUT_BLANK_MIN_SEPARATION_MM} apart; otherwise one from each tier; tier 2
 *    alone only when tier 1 is empty (the analyst, 2026-11-10).
 *
 * The mount's obstacles (clamps, arms) and a {@link CUT_BLANK_EDGE_MARGIN_MM} edge margin are
 * excluded everywhere. Nothing here probes or reads a store; the executor touches what this picks.
 */
import { goalWorkMesh } from '@/engine/cnc/engrave/goalFlipFindings';
import { sampleCoverageField } from '@/engine/cnc/engrave/goalCoverage';
import { buildSwathIndex } from '@/engine/cnc/engrave/liveSwath';
import type { EngraveTargetObject } from '@/types/engraveJob';

/** The candidate raster's pitch, mm. */
export const CUT_BLANK_PITCH_MM = 1;
/** The margin kept clear of the stock's edges, mm (#1179 B1). */
export const CUT_BLANK_EDGE_MARGIN_MM = 3;
/** Two tier-1 touches must be at least this far apart, mm (#1179 B1, the analyst's ruling). */
export const CUT_BLANK_MIN_SEPARATION_MM = 20;

export interface StockRaster {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  pitchMm: number;
  nx: number;
  ny: number;
}

/** One program of the frozen package: its NC text, and how far its cutter clears the path. */
export interface CutProgramInput {
  nc: string;
  /** The program's cutter radius + 1 mm — or NaN when its cutter is unknown (the fallback). */
  growMm: number;
}

/** A mount obstacle in the plan's work XY, as the registration already carries it. */
export interface CutBlankObstacle {
  min: [number, number];
  max: [number, number];
}

/** One candidate touch point, with the tier the analyst's ruling gives it. */
export interface SurfacePointCandidate {
  x: number;
  y: number;
  tier: 1 | 2;
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

/** Mark every cell whose centre is within `grow` of the segment's XY line. */
function markSegment(mask: Uint8Array, raster: StockRaster, a: { x: number; y: number }, b: { x: number; y: number }, grow: number): void {
  const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - grow - raster.xMin) / raster.pitchMm));
  const i1 = Math.min(raster.nx - 1, Math.ceil((Math.max(a.x, b.x) + grow - raster.xMin) / raster.pitchMm));
  const j0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - grow - raster.yMin) / raster.pitchMm));
  const j1 = Math.min(raster.ny - 1, Math.ceil((Math.max(a.y, b.y) + grow - raster.yMin) / raster.pitchMm));
  for (let j = j0; j <= j1; j++) {
    const y = cellY(raster, j);
    for (let i = i0; i <= i1; i++) {
      if (mask[j * raster.nx + i] === 1) continue;
      if (distanceToSegment2d(cellX(raster, i), y, a, b) <= grow + 1e-9) mask[j * raster.nx + i] = 1;
    }
  }
}

/**
 * The package's cut footprint: every program's cutting moves, grown by its own cutter radius + 1 mm
 * (`growMm`), or by `fallbackGrowMm` when the program's cutter is unknown. A rapid never marks.
 */
export function cutFootprintMask(
  raster: StockRaster,
  programs: readonly CutProgramInput[],
  fallbackGrowMm: number,
): Uint8Array {
  const mask = new Uint8Array(raster.nx * raster.ny);
  const fallback = Number.isFinite(fallbackGrowMm) && fallbackGrowMm >= 0 ? fallbackGrowMm : CUT_BLANK_PITCH_MM;
  for (const program of programs) {
    const grow = Number.isFinite(program.growMm) && program.growMm >= 0 ? program.growMm : fallback;
    for (const segment of buildSwathIndex(program.nc).segments) {
      if (!segment.cut) continue;
      markSegment(mask, raster, segment.from, segment.to, grow);
    }
  }
  return mask;
}

/**
 * The part's placed silhouette (the goal's work mesh) rasterised and grown by `growMm` — the
 * largest owned cutter diameter + 1 mm, per the ruling. Null when the goal has no readable mesh
 * (a 2D-only part), which leaves tier 1 empty and the choice to tier 2.
 */
export function partFootprintMask(
  raster: StockRaster,
  goal: EngraveTargetObject | null,
  growMm: number,
): Uint8Array | null {
  if (goal === null) return null;
  const mesh = goalWorkMesh(goal);
  if (mesh === null) return null;
  let field: ReturnType<typeof sampleCoverageField>;
  try {
    field = sampleCoverageField(mesh, raster.pitchMm);
  } catch {
    return null;
  }
  if (field.coveredCount === 0) return null;
  const grow = Number.isFinite(growMm) && growMm >= 0 ? growMm : 0;
  const mask = new Uint8Array(raster.nx * raster.ny);
  // Each covered coverage cell is a disc of `grow` in the stock raster.
  for (let j = 0; j < field.ny; j++) {
    for (let i = 0; i < field.nx; i++) {
      if (field.covered[j * field.nx + i] === 0) continue;
      const cx = field.x0 + (i + 0.5) * field.pitch;
      const cy = field.y0 + (j + 0.5) * field.pitch;
      const gi0 = Math.max(0, Math.floor((cx - grow - raster.xMin) / raster.pitchMm));
      const gi1 = Math.min(raster.nx - 1, Math.ceil((cx + grow - raster.xMin) / raster.pitchMm));
      const gj0 = Math.max(0, Math.floor((cy - grow - raster.yMin) / raster.pitchMm));
      const gj1 = Math.min(raster.ny - 1, Math.ceil((cy + grow - raster.yMin) / raster.pitchMm));
      for (let gj = gj0; gj <= gj1; gj++) {
        const y = cellY(raster, gj);
        for (let gi = gi0; gi <= gi1; gi++) {
          if (mask[gj * raster.nx + gi] === 1) continue;
          if (Math.hypot(cellX(raster, gi) - cx, y - cy) <= grow + raster.pitchMm / 2) mask[gj * raster.nx + gi] = 1;
        }
      }
    }
  }
  return mask;
}

interface Cell {
  x: number;
  y: number;
}

const dist = (a: Cell, b: Cell): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The cell farthest from every seed (or from the stock's centre with no seed), or null. */
function farthestFrom(cells: readonly Cell[], seeds: readonly Cell[], centre: Cell): Cell | null {
  let best: Cell | null = null;
  let bestDistance = -Infinity;
  for (const cell of cells) {
    const distance = seeds.length === 0 ? dist(cell, centre) : Math.min(...seeds.map((seed) => dist(cell, seed)));
    if (distance > bestDistance) {
      bestDistance = distance;
      best = cell;
    }
  }
  return best;
}

/**
 * The tiered touch points (#1179 B1, the analyst's ruling):
 *  - tier 1 — outside the part's grown silhouette AND outside the package's grown cut footprint,
 *    inside the edge margin and clear of the mount's obstacles;
 *  - tier 2 — the same, minus the part test.
 * Two tier-1 points at least `minSeparationMm` apart win; otherwise one from each tier; tier 2
 * alone only when tier 1 is empty. Up to three points are returned (the third serves the
 * disagreement rule), chosen as far apart as the free cells allow.
 */
export function surfaceCandidates(input: {
  raster: StockRaster;
  cut: Uint8Array;
  part: Uint8Array | null;
  obstacles: readonly CutBlankObstacle[];
  edgeMarginMm?: number;
  minSeparationMm?: number;
}): SurfacePointCandidate[] {
  const { raster, cut, part, obstacles } = input;
  const margin = input.edgeMarginMm ?? CUT_BLANK_EDGE_MARGIN_MM;
  const separation = input.minSeparationMm ?? CUT_BLANK_MIN_SEPARATION_MM;
  const tier1: Cell[] = [];
  const tier2: Cell[] = [];
  for (let j = 0; j < raster.ny; j++) {
    const y = cellY(raster, j);
    if (y < raster.yMin + margin || y > raster.yMax - margin) continue;
    for (let i = 0; i < raster.nx; i++) {
      const x = cellX(raster, i);
      if (x < raster.xMin + margin || x > raster.xMax - margin) continue;
      if (cut[j * raster.nx + i] === 1) continue;
      if (obstacles.some((o) => x >= o.min[0] && x <= o.max[0] && y >= o.min[1] && y <= o.max[1])) continue;
      const cell = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
      tier2.push(cell);
      if (part === null || part[j * raster.nx + i] === 0) tier1.push(cell);
    }
  }
  const centre = {
    x: (raster.xMin + raster.xMax) / 2,
    y: (raster.yMin + raster.yMax) / 2,
  };
  const pick: SurfacePointCandidate[] = [];
  const first = farthestFrom(tier1, [], centre);
  const second = first === null ? null : farthestFrom(tier1, [first], centre);
  if (first !== null && second !== null && dist(first, second) >= separation) {
    pick.push({ ...first, tier: 1 }, { ...second, tier: 1 });
  } else if (first !== null) {
    pick.push({ ...first, tier: 1 });
    const other = farthestFrom(tier2, [first], centre);
    if (other !== null) pick.push({ ...other, tier: 2 });
  } else {
    const a = farthestFrom(tier2, [], centre);
    if (a !== null) pick.push({ ...a, tier: 2 });
    const b = a === null ? null : farthestFrom(tier2, [a], centre);
    if (b !== null) pick.push({ ...b, tier: 2 });
  }
  // A third point for the disagreement rule: tier 1 first, then tier 2, far from both.
  const seeds = pick.map((p) => ({ x: p.x, y: p.y }));
  const third =
    farthestFrom(
      tier1.filter((cell) => !seeds.some((s) => dist(cell, s) < 0.5)),
      seeds,
      centre,
    ) ??
    farthestFrom(
      tier2.filter((cell) => !seeds.some((s) => dist(cell, s) < 0.5)),
      seeds,
      centre,
    );
  if (third !== null) {
    const inTier1 = tier1.some((cell) => dist(cell, third) < 0.5);
    pick.push({ ...third, tier: inTier1 ? 1 : 2 });
  }
  return pick;
}
