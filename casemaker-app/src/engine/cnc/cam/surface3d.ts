/**
 * 3D SURFACING FROM A GOAL MESH (#534, slice D of #222).
 *
 * The input is a `role: 'goal'` {@link EngraveTargetObject} (#533, slice C): an STL/3MF embedded
 * in the job as the shape to MAKE, not a part to position against. This module turns that mesh
 * into a surfacing toolpath and emits it to the linear IR (`cam/ir.ts`, `frame: 'flat'`). Two
 * stages, each pure and deterministic:
 *
 *   1. {@link sampleGoalHeightfield} — the mesh → a TOP-Z HEIGHTFIELD over an (x, y) grid at the
 *      shop grid pitch (`sim.columnFlatPitchYMm`, default {@link DEFAULT_GRID_PITCH_MM}). Each
 *      cell holds the highest surface Z of the placed mesh above it, in the WORK frame (z = 0 is
 *      the stock's top face). A cell no triangle covers keeps the stock top as a sentinel — the
 *      goal says nothing there, so the passes leave the stock standing. The grid is capped
 *      ({@link DEFAULT_MAX_CELLS}); above the cap the pitch is COARSENED and the coarser value is
 *      stated in {@link GoalHeightfield.resolutionNote}, never a refusal (design doc §2).
 *
 *   2. {@link generateSurface3dIR} — the heightfield → two passes:
 *      - RASTER ROUGHING in step-down Z layers that clears the stock ABOVE the heightfield,
 *        leaving a `stockToLeaveMm` allowance. At each raster point the tip rides at the layer Z
 *        but is clamped up to `H + allowance`, so a rough move never reaches the goal surface.
 *      - A BALL-NOSE FINISHING raster that follows the heightfield. The tip is the GOUGE-SAFE
 *        drop of the tool onto the field — the ball is lowered until it just touches, so it tracks
 *        the goal within the step-over and the grid pitch without cutting through it. #945 — the
 *        step-over ITSELF, when the caller states none, is derived from the ball's own radius and
 *        the shop's leftover-visible band ({@link finishStepOverForCusp}), not the 2.5D pocketing
 *        step-over reused as-is: the two numbers answer different questions.
 *      Both are emitted as linear feed/rapid moves (the IR is linear — no arcs, #172).
 *
 * WHAT A HEIGHTFIELD CANNOT DO: undercuts. A single top-Z per (x, y) cannot express an overhang,
 * a re-entrant wall or anything a 3-axis tool could not reach straight down anyway. A goal with
 * undercuts is sampled to its TOPMOST surface and the hidden material below is left — which is the
 * honest 3-axis answer, and the caller is told so with a note.
 *
 * FEEDS ARE A PLACEHOLDER (slice F, #536). The cutting feed, plunge feed, step-down and step-over
 * handed in here are the job's ordinary 2.5D feeds, reused UNCHANGED. Real cutting feeds for the
 * variable 3D engagement a surfacing pass sees are the bench slice's to measure; this module never
 * invents one, and it labels the numbers it was given so the run sheet cannot present them as
 * tuned for 3D (see {@link Surface3dResult.notes}).
 */

import type { EngraveTargetObject } from '@/types/engraveJob';
import { targetObjectMesh } from '@/engine/import/targetObject';
import { placedSize } from '@/engine/cnc/engrave/targetScale';
import { placeTarget } from '@/engine/cnc/engrave/targetPlace';
import { base64ToArrayBuffer } from '@/engine/import/base64';
import { decodePng } from '@/engine/import/png';
import { reliefDepthMm, reliefNumbers } from './relief';
import {
  estimateCycleSeconds,
  HOP_Z,
  SAFE_Z,
  type CamMove,
  type CamOperation,
  type RapidEstimate,
  type ToolpathIR,
} from './ir';
import type { Tool } from '../tool';
import { cuttingDiameter, cuttingRadiusForSweep } from '../tool';
import { adaptiveSettings, type AdaptiveSettings } from './adaptive';
import { roughingAdaptiveMoves, type LevelPlanMemory, type LevelPlanner } from './rough3d';
import { isMetalMaterial } from '../materials';
import { GOAL_MERGE_TOLERANCE_MM, MoveStore } from './moveStore';
import type { StockMaterial } from '@/types/engraveJob';

/**
 * The FLAT grid's default pitch, mm — the LABELLED FALLBACK for the shop's `sim.columnFlatPitchYMm`
 * (#438), the same number the column sim falls back to (`COLUMN_FLAT_PITCH_Y_FALLBACK_MM`). Kept as
 * its own constant so this CAM module does not import the geometry worker; the two values are the
 * one shop default and must stay equal.
 */
export const DEFAULT_GRID_PITCH_MM = 0.1;

/**
 * The heightfield grid cap (design doc §2): above it the pitch is coarsened rather than the job
 * refused. 4 M cells at 4 bytes is 16 MB — the same comfort the sim's ~16 M-cell bed figure is
 * sized against, held lower here because a CAM pass walks the grid many times.
 */
export const DEFAULT_MAX_CELLS = 4_000_000;

/** The roughing allowance when the caller states none, mm — labelled, not measured (slice F). */
export const DEFAULT_STOCK_TO_LEAVE_MM = 0.3;

/**
 * #847 — the rise above the goal that counts as material the finish LEFT, mm. A hundredth of a
 * millimetre: the residual is measured cell for cell from the same grid the tip was dropped on, so
 * this is not a sampling allowance — it keeps float noise along a flat or a straight wall from
 * summoning a rest pass, and names the smallest concavity worth a second program.
 */
export const REST_TOLERANCE_MM = 0.01;

/**
 * The finishing tip-field compute budget (#540): the ball drop is O(covered cells × disc-stencil
 * cells), so a large ball on a fine grid is billions of inner-loop ops with no cutoff — enough to
 * hang the worker. Above this cap {@link finishTipField} REFUSES honestly (it states the op count
 * and the fix), mirroring the exact sweep's `sweep-budget-exceeded` rather than running to a hang.
 * 300 M evaluations is comfortably past any real small-ball/coarse-grid job yet well under the
 * ~2.8 billion a 3 mm ball at 0.1 mm over a near-cap grid would cost.
 */
export const DEFAULT_MAX_FINISH_TIP_OPS = 300_000_000;

/**
 * #671 — the crease angle the PENCIL pass follows when the operation states none, degrees. The
 * mark is a change of slope across one grid cell sharper than this: a 90° wall's foot marks a
 * line; a cylinder, a dome and a ramp do not.
 */
export const DEFAULT_PENCIL_CREASE_DEG = 20;

/**
 * #671 — the steepest-slope crowding clamp for the SCALLOP pass. The contour spacing is the
 * surface step-over divided by the slope's secant (`sqrt(1 + s²)`), so a vertical wall would ask
 * for infinitely many passes; past this factor the spacing stops shrinking. `8` is a slope of
 * ~82.6°, and the pass's note says so when the clamp binds.
 */
export const MAX_SCALLOP_CROWDING = 8;

/**
 * #671 — the scallop pass's contour cap. Each contour is a marching-squares walk of the distance
 * field; past this many the pass REFUSES by name (as #540's tip budget does) rather than spin.
 */
export const DEFAULT_MAX_SCALLOP_CONTOURS = 4000;

/**
 * A TOP-Z HEIGHTFIELD over an (x, y) grid in the WORK frame (z = 0 = stock top). `z[j*nx + i]` is
 * the highest surface Z of the placed goal mesh above column (i, j), or {@link topZ} where no
 * triangle covered the cell (the goal is silent there). Columns are square — both axes at
 * {@link pitch}.
 */
export interface GoalHeightfield {
  nx: number;
  ny: number;
  /** Work X of column i = 0's centre, mm. */
  x0: number;
  /** Work Y of column j = 0's centre, mm. */
  y0: number;
  /** Square cell pitch, mm (both axes). */
  pitch: number;
  /** Work Z of the stock top — the sentinel for a cell the goal does not cover. */
  topZ: number;
  /** The lowest covered top-Z over the grid (equals {@link topZ} when nothing is covered). */
  minZ: number;
  /** Top-Z per column, `z[j*nx + i]`. */
  z: Float32Array;
  /** 1 where at least one triangle covered the cell, else 0. */
  covered: Uint8Array;
  /** How many cells the goal footprint covers. */
  coveredCount: number;
  /** The resolution this field is good to, in words, for the panel/run sheet to quote. */
  resolutionNote: string;
}

/**
 * #785, #889 — THE GOAL PROGRAM'S STATED MEMORY BUDGET, in MB. A goal program is held whole at
 * every stage after the CAM: its moves (packed, 33 bytes each), its posted text, and then the
 * simulation that checks it — which reads the text back into its own per-line records and is by
 * far the largest cost. Measured on the 50 mm panther (Node, 2026-11-01): about 1 KB of heap per
 * posted line through the simulation, against 33 bytes for the packed move and some 16 for its
 * line of text. {@link GOAL_BYTES_PER_MOVE} is that whole cost, so the budget is the memory the
 * program will really take, and Chrome's worker heap (1120 MB on the maintainer's desktop) keeps
 * room for the page and the goal's own mesh.
 *
 * `engraveGenerate` samples the goal first (cheap, and the same grid the CAM will cut), estimates
 * the moves from what each roughing level really removes ({@link estimateGoalMoves}), settles on
 * the coarser base pitch when that fits, and otherwise REFUSES BY NAME with the numbers and the
 * fixes. A dead tab is never the outcome. A phone gets the smaller budget.
 */
export const GOAL_MEMORY_BUDGET_MB = { desktop: 640, phone: 256 } as const;

/** #889 — the heap one goal move costs from the CAM through the simulation, bytes (see above). */
export const GOAL_BYTES_PER_MOVE = 1100;

/**
 * #889 — the budget this device gets, MB: the phone figure where the browser says it is a phone
 * (`userAgentData.mobile`, else a mobile user agent), the desktop one everywhere else (Node too).
 */
export function goalMemoryBudgetMb(nav: { userAgent?: string; userAgentData?: { mobile?: boolean } } | null | undefined =
  (globalThis as { navigator?: { userAgent?: string; userAgentData?: { mobile?: boolean } } }).navigator): number {
  const mobile =
    nav?.userAgentData?.mobile === true || /Android|iPhone|iPad|iPod|Mobile/i.test(nav?.userAgent ?? '');
  return mobile ? GOAL_MEMORY_BUDGET_MB.phone : GOAL_MEMORY_BUDGET_MB.desktop;
}

/** #889 — a goal program's size before it is built: its passes' moves and what they cost. */
export interface GoalMoveEstimate {
  /** The roughing's moves, counted exactly (the levels, merged as the CAM merges them). */
  rough: number;
  /** The finish's moves: its raster at most (one per sample, before any merge), and its rim laps. */
  finish: number;
  /** Both. */
  moves: number;
  /** What they cost through the simulation, MB ({@link GOAL_BYTES_PER_MOVE}). */
  mb: number;
}

/**
 * #889 — ESTIMATE A GOAL PROGRAM FROM WHAT IT REALLY CUTS. The roughing is counted by running its
 * own planner without holding the moves: each level is cut only where it removes material, so a
 * deep goal costs its levels' real work, not every level across every cell. The finish is bounded
 * by its raster's samples. A rest pass is a separate, smaller program over the finish's own rows,
 * planned after; it is not part of this one.
 */
export function estimateGoalMoves(
  hf: GoalHeightfield,
  feeds: SurfaceFeeds,
  allowanceMm: number,
  alongStepMm?: number | null,
  /** #862's rim laps, when the run will cut them: the band floor and the finishing cutter. */
  rim?: { floorZ: number; tool: SurfaceTool } | null,
  /**
   * #909 — the ROUGH cutter's own tip. The clamp is taken over its whole disc, so the estimate
   * counts the moves the CAM will really write. Absent: the per-column clamp of a caller that
   * states no cutter.
   */
  roughTool?: SurfaceTool | null,
): GoalMoveEstimate {
  const alongStep = positive(alongStepMm) ? (alongStepMm as number) : hf.pitch;
  // A step-down the roughing cannot layer is the CAM's own named refusal; it is not counted here.
  const rough = hf.coveredCount === 0 || !(feeds.stepDown > 0)
    ? 0
    : roughingMoves(hf, feeds, allowanceMm, alongStep, SAFE_Z, HOP_Z, undefined, true, roughTool ?? null).count;
  let finish = 0;
  if (hf.coveredCount > 0) {
    for (const j of rasterRows(hf, feeds.finishStepOver)) {
      for (const [iS, iE] of coveredRuns(hf, j)) finish += alongColumns(hf, iS, iE, alongStep).length + 2;
    }
    finish += 1;
    if (rim != null) finish += rimMoves(hf, rim.tool, feeds, rim.floorZ, alongStep, SAFE_Z, HOP_Z, true).count;
  }
  const moves = rough + finish;
  return { rough, finish, moves, mb: (moves * GOAL_BYTES_PER_MOVE) / (1024 * 1024) };
}

export interface SampleGoalOpts {
  /** The shop's `sim.columnFlatPitchYMm`; absent → {@link DEFAULT_GRID_PITCH_MM}. */
  pitchMm?: number | null;
  /** The grid cap; absent → {@link DEFAULT_MAX_CELLS}. */
  maxCells?: number | null;
  /** Work Z of the stock top, mm; absent → 0 (the flat frame's own top). */
  stockTopZ?: number;
  /**
   * #764 — CLEAR AROUND THE GOAL. A goal made as the item is cut only where the mesh's own
   * footprint stands above the stock; the blank around it keeps its full height, so the part ends
   * in a pit whose walls reach its crown and is never free. With a clear band, the sampled grid is
   * extended past the footprint and every uncovered cell inside the band is cut down to the goal's
   * BASE plane (`baseZ`) — roughing and finishing then include it like any other part of the
   * surface. `ring` takes a band at least `widthMm` beyond the footprint, clipped to `stockRect`;
   * `whole` takes the stock's own rectangle. Absent = the footprint only, the pre-#764 cut.
   */
  clear?: { kind: 'ring'; widthMm: number } | { kind: 'whole' } | null;
  /** The stock's top-face rectangle in work XY, mm — what a clear band is clipped to. */
  stockRect?: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
  /** Work Z of the goal's base plane, mm — the floor a cleared band is cut to. */
  baseZ?: number | null;
  /**
   * #784 — the blank's top-face rectangle. The grid is intersected with it: a goal larger than
   * the stock is cut only where the stock exists ("clipped to the blank"), and a goal already
   * inside the blank samples exactly as before. Absent: no clip (every pre-#784 caller).
   */
  clip?: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
  /**
   * #785 — THE CUT'S FLOOR, in work Z (mm). Every covered cell's top-Z is raised to at least this
   * value, so the part is cut only down to it and the material below is left in the stock. Used by
   * the operator's top-band choice: the floor is the stock top less (the cutter's reach less the
   * clearance), so the holder never enters the work. The clear band (whose own `baseZ` may be
   * deeper) is clamped too — the band is a cut like any other. Absent: no floor (every other cut).
   */
  depthLimitZ?: number | null;
}

/**
 * Sample a goal mesh to a top-Z heightfield (stage 1).
 *
 * PLACEMENT (the {@link EngraveTargetObject} contract): the mesh's bbox CENTRE is placed at
 * `position.x / position.y` in work XY, its TOP (bbox max Z) at `position.z`, and it is turned
 * `rotation` degrees counter-clockwise about Z through that centre. So a goal left at the default
 * position sits top-flush with the stock, and the sampled top-Z is at or below the stock top.
 *
 * The rasteriser walks every triangle, projects it to XY, and at each grid cell its projection
 * covers writes the triangle's interpolated Z, keeping the MAXIMUM across triangles — the topmost
 * surface, which is the only one a 3-axis tool meets. Deterministic: fixed triangle and cell
 * order, no tolerance that depends on traversal.
 */
export function sampleGoalHeightfield(
  target: Pick<
    EngraveTargetObject,
    'sha256' | 'format' | 'data' | 'position' | 'rotation' | 'rotationX' | 'rotationY' | 'size' | 'relief' | 'scale'
  >,
  opts: SampleGoalOpts = {},
): GoalHeightfield {
  // #672 — a PICTURE is its own heightfield: the same grid, the same frame, the same downstream.
  if (target.format === 'png') return sampleImageHeightfield(target, opts);
  const mesh = targetObjectMesh(target);
  const topZ = opts.stockTopZ ?? 0;
  const requestedPitch = positive(opts.pitchMm) ? (opts.pitchMm as number) : DEFAULT_GRID_PITCH_MM;
  const maxCells = positive(opts.maxCells) ? (opts.maxCells as number) : DEFAULT_MAX_CELLS;

  // The placed mesh's XY footprint, from the LOCAL bbox's eight corners turned about its centre,
  // so the grid is sized for the object as it sits on the stock. #829 — the placement itself is
  // `targetPlace.ts`'s, shared with the rim extractor so the two cannot disagree about where the
  // mesh is.
  const { place } = placeTarget(target, mesh);

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  // #723 part 2 — all EIGHT corners: an X or Y turn mixes Z into the work footprint, so the four
  // XY corners of the unrotated box no longer bound it (the pre-#723 loop passed z = 0).
  for (const [bx, by, bz] of [
    [mesh.bbox.min[0], mesh.bbox.min[1], mesh.bbox.min[2]],
    [mesh.bbox.max[0], mesh.bbox.min[1], mesh.bbox.min[2]],
    [mesh.bbox.max[0], mesh.bbox.max[1], mesh.bbox.min[2]],
    [mesh.bbox.min[0], mesh.bbox.max[1], mesh.bbox.min[2]],
    [mesh.bbox.min[0], mesh.bbox.min[1], mesh.bbox.max[2]],
    [mesh.bbox.max[0], mesh.bbox.min[1], mesh.bbox.max[2]],
    [mesh.bbox.max[0], mesh.bbox.max[1], mesh.bbox.max[2]],
    [mesh.bbox.min[0], mesh.bbox.max[1], mesh.bbox.max[2]],
  ] as const) {
    const [wx, wy] = place(bx, by, bz);
    xMin = Math.min(xMin, wx);
    xMax = Math.max(xMax, wx);
    yMin = Math.min(yMin, wy);
    yMax = Math.max(yMax, wy);
  }
  // #764 — THE CLEAR BAND. A ring wants the grid to reach past the footprint by its width; the
  // whole-blank choice takes the stock's own rectangle; both are clipped to the stock.
  const clear = opts.clear ?? null;
  const stockRect = opts.stockRect ?? null;
  let gxMin = xMin;
  let gxMax = xMax;
  let gyMin = yMin;
  let gyMax = yMax;
  let clearBand: string | null = null;
  if (clear !== null && stockRect !== null) {
    if (clear.kind === 'whole') {
      gxMin = stockRect.xMin;
      gxMax = stockRect.xMax;
      gyMin = stockRect.yMin;
      gyMax = stockRect.yMax;
      clearBand = 'the whole blank';
    } else if (clear.widthMm > 0) {
      gxMin = Math.max(stockRect.xMin, xMin - clear.widthMm);
      gxMax = Math.min(stockRect.xMax, xMax + clear.widthMm);
      gyMin = Math.max(stockRect.yMin, yMin - clear.widthMm);
      gyMax = Math.min(stockRect.yMax, yMax + clear.widthMm);
      clearBand = `a ${Number(clear.widthMm.toFixed(3))} mm band around the part`;
    }
  }
  // #784 — CLIPPED TO THE BLANK. The goal is cut only where the stock exists: intersect the grid
  // with the blank's rectangle. A goal already inside the blank is unchanged; one that overhangs
  // is cut up to the edge, and the job's warning says which sides lost what. A goal with nothing
  // over the blank is refused before sampling; a degenerate grid here is still a valid empty field.
  const clip = opts.clip ?? null;
  if (clip !== null) {
    gxMin = Math.max(gxMin, clip.xMin);
    gxMax = Math.min(gxMax, clip.xMax);
    gyMin = Math.max(gyMin, clip.yMin);
    gyMax = Math.min(gyMax, clip.yMax);
    if (!(gxMax > gxMin) || !(gyMax > gyMin)) {
      const z = new Float32Array(1);
      z[0] = topZ;
      return {
        nx: 1,
        ny: 1,
        x0: clip.xMin,
        y0: clip.yMin,
        pitch: requestedPitch,
        topZ,
        minZ: topZ,
        z,
        covered: new Uint8Array(1),
        coveredCount: 0,
        resolutionNote: 'the goal lies outside the blank, so nothing was sampled',
      };
    }
  }
  const grid = planGrid(gxMin, gxMax, gyMin, gyMax, requestedPitch, maxCells);
  const { pitch, nx, ny, coarsened } = grid;
  const x0 = grid.x0;
  const y0 = grid.y0;
  const z = new Float32Array(nx * ny);
  z.fill(topZ);
  const covered = new Uint8Array(nx * ny);

  const idxCount = mesh.indices.length;
  for (let t = 0; t < idxCount; t += 3) {
    const ia = mesh.indices[t]! * 3;
    const ib = mesh.indices[t + 1]! * 3;
    const ic = mesh.indices[t + 2]! * 3;
    const a = place(mesh.positions[ia]!, mesh.positions[ia + 1]!, mesh.positions[ia + 2]!);
    const b = place(mesh.positions[ib]!, mesh.positions[ib + 1]!, mesh.positions[ib + 2]!);
    const c = place(mesh.positions[ic]!, mesh.positions[ic + 1]!, mesh.positions[ic + 2]!);
    rasterTriangle(a, b, c, x0, y0, pitch, nx, ny, z, covered);
  }

  // The band's cells become part of the surface at the goal's BASE plane — the CAM then roughs
  // and finishes them like any other cell, so the part stands on a plateau instead of in a pit.
  const baseZ = opts.baseZ ?? null;
  if (clear !== null && clearBand !== null && baseZ !== null) {
    if (clear.kind === 'whole') {
      for (let k = 0; k < z.length; k++) {
        if (covered[k] === 1) continue;
        z[k] = baseZ;
        covered[k] = 1;
      }
    } else {
      const dist = distanceToCovered(nx, ny, covered, pitch);
      const reach = clear.widthMm + pitch / 2 + 1e-9;
      for (let k = 0; k < z.length; k++) {
        if (covered[k] === 1 || (dist[k] as number) > reach) continue;
        z[k] = baseZ;
        covered[k] = 1;
      }
    }
  }

  // #785 — THE CUT'S FLOOR. Raise every covered cell to the floor, so a surface deeper than the
  // cutter's safe reach is cut as a flat bottom at the floor and the rest is left in the stock.
  // Applied AFTER the clear band: that band's base plane may be deeper than the floor, and it is a
  // cut like any other — the holder must stay out of it too.
  const depthLimitZ = opts.depthLimitZ ?? null;
  if (depthLimitZ !== null) {
    for (let k = 0; k < z.length; k++) {
      if (covered[k] === 1 && (z[k] as number) < depthLimitZ) z[k] = depthLimitZ;
    }
  }

  let minZ = topZ;
  let coveredCount = 0;
  for (let k = 0; k < z.length; k++) {
    if (covered[k] === 1) {
      coveredCount++;
      if ((z[k] as number) < minZ) minZ = z[k] as number;
    }
  }

  const resolutionNote =
    (coarsened
      ? `sampled on a ${pitch.toFixed(4)} mm grid (coarsened from the requested ${requestedPitch} mm: ` +
        `the footprint would need ${Math.ceil((gxMax - gxMin) / requestedPitch) * Math.ceil((gyMax - gyMin) / requestedPitch)} cells, ` +
        `over the ${maxCells}-cell cap)`
      : `sampled on a ${pitch} mm grid`) +
    (clearBand === null || baseZ === null ? '' : `; cleared ${clearBand} to the part's base plane`);

  return { nx, ny, x0, y0, pitch, topZ, minZ, z, covered, coveredCount, resolutionNote };
}

/**
 * #764 — each cell's distance to the nearest COVERED cell, mm. The same exact separable transform
 * as {@link distanceField}, seeded the other way round (covered cells are the sources), so a ring
 * cell's distance is to the goal's foot, not to the blank's edge.
 */
function distanceToCovered(nx: number, ny: number, covered: Uint8Array, pitch: number): Float32Array {
  const INF = 1e12;
  const n = Math.max(nx, ny);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const zs = new Float64Array(n + 1);
  const grid = new Float64Array(nx * ny);
  for (let k = 0; k < grid.length; k++) grid[k] = covered[k] === 1 ? 0 : INF;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = grid[j * nx + i]!;
    edt1d(f, d, nx, v, zs);
    for (let i = 0; i < nx; i++) grid[j * nx + i] = d[i]!;
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = grid[j * nx + i]!;
    edt1d(f, d, ny, v, zs);
    for (let j = 0; j < ny; j++) grid[j * nx + i] = d[j]!;
  }
  const out = new Float32Array(nx * ny);
  for (let k = 0; k < out.length; k++) out[k] = Math.sqrt(grid[k]!) * pitch;
  return out;
}

/**
 * The grid a goal footprint is sampled on: its origin, pitch and cell counts. The cap is honoured
 * by COARSENING (design doc §2) — never a refusal: the pitch scales up by the square root of the
 * overshoot so the cell count lands at the cap.
 */
function planGrid(
  xMin: number,
  xMax: number,
  yMin: number,
  yMax: number,
  requestedPitch: number,
  maxCells: number,
): { x0: number; y0: number; pitch: number; nx: number; ny: number; coarsened: boolean } {
  const extentX = xMax - xMin;
  const extentY = yMax - yMin;
  let pitch = requestedPitch;
  let nx = Math.max(1, Math.ceil(extentX / pitch) + 1);
  let ny = Math.max(1, Math.ceil(extentY / pitch) + 1);
  let coarsened = false;
  if (nx * ny > maxCells) {
    const scale = Math.sqrt((nx * ny) / maxCells);
    pitch = requestedPitch * scale;
    nx = Math.max(1, Math.ceil(extentX / pitch) + 1);
    ny = Math.max(1, Math.ceil(extentY / pitch) + 1);
    coarsened = true;
  }
  return { x0: xMin, y0: yMin, pitch, nx, ny, coarsened };
}

/**
 * #672 — A PICTURE AS A GOAL: its luminance is the top-Z field, sampled on the same grid the
 * mesh path uses and placed by the same contract — the image's rectangle centred at `position`,
 * turned `rotation` about that centre, its brightest toned face at the image's `position.z`.
 *
 * The pixel's grey is sampled BILINEARLY at the cell centre (pixel centres at half-integers), so a
 * linear ramp stays linear between pixels rather than stair-stepping. The image's TOP ROW faces
 * +Y (the far side of the blank), the way a picture lies on the bed. The resolution sentence names
 * the grid pitch, the picture's size in millimetres and its pitch in mm per pixel — the honest
 * bound on the detail, before the cutter's own.
 */
function sampleImageHeightfield(
  target: Pick<EngraveTargetObject, 'sha256' | 'format' | 'data' | 'position' | 'rotation' | 'size' | 'relief'>,
  opts: SampleGoalOpts,
): GoalHeightfield {
  const topZ = opts.stockTopZ ?? 0;
  const requestedPitch = positive(opts.pitchMm) ? (opts.pitchMm as number) : DEFAULT_GRID_PITCH_MM;
  const maxCells = positive(opts.maxCells) ? (opts.maxCells as number) : DEFAULT_MAX_CELLS;
  // #720 — the bytes live beside the document; without them there is no picture to sample. The
  // job's `target-mesh-missing` finding refuses the Generate before this runs.
  if (target.data === undefined) throw new Error('the image relief has no bytes loaded — import the picture again');
  const decoded = decodePng(new Uint8Array(base64ToArrayBuffer(target.data)));
  if (!decoded.ok) {
    throw new Error(`the image relief could not be read: ${decoded.error}`);
  }
  const { width, height, grey } = decoded.image;
  const numbers = reliefNumbers(target.relief);
  const halfX = target.size.x / 2;
  const halfY = target.size.y / 2;
  if (!(halfX > 0 && halfY > 0)) {
    throw new Error('the image relief has no placed size — set its width before generating');
  }
  const theta = (target.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  // The rotated rectangle's world bbox.
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const [lx, ly] of [
    [-halfX, -halfY],
    [halfX, -halfY],
    [halfX, halfY],
    [-halfX, halfY],
  ] as const) {
    const wx = target.position.x + (lx * cos - ly * sin);
    const wy = target.position.y + (lx * sin + ly * cos);
    xMin = Math.min(xMin, wx);
    xMax = Math.max(xMax, wx);
    yMin = Math.min(yMin, wy);
    yMax = Math.max(yMax, wy);
  }
  const grid = planGrid(xMin, xMax, yMin, yMax, requestedPitch, maxCells);
  const x0 = grid.x0;
  const y0 = grid.y0;
  const z = new Float32Array(grid.nx * grid.ny);
  z.fill(topZ);
  const covered = new Uint8Array(grid.nx * grid.ny);
  for (let j = 0; j < grid.ny; j++) {
    const wy = y0 + j * grid.pitch;
    for (let i = 0; i < grid.nx; i++) {
      const wx = x0 + i * grid.pitch;
      // Into the image's own frame (the inverse of the placement's rotation)…
      const dx = wx - target.position.x;
      const dy = wy - target.position.y;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      if (Math.abs(lx) > halfX || Math.abs(ly) > halfY) continue;
      // …then to continuous pixel coordinates: pixel centres are at half-integers, and the
      // image's top row faces +Y.
      const u = ((lx + halfX) / target.size.x) * width;
      const v = ((halfY - ly) / target.size.y) * height;
      const g = bilinearGrey(grey, width, height, u, v);
      const idx = j * grid.nx + i;
      z[idx] = topZ - reliefDepthMm(g, numbers.maxDepthMm, numbers.invert);
      covered[idx] = 1;
    }
  }
  const summary = summarise(z, covered, topZ);
  const pixelPitch = Math.max(target.size.x / width, target.size.y / height);
  const resolutionNote =
    (grid.coarsened
      ? `sampled on a ${grid.pitch.toFixed(4)} mm grid (coarsened from the requested ${requestedPitch} mm: the footprint would need ${Math.ceil((xMax - xMin) / requestedPitch) * Math.ceil((yMax - yMin) / requestedPitch)} cells, over the ${maxCells}-cell cap)`
      : `sampled on a ${grid.pitch} mm grid`) +
    ` from a ${width} × ${height} px image over ${round3(target.size.x)} × ${round3(target.size.y)} mm — ` +
    `${Number(pixelPitch.toFixed(4))} mm per pixel` +
    (numbers.invert ? `; black is the top face` : '') +
    `; ${Number(numbers.maxDepthMm.toFixed(3))} mm deep (${numbers.depthSource})`;
  return {
    nx: grid.nx,
    ny: grid.ny,
    x0,
    y0,
    pitch: grid.pitch,
    topZ,
    minZ: summary.minZ,
    z,
    covered,
    coveredCount: summary.coveredCount,
    resolutionNote,
  };
}

/** The luminance at continuous pixel coordinates (u, v), bilinear between pixel centres. */
function bilinearGrey(grey: Uint8Array, width: number, height: number, u: number, v: number): number {
  const x = Math.min(width - 1, Math.max(0, u - 0.5));
  const y = Math.min(height - 1, Math.max(0, v - 0.5));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const at = (ii: number, jj: number): number => grey[jj * width + ii] as number;
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

/** `12.5` — a millimetre figure as a sentence prints it. */
function round3(v: number): string {
  return String(Number(v.toFixed(3)));
}

/** The covered-cell count and the lowest top-Z over the grid. */
function summarise(z: Float32Array, covered: Uint8Array, topZ: number): { coveredCount: number; minZ: number } {
  let minZ = topZ;
  let coveredCount = 0;
  for (let k = 0; k < z.length; k++) {
    if (covered[k] === 1) {
      coveredCount++;
      if ((z[k] as number) < minZ) minZ = z[k] as number;
    }
  }
  return { coveredCount, minZ };
}

/** Rasterise one placed triangle into the grid, keeping the max Z per covered cell. */
function rasterTriangle(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  x0: number,
  y0: number,
  pitch: number,
  nx: number,
  ny: number,
  z: Float32Array,
  covered: Uint8Array,
): void {
  const minX = Math.min(a[0], b[0], c[0]);
  const maxX = Math.max(a[0], b[0], c[0]);
  const minY = Math.min(a[1], b[1], c[1]);
  const maxY = Math.max(a[1], b[1], c[1]);
  const iLo = Math.max(0, Math.floor((minX - x0) / pitch));
  const iHi = Math.min(nx - 1, Math.ceil((maxX - x0) / pitch));
  const jLo = Math.max(0, Math.floor((minY - y0) / pitch));
  const jHi = Math.min(ny - 1, Math.ceil((maxY - y0) / pitch));
  // Barycentric denominator; a degenerate (zero-area in XY) triangle contributes nothing — its
  // edge is covered by the triangles that share it.
  const denom = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (denom === 0) return;
  const eps = 1e-9;
  for (let j = jLo; j <= jHi; j++) {
    const py = y0 + j * pitch;
    for (let i = iLo; i <= iHi; i++) {
      const px = x0 + i * pitch;
      const wa = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / denom;
      const wb = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / denom;
      const wc = 1 - wa - wb;
      if (wa < -eps || wb < -eps || wc < -eps) continue;
      const zz = wa * a[2] + wb * b[2] + wc * c[2];
      const idx = j * nx + i;
      if (covered[idx] === 0 || zz > (z[idx] as number)) {
        z[idx] = zz;
        covered[idx] = 1;
      }
    }
  }
}

/** The surfacing cutter's geometry, as the passes need it. */
export interface SurfaceTool {
  /** Cutting radius at the tip, mm. */
  radius: number;
  /**
   * A hemispherical tip of {@link radius} (a ball nose). The finishing drop is gouge-safe for it;
   * a flat tool (`false`) drops onto the highest point under its disc, which cannot enter a
   * concavity — a flat finish of a 3D surface is a fallback the notes flag.
   */
  ball: boolean;
}

/**
 * #909 — the tool's swept tip shape, as the tip fields and the roughing clamp read it. The tip
 * fields have taken the whole disc into account since #540; the roughing clamp now does too.
 */
export function surfaceToolFor(tool: Tool): SurfaceTool {
  const d = cuttingDiameter(tool);
  const radius = d !== null && d > 0 ? d / 2 : 0;
  return { radius, ball: tool.shape === 'ball' || tool.shape === 'bull' };
}

/**
 * #945 a1 — THE STEP-OVER A BALL-NOSE FINISH NEEDS TO HOLD ITS ROW-TO-ROW CUSP AT OR UNDER A
 * STATED BAND, mm. NOT a tuned constant: a closed-form consequence of the ball's own radius and
 * the band, so a different cutter or a different band re-derives a different number.
 *
 * Between two adjacent raster rows spaced `s` apart over a FLAT span, the ball's spherical flank
 * leaves a cusp standing between them — the sagitta of a chord `s` long on the ball's own circle
 * of radius `r`:
 *
 *   cusp(s) = r − √(r² − (s/2)²)                              (the same sagitta `residueSliver`
 *                                                                in restSettings.ts runs the
 *                                                                other way: a step-over to a sliver)
 *
 * Holding `cusp(s) ≤ band` and solving for the largest such `s`:
 *
 *   √(r² − (s/2)²) ≥ r − band
 *   (s/2)² ≤ r² − (r − band)² = 2·r·band − band²
 *   s ≤ 2·√(2·r·band − band²)
 *
 * {@link rasterRows} spaces rows by `Math.round(stepOver / pitch)` cells, so passing the
 * CONTINUOUS bound through unrounded can round UP past it (a 0.872 mm bound at a 0.1 mm pitch
 * rounds to a 9-cell, 0.9 mm stride — 0.107 mm of cusp, over a 0.1 mm band). This floors the
 * stride instead, so the stepover handed back reproduces the exact stride this function already
 * verified: `Math.round(stride·pitch / pitch) === stride` for any `pitch > 0`.
 *
 * Returns null when the bound cannot be formed from this tool/band (no radius, no positive band,
 * or a band at or past the radius — the chord never closes before the cusp reaches the whole
 * radius). The caller then keeps whatever step-over it already had: a leftover this wide is a
 * ball-radius question (a2 — a smaller cutter or a rest pass), not a row-spacing one, and no
 * step-over closes it. A band that clears a FLAT span this way still leaves more cusp on a slope
 * (the cusp grows roughly with the slope's secant cubed) — the remainder there is #671's scallop
 * pass's question, not this one's.
 */
export function finishStepOverForCusp(radiusMm: number, bandMm: number, pitchMm: number): number | null {
  if (!(radiusMm > 0) || !(bandMm > 0) || !(pitchMm > 0) || bandMm >= radiusMm) return null;
  const idealMm = 2 * Math.sqrt(2 * radiusMm * bandMm - bandMm * bandMm);
  // The `+ 1e-9` keeps a ratio that is EXACTLY a whole stride (0.6 / 0.1) from floor()ing down one
  // notch on float noise (0.6 / 0.1 can land at 5.999999999999999): a false floor here is strictly
  // more conservative than the bound asks for, never less, but it is not the bound this function
  // promises, and an operator comparing two radii would see an unexplained one-cell jump.
  const stride = Math.max(1, Math.floor(idealMm / pitchMm + 1e-9));
  // Rounded: `stride * pitchMm` can itself land a float off (2 mm radius, 0.1 mm band/pitch gives
  // 1.2000000000000002), and this value is printed on the run sheet (`GoalSurfaceFacts`), not only
  // compared — an operator should not see that noise. The stride itself is untouched by this.
  return Number((stride * pitchMm).toFixed(9));
}

/**
 * The feeds a surfacing program runs at — the job's ordinary 2.5D feeds, HANDED IN unchanged.
 * NONE of these is tuned for 3D engagement (slice F, #536); the module labels them and never
 * invents one.
 */
export interface SurfaceFeeds {
  /** XY cutting feed, mm/min. */
  feed: number;
  /** Z plunge feed, mm/min. */
  plungeFeed: number;
  /** Roughing step-down per Z layer, mm. */
  stepDown: number;
  /** Roughing raster pitch between scan lines, mm. */
  roughStepOver: number;
  /** Finishing raster pitch between scan lines, mm. */
  finishStepOver: number;
}

/**
 * #846 — HOW THE ROUGH IS CLEARED. Absent → the raster exactly as before (a
 * legacy plan stays byte-identical). 'auto' measures both roughs when the goal
 * is small enough to afford it and decides on simulated time and engagement;
 * above the cell budget it decides by the stated rule and says the comparison
 * was skipped. The two numbers are the shop's (`rough3d.adaptiveDepthRatio`,
 * `rough3d.compareCellBudget`).
 */
export interface RoughingOptions {
  mode?: 'auto' | 'raster' | 'adaptive';
  /** The job's stock material, for the metal half of the rule. */
  material?: StockMaterial | null;
  /** Depth (× the cutter's ⌀) from which a goal counts as deep; absent → 1.5. */
  depthRatio?: number;
  /** Covered cells above which both roughs are not both planned; absent → 1,000,000. */
  cellBudget?: number;
  /**
   * #846 — THE PLANNING BUDGET, in cell-levels (covered cells × roughing layers): the adaptive
   * rough is planned one level at a time at roughly 100 µs per cell-level, so a real goal costs
   * minutes. Above this the raster runs instead and the line says why. Absent → 500,000.
   */
  planBudget?: number;
  /** The adaptive planner's shop settings; absent → the shop fallbacks. */
  adaptive?: AdaptiveSettings;
  /** The rapid model, for the time comparison. */
  rapid?: RapidEstimate;
  /**
   * #881 — where the adaptive rough's levels are planned (a pool); absent → in this thread. Only
   * the adaptive rough uses it: the raster and the finishing passes have no independent levels.
   */
  planner?: LevelPlanner;
  /**
   * #881 — the budget the pool may size itself against: the page's stated memory (#889) and the
   * program's own estimate. Absent → the pool's core rule alone.
   */
  memory?: LevelPlanMemory;
}

export interface SurfaceOpts {
  /** Roughing allowance left on the goal surface, mm; absent → {@link DEFAULT_STOCK_TO_LEAVE_MM}. */
  stockToLeaveMm?: number;
  /** #846 — raster or adaptive clearing of each roughing level (see {@link RoughingOptions}). */
  roughing?: RoughingOptions;
  /** Sampling pitch ALONG a raster line, mm; absent → the heightfield pitch (tightest sim match). */
  alongStepMm?: number;
  /** Inter-pass retract above the stock top, mm; absent → {@link SAFE_Z}. */
  safeZ?: number;
  /** Intra-pass hop above the stock top, mm; absent → {@link HOP_Z}. */
  hopZ?: number;
  /** Finishing tip-field op budget; absent → {@link DEFAULT_MAX_FINISH_TIP_OPS} (#540). */
  maxFinishTipOps?: number;
  /**
   * #671 — add the SCALLOP pass after the parallel finish: offset contours of the goal's
   * footprint, spaced so the step measured ALONG THE SURFACE is the finishing step-over. Absent
   * or false leaves today's program byte for byte.
   */
  scallop?: boolean;
  /** #671 — add the PENCIL pass after the scallop: one path along every concave crease. */
  pencil?: boolean;
  /** #671 — the crease angle the pencil pass follows, degrees; absent → {@link DEFAULT_PENCIL_CREASE_DEG}. */
  pencilCreaseDeg?: number;
  /** #671 — the scallop contour cap; absent → {@link DEFAULT_MAX_SCALLOP_CONTOURS}. */
  maxScallopContours?: number;
  /**
   * #785 — PROGRESS OUT OF THE LONG LOOPS, so Generate can say "roughing level 41 of 112" instead
   * of "working". Called once per roughing Z layer and once per finishing scan line, at the start
   * of the work that line will do; the CAM's output is byte-for-byte unchanged.
   */
  onProgress?: (p: { pass: 'rough' | 'finish'; done: number; total: number }) => void;
  /**
   * #862 — FINISH THE CLEAR-BAND WALL. A goal sampled with a clear ring (#764) is cut out of the
   * stock as a plateau, and its outer edge is a vertical wall between the band floor and the stock
   * top. The roughing's raster only reaches that wall with its row ends — the wall keeps the
   * raster's step-over as vertical ridges and its top edge as ball bites. Given the band's floor,
   * the finishing operation also runs contour laps along the covered boundary from the stock top
   * down to it, so the pocket's outer wall is a contour cut like any other finished face. Absent →
   * no rim pass (every pre-#862 plan, byte for byte).
   */
  rim?: { floorZ: number } | null;
}

export interface Surface3dArgs {
  heightfield: GoalHeightfield;
  tool: SurfaceTool;
  /** The cutter as the IR/post describe it. */
  toolObj: Tool;
  toolNumber: number;
  spindleRpm: number;
  air: boolean;
  feeds: SurfaceFeeds;
  rapid: RapidEstimate;
  /** The goal object's id, so the operations name the label they cut. */
  labelId: string;
  /**
   * #869 — THE FLAT THAT ROUGHS BEFORE THE FINISHING CUTTER. Real 3D practice: a flat end mill
   * takes the bulk (a deeper step-down and a wider step-over than the ball, and the adaptive
   * clearing engine, which sweeps flat end mills only), and the ball finishes the surface. The
   * rough's operation is named with ITS tool number and cut with ITS feeds, and the caller posts
   * it as a program of its own; the finishing passes (`tool`, `feeds` and the rim) are untouched.
   * Absent: one cutter for both passes, exactly as before.
   */
  rough?: {
    /** The roughing cutter's swept shape — a flat's disc. */
    tool: SurfaceTool;
    /** The cutter as the IR and the post describe it. */
    toolObj: Tool;
    toolNumber: number;
    /** The rough's own feeds (its step-down and step-over, not the finishing proxy's). */
    feeds: SurfaceFeeds;
  };
  opts?: SurfaceOpts;
}

export interface Surface3dResult {
  ir: ToolpathIR;
  /** The roughing operation (0 moves when nothing stands above the goal + allowance). */
  roughing: CamOperation;
  /** The ball-nose finishing operation. */
  finishing: CamOperation;
  /**
   * #535 — how many Z layers the roughing pass stepped through (the final layer included). The
   * operator-facing "levels" number, reported rather than re-derived by a caller.
   */
  roughingLayers: number;
  /** #671 — the scallop pass and its own numbers, or null when it did not run. */
  scallop: { operation: CamOperation; facts: ScallopPassFacts } | null;
  /** #671 — the pencil pass and its own numbers, or null when it did not run. */
  pencil: { operation: CamOperation; facts: PencilPassFacts } | null;
  /**
   * #862 — the rim pass that finished the clear band's wall, or null when it did not run. Its
   * moves are part of the FINISHING operation, at its head: the wall is cut before the finish
   * rides the floor beside it.
   */
  rim: { laps: number; floorZ: number } | null;
  /**
   * #847 — the finish's gouge-safe tip field, the surface its program cuts. Returned so the goal
   * path measures the residual from the SAME field rather than a second model of the cut. It is a
   * tall array (one Float32 per grid cell): never store it on a program, a fact or a result that
   * is serialized — the caller's own measurement is what leaves this call. When the #862 rim laps
   * run, this is the LOWER of the raster's field and the laps' swept underside, because the laps
   * cut the clear band's wall the raster cannot: the field is the whole finish's surface.
   */
  finishTip: Float32Array;
  /**
   * #869 — which roughing pass the roughing operation holds: the adaptive clearing of each level,
   * or the legacy raster. `chooseRough`'s note says why; this is the fact a reader switches on.
   */
  roughKind: 'raster' | 'adaptive';
  /** Labelled placeholders and limitations for the run sheet (feeds, undercuts, flat finish). */
  notes: string[];
}

/** #671 — what the SCALLOP pass did, as the row and the run sheet quote it. */
export interface ScallopPassFacts {
  /** Contour loops the pass followed, outermost first. */
  contours: number;
  /** The step-over the pass held, measured along the surface, mm. */
  stepOverMm: number;
  /** True when the steep-slope clamp ({@link MAX_SCALLOP_CROWDING}) bound — the note says so. */
  clamped: boolean;
}

/** #671 — what the PENCIL pass did. */
export interface PencilPassFacts {
  /** Crease paths the pass followed. */
  paths: number;
  /** The crease angle it marked, degrees. */
  creaseDeg: number;
}

/**
 * #535 — a goal program's surfacing facts, as the operation row and the run sheet quote them.
 * Every number is one the CAM ran with, never a second resolution of the same question.
 */
export interface GoalSurfaceFacts {
  /** The heightfield's own resolution sentence ("sampled on a 0.1 mm grid"). */
  resolutionNote: string;
  /** The pitch the heightfield was sampled at, mm — after any coarsening. */
  gridPitchMm: number;
  /** The cells the heightfield held, `nx × ny`. */
  gridCells: number;
  /** Roughing step-down per Z layer, mm. */
  stepDownMm: number;
  /**
   * #869 — the FINISHING cutter's step-down, mm — the spacing of the rim laps (#862), which ride
   * the finish. Absent on a result stored before the field; a reader falls back to `stepDownMm`.
   */
  finishStepDownMm?: number;
  /** Roughing raster pitch, mm. */
  roughStepOverMm: number;
  /** Finishing raster pitch, mm. */
  finishStepOverMm: number;
  /** Roughing allowance left on the goal surface, mm. */
  stockToLeaveMm: number;
  /**
   * #898 — the UNDERSIDE choice this program cut to: its kind and the work-Z floor it set (`null`
   * when the choice carries no floor of its own). Absent when the goal states no underside, or on
   * a result stored before the field.
   */
  underside?: { kind: 'flat' | 'flipped-tabs' | 'plinth'; floorZ: number | null } | null;
  /** Z layers the roughing pass stepped through. */
  roughingLayers: number;
  /**
   * #869 — THE FLAT ROUGH, when the goal is cut as two programs: the cutter's name, as the run
   * sheet names it, and which roughing pass ran. Null when a flat was chosen but nothing stood
   * above the allowance to remove; ABSENT on a one-cutter goal and on every result stored before
   * the field, which is why a reader asks `!= null`.
   */
  rough?: { tool: string; kind: 'raster' | 'adaptive' } | null;
  /**
   * #671 — the scallop pass's numbers, or null when it did not run. ABSENT on a result stored by
   * a build before #671, which is why a reader asks `!= null` rather than `!== null`.
   */
  scallop?: { contours: number; stepOverMm: number; clamped: boolean } | null;
  /** #671 — the pencil pass's numbers, or null when it did not run; absent before #671. */
  pencil?: { paths: number; creaseDeg: number } | null;
  /**
   * #862 — the rim pass's numbers, or null when it did not run; absent before #862. The laps are
   * the finishing operation's opening moves, down the clear band's wall.
   */
  rim?: { laps: number; floorZ: number } | null;
  /**
   * #847 — the REST PASS the finish was followed by, or null when the finish reached the goal (or
   * nothing owned would lower it; the run's `goal-rest-uncut` warning states that case). ABSENT on
   * a result stored by a build before #847.
   */
  rest?: GoalRestFacts | null;
  /** The engine's notes for the run sheet: the feeds, undercuts and a flat finishing cutter. */
  notes: string[];
}

/**
 * #846 — the roughing numbers' LABELLED FALLBACKS (the shop's `rough3d.*`
 * defaults are the real source; these are what a caller with no location gets).
 * `DEFAULT_ADAPTIVE_DEPTH_RATIO`: the goal is "deep" at 1.5× the cutter's ⌀.
 * `DEFAULT_COMPARE_CELL_BUDGET`: below a million covered cells both roughs are
 * planned and compared on simulated time; above it the rule decides and the
 * line says the comparison was skipped.
 * `DEFAULT_PLAN_BUDGET_CELL_LEVELS`: the adaptive rough is planned ONE LEVEL AT A
 * TIME at roughly 100 µs per cell-level, so a real goal costs minutes; above half
 * a million cell-levels (covered cells × roughing layers) the raster runs instead
 * and the line says why.
 */
export const DEFAULT_ADAPTIVE_DEPTH_RATIO = 1.5;
export const DEFAULT_COMPARE_CELL_BUDGET = 1_000_000;
export const DEFAULT_PLAN_BUDGET_CELL_LEVELS = 500_000;

interface RoughChoice {
  kind: 'raster' | 'adaptive';
  moves: CamMove[];
  layers: number;
  /** The one line the run sheet carries: what was chosen and why. Null for a legacy raster. */
  note: string | null;
}

const r3n = (n: number): string => String(Math.round(n * 100) / 100);

/**
 * #846 — CLEAR EACH ROUGHING LEVEL, and say how. The raster is always planned
 * (it is the fallback and, when measured, half of the comparison); the adaptive
 * rough is planned when the mode forces it, when the cell budget allows the
 * comparison, or when the rule says a raster would be the wrong answer.
 */
async function chooseRough(
  hf: GoalHeightfield,
  feeds: SurfaceFeeds,
  allowance: number,
  alongStep: number,
  safeZ: number,
  hopZ: number,
  tool: Tool,
  rapid: RapidEstimate,
  opts: RoughingOptions | undefined,
  onLayer: (done: number, total: number) => void,
): Promise<RoughChoice> {
  // #909 — the raster is clamped over the rough cutter's own disc (a flat's disc; a ball's drop),
  // never its centre column: see `roughClampField`.
  const raster = roughingMoves(hf, feeds, allowance, alongStep, safeZ, hopZ, onLayer, false, surfaceToolFor(tool));
  const mode = opts?.mode ?? 'raster';
  if (mode === 'raster') return { kind: 'raster', moves: raster.moves, layers: raster.layers, note: null };
  const flat = cuttingRadiusForSweep(tool);
  const diameter = flat.ok ? 2 * flat.radius : (cuttingDiameter(tool) ?? 0);
  const depth = Math.max(0, hf.topZ - hf.minZ);
  const ratio = diameter > 0 ? depth / diameter : 0;
  const metal = opts?.material != null && isMetalMaterial(opts.material);
  const ruleLine = `the goal is ${r3n(ratio)}× the cutter’s ⌀ deep${metal ? ` in ${opts!.material}` : ''}`;
  const settings = opts?.adaptive ?? adaptiveSettings(null).settings;
  // #881 — the levels go to the planner when there is one; the plans and the assembly are the
  // same either way, so the choice, its notes and the moves do not depend on where they ran.
  const runAdaptive = () =>
    roughingAdaptiveMoves(hf, feeds, allowance, {
      tool,
      adaptive: settings,
      safeZ,
      hopZ,
      onLayer,
      ...(opts?.planner !== undefined ? { planner: opts.planner } : {}),
      ...(opts?.memory !== undefined ? { memory: opts.memory } : {}),
    });
  // #868 — levels whose region repeated were not walked again; say so when it happened.
  const reuseWords = (reused: number): string =>
    reused > 0 ? `, ${reused} level${reused === 1 ? '' : 's'} reusing the level above’s identical region` : '';
  const mins = (seconds: number): string => `${(seconds / 60).toFixed(1)} min`;
  const refusal = (reason: string): RoughChoice => ({
    kind: 'raster',
    moves: raster.moves,
    layers: raster.layers,
    note: `Adaptive roughing was not possible — ${reason}; the raster runs instead.`,
  });

  if (mode === 'adaptive') {
    const a = await runAdaptive();
    if (!a.ok) return refusal(a.reason);
    return {
      kind: 'adaptive',
      moves: a.result.moves,
      layers: a.result.layers,
      note: `Adaptive roughing: max engagement ${r3n(a.result.maxEngagementMm)} mm under the ${r3n(a.result.capMm)} mm cap${reuseWords(a.result.reusedLevels)} (${ruleLine}).`,
    };
  }

  // 'auto' — THE PLANNING BUDGET FIRST. The adaptive plan costs one planAdaptive per roughing
  // level (~100 µs per cell-level, measured), so a real goal would spend minutes here. Above the
  // budget the goal keeps the raster, and this line is the reason the sheet quotes.
  const planWork = hf.coveredCount * Math.max(1, raster.layers);
  const planBudget = opts?.planBudget ?? DEFAULT_PLAN_BUDGET_CELL_LEVELS;
  if (planWork > planBudget) {
    return {
      kind: 'raster',
      moves: raster.moves,
      layers: raster.layers,
      note:
        `Raster roughing chosen: the adaptive rough is planned one level at a time, and this goal would need ` +
        `${planWork.toLocaleString('en')} cell-levels (${hf.coveredCount.toLocaleString('en')} covered cells × ` +
        `${raster.layers} layer${raster.layers === 1 ? '' : 's'}) — above the shop’s rough3d.planBudgetCellLevels ` +
        `of ${planBudget.toLocaleString('en')}; the raster runs instead.`,
    };
  }

  // 'auto' — measure both when the goal is small enough, otherwise decide by rule.
  const budget = opts?.cellBudget ?? DEFAULT_COMPARE_CELL_BUDGET;
  const depthRatio = opts?.depthRatio ?? DEFAULT_ADAPTIVE_DEPTH_RATIO;
  const deep = ratio >= depthRatio;
  if (hf.coveredCount <= budget) {
    const a = await runAdaptive();
    if (!a.ok) return refusal(a.reason);
    const tRaster = estimateCycleSeconds(raster.moves, rapid);
    const tAdaptive = estimateCycleSeconds(a.result.moves, rapid);
    // The rule (deep or metal) prefers the capped engagement; on a shallow
    // woody goal the measured time decides.
    const byRule = deep || metal;
    const adaptive = byRule || tAdaptive < tRaster;
    return {
      kind: adaptive ? 'adaptive' : 'raster',
      moves: adaptive ? a.result.moves : raster.moves,
      layers: adaptive ? a.result.layers : raster.layers,
      note:
        `${adaptive ? 'Adaptive' : 'Raster'} roughing chosen: ${mins(adaptive ? tAdaptive : tRaster)} vs the ` +
        `${adaptive ? 'raster’s' : 'adaptive'} ${mins(adaptive ? tRaster : tAdaptive)}` +
        `${adaptive ? `, max engagement ${r3n(a.result.maxEngagementMm)} mm under the ${r3n(a.result.capMm)} mm cap${reuseWords(a.result.reusedLevels)}` : ''} ` +
        `(${ruleLine}; ${byRule ? 'the depth and material rule prefers the capped engagement' : 'the shorter simulated time wins'}; both were measured at ${hf.coveredCount.toLocaleString('en')} covered cells).`,
    };
  }
  if (deep || metal) {
    const a = await runAdaptive();
    if (!a.ok) return refusal(a.reason);
    return {
      kind: 'adaptive',
      moves: a.result.moves,
      layers: a.result.layers,
      note:
        `Adaptive roughing chosen by rule: ${ruleLine} (rough3d.adaptiveDepthRatio ${depthRatio}×), max engagement ` +
        `${r3n(a.result.maxEngagementMm)} mm under the ${r3n(a.result.capMm)} mm cap${reuseWords(a.result.reusedLevels)}; the comparison was skipped above ` +
        `${budget.toLocaleString('en')} cells (rough3d.compareCellBudget).`,
    };
  }
  return {
    kind: 'raster',
    moves: raster.moves,
    layers: raster.layers,
    note:
      `Raster roughing chosen by rule: ${ruleLine} (rough3d.adaptiveDepthRatio ${depthRatio}×); the comparison was ` +
      `skipped above ${budget.toLocaleString('en')} cells (rough3d.compareCellBudget).`,
  };
}

/**
 * #847 — WHAT A REST PASS DID, as the operation row and the run sheet quote it: the smaller ball,
 * the material the finish left, and what that ball still leaves measured from its own tip field.
 */
export interface GoalRestFacts {
  /** The smaller ball the rest pass runs, as the tool library files it. */
  toolKey: string;
  /** Its display name. */
  toolName: string;
  /** What the finish left above the goal, mm³. */
  finishResidualMm3: number;
  /** What the rest ball still leaves, mm³. */
  residualMm3: number;
  /** The deepest rise above the goal the finish left, mm. */
  deepestMm: number;
  /** The rest program's moves and the CAM's cutting-time estimate, seconds. */
  moves: number;
  seconds: number;
}

/**
 * Generate the roughing + finishing surfacing IR for a goal heightfield (stage 2).
 *
 * The two operations share one machine state, so they post as one program. Roughing is operation
 * 1, finishing operation 2 — rough the bulk, then finish the surface.
 */
export async function generateSurface3dIR(args: Surface3dArgs): Promise<Surface3dResult> {
  const { heightfield: hf, tool, feeds, opts = {} } = args;
  const allowance = opts.stockToLeaveMm ?? DEFAULT_STOCK_TO_LEAVE_MM;
  const alongStep = positive(opts.alongStepMm) ? (opts.alongStepMm as number) : hf.pitch;
  const safeZ = opts.safeZ ?? SAFE_Z;
  const hopZ = opts.hopZ ?? HOP_Z;
  const maxFinishTipOps = positive(opts.maxFinishTipOps)
    ? (opts.maxFinishTipOps as number)
    : DEFAULT_MAX_FINISH_TIP_OPS;

  // #869 — THE ROUGH MAY BE ANOTHER CUTTER. Its feeds are its own row's (a flat's step-down and
  // step-over, not the ball's flat proxy), and its operation is named with its own tool number;
  // the finishing passes below keep `feeds` and `tool` unchanged.
  const roughArgs = args.rough ?? null;
  const roughFeeds = roughArgs === null ? feeds : roughArgs.feeds;

  const notes: string[] = [
    roughArgs === null
      ? 'The cutting feed, plunge feed, step-down and step-over are the job’s 2.5D feeds, reused unchanged. Measured 3D engagement numbers are not in the feeds table.'
      : 'The rough’s and the finish’s cutting feeds, plunge feeds, step-downs and step-overs are each cutter’s own 2.5D feeds row, reused unchanged. Measured 3D engagement numbers are not in the feeds table.',
    'A heightfield has one top-Z per (x, y): undercuts and overhangs cannot be expressed, so hidden material below the topmost surface is left standing (the 3-axis answer).',
    `Resolution: ${hf.resolutionNote}.`,
  ];
  if (!tool.ball) {
    notes.push(
      'The finishing cutter is not a ball nose; a flat tool drops onto the highest point under its disc and cannot enter concavities, so the finish is faceted — use a ball for a 3D surface.',
    );
  }
  if (roughArgs !== null) {
    notes.push(
      `Roughing is its own program with ${roughArgs.toolObj.name}, before the finishing cutter; it leaves ${allowance} mm of stock on the surface for the finish to lift.`,
    );
  }

  // #846 — the raster stays the default (a plan without `roughing` is unchanged);
  // 'auto' chooses per job and STATES the choice in one line.
  const rough = await chooseRough(
    hf,
    roughFeeds,
    allowance,
    alongStep,
    safeZ,
    hopZ,
    // #869 — the rough is the flat's question: its radius sets the adaptive engagement cap and its
    // depth ratio sets the rule. Absent, the finishing cutter answers both, as it always has.
    roughArgs?.toolObj ?? args.toolObj,
    args.rapid,
    opts.roughing,
    (done, total) => opts.onProgress?.({ pass: 'rough', done, total }),
  );
  if (rough.note !== null) notes.push(rough.note);
  const roughMoves = rough.moves;
  // #671 — ONE tip field, four passes: the finishing raster, the scallop contours and the pencil
  // paths all ride the same gouge-safe drop, so no pass can promise a depth another one refuses.
  const tip = finishTipField(hf, tool, maxFinishTipOps);
  const finishRaster = finishingMoves(
    hf,
    tip,
    feeds,
    alongStep,
    safeZ,
    hopZ,
    (done, total) => opts.onProgress?.({ pass: 'finish', done, total }),
    null,
    GOAL_MERGE_TOLERANCE_MM,
  );
  // #862 — THE RIM PASS OPENS THE FINISH: the clear band's wall as contour laps from the stock
  // top down to its floor, then the raster rides the floor beside it.
  const rim =
    opts.rim != null
      ? rimMoves(hf, tool, feeds, opts.rim.floorZ, alongStep, safeZ, hopZ)
      : { moves: [], laps: 0, tip: null, count: 0 };
  // #889 — joined packed to packed: the rim's few laps, then the raster's arrays copied as they are.
  const finishMoves = ((): CamMove[] => {
    if (rim.moves.length === 0) return finishRaster;
    const joined = new MoveStore({ capacity: rim.moves.length + finishRaster.length });
    joined.append(rim.moves);
    joined.append(finishRaster);
    return joined.view();
  })();
  // #847 — THE FINISH'S CUT SURFACE IS THE RASTER'S, LOWERED BY THE RIM LAPS WHERE THEY RUN. The
  // laps take the clear band's wall down to its floor; measured from the raster's tip field alone
  // that wall would read as residual the finish has already removed. The returned field is the
  // lower of the two, cell for cell, so the rest pass is planned over what is really left.
  const finishTip = ((): Float32Array => {
    if (rim.tip === null) return tip;
    const combined = new Float32Array(tip.length);
    for (let k = 0; k < tip.length; k++) combined[k] = Math.min(tip[k] as number, rim.tip[k] as number);
    return combined;
  })();

  const depth = Math.max(0, hf.topZ - hf.minZ);
  const roughing: CamOperation = {
    number: 1,
    name: `[T${roughArgs === null ? args.toolNumber : roughArgs.toolNumber}] 3D rough${rough.kind === 'adaptive' ? ' (adaptive)' : ''} — ${allowance} mm to leave`,
    labelId: args.labelId,
    depth,
    passKind: 'rough',
    moves: roughMoves,
    estimatedSeconds: estimateCycleSeconds(roughMoves, args.rapid),
  };
  const finishing: CamOperation = {
    number: 2,
    name: `[T${args.toolNumber}] 3D finish`,
    labelId: args.labelId,
    depth,
    passKind: 'finish',
    moves: finishMoves,
    estimatedSeconds: estimateCycleSeconds(finishMoves, args.rapid),
  };
  const operations: CamOperation[] = [roughing, finishing];

  // #862 — the rim pass's numbers, and the line that says what the wall now is.
  let rimFacts: Surface3dResult['rim'] = null;
  if (rim.laps > 0 && opts.rim != null) {
    rimFacts = { laps: rim.laps, floorZ: opts.rim.floorZ };
    notes.push(
      `The finish opens with ${rim.laps} rim lap${rim.laps === 1 ? '' : 's'} down the cleared band’s wall — ` +
        `the goal’s own outline, one pass per ${feeds.stepDown} mm from the stock top to the band floor — so the ` +
        'pocket’s outer wall is a contour cut, not the roughing’s row ends.',
    );
  }

  // #671 — THE SCALLOP PASS: offset contours of the goal's footprint, each projected onto the tip
  // field, spaced so the step measured ALONG THE SURFACE is the finishing step-over.
  let scallop: Surface3dResult['scallop'] = null;
  if (opts.scallop === true && hf.coveredCount > 0) {
    const pass = scallopMoves(
      hf,
      tip,
      feeds,
      alongStep,
      safeZ,
      hopZ,
      positive(opts.maxScallopContours) ? (opts.maxScallopContours as number) : DEFAULT_MAX_SCALLOP_CONTOURS,
    );
    if (pass.contours > 0) {
      const operation: CamOperation = {
        number: operations.length + 1,
        name: `[T${args.toolNumber}] 3D scallop`,
        labelId: args.labelId,
        depth,
        passKind: 'finish',
        moves: pass.moves,
        estimatedSeconds: estimateCycleSeconds(pass.moves, args.rapid),
      };
      operations.push(operation);
      scallop = {
        operation,
        facts: { contours: pass.contours, stepOverMm: feeds.finishStepOver, clamped: pass.clamped },
      };
      notes.push(
        `The scallop pass follows ${pass.contours} offset contour${pass.contours === 1 ? '' : 's'} of the goal’s ` +
          `outline, spaced so the step measured along the surface is ${feeds.finishStepOver} mm` +
          (pass.clamped
            ? ` — on slopes past ${(Math.atan(Math.sqrt(MAX_SCALLOP_CROWDING * MAX_SCALLOP_CROWDING - 1)) * 180 / Math.PI).toFixed(0)}° the contour spacing stops shrinking (${MAX_SCALLOP_CROWDING}× at most).`
            : '.'),
      );
    }
  }

  // #671 — THE PENCIL PASS: one path along every concave crease the heightfield shows.
  let pencil: Surface3dResult['pencil'] = null;
  if (opts.pencil === true && hf.coveredCount > 0) {
    const creaseDeg = positive(opts.pencilCreaseDeg) ? (opts.pencilCreaseDeg as number) : DEFAULT_PENCIL_CREASE_DEG;
    const pass = pencilMoves(hf, tip, feeds, safeZ, hopZ, creaseDeg);
    if (pass.paths > 0) {
      const operation: CamOperation = {
        number: operations.length + 1,
        name: `[T${args.toolNumber}] 3D pencil`,
        labelId: args.labelId,
        depth,
        passKind: 'finish',
        moves: pass.moves,
        estimatedSeconds: estimateCycleSeconds(pass.moves, args.rapid),
      };
      operations.push(operation);
      pencil = { operation, facts: { paths: pass.paths, creaseDeg } };
      notes.push(
        `The pencil pass follows ${pass.paths} concave crease${pass.paths === 1 ? '' : 's'} — where the ` +
          `surface’s slope changes by more than ${creaseDeg}° across one grid cell — at the same gouge-safe ` +
          'drop as the finishing pass.',
      );
    }
  }

  const ir: ToolpathIR = {
    frame: 'flat',
    tool: args.toolObj,
    toolNumber: args.toolNumber,
    spindleRpm: args.spindleRpm,
    air: args.air,
    safeZ,
    hopZ,
    operations,
  };

  return {
    ir,
    roughing,
    finishing,
    roughingLayers: rough.layers,
    scallop,
    pencil,
    rim: rimFacts,
    finishTip,
    roughKind: rough.kind,
    notes,
  };
}

/** #721 — true for a goal MESH marked as a mold (a PNG relief and an item are never molds). */
export function isMold(target: Pick<EngraveTargetObject, 'format' | 'goalMode'>): boolean {
  return target.goalMode === 'mold' && target.format !== 'png';
}

/**
 * #764/#888 — THE CLEAR BAND A GOAL'S PROGRAM CUTS AROUND ITS FOOTPRINT, from the goal's own
 * settings. ONE reader, used by the CAM and by the top-face measure (#888), so the plan that is
 * judged and the program that is cut cannot disagree about what is cleared. `stepOverMm` widens
 * the ring as the CAM does; a caller that does not know it (the measure before a cutter is
 * resolved) passes none, which only makes the ring narrower — a top reads as surviving a little
 * more often, never less.
 */
export function goalClearBand(
  goal: Pick<EngraveTargetObject, 'format' | 'goalMode' | 'surface'>,
  opts: { toolDiameterMm?: number | null; stepOverMm?: number | null } = {},
): { clear: { kind: 'ring'; widthMm: number } | { kind: 'whole' } | null; ringWidthMm: number } {
  const settings = goal.surface ?? {};
  const clearAround = settings.clearAround ?? 'ring';
  const stepOver = opts.stepOverMm !== null && opts.stepOverMm !== undefined && opts.stepOverMm > 0 ? opts.stepOverMm : 0;
  const ringWidthMm = (opts.toolDiameterMm ?? 0) + stepOver;
  const clear =
    goal.format === 'png' || isMold(goal) || clearAround === 'none' || (clearAround === 'ring' && !(ringWidthMm > 0))
      ? null
      : clearAround === 'whole'
        ? ({ kind: 'whole' } as const)
        : ({ kind: 'ring', widthMm: ringWidthMm } as const);
  return { clear, ringWidthMm };
}

/**
 * #721 — turn an ITEM heightfield into the MOLD of the same part.
 *
 * The part's height above its own base at each covered cell (`z − baseZ`) becomes the cavity's
 * depth below the stock top, and the rows are mirrored about the footprint's centre line in Y: the
 * part is turned over about its X axis, as one pressed face-down into the stock, so a casting taken
 * from the cavity reads the right way round (a reflection would cast its mirror image). Cells the
 * part does not cover stay at the stock top (uncut — the rim). Pure: returns a new field.
 */
export function moldHeightfield(hf: GoalHeightfield, centreY: number, baseZ: number): GoalHeightfield {
  const { nx, ny } = hf;
  const z = new Float32Array(nx * ny);
  z.fill(hf.topZ);
  const covered = new Uint8Array(nx * ny);
  let minZ = hf.topZ;
  for (let j = 0; j < ny; j++) {
    const src = ny - 1 - j;
    for (let i = 0; i < nx; i++) {
      const k = src * nx + i;
      if (hf.covered[k] !== 1) continue;
      const depth = Math.max(0, (hf.z[k] as number) - baseZ);
      const v = hf.topZ - depth;
      z[j * nx + i] = v;
      covered[j * nx + i] = 1;
      if (v < minZ) minZ = v;
    }
  }
  // Row j now holds the source row (ny − 1 − j), mirrored about `centreY`.
  const y0 = 2 * centreY - hf.y0 - (ny - 1) * hf.pitch;
  return { ...hf, y0, z, covered, minZ };
}

/**
 * #721 — the steepest wall of a cavity, degrees from horizontal, between neighbouring covered
 * cells of a field. A mold wants draft (walls short of vertical) to release a casting; 90° means a
 * wall that rises within one cell.
 */
export function steepestWallDeg(hf: GoalHeightfield): number {
  const { nx, ny, z, covered, pitch } = hf;
  let worst = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const here = z[k] as number;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const ii = i + di;
        const jj = j + dj;
        // Off the grid is uncut stock at the top: the grid ends at the footprint, so a covered
        // border cell's outer neighbour is the cavity's rim wall.
        const inside = ii >= 0 && jj >= 0 && ii < nx && jj < ny;
        const kk = jj * nx + ii;
        if (covered[k] !== 1 && (!inside || covered[kk] !== 1)) continue;
        const there = inside ? (z[kk] as number) : hf.topZ;
        const dz = Math.abs(here - there);
        const deg = (Math.atan2(dz, pitch) * 180) / Math.PI;
        if (deg > worst) worst = deg;
      }
    }
  }
  return worst;
}

/**
 * Build the surfacing IR straight from a goal `EngraveTargetObject` and a `Tool` (the dispatch's
 * convenience entry). Returns `null` when the field covers nothing — a goal entirely at or above
 * the stock top has no surface to cut.
 */
export async function generateSurface3dForGoal(args: {
  target: Pick<
    EngraveTargetObject,
    'id' | 'sha256' | 'format' | 'data' | 'position' | 'rotation' | 'size' | 'relief' | 'scale' | 'goalMode'
  >;
  tool: Tool;
  toolNumber: number;
  spindleRpm: number;
  air: boolean;
  feeds: SurfaceFeeds;
  rapid: RapidEstimate;
  sample?: SampleGoalOpts;
  /** #869 — the flat that roughs before `tool` finishes (see {@link Surface3dArgs.rough}). */
  rough?: {
    tool: Tool;
    toolNumber: number;
    feeds: SurfaceFeeds;
  };
  opts?: SurfaceOpts;
}): Promise<(Surface3dResult & { heightfield: GoalHeightfield }) | null> {
  const sampled = sampleGoalHeightfield(args.target, args.sample);
  if (sampled.coveredCount === 0) return null;
  // #721 — a MOLD is the same part turned over and sunk from the stock top. The part's base is its
  // placed top less its placed height (the scale is the one #722 applies).
  const heightfield =
    isMold(args.target)
      ? moldHeightfield(sampled, args.target.position.y, args.target.position.z - placedSize(args.target).z)
      : sampled;
  // #909 — one conversion, shared with the rough clamp: the tool's swept tip shape.
  const surfaceToolOf = surfaceToolFor;
  const result = await generateSurface3dIR({
    heightfield,
    tool: surfaceToolOf(args.tool),
    toolObj: args.tool,
    toolNumber: args.toolNumber,
    spindleRpm: args.spindleRpm,
    air: args.air,
    feeds: args.feeds,
    rapid: args.rapid,
    labelId: args.target.id,
    // #869 — the flat's rough, when the caller split the goal in two programs.
    ...(args.rough === undefined
      ? {}
      : {
          rough: {
            tool: surfaceToolOf(args.rough.tool),
            toolObj: args.rough.tool,
            toolNumber: args.rough.toolNumber,
            feeds: args.rough.feeds,
          },
        }),
    opts: args.opts,
  });
  return { ...result, heightfield };
}

/**
 * #909 — THE DISTANCE FROM A POINT TO A GRID CELL'S SQUARE. A cell is a `pitch`-wide square
 * centred on its sample; the cutter reaches the cell when its disc reaches any part of that
 * square, so the distance measured is to the square's NEAREST point (0 inside it). Measuring to the
 * centre instead put a knife edge at the disc's rim, where the ball's flank is steepest.
 */
function cellSquareDistance(dx: number, dy: number, pitch: number): number {
  const ex = Math.max(0, Math.abs(dx) - pitch / 2);
  const ey = Math.max(0, Math.abs(dy) - pitch / 2);
  return Math.hypot(ex, ey);
}

/** The height a ball of `radius` rises above its tip at radial distance `d` (0 for a flat tool). */
function ballRise(ball: boolean, radius: number, d: number): number {
  if (!ball || radius <= 0) return 0;
  if (d >= radius) return radius;
  return radius - Math.sqrt(radius * radius - d * d);
}

/**
 * The gouge-safe tip field: the tool dropped onto the heightfield until it just touches.
 *
 * #723 — `wrapRows` reads the field's ROW axis as a cylinder's circumference (the rotary map):
 * the stencil wraps modulo `ny` instead of treating the off-grid neighbours as uncut stock, so a
 * pass on the first (or last) row is not lifted to the stock's surface by the seam. The COLUMN
 * axis keeps the flat rule — beyond the sampled X range the stock really does continue.
 */
/**
 * #889 — how many stencil cells the finishing tip field runs per covered cell for a cutter of
 * `radius` on a `pitch` grid: the same disc {@link finishTipField} builds, so a budget check
 * before the CAM counts exactly what the CAM would.
 */
export function tipStencilCells(radius: number, pitch: number): number {
  const span = Math.max(0, Math.floor(radius / pitch));
  let n = 0;
  for (let dj = -span; dj <= span; dj++) {
    for (let di = -span; di <= span; di++) {
      if (Math.hypot(di * pitch, dj * pitch) <= radius) n++;
    }
  }
  return Math.max(1, n);
}

export function finishTipField(
  hf: GoalHeightfield,
  tool: SurfaceTool,
  maxOps: number,
  opts: { wrapRows?: boolean } = {},
): Float32Array {
  const { nx, ny, z, covered, pitch, topZ } = hf;
  const tip = new Float32Array(nx * ny);
  tip.fill(topZ);
  const span = Math.max(0, Math.ceil(tool.radius / pitch));
  // Precompute the disc stencil: every CELL the tool's disc reaches, and the ball rise at the
  // cell's NEAREST POINT (#909). A cell is a square, not a point: measuring to its centre made the
  // knife edge at the rim — a wall cell one radius away flipped in and out on float noise, and on a
  // ball's flank that is several millimetres of either clamp or gouge.
  const stencil: { di: number; dj: number; rise: number }[] = [];
  for (let dj = -span; dj <= span; dj++) {
    for (let di = -span; di <= span; di++) {
      const d = cellSquareDistance(di * pitch, dj * pitch, pitch);
      if (d > tool.radius) continue;
      stencil.push({ di, dj, rise: ballRise(tool.ball, tool.radius, d) });
    }
  }
  if (stencil.length === 0) stencil.push({ di: 0, dj: 0, rise: 0 });
  // #540 — the inner drop runs the stencil at every covered cell. Bound that work BEFORE the loop:
  // a large ball on a fine grid is billions of ops that would hang the worker. Over budget, refuse
  // honestly (stating the op count and the way out), as the exact sweep raises sweep-budget-exceeded.
  const ops = hf.coveredCount * stencil.length;
  if (ops > maxOps) {
    throw new Error(
      `3D finishing would need ${ops} tip evaluations (${hf.coveredCount} covered cells × ` +
        `${stencil.length} stencil cells for a ${(tool.radius * 2).toFixed(2)} mm cutter at a ` +
        `${pitch.toFixed(4)} mm grid), over the ${maxOps} budget. Use a coarser grid (a larger flat ` +
        `pitch) or a smaller ball so the finishing pass fits the budget.`,
    );
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (covered[idx] === 0) continue;
      // The lowest tip that keeps every point of the tool at or above the surface under it:
      // max over the disc of (surface height - the ball's rise there).
      let best = -Infinity;
      for (const s of stencil) {
        const ii = i + s.di;
        const rawJ = j + s.dj;
        if (ii < 0 || ii >= nx) {
          // Off the grid in X is uncut stock at the top face — the tool rides on it.
          best = Math.max(best, topZ - s.rise);
          continue;
        }
        if (opts.wrapRows === true) {
          const jj = ((rawJ % ny) + ny) % ny;
          best = Math.max(best, (z[jj * nx + ii] as number) - s.rise);
          continue;
        }
        if (rawJ < 0 || rawJ >= ny) {
          best = Math.max(best, topZ - s.rise);
          continue;
        }
        best = Math.max(best, (z[rawJ * nx + ii] as number) - s.rise);
      }
      tip[idx] = best;
    }
  }
  return tip;
}

/**
 * #847 — WHAT A FINISH LEFT, CELL FOR CELL. The finish's gouge-safe TIP FIELD is the surface its
 * program cuts: at a cell the ball can reach, the tip rests ON the goal; in a concavity tighter
 * than the ball it rests ABOVE it, and that height IS the material the big ball cannot take.
 *
 * A cell is RESIDUAL when its tip stands above the goal by more than the stated tolerance (the
 * stock-to-leave is not residual — the job means to leave it). `volumeMm3` is the residual above
 * the goal less that allowance, summed over the cells; `deepestMm` is the largest rise, which is
 * the depth a smaller ball has to reach to touch the deepest one.
 */
export interface SurfaceResidual {
  /** 1 where the finish's tip field stands above the goal by more than the tolerance. */
  mask: Uint8Array;
  /** How many cells the mask holds. */
  cells: number;
  /** Residual material above the goal (less the allowance), mm³. */
  volumeMm3: number;
  /** The largest tip-above-goal rise, mm — 0 when the finish reaches everything. */
  deepestMm: number;
  /**
   * #847 — THE DENOMINATOR: the material the goal asks to remove, mm³ — every covered cell's rise
   * from its own surface up to the stock top, summed. A leftover's share of this is what says
   * whether it is a real part of the part or a mark on it.
   */
  removedMm3: number;
}

/**
 * The residual a finish's tip field leaves against the goal itself, beyond `stockToLeave` and the
 * grid's own tolerance. Pure: the same field the CAM cut from, so the number cannot be a second
 * model of the cut.
 */
export function surfaceResidual(
  hf: GoalHeightfield,
  tip: Float32Array,
  stockToLeaveMm: number,
  toleranceMm: number,
): SurfaceResidual {
  const { nx, ny, z, covered, pitch, topZ } = hf;
  const mask = new Uint8Array(nx * ny);
  const leave = Number.isFinite(stockToLeaveMm) && stockToLeaveMm > 0 ? stockToLeaveMm : 0;
  const tol = Number.isFinite(toleranceMm) && toleranceMm > 0 ? toleranceMm : 0;
  let cells = 0;
  let volume = 0;
  let deepest = 0;
  let removed = 0;
  const area = pitch * pitch;
  for (let idx = 0; idx < nx * ny; idx++) {
    if (covered[idx] === 0) continue;
    const here = z[idx] as number;
    // The goal's own removal: how much stock stands above its surface at this cell (#847).
    const cut = topZ - here;
    if (cut > 0) removed += cut * area;
    const rise = (tip[idx] as number) - here;
    if (!(rise > 0)) continue;
    if (rise > deepest) deepest = rise;
    const over = rise - leave;
    if (!(over > tol)) continue;
    mask[idx] = 1;
    cells += 1;
    volume += over * area;
  }
  return { mask, cells, volumeMm3: volume, deepestMm: deepest, removedMm3: removed };
}

/**
 * #847 — IS THE LEFTOVER VISIBLE? A run that states every leftover would cry wolf on any organic
 * goal: every concave detail tighter than the ball leaves some material. So the sentence is
 * INFORMATION until the leftover would show — a rise deeper than the stated depth, or a leftover
 * that is a real share of what the goal removes. The share is the same judgement the 2D rest pair
 * uses for a third cutter (`rest.thirdToolPct`).
 */
export function restResidualVisible(
  residual: SurfaceResidual,
  depthMm: number,
  shareFraction: number,
): { visible: boolean; share: number } {
  const share = residual.removedMm3 > 0 ? residual.volumeMm3 / residual.removedMm3 : 0;
  const depth = Number.isFinite(depthMm) && depthMm >= 0 ? depthMm : 0;
  const fraction = Number.isFinite(shareFraction) && shareFraction > 0 ? shareFraction : 0;
  return { visible: residual.deepestMm > depth + 1e-9 || share > fraction + 1e-9, share };
}

/** #909 — what a goal-vs-plan over-cut check found. */
export interface GoalOvercutReport {
  /** The deepest point of the planned cut below the goal's own surface, mm; 0 when none. */
  worstMm: number;
  /** Covered cells the planned cut reaches below the goal. */
  cells: number;
  /** The worst point, in work XY, and the goal and cut Z there; null when there is none. */
  at: { x: number; y: number; goalZ: number; cutZ: number } | null;
  /** Which of the caller's stages made the worst cut (an index into `stages`); null when none. */
  stage: number | null;
}

/**
 * #909 — DOES THE PLAN CUT INTO THE PART? The oracle compares the SIMULATION with the PLAN, so a
 * plan that gouges the goal passes it on every job (the 2026-11-02 demo: the rough cut up to
 * 7.1 mm into the mouse shell, and the finished part sat a median 0.77 mm under the goal). This is
 * the comparison the oracle cannot make: the plan's own removal, stamped by the cutter's whole
 * footprint exactly as the passes cut it, against the goal's heightfield.
 *
 * Every stage's feed moves — the rough, the finish, the rest — are stamped cell by cell: a flat's
 * disc at its tip Z, a ball's rise at the cell's nearest point. Any covered cell whose planned cut
 * stands below the goal by more than the tolerance is an over-cut — material the part needs, which
 * no later pass can put back.
 */
export function planGoalOvercut(
  hf: GoalHeightfield,
  stages: readonly { moves: readonly CamMove[]; tool: SurfaceTool }[],
  toleranceMm = 0.001,
): GoalOvercutReport {
  const { nx, ny, z, covered, pitch, x0, y0 } = hf;
  if (hf.coveredCount === 0 || stages.length === 0) {
    return { worstMm: 0, cells: 0, at: null, stage: null };
  }
  const cut = new Float32Array(nx * ny);
  cut.fill(Infinity);
  // Which stage made each cell's lowest cut, so a refusal can name the pass that gouges rather
  // than blaming the roughing whatever it was (#909).
  const cutStage = new Uint8Array(nx * ny);
  cutStage.fill(255);
  /**
   * Stamp one feed LINE: every cell whose SQUARE lies within the cutter's radius of the segment
   * takes the lowest tip the cutter reaches there. A line's Z ramps between its two moves, as the
   * machine interpolates it; the lowest point over a cell is at the segment's nearest approach to
   * it or at an end (a flat's disc: exactly; a ball's rise only makes the ends safer).
   */
  const stampStage = (moves: readonly CamMove[], tool: SurfaceTool, stageIndex: number): void => {
    if (!(tool.radius > 0)) return;
    const r = tool.radius;
    /**
     * #909 — THE MODEL'S OWN SKIN, mm. A pass that follows the goal's outline holds the cutter a
     * radius off the region's own edges, but a planner's straight chords can pass just inside a
     * cell's square at a corner: the adaptive walk takes fifth-of-a-radius steps, and the chord
     * between two allowed points dips up to r/200 inside the wall (its midpoint is checked, so the
     * real dip is a quarter of that). A graze thinner than this is the grid's resolution, not a
     * gouge — no machine holds a sub-0.01 mm sliver of a wall, and the goal's columns are 0.1 mm
     * squares or larger. Real over-cuts, the mouse's 7.1 mm among them, are orders of magnitude
     * deeper and stay refused.
     */
    const skin = Math.max(0.01, r / 100);
    const stampSegment = (sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): void => {
      const dx = ex - sx;
      const dy = ey - sy;
      const dz = ez - sz;
      const len2 = dx * dx + dy * dy;
      const iLo = Math.max(0, Math.floor((Math.min(sx, ex) - r - x0) / pitch));
      const iHi = Math.min(nx - 1, Math.ceil((Math.max(sx, ex) + r - x0) / pitch));
      const jLo = Math.max(0, Math.floor((Math.min(sy, ey) - r - y0) / pitch));
      const jHi = Math.min(ny - 1, Math.ceil((Math.max(sy, ey) + r - y0) / pitch));
      // #945 — THE LATERAL-NEAREST POINT IS NOT ALWAYS THE WORST POINT. A segment that moves away
      // from a cell while also descending (a steep link between two adjacent raster columns) can
      // gouge the cell partway along its length, where the ball's edge is just inside reach (its
      // rise is near 0) but the centre has already dropped a long way — deeper than at the single
      // point closest in XY, which is what used to be evaluated here. Candidates, each clamped and
      // re-checked against the REAL (square) distance below, so an approximation only adds a
      // candidate to try, never changes what counts as a hit:
      //   - t0: the old lateral-nearest point (kept; still often the worst point);
      //   - 0, 1: the segment's own ends, the worst point for a non-ball tool (reached(t) is then
      //     just z(t), linear, so its minimum over any sub-interval is always at an end);
      //   - the two points where the cutter's disc just reaches the cell at all (point-centre
      //     approximation; `skin` already absorbs the pitch/2 square correction) — the ball's rise
      //     there is ~0, so this is where a steep descent gouges deepest;
      //   - for a ball tool, the interior point minimising `z(t) + ballRise(d(t))` exactly (closed
      //     form: z is linear and d² is quadratic in t, so the derivative solves to one root).
      for (let j = jLo; j <= jHi; j++) {
        const cy = y0 + j * pitch;
        for (let i = iLo; i <= iHi; i++) {
          const k = j * nx + i;
          if (covered[k] === 0) continue;
          const cx = x0 + i * pitch;
          let best = Infinity;
          const consider = (tRaw: number): void => {
            if (!Number.isFinite(tRaw)) return;
            const t = Math.max(0, Math.min(1, tRaw));
            const d = cellSquareDistance(cx - (sx + dx * t), cy - (sy + dy * t), pitch);
            if (d > r - skin) return;
            const reached = sz + dz * t + ballRise(tool.ball, r, d);
            if (reached < best) best = reached;
          };
          const t0 = len2 > 0 ? ((cx - sx) * dx + (cy - sy) * dy) / len2 : 0;
          consider(t0);
          consider(0);
          consider(1);
          if (len2 > 0) {
            // Where the disc's edge (point-centre) reaches the cell at all: A t² + B t + C = 0.
            const px = sx - cx;
            const py = sy - cy;
            const B = 2 * (px * dx + py * dy);
            const C = px * px + py * py - r * r;
            const disc = B * B - 4 * len2 * C;
            if (disc > 0) {
              const sq = Math.sqrt(disc);
              const tLo = (-B - sq) / (2 * len2);
              const tHi = (-B + sq) / (2 * len2);
              consider(tLo);
              consider(tHi);
              if (tool.ball && r > 0) {
                // The closed-form interior minimum of z(t) + ballRise(r, d(t)): with w = t − t0 and
                // d(t)² = p² + len2·w² (p = the point's own perpendicular distance, at t0), solving
                // d/dw [sz + dz·(t0+w) − √(r² − p² − len2·w²)] = 0 gives w = −dz·R0 / (L·√(len2+dz²))
                // where R0² = r² − p², L = √len2 (negative when R0² < 0: the line never reaches the
                // cell at t0's own perpendicular, so no interior root — the boundary candidates above
                // already cover that case).
                const qx = cx - (sx + dx * t0);
                const qy = cy - (sy + dy * t0);
                const p2 = qx * qx + qy * qy;
                const r0sq = r * r - p2;
                if (r0sq > 0) {
                  const L = Math.sqrt(len2);
                  const denom = L * Math.sqrt(len2 + dz * dz);
                  if (denom > 0) {
                    const w = (-dz * Math.sqrt(r0sq)) / denom;
                    consider(t0 + w);
                  }
                }
              }
            }
          }
          if (best < (cut[k] as number)) {
            cut[k] = best;
            cutStage[k] = Math.min(254, stageIndex);
          }
        }
      }
    };
    let prevX = 0;
    let prevY = 0;
    let prevZ = 0;
    for (const move of moves) {
      if (move.kind !== 'feed') {
        prevX = move.x;
        prevY = move.y;
        prevZ = move.z;
        continue;
      }
      stampSegment(prevX, prevY, prevZ, move.x, move.y, move.z);
      prevX = move.x;
      prevY = move.y;
      prevZ = move.z;
    }
  };
  stages.forEach((stage, index) => stampStage(stage.moves, stage.tool, index));
  const tol = Number.isFinite(toleranceMm) && toleranceMm > 0 ? toleranceMm : 0;
  let worstMm = 0;
  let cells = 0;
  let at: GoalOvercutReport['at'] = null;
  let stage: number | null = null;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (covered[k] === 0) continue;
      const reached = cut[k] as number;
      if (!Number.isFinite(reached)) continue;
      const goalZ = z[k] as number;
      const below = goalZ - reached; // positive: the plan cuts below the goal's surface
      if (!(below > tol)) continue;
      cells += 1;
      if (below > worstMm) {
        worstMm = below;
        at = { x: x0 + i * pitch, y: y0 + j * pitch, goalZ, cutZ: reached };
        const which = cutStage[k] as number;
        stage = which === 255 ? null : which;
      }
    }
  }
  return { worstMm, cells, at, stage };
}

/**
 * Contiguous runs of cuttable columns in grid-row `j`, as `[iStart, iEnd]` inclusive pairs. With
 * `only` (#847), a cell is cuttable only where the mask says so — the rest pass's own region.
 */
function coveredRuns(hf: GoalHeightfield, j: number, only?: Uint8Array | null): [number, number][] {
  const { nx, covered } = hf;
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < nx; i++) {
    const on = covered[j * nx + i] === 1 && (only === undefined || only === null || only[j * nx + i] === 1);
    if (on && start === -1) start = i;
    else if (!on && start !== -1) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, nx - 1]);
  return runs;
}

/** Rows to raster, from j = 0 upward, spaced by `stepOver` (at least every row). */
function rasterRows(hf: GoalHeightfield, stepOver: number): number[] {
  const stride = Math.max(1, Math.round(stepOver / hf.pitch));
  const rows: number[] = [];
  for (let j = 0; j < hf.ny; j += stride) rows.push(j);
  if (rows.length > 0 && rows[rows.length - 1] !== hf.ny - 1) rows.push(hf.ny - 1);
  return rows;
}

/** X sample columns across a run, spaced by `alongStep` (always including both ends). */
function alongColumns(
  hf: GoalHeightfield,
  iStart: number,
  iEnd: number,
  alongStep: number,
  only?: Uint8Array | null,
  j?: number,
): number[] {
  const stride = Math.max(1, Math.round(alongStep / hf.pitch));
  const cols: number[] = [];
  for (let i = iStart; i <= iEnd; i += stride) {
    if (only !== undefined && only !== null && j !== undefined && only[j * hf.nx + i] !== 1) continue;
    cols.push(i);
  }
  if (only === undefined || only === null) {
    if (cols.length === 0 || cols[cols.length - 1] !== iEnd) cols.push(iEnd);
  } else if (j !== undefined) {
    // A masked run's ends are its own mask's ends; add them when the stride skipped them.
    if (only[j * hf.nx + iStart] === 1 && !cols.includes(iStart)) cols.unshift(iStart);
    if (only[j * hf.nx + iEnd] === 1 && !cols.includes(iEnd)) cols.push(iEnd);
  }
  return cols;
}

/**
 * #847 — DILATE a residual mask by `radiusMm` (a disc on the grid), so a smaller ball's BODY can
 * reach a residual cell: a ball whose centre cannot come within its own radius of the cell leaves
 * it uncut, and the rest pass's raster samples centres.
 */
export function dilateMask(hf: GoalHeightfield, mask: Uint8Array, radiusMm: number): Uint8Array {
  const { nx, ny, pitch } = hf;
  const out = new Uint8Array(nx * ny);
  const span = Math.max(0, Math.ceil(radiusMm / pitch));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (mask[j * nx + i] !== 1) continue;
      for (let dj = -span; dj <= span; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -span; di <= span; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          if (Math.hypot(di * pitch, dj * pitch) > radiusMm + 1e-9) continue;
          out[jj * nx + ii] = 1;
        }
      }
    }
  }
  return out;
}

/**
 * RASTER ROUGHING in step-down layers (stage 2a). For each Z layer from the top down, the tool
 * rasters the footprint; at each sample its tip rides at the layer Z, clamped UP to the lowest tip
 * that keeps the cutter's whole FOOTPRINT at or above the goal plus the allowance, so it never
 * reaches the goal surface. A sample where the clamp reaches the stock top has no material to
 * remove and opens a gap — the pass retracts and re-enters.
 *
 * #909 — THE CLAMP IS THE DISC, NOT THE CENTRE. A flat end mill cuts every column under its disc
 * at the tip Z; clamping only the centre column let the disc pass below a higher neighbour's
 * surface — a wall the centre could not see — and the rough gouged up to 7 mm into the part on the
 * demo's mouse shell. The field is taken once per pass by `roughClampField`.
 *
 * #889 — A LEVEL CUTS WHAT IT REMOVES. A sample whose clamp held the tip at or above the level
 * before this one was finished there; a segment between two finished samples was already cut,
 * identically, at an earlier level, so this level skips it (on a 50 mm goal that repeated ride
 * was more than half of every move). Every other segment is cut exactly as before, so the roughing
 * removes what it always did (see `writeSpan`), and collinear feeds are merged as they are written.
 *
 * #738 — every hop out of a cut is TWO moves, as the house rule in `ir.ts` (`rapidRate`) states:
 * a Z-only retract at the point the cut stopped, then the next span's XY traverse at `hopZ`. A
 * single `G0 X.. Z..` from a cut depth climbs away diagonally through material the program has
 * not removed yet, which the geometry check refuses (j06/j07 on the bench).
 */
/**
 * #889 — how far over the finished tips a roughing crossing's chords may run, mm, where it follows
 * a curved stretch on chords (see `cross` in `roughingMoves`).
 */
export const ROUGH_CROSS_LIFT_MM = 1;

/**
 * #909 — THE ROUGHING CLAMP, TAKEN OVER THE CUTTER'S WHOLE DISC. Per covered cell: the lowest tip
 * that keeps the tool's footprint at or above the goal plus the allowance — the same
 * `max(surface − rise)` the finishing tip field uses, plus the allowance on the goal cells. Uncut
 * (stock) cells and the grid's outside clamp to the stock top exactly as the finishing field does,
 * so the tool also stays off the blank outside the cleared band. Without a stated cutter (a caller
 * that passes none), the legacy per-column clamp is returned.
 */
function roughClampField(
  hf: GoalHeightfield,
  tool: SurfaceTool | null,
  allowance: number,
  alongStep: number,
): Float32Array {
  const { nx, ny, z, covered, pitch, topZ } = hf;
  const field = new Float32Array(nx * ny);
  if (tool === null || !(tool.radius > 0)) {
    for (let k = 0; k < field.length; k++) {
      field[k] = covered[k] === 0 ? topZ : (z[k] as number) + allowance;
    }
    return field;
  }
  // #909 — THE CLAMP IS THE CUTTER'S WHOLE REACH, NOT ITS CENTRE COLUMN, and it is taken as the
  // SEPARABLE MAX over the square that CONTAINS the disc. The square is conservative (it reaches a
  // disc's corner distance diagonally), so the tip it produces is never below the exact disc's —
  // it can only leave more material, which the finish lifts. Its cost is O(cells) whatever the
  // cutter's size, which the planning budget needs: the estimate runs it once per pitch it tries,
  // and an exact disc on a 0.02 mm grid is billions of ops.
  //
  // A flat's disc reaches half a sample past each sampled centre (the program is sampled every
  // `alongStep`), so its square is widened by that; a ball's surface ends at its radius.
  const radius = tool.ball ? tool.radius : tool.radius + Math.max(0, alongStep) / 2;
  const need = new Float32Array(nx * ny);
  for (let k = 0; k < need.length; k++) {
    need[k] = covered[k] === 0 ? topZ : (z[k] as number) + allowance;
  }
  const span = Math.max(0, Math.ceil(radius / pitch));
  return squareMax(need, nx, ny, span);
}

/**
 * #909 — the max of `src` over a (2·span+1)² square, in two separable passes (rows, then
 * columns) with a monotonic deque, O(nx·ny) whatever the span.
 */
function squareMax(src: Float32Array, nx: number, ny: number, span: number): Float32Array {
  const n = nx * ny;
  const row = new Float32Array(n);
  // Rows: max over [i-span, i] (forward) and [i, i+span] (backward), combined.
  const fwd = new Float32Array(n);
  const bwd = new Float32Array(n);
  const dq = new Int32Array(Math.max(nx, ny) + 1);
  for (let j = 0; j < ny; j++) {
    const base = j * nx;
    let head = 0;
    let tail = 0;
    for (let i = 0; i < nx; i++) {
      const v = src[base + i] as number;
      while (tail > head && (src[base + (dq[tail - 1] as number)] as number) <= v) tail--;
      dq[tail++] = i;
      while ((dq[head] as number) < i - span) head++;
      fwd[base + i] = src[base + (dq[head] as number)] as number;
    }
    head = 0;
    tail = 0;
    for (let i = nx - 1; i >= 0; i--) {
      const v = src[base + i] as number;
      while (tail > head && (src[base + (dq[tail - 1] as number)] as number) <= v) tail--;
      dq[tail++] = i;
      while ((dq[head] as number) > i + span) head++;
      bwd[base + i] = src[base + (dq[head] as number)] as number;
    }
    for (let i = 0; i < nx; i++) row[base + i] = Math.max(fwd[base + i] as number, bwd[base + i] as number);
  }
  // Columns: the same, on `row`.
  const out = new Float32Array(n);
  const colFwd = new Float32Array(n);
  const colBwd = new Float32Array(n);
  for (let i = 0; i < nx; i++) {
    let head = 0;
    let tail = 0;
    for (let j = 0; j < ny; j++) {
      const v = row[j * nx + i] as number;
      while (tail > head && (row[(dq[tail - 1] as number) * nx + i] as number) <= v) tail--;
      dq[tail++] = j;
      while ((dq[head] as number) < j - span) head++;
      colFwd[j * nx + i] = row[(dq[head] as number) * nx + i] as number;
    }
    head = 0;
    tail = 0;
    for (let j = ny - 1; j >= 0; j--) {
      const v = row[j * nx + i] as number;
      while (tail > head && (row[(dq[tail - 1] as number) * nx + i] as number) <= v) tail--;
      dq[tail++] = j;
      while ((dq[head] as number) > j + span) head++;
      colBwd[j * nx + i] = row[(dq[head] as number) * nx + i] as number;
    }
    for (let j = 0; j < ny; j++) out[j * nx + i] = Math.max(colFwd[j * nx + i] as number, colBwd[j * nx + i] as number);
  }
  return out;
}

function roughingMoves(
  hf: GoalHeightfield,
  feeds: SurfaceFeeds,
  allowance: number,
  alongStep: number,
  safeZ: number,
  hopZ: number,
  onLayer?: (done: number, total: number) => void,
  /** #889 — count the moves without holding them (the budget's estimate); `moves` is then empty. */
  countOnly = false,
  /**
   * #909 — the rough cutter's own tip; the clamp is taken over its disc. Absent: the per-column
   * clamp of a caller that states no cutter.
   */
  tool: SurfaceTool | null = null,
): { moves: CamMove[]; layers: number; count: number } {
  // #889 — packed, and collinear feeds merged on the way in: a level's flat stretches are one
  // move each, not one per cell.
  const moves = new MoveStore({ mergeToleranceMm: GOAL_MERGE_TOLERANCE_MM, countOnly });
  const done = (layers: number): { moves: CamMove[]; layers: number; count: number } => ({
    moves: countOnly ? [] : moves.view(),
    layers,
    count: moves.length,
  });
  if (hf.coveredCount === 0) return done(0);
  // #541 — the layer loop steps L down by `stepDown` until it passes `deepest`. A zero or negative
  // step-down (a placeholder or bad feed row through the flat proxy) never terminates it, so refuse
  // here rather than hang: a non-positive step-down cannot layer a roughing pass.
  if (!(feeds.stepDown > 0)) {
    throw new Error(
      `3D roughing needs a positive step-down; the feeds gave ${feeds.stepDown} mm. ` +
        `A zero or negative step-down cannot layer the rough passes — check the feed row for this tool and material.`,
    );
  }
  const { pitch, x0, y0, topZ, minZ } = hf;
  // #909 — the clamp surface: the lowest tip that keeps the rough cutter's whole disc at or above
  // the goal plus the allowance, per covered column (see `roughClampField`).
  const clampField = roughClampField(hf, tool, allowance, alongStep);
  const floorAt = (i: number, j: number): number => clampField[j * hf.nx + i] as number;
  // Layers: step down from the top until the deepest clamp (minZ + allowance) is reached.
  const deepest = minZ + allowance;
  const levels: number[] = [];
  for (let L = topZ - feeds.stepDown; L > deepest + 1e-9; L -= feeds.stepDown) levels.push(L);
  levels.push(deepest); // the final layer rides the allowance surface exactly
  const rows = rasterRows(hf, feeds.roughStepOver);
  /** #738 — a Z-only retract at the point the cut stopped; the traverse comes after it. */
  const retract = (z: number): void => {
    moves.rapid(moves.lastX(), moves.lastY(), z);
  };

  // #889 — a span's points, gathered before any is written: which of them this level REMOVES
  // material at, and where the tip rides.
  const spanX: number[] = [];
  const spanTip: number[] = [];
  const spanCuts: boolean[] = [];
  /**
   * #889 — write one span (a stretch of the run where the tip stands below the stock top).
   *
   * THE INVARIANT: every segment the cell-by-cell ride would cut at this level is either cut here
   * exactly as that ride cut it, or was already cut, identically, at an earlier level. A point
   * whose clamp held its tip at or above the level before this one is FINISHED: its tip is the
   * same at this level as at the last. A segment between two finished points is therefore the
   * very segment an earlier level cut (the level at which the later of the two was finished,
   * where that point still removed material and the segment was written) — repeating it removes
   * nothing, so it is skipped. Every segment with an unfinished end is written as the ride wrote
   * it, the flat's whole disc along it. So the roughing removes exactly what the ride did, and a
   * cell holds no more than the allowance it always held.
   *
   * Skipped segments are crossed on at most three moves that never pass below a finished tip
   * (`cross`), along the ride's own XY, so the crossing cuts nothing the ride did not. The span is entered at its
   * first point and left from its last, as the ride was. A span this level writes no segment of
   * is not cut at all.
   */
  const writeSpan = (y: number): void => {
    const n = spanX.length;
    const needed = (k: number): boolean => (spanCuts[k] as boolean) || (spanCuts[k + 1] as boolean);
    /**
     * Cross the finished points after `from` (written) up to `to`, along the ride's own XY and
     * never below the ride, in at most three moves. The path is the lowest of three lines, each of
     * which clears every finished tip between: the line from `from` at the least slope that clears
     * them, the line into `to` likewise (when `to` is landed on at its own tip), and the level at
     * the stretch's highest tip. Each line is over every tip, so their lowest is too; the ride
     * between two points is their straight segment, so a path over the points is over the ride and
     * cuts nothing the ride did not. Over a steep wall it is up, level and down. Where those three
     * moves run more than a twentieth longer than the ride (a dome's flank), chords lifted a little
     * over the tips take their place, at about the ride's own length. `to` is landed on at its own tip when
     * `landExact`; otherwise (the span's end, where the retract follows) only cleared.
     */
    const cross = (from: number, to: number, landExact: boolean): void => {
      const x0s = spanX[from] as number;
      const dir = (spanX[to] as number) >= x0s ? 1 : -1;
      const u = (q: number): number => ((spanX[q] as number) - x0s) * dir;
      const U = u(to);
      const zA = spanTip[from] as number;
      const zB = spanTip[to] as number;
      const last = landExact ? to - 1 : to; // the tips the path must clear
      let H = Math.max(zA, landExact ? zB : -Infinity);
      let sA = -Infinity;
      let sB = Infinity;
      for (let q = from + 1; q <= last; q++) {
        const zq = spanTip[q] as number;
        const uq = u(q);
        H = Math.max(H, zq);
        sA = Math.max(sA, (zq - zA) / uq);
        if (landExact) sB = Math.min(sB, (zB - zq) / (U - uq));
      }
      if (sA === -Infinity) {
        // Nothing between: the ride's own segment.
        moves.feed(spanX[to] as number, y, zB, feeds.feed);
        return;
      }
      const lines: { z0: number; s: number }[] = [{ z0: zA, s: sA }, { z0: H, s: 0 }];
      if (landExact) lines.push({ z0: zB - sB * U, s: sB });
      const f = (uu: number): number => {
        let m = Infinity;
        for (const l of lines) m = Math.min(m, l.z0 + l.s * uu);
        return m;
      };
      // The envelope's corners: where two of the lines cross inside the stretch, kept only where
      // the lowest line changes there.
      const cuts: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const li = lines[i]!;
          const lj = lines[j]!;
          if (Math.abs(li.s - lj.s) < 1e-12) continue;
          const uc = (lj.z0 - li.z0) / (li.s - lj.s);
          if (uc > 1e-9 && uc < U - 1e-9 && Math.abs(li.z0 + li.s * uc - f(uc)) < 1e-9) cuts.push(uc);
        }
      }
      cuts.sort((p, q) => p - q);
      // The ride's own length over the stretch, and the envelope's: past a twentieth longer (a
      // dome's flank, where few corners cannot hug the curve), the stretch is crossed on chords
      // instead — each lifted ROUGH_CROSS_LIFT_MM over a later tip, as far as no tip between rises
      // above it — which keep about the ride's length in a few more moves. (Measured: the
      // near-sphere's rough within 1 % of the ride's time; the 50 mm panther at 0.1 mm in budget.)
      let rideLen = 0;
      for (let q = from + 1; q <= to; q++) {
        rideLen += Math.hypot(u(q) - u(q - 1), (spanTip[q] as number) - (spanTip[q - 1] as number));
      }
      let envLen = 0;
      {
        let qu = 0;
        let qz = zA;
        for (const uc of [...cuts, U]) {
          const zc = uc === U ? (landExact ? zB : f(U)) : f(uc);
          envLen += Math.hypot(uc - qu, zc - qz);
          qu = uc;
          qz = zc;
        }
      }
      if (envLen > rideLen * 1.05) {
        const lifted = (q: number): number => Math.min(topZ, (spanTip[q] as number) + ROUGH_CROSS_LIFT_MM);
        const at = (q: number): number => (q === to && landExact ? zB : lifted(q));
        let a = from;
        let ha = zA;
        let bound = -Infinity; // the least slope a chord from the anchor needs to clear the tips so far
        let lastOk = -1;
        let e = a + 1;
        while (e <= to) {
          const du = u(e) - u(a);
          if ((at(e) - ha) / du >= bound - 1e-12) {
            lastOk = e;
            bound = Math.max(bound, ((spanTip[e] as number) - ha) / du);
            e++;
            continue;
          }
          moves.feed(spanX[lastOk] as number, y, lifted(lastOk), feeds.feed);
          a = lastOk;
          ha = lifted(lastOk);
          bound = -Infinity;
          for (let q = a + 1; q < e; q++) bound = Math.max(bound, ((spanTip[q] as number) - ha) / (u(q) - u(a)));
        }
        moves.feed(spanX[to] as number, y, at(to), feeds.feed);
        return;
      }
      let pu = 0;
      let pz = zA;
      for (const uc of cuts) {
        if (uc - pu < 1e-9) continue;
        const zc = f(uc);
        // Skip a corner the path runs straight through.
        const zNext = f(Math.min(U, uc + 1e-3));
        const sIn = (zc - pz) / (uc - pu);
        const sOut = (zNext - zc) / Math.max(1e-12, Math.min(U, uc + 1e-3) - uc);
        if (Math.abs(sIn - sOut) < 1e-9) continue;
        moves.feed(x0s + dir * uc, y, zc, feeds.feed);
        pu = uc;
        pz = zc;
      }
      moves.feed(spanX[to] as number, y, landExact ? zB : f(U), feeds.feed);
    };
    let any = false;
    for (let k = 0; k + 1 < n && !any; k++) any = needed(k);
    if (n === 1) any = spanCuts[0] as boolean;
    if (any) {
      // Entered at the span's first point and left from its last, as the ride was: only the
      // segments between finished points are crossed instead of ridden.
      moves.rapid(spanX[0] as number, y, hopZ);
      moves.feed(spanX[0] as number, y, spanTip[0] as number, feeds.plungeFeed);
      let lastWritten = 0;
      for (let k = 0; k + 1 < n; k++) {
        if (!needed(k)) continue;
        if (lastWritten !== k) cross(lastWritten, k, true);
        moves.feed(spanX[k + 1] as number, y, spanTip[k + 1] as number, feeds.feed);
        lastWritten = k + 1;
      }
      // The finished points after the last written one: crossed to the span's end, and the
      // retract made from there, over them, as the ride's was from the span's last point.
      if (lastWritten < n - 1) cross(lastWritten, n - 1, false);
      retract(hopZ);
    }
    spanX.length = 0;
    spanTip.length = 0;
    spanCuts.length = 0;
  };

  for (const [index, L] of levels.entries()) {
    // #785 — the level about to be cut, reported BEFORE it (the caller's "doing k of n").
    onLayer?.(index + 1, levels.length);
    // #889 — the level above this one (the stock top for the first): a point whose clamp holds the
    // tip at or above it was finished there, and this level removes nothing at it.
    const above = index === 0 ? topZ : (levels[index - 1] as number);
    let flip = false;
    for (const j of rows) {
      const y = y0 + j * pitch;
      for (const [iS, iE] of coveredRuns(hf, j)) {
        const cols = alongColumns(hf, iS, iE, alongStep);
        const ordered = flip ? [...cols].reverse() : cols;
        // The tip along the run rides at the layer, clamped up to the allowance surface. A point
        // where the clamp reaches the stock top has nothing above it: it ends the span (the pass
        // lifts clear and re-enters, #738).
        for (const i of ordered) {
          const clamp = floorAt(i, j);
          const tip = Math.max(L, clamp);
          if (tip < topZ - 1e-9) {
            spanX.push(x0 + i * pitch);
            spanTip.push(tip);
            spanCuts.push(clamp < above - 1e-9);
          } else if (spanX.length > 0) {
            writeSpan(y);
          }
        }
        if (spanX.length > 0) writeSpan(y);
      }
      flip = !flip;
    }
  }
  if (moves.length > 0) retract(safeZ);
  return done(levels.length);
}

/**
 * #945 — THE STAIRCASE, shared by every pass that connects two already drop-cutter-safe points
 * with a straight feed (the finishing raster, the scallop contours, the pencil crease trace): a
 * diagonal between them can dip below the goal partway along it once the wall between them is
 * steeper than slope 1 (a raster/contour/crease step is a fraction of a mm; a goal wall a few mm
 * deep over that step is routine — a crevice between a figure's legs, a contour crossing a step's
 * edge, a crease running down one). Each point's OWN z is already its own drop-cutter-safe value
 * for its footprint, so a corner at the HIGHER of the two — level first at that z, then straight
 * down to the lower point (or straight up at the current xy, then level) — never goes below
 * either point's own verified-safe height along the way; the level leg's own clearance error is
 * the chord sagitta, step²/(8·r), negligible against the cutter. Below slope 1 the single
 * diagonal stays (its interpolation error is smaller still, inside the overcut guard's own skin
 * tolerance). Null below slope 1 or when the two points coincide in XY (a pure plunge/retract,
 * already vertical).
 */
function staircaseCorner(
  prevX: number,
  prevY: number,
  prevZ: number,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } | null {
  const lateral = Math.hypot(x - prevX, y - prevY);
  if (!(lateral > 0) || Math.abs(z - prevZ) <= lateral) return null;
  return z <= prevZ ? { x, y, z: prevZ } : { x: prevX, y: prevY, z };
}

/**
 * BALL-NOSE FINISHING raster (stage 2b). The tool follows the gouge-safe tip field in boustrophedon
 * scan lines spaced by the finishing step-over, sampled along each line at `alongStep` so the dexel
 * sim of the result tracks the goal within the step-over and the grid pitch.
 */
export function finishingMoves(
  hf: GoalHeightfield,
  tip: Float32Array,
  feeds: SurfaceFeeds,
  alongStep: number,
  safeZ: number,
  hopZ: number,
  /** #785 — called once per scan line, before it is cut (`done` counts from 1). */
  onRow?: (done: number, total: number) => void,
  /**
   * #847 — cut ONLY where this mask says (a rest pass over the finish's residual), dilated by the
   * rest ball's radius before it is handed in. Absent: every covered cell, as the finish does.
   */
  only?: Uint8Array | null,
  /**
   * #889 — merge collinear feeds within this distance, mm (see `MoveStore`). Absent: 0, every
   * sample its own move — the rotary relief's reading, which wraps the moves after.
   */
  mergeToleranceMm = 0,
): CamMove[] {
  // #889 — packed, as the roughing is.
  const moves = new MoveStore({ mergeToleranceMm });
  if (hf.coveredCount === 0) return moves.view();
  const { pitch, x0, y0 } = hf;
  const rows = rasterRows(hf, feeds.finishStepOver).filter(
    (j) => only === undefined || only === null || only.subarray(j * hf.nx, (j + 1) * hf.nx).some((v) => v === 1),
  );
  let flip = false;
  for (const [index, j] of rows.entries()) {
    onRow?.(index + 1, rows.length);
    const y = y0 + j * pitch;
    for (const [iS, iE] of coveredRuns(hf, j, only)) {
      const cols = alongColumns(hf, iS, iE, alongStep, only, j);
      const ordered = flip ? [...cols].reverse() : cols;
      let open = false;
      let prevX = 0;
      let prevY = 0;
      let prevZ = 0;
      for (const i of ordered) {
        const x = x0 + i * pitch;
        const z = tip[j * hf.nx + i] as number;
        if (!open) {
          moves.rapid(x, y, hopZ);
          moves.feed(x, y, z, feeds.plungeFeed);
          open = true;
        } else {
          const corner = staircaseCorner(prevX, prevY, prevZ, x, y, z);
          if (corner !== null) moves.feed(corner.x, corner.y, corner.z, feeds.feed);
          moves.feed(x, y, z, feeds.feed);
        }
        prevX = x;
        prevY = y;
        prevZ = z;
      }
      if (open) moves.rapid(moves.lastX(), moves.lastY(), hopZ);
    }
    flip = !flip;
  }
  if (moves.length > 0) moves.rapid(moves.lastX(), moves.lastY(), safeZ);
  return moves.view();
}

function positive(v: number | null | undefined): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

// ---------------------------------------------------------------------------
// #847 — THE REST PASS: a smaller ball over what the finish could not reach.
// ---------------------------------------------------------------------------

export interface SurfaceRestArgs {
  heightfield: GoalHeightfield;
  /** The finish's residual, measured by {@link surfaceResidual} over its OWN tip field. */
  residual: SurfaceResidual;
  /** The smaller ball being tried. */
  tool: SurfaceTool;
  /** The feeds the rest pass runs at — the job's 2.5D feeds, as the finish runs them. */
  feeds: SurfaceFeeds;
  rapid: RapidEstimate;
  /** The allowance the goal's roughing left; the rest's own residual is measured against it. */
  stockToLeaveMm: number;
  /** The rise above the goal that counts as material left, mm. */
  toleranceMm: number;
  /** Sampling pitch along a raster line, mm; absent → the heightfield pitch. */
  alongStepMm?: number;
  safeZ?: number;
  hopZ?: number;
  /** The rest ball's tip-field op budget; absent → {@link DEFAULT_MAX_FINISH_TIP_OPS}. */
  maxFinishTipOps?: number;
  onRow?: (done: number, total: number) => void;
}

/** What one candidate ball's rest pass would do, as the pick compares it. */
export interface SurfaceRestPlan {
  /** The region actually cut: the residual dilated by the ball's radius. */
  region: Uint8Array;
  /** The pass's moves, over the region only. */
  moves: CamMove[];
  /** What THIS ball still leaves above the goal, measured from its own tip field. */
  residual: SurfaceResidual;
  /** The pass's cutting time, the pick's tie-break. */
  estimatedSeconds: number;
  /** The dilation the region took, mm (the ball's own radius). */
  dilationMm: number;
}

/**
 * #847 — PLAN ONE CANDIDATE REST BALL. The ball's own gouge-safe tip field is what its program
 * cuts, so the SAME finishing raster runs over the finish's residual dilated by the ball's radius
 * (its centre has to fit beside a cell to reach it), and the ball's residual is then measured from
 * that same field. The finish's raster settings (step-over, along-step, feeds) are reused unchanged:
 * the rest pass is the finish again, with a smaller ball, over less of the surface.
 *
 * Throws the tip-field budget's error for a candidate the grid cannot afford (the caller skips it).
 */
export function planSurfaceRest(args: SurfaceRestArgs): SurfaceRestPlan {
  const { heightfield: hf, residual, tool, feeds, rapid, stockToLeaveMm, toleranceMm } = args;
  const alongStep = positive(args.alongStepMm) ? (args.alongStepMm as number) : hf.pitch;
  const safeZ = args.safeZ ?? SAFE_Z;
  const hopZ = args.hopZ ?? HOP_Z;
  const maxOps = positive(args.maxFinishTipOps) ? (args.maxFinishTipOps as number) : DEFAULT_MAX_FINISH_TIP_OPS;
  const tip = finishTipField(hf, tool, maxOps);
  const region = dilateMask(hf, residual.mask, tool.radius);
  const moves = finishingMoves(hf, tip, feeds, alongStep, safeZ, hopZ, args.onRow, region, GOAL_MERGE_TOLERANCE_MM);
  return {
    region,
    moves,
    residual: surfaceResidual(hf, tip, stockToLeaveMm, toleranceMm),
    estimatedSeconds: estimateCycleSeconds(moves, rapid),
    dilationMm: tool.radius,
  };
}

/**
 * #847 — WHEN NOTHING OWNED REACHES THE RESIDUAL, the ball that would: halve the finish ball's
 * radius until its own tip field leaves less material above the goal, and name the first (largest)
 * that does. Pure geometry on the measured grid — no inventory, no simulation. Null when even a ball a
 * grid cell wide leaves the same cells, or when the goal had no residual to begin with.
 */
export function suggestedRestRadiusMm(
  hf: GoalHeightfield,
  finishResidual: SurfaceResidual,
  finishTool: SurfaceTool,
  stockToLeaveMm: number,
  toleranceMm: number,
  maxOps: number = DEFAULT_MAX_FINISH_TIP_OPS,
): number | null {
  if (finishResidual.cells === 0 || !(finishTool.radius > 0)) return null;
  let radius = finishTool.radius / 2;
  // Down to a ball no wider than the grid's own cell: smaller than that, the grid cannot tell.
  for (let n = 0; n < 8 && radius >= hf.pitch / 2; n++) {
    let tip: Float32Array;
    try {
      tip = finishTipField(hf, { ball: true, radius }, maxOps);
    } catch {
      // Over the tip-field budget: a smaller ball is cheaper, so the next halving may fit.
      radius /= 2;
      continue;
    }
    const after = surfaceResidual(hf, tip, stockToLeaveMm, toleranceMm);
    if (after.volumeMm3 < finishResidual.volumeMm3 - 1e-9) return radius;
    radius /= 2;
  }
  return null;
}

// ---------------------------------------------------------------------------
// #671 — THE SCALLOP PASS: offset contours of the goal's footprint, projected onto the tip field.
// ---------------------------------------------------------------------------

/**
 * The tip field at an arbitrary XY: the MAX of the four cells bracketing the point. A cell's tip
 * is already the gouge-safe drop, and the max can only ride HIGHER than any of them, so a path
 * that crosses between cells can never dip below the safe drop the tip field promises.
 */
function tipAt(hf: GoalHeightfield, tip: Float32Array, x: number, y: number): number {
  const i0 = Math.min(hf.nx - 1, Math.max(0, Math.floor((x - hf.x0) / hf.pitch)));
  const j0 = Math.min(hf.ny - 1, Math.max(0, Math.floor((y - hf.y0) / hf.pitch)));
  const i1 = Math.min(hf.nx - 1, i0 + 1);
  const j1 = Math.min(hf.ny - 1, j0 + 1);
  return Math.max(
    tip[j0 * hf.nx + i0] as number,
    tip[j0 * hf.nx + i1] as number,
    tip[j1 * hf.nx + i0] as number,
    tip[j1 * hf.nx + i1] as number,
  );
}

/** The 1-D squared Euclidean distance transform (Felzenszwalb–Huttenlocher), in place. */
function edt1d(f: Float64Array, d: Float64Array, n: number, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!;
  }
}

/**
 * #671 — the exact Euclidean distance from each cell to the nearest cell the goal does not cover,
 * in mm. Uncovered cells are 0, so a contour of this field never leaves the footprint; the grid is
 * surrounded by one virtual uncovered ring so a goal that runs to the blank's edge still has a
 * boundary (its own outline, half a cell out). Rows then columns of the 1-D transform give the
 * exact 2-D answer on a grid — no chamfer approximation.
 */
function distanceField(hf: GoalHeightfield): Float32Array {
  const { nx, ny, covered, pitch } = hf;
  const INF = 1e12;
  // The padded field: (nx+2) × (ny+2), the border uncovered.
  const ex = nx + 2;
  const ey = ny + 2;
  const n = Math.max(ex, ey);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const grid = new Float64Array(ex * ey);
  for (let j = 0; j < ey; j++) {
    for (let i = 0; i < ex; i++) {
      const inner = i >= 1 && i <= nx && j >= 1 && j <= ny && covered[(j - 1) * nx + (i - 1)] === 1;
      grid[j * ex + i] = inner ? INF : 0;
    }
  }
  for (let j = 0; j < ey; j++) {
    for (let i = 0; i < ex; i++) f[i] = grid[j * ex + i]!;
    edt1d(f, d, ex, v, z);
    for (let i = 0; i < ex; i++) grid[j * ex + i] = d[i]!;
  }
  for (let i = 0; i < ex; i++) {
    for (let j = 0; j < ey; j++) f[j] = grid[j * ex + i]!;
    edt1d(f, d, ey, v, z);
    for (let j = 0; j < ey; j++) grid[j * ex + i] = d[j]!;
  }
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      out[j * nx + i] = Math.sqrt(grid[(j + 1) * ex + (i + 1)]!) * pitch;
    }
  }
  return out;
}

/** The heightfield's gradient magnitude at a covered cell (central, one-sided at the footprint edge). */
function slopeAt(hf: GoalHeightfield, i: number, j: number): number {
  const { nx, ny, covered, z } = hf;
  const h = (ii: number, jj: number): number | null =>
    ii < 0 || ii >= nx || jj < 0 || jj >= ny || covered[jj * nx + ii] === 0
      ? null
      : (z[jj * nx + ii] as number);
  const g = (a: number | null, b: number | null, span: number): number => {
    if (a !== null && b !== null) return (a - b) / (2 * hf.pitch * span);
    if (a !== null) return (h(i, j)! - a) / (hf.pitch * span);
    if (b !== null) return (h(i, j)! - b) / (hf.pitch * span);
    return 0;
  };
  const gx = g(h(i + 1, j), h(i - 1, j), 1);
  const gy = g(h(i, j + 1), h(i, j - 1), 1);
  return Math.hypot(gx, gy);
}

/**
 * #671 — iso-lines of the distance field at `level`, as polylines in work XY. Marching squares
 * with linear crossings; the two saddle cases are resolved by the cell's mean value, so the walk
 * is deterministic. Uncovered neighbours read 0, which is exactly what the field holds there, so
 * a contour closes inside the footprint.
 */
function contourLoops(hf: GoalHeightfield, field: Float32Array, level: number): [number, number][][] {
  const { nx, ny, x0, y0, pitch } = hf;
  const at = (i: number, j: number): number =>
    i < 0 || i >= nx || j < 0 || j >= ny ? 0 : (field[j * nx + i] as number);
  const px = (i: number): number => x0 + i * pitch;
  const py = (j: number): number => y0 + j * pitch;
  const cross = (va: number, vb: number, p1: [number, number], p2: [number, number]): [number, number] => {
    const t = vb === va ? 0.5 : (level - va) / (vb - va);
    return [p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1])];
  };
  const segs: { a: [number, number]; b: [number, number] }[] = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const e = at(i, j + 1);
      const code = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (e >= level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const bot = (): [number, number] => cross(a, b, [px(i), py(j)], [px(i + 1), py(j)]);
      const right = (): [number, number] => cross(b, c, [px(i + 1), py(j)], [px(i + 1), py(j + 1)]);
      const top = (): [number, number] => cross(e, c, [px(i), py(j + 1)], [px(i + 1), py(j + 1)]);
      const left = (): [number, number] => cross(a, e, [px(i), py(j)], [px(i), py(j + 1)]);
      switch (code) {
        case 1:
        case 14:
          segs.push({ a: left(), b: bot() });
          break;
        case 2:
        case 13:
          segs.push({ a: bot(), b: right() });
          break;
        case 3:
        case 12:
          segs.push({ a: left(), b: right() });
          break;
        case 4:
        case 11:
          segs.push({ a: right(), b: top() });
          break;
        case 6:
        case 9:
          segs.push({ a: bot(), b: top() });
          break;
        case 7:
        case 8:
          segs.push({ a: left(), b: top() });
          break;
        case 5:
        case 10: {
          const mid = (a + b + c + e) / 4;
          const highCorners = code === 5 ? mid >= level : mid < level;
          if (highCorners) {
            segs.push({ a: left(), b: top() });
            segs.push({ a: bot(), b: right() });
          } else {
            segs.push({ a: left(), b: bot() });
            segs.push({ a: right(), b: top() });
          }
          break;
        }
        default:
          break;
      }
    }
  }
  // Join the segments end to end into polylines. Shared crossings are computed from the same two
  // cell values in the same order, so the coordinates are bit-identical and the keys match.
  const key = (p: [number, number]): string => `${p[0]}|${p[1]}`;
  const ends = new Map<string, number[]>();
  segs.forEach((s, k) => {
    for (const p of [s.a, s.b]) {
      const list = ends.get(key(p));
      if (list === undefined) ends.set(key(p), [k]);
      else list.push(k);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops: [number, number][][] = [];
  for (let k = 0; k < segs.length; k++) {
    if (used[k] === 1) continue;
    used[k] = 1;
    const first = segs[k]!;
    const chain: [number, number][] = [first.a, first.b];
    let curKey = key(first.b);
    for (;;) {
      if (curKey === key(chain[0]!)) break;
      const next = (ends.get(curKey) ?? []).find((ix) => used[ix] === 0);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next]!;
      const nextPoint = key(s.a) === curKey ? s.b : s.a;
      chain.push(nextPoint);
      curKey = key(nextPoint);
    }
    // A closed loop repeats its start as the last point; drop the repeat (the caller closes it).
    if (chain.length > 1 && key(chain[chain.length - 1]!) === key(chain[0]!)) chain.pop();
    if (chain.length >= 2) loops.push(chain);
  }
  return loops;
}

/**
 * #671 — THE SCALLOP PASS. Contours of the footprint's distance field, spaced by
 * `finishStepOver / sqrt(1 + s²)` with `s` the steepest slope in the band to be crossed: the
 * distance measured ALONG THE SURFACE is held at the finishing step-over (clamped at
 * {@link MAX_SCALLOP_CROWDING} where the wall is too steep for that to be useful). Each contour
 * rides the tip field, so it is gouge-safe by the same construction as the finishing raster.
 */
function scallopMoves(
  hf: GoalHeightfield,
  tip: Float32Array,
  feeds: SurfaceFeeds,
  alongStep: number,
  safeZ: number,
  hopZ: number,
  maxContours: number,
): { moves: CamMove[]; contours: number; clamped: boolean } {
  const moves: CamMove[] = [];
  if (hf.coveredCount === 0) return { moves, contours: 0, clamped: false };
  const step = feeds.finishStepOver;
  if (!(step > 0)) {
    throw new Error(
      `3D scallop finishing needs a positive step-over; the feeds gave ${step} mm. ` +
        'A zero or negative step-over cannot space the contours — check the feed row for this tool and material.',
    );
  }
  const D = distanceField(hf);
  let maxD = 0;
  for (let k = 0; k < D.length; k++) if ((hf.covered[k] as number) === 1 && D[k]! > maxD) maxD = D[k]!;
  if (!(maxD > 0)) return { moves, contours: 0, clamped: false };

  // The slope field, once: the band scan per level is then a lookup.
  const slope = new Float32Array(hf.nx * hf.ny);
  for (let j = 0; j < hf.ny; j++) {
    for (let i = 0; i < hf.nx; i++) {
      if (hf.covered[j * hf.nx + i] === 1) slope[j * hf.nx + i] = slopeAt(hf, i, j);
    }
  }
  // The work, bounded BEFORE the loop: every level walks the grid (the band scan and the marching
  // squares). Refuse honestly rather than grind a worker, as #540's tip budget does.
  const estimatedLevels = Math.min(maxContours, Math.ceil((maxD * MAX_SCALLOP_CROWDING) / step) + 1);
  const ops = estimatedLevels * hf.nx * hf.ny;
  if (ops > 4_000_000_000) {
    throw new Error(
      `3D scallop finishing would need about ${ops} grid evaluations (${estimatedLevels} contours over a ` +
        `${hf.nx}×${hf.ny} grid), which is too much for one pass. Use a coarser grid pitch, a larger ` +
        'step-over, or a smaller goal.',
    );
  }

  const levels: number[] = [];
  let d = step / 2;
  let delta = step;
  let clamped = false;
  while (d < maxD) {
    if (levels.length > maxContours) {
      throw new Error(
        `3D scallop finishing would need more than ${maxContours} contours at a ${step} mm surface ` +
          `step-over over a ${maxD.toFixed(2)} mm footprint. Use a larger step-over, or a coarser grid.`,
      );
    }
    levels.push(d);
    let s = 0;
    for (let k = 0; k < D.length; k++) {
      const dk = D[k]!;
      if ((hf.covered[k] as number) === 1 && dk >= d && dk <= d + delta) {
        const sk = slope[k]!;
        if (sk > s) s = sk;
      }
    }
    let crowd = Math.sqrt(1 + s * s);
    if (crowd > MAX_SCALLOP_CROWDING) {
      crowd = MAX_SCALLOP_CROWDING;
      clamped = true;
    }
    delta = step / crowd;
    d += delta;
  }

  let contours = 0;
  for (const level of levels) {
    for (const loop of contourLoops(hf, D, level)) {
      const pts = decimateLoop(loop, alongStep);
      if (pts.length < 2) continue;
      const first = pts[0]!;
      const firstZ = tipAt(hf, tip, first[0], first[1]);
      moves.push({ kind: 'rapid', x: first[0], y: first[1], z: hopZ });
      moves.push({ kind: 'feed', x: first[0], y: first[1], z: firstZ, f: feeds.plungeFeed });
      let prevX = first[0];
      let prevY = first[1];
      let prevZ = firstZ;
      // #945 — a contour crossing a step (two decimated points either side of it) is the same
      // steep-diagonal hazard the raster pass has; the shared staircase applies here too.
      const stepTo = (x: number, y: number, z: number): void => {
        const corner = staircaseCorner(prevX, prevY, prevZ, x, y, z);
        if (corner !== null) moves.push({ kind: 'feed', x: corner.x, y: corner.y, z: corner.z, f: feeds.feed });
        moves.push({ kind: 'feed', x, y, z, f: feeds.feed });
        prevX = x;
        prevY = y;
        prevZ = z;
      };
      for (let p = 1; p < pts.length; p++) {
        const q = pts[p]!;
        stepTo(q[0], q[1], tipAt(hf, tip, q[0], q[1]));
      }
      // Close the loop: the contour is a closed curve, so the last point returns to the first.
      const last = pts[pts.length - 1]!;
      if (last[0] !== first[0] || last[1] !== first[1]) {
        stepTo(first[0], first[1], firstZ);
      }
      moves.push({ kind: 'rapid', x: first[0], y: first[1], z: hopZ });
      contours++;
    }
  }
  if (moves.length > 0) moves.push({ kind: 'rapid', x: moves[moves.length - 1]!.x, y: moves[moves.length - 1]!.y, z: safeZ });
  return { moves, contours, clamped };
}

/** Drop loop points closer than `alongStep` to the last kept one (the first and last always stay). */
function decimateLoop(loop: [number, number][], alongStep: number): [number, number][] {
  if (loop.length <= 2) return loop;
  const out: [number, number][] = [loop[0]!];
  for (let p = 1; p < loop.length; p++) {
    const q = loop[p]!;
    const last = out[out.length - 1]!;
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= alongStep || p === loop.length - 1) out.push(q);
  }
  return out;
}

/**
 * #862 — THE RIM PASS: contour laps around the covered boundary, down the clear band's wall.
 *
 * A goal cut with a clear ring (#764) is a plateau out of the stock; its outer edge is a vertical
 * wall between the band floor and the stock top. The roughing's raster reaches that wall only with
 * its row ends, so the wall keeps the raster's step-over as vertical ridges and its top edge as
 * ball bites. A contour lap at Z has the ball's equator at Z + radius touching the wall there, so
 * laps from the stock top down to the floor cut the wall as one contour surface instead.
 *
 * The path is the boundary cells' centres — the distance field's first contour, at one pitch — so
 * the wall stands exactly where the roughing's outermost pass left it. A lap cuts only where the
 * boundary cell's own surface is at or below it: over a part's own rim (a goal clipped at the
 * stock edge) the wall stops at the surface, and the lap must not gouge below it.
 */
function rimMoves(
  hf: GoalHeightfield,
  tool: SurfaceTool,
  feeds: SurfaceFeeds,
  floorZ: number,
  alongStep: number,
  safeZ: number,
  hopZ: number,
  /** #889 — count the moves without holding them (the budget's estimate); no tip field either. */
  countOnly = false,
): { moves: CamMove[]; laps: number; tip: Float32Array | null; count: number } {
  // #889 — packed and merged like the raster passes: a lap's straight stretches are one move.
  const moves = new MoveStore({ mergeToleranceMm: GOAL_MERGE_TOLERANCE_MM, countOnly });
  if (hf.coveredCount === 0 || !(feeds.stepDown > 0)) return { moves: [], laps: 0, tip: null, count: 0 };
  const D = distanceField(hf);
  // Decimated at the finishing step-over: the rim's own chord facets are then the size of the
  // finish's, so the wall carries no coarser a pattern than the floor beside it.
  const along = Math.max(alongStep, feeds.finishStepOver > 0 ? feeds.finishStepOver : 0);
  // The distance field's first expressible contour sits one cell in from the edge; 5 % of a pitch
  // past that puts the path on the boundary cells' centres, where the roughing's outermost pass
  // ran — a plateau at exactly one pitch has no contour at all.
  const boundaryLevel = hf.pitch * 1.05;
  const paths = contourLoops(hf, D, boundaryLevel)
    .map((loop) => decimateLoop(loop, along))
    .filter((loop) => loop.length >= 2);
  if (paths.length === 0) return { moves: [], laps: 0, tip: null, count: 0 };
  // The wall's foot at a contour point: the highest covered cell the CUTTER'S DISC reaches there
  // (cells as squares). A 3×3 window read only the corner's own band cells and missed the part a
  // ball's radius away: at a tight corner (a band narrower than the tool) the lap's flank then cut
  // the part's rounded edge down to the floor — a 10 mm gouge on the STEP-accuracy fixture (#909).
  const footReach = tool.radius + hf.pitch;
  const footSpan = Math.max(1, Math.ceil(footReach / hf.pitch));
  const footAt = (x: number, y: number): number => {
    const i = Math.round((x - hf.x0) / hf.pitch);
    const j = Math.round((y - hf.y0) / hf.pitch);
    let foot = -Infinity;
    for (let dj = -footSpan; dj <= footSpan; dj++) {
      for (let di = -footSpan; di <= footSpan; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= hf.nx || jj >= hf.ny) continue;
        const d = cellSquareDistance(di * hf.pitch, dj * hf.pitch, hf.pitch);
        if (d > footReach) continue;
        const k = jj * hf.nx + ii;
        if (hf.covered[k] === 1) foot = Math.max(foot, hf.z[k] as number);
      }
    }
    return foot === -Infinity ? hf.topZ : foot;
  };

  const levels: number[] = [];
  for (let L = hf.topZ - feeds.stepDown; L > floorZ + 1e-9; L -= feeds.stepDown) levels.push(L);
  levels.push(floorZ);

  for (const L of levels) {
    for (const pts of paths) {
      const n = pts.length;
      const cut = pts.map((p) => footAt(p[0], p[1]) <= L + 1e-9);
      const rapidsOut = (x: number, y: number): void => {
        moves.push({ kind: 'rapid', x, y, z: hopZ });
      };
      if (cut.every(Boolean)) {
        const first = pts[0]!;
        rapidsOut(first[0], first[1]);
        moves.push({ kind: 'feed', x: first[0], y: first[1], z: L, f: feeds.plungeFeed });
        for (let p = 1; p < n; p++) {
          const q = pts[p]!;
          moves.push({ kind: 'feed', x: q[0], y: q[1], z: L, f: feeds.feed });
        }
        const last = pts[n - 1]!;
        if (last[0] !== first[0] || last[1] !== first[1]) {
          moves.push({ kind: 'feed', x: first[0], y: first[1], z: L, f: feeds.feed });
        }
        rapidsOut(first[0], first[1]);
        continue;
      }
      // Split runs: start after a skipped point so every run is found exactly once.
      const start = cut.indexOf(false);
      let inRun = false;
      for (let s = 1; s <= n; s++) {
        const idx = (start + s) % n;
        const q = pts[idx]!;
        if (cut[idx] === true) {
          if (!inRun) {
            rapidsOut(q[0], q[1]);
            moves.push({ kind: 'feed', x: q[0], y: q[1], z: L, f: feeds.plungeFeed });
            inRun = true;
          } else {
            moves.push({ kind: 'feed', x: q[0], y: q[1], z: L, f: feeds.feed });
          }
        } else if (inRun) {
          const prev = pts[(start + s - 1) % n]!;
          rapidsOut(prev[0], prev[1]);
          inRun = false;
        }
      }
      if (inRun) {
        const prev = pts[(start + n) % n]!;
        rapidsOut(prev[0], prev[1]);
      }
    }
  }
  // #847 — WHAT THE LAPS LEAVE, cell for cell. Their deepest level is the band floor, so around
  // every path point the cutter's underside cuts to `floorZ + rise(d)` within its radius; the rest
  // of the grid is untouched (Infinity). Distances are to the sampled POINTS, never shorter than to
  // the chord between them, so the field cannot claim a cut the laps did not make.
  let lapTip: Float32Array | null = null;
  const radius = tool.radius;
  if (radius > 0 && !countOnly) {
    lapTip = new Float32Array(hf.nx * hf.ny);
    lapTip.fill(Infinity);
    for (const pts of paths) {
      for (const [x, y] of pts) {
        const i0 = Math.max(0, Math.ceil((x - radius - hf.x0) / hf.pitch));
        const i1 = Math.min(hf.nx - 1, Math.floor((x + radius - hf.x0) / hf.pitch));
        const j0 = Math.max(0, Math.ceil((y - radius - hf.y0) / hf.pitch));
        const j1 = Math.min(hf.ny - 1, Math.floor((y + radius - hf.y0) / hf.pitch));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const d = Math.hypot(hf.x0 + i * hf.pitch - x, hf.y0 + j * hf.pitch - y);
            if (!(d < radius)) continue;
            const cut = floorZ + ballRise(tool.ball, radius, d);
            const k = j * hf.nx + i;
            if (cut < (lapTip[k] as number)) lapTip[k] = cut;
          }
        }
      }
    }
  }
  if (moves.length > 0) moves.rapid(moves.lastX(), moves.lastY(), safeZ);
  return { moves: countOnly ? [] : moves.view(), laps: levels.length, tip: lapTip, count: moves.length };
}


// ---------------------------------------------------------------------------
// #671 — THE PENCIL PASS: one path along every concave crease the heightfield shows.
// ---------------------------------------------------------------------------

/**
 * The cells where the surface turns CONCAVE by more than the crease angle: the second difference
 * along x, y or either diagonal (over covered neighbours only) is steeper than `tan(creaseDeg)`
 * per unit length. A wall's foot marks a line; a dome (`c < 0`), a ramp (`c = 0`) and a convex
 * edge mark nothing, and an uncovered neighbour is absent rather than a false wall at the edge.
 */
function pencilMarks(hf: GoalHeightfield, creaseDeg: number): Uint8Array {
  const { nx, ny, covered, z, pitch } = hf;
  const marks = new Uint8Array(nx * ny);
  const threshold = Math.tan((creaseDeg * Math.PI) / 180);
  const h = (i: number, j: number): number => z[j * nx + i] as number;
  const ok = (i: number, j: number): boolean =>
    i >= 0 && i < nx && j >= 0 && j < ny && covered[j * nx + i] === 1;
  const dirs: [number, number, number][] = [
    [1, 0, 1],
    [0, 1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
  ];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (covered[j * nx + i] === 0) continue;
      const here = h(i, j);
      for (const [di, dj, span] of dirs) {
        if (!ok(i - di, j - dj) || !ok(i + di, j + dj)) continue;
        const second = (h(i - di, j - dj) + h(i + di, j + dj) - 2 * here) / (pitch * span);
        if (second > threshold) {
          marks[j * nx + i] = 1;
          break;
        }
      }
    }
  }
  return marks;
}

/**
 * Trace the marked cells into paths: 8-connected, deterministic — the lowest unvisited cell starts
 * a path, then a greedy walk follows the neighbour that best continues the current direction
 * (first in a fixed offset order on a tie). Junctions split into more paths, which is honest: each
 * one is still a stretch of crease, cut at the same tip.
 */
function tracePencilPaths(marks: Uint8Array, hf: GoalHeightfield): [number, number][][] {
  const { nx, ny, x0, y0, pitch } = hf;
  const visited = new Uint8Array(marks.length);
  const offs: [number, number][] = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  const paths: [number, number][][] = [];
  for (let k0 = 0; k0 < marks.length; k0++) {
    if (marks[k0] === 0 || visited[k0] === 1) continue;
    const cells: number[] = [k0];
    visited[k0] = 1;
    let cur = k0;
    let dir: [number, number] | null = null;
    for (;;) {
      const ci = cur % nx;
      const cj = (cur - ci) / nx;
      let best: number | null = null;
      let bestScore = -Infinity;
      for (const [di, dj] of offs) {
        const ii = ci + di;
        const jj = cj + dj;
        if (ii < 0 || ii >= nx || jj < 0 || jj >= ny) continue;
        const idx = jj * nx + ii;
        if (marks[idx] === 0 || visited[idx] === 1) continue;
        const len = Math.hypot(di, dj);
        const score = dir === null ? 0 : (dir[0] * di + dir[1] * dj) / len;
        if (score > bestScore) {
          bestScore = score;
          best = idx;
        }
      }
      if (best === null) break;
      const ni = best % nx;
      const nj = (best - ni) / nx;
      dir = [Math.sign(ni - ci), Math.sign(nj - cj)];
      visited[best] = 1;
      cells.push(best);
      cur = best;
    }
    if (cells.length >= 2) {
      paths.push(cells.map((idx) => {
        const i = idx % nx;
        const j = (idx - i) / nx;
        return [x0 + i * pitch, y0 + j * pitch] as [number, number];
      }));
    }
  }
  return paths;
}

/** #671 — THE PENCIL PASS: every traced crease, cut at the tip field like the finishing raster. */
function pencilMoves(
  hf: GoalHeightfield,
  tip: Float32Array,
  feeds: SurfaceFeeds,
  safeZ: number,
  hopZ: number,
  creaseDeg: number,
): { moves: CamMove[]; paths: number } {
  const moves: CamMove[] = [];
  if (hf.coveredCount === 0) return { moves, paths: 0 };
  const paths = tracePencilPaths(pencilMarks(hf, creaseDeg), hf);
  for (const path of paths) {
    const first = path[0]!;
    const firstZ = tipAt(hf, tip, first[0], first[1]);
    moves.push({ kind: 'rapid', x: first[0], y: first[1], z: hopZ });
    moves.push({ kind: 'feed', x: first[0], y: first[1], z: firstZ, f: feeds.plungeFeed });
    // #945 — a crease runs straight down a step as often as along it; the shared staircase
    // applies here too (the raster pass's own note explains why).
    let prevX = first[0];
    let prevY = first[1];
    let prevZ = firstZ;
    for (let p = 1; p < path.length; p++) {
      const q = path[p]!;
      const z = tipAt(hf, tip, q[0], q[1]);
      const corner = staircaseCorner(prevX, prevY, prevZ, q[0], q[1], z);
      if (corner !== null) moves.push({ kind: 'feed', x: corner.x, y: corner.y, z: corner.z, f: feeds.feed });
      moves.push({ kind: 'feed', x: q[0], y: q[1], z, f: feeds.feed });
      prevX = q[0];
      prevY = q[1];
      prevZ = z;
    }
    const last = path[path.length - 1]!;
    moves.push({ kind: 'rapid', x: last[0], y: last[1], z: hopZ });
  }
  if (moves.length > 0) moves.push({ kind: 'rapid', x: moves[moves.length - 1]!.x, y: moves[moves.length - 1]!.y, z: safeZ });
  return { moves, paths: paths.length };
}
