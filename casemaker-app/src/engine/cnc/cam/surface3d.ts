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
 *        the goal within the step-over and the grid pitch without cutting through it.
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
import { cuttingDiameter } from '../tool';

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
 * The finishing tip-field compute budget (#540): the ball drop is O(covered cells × disc-stencil
 * cells), so a large ball on a fine grid is billions of inner-loop ops with no cutoff — enough to
 * hang the worker. Above this cap {@link finishTipField} REFUSES honestly (it states the op count
 * and the fix), mirroring the exact sweep's `sweep-budget-exceeded` rather than running to a hang.
 * 300 M evaluations is comfortably past any real small-ball/coarse-grid job yet well under the
 * ~2.8 billion a 3 mm ball at 0.1 mm over a near-cap grid would cost.
 */
export const DEFAULT_MAX_FINISH_TIP_OPS = 300_000_000;

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

export interface SampleGoalOpts {
  /** The shop's `sim.columnFlatPitchYMm`; absent → {@link DEFAULT_GRID_PITCH_MM}. */
  pitchMm?: number | null;
  /** The grid cap; absent → {@link DEFAULT_MAX_CELLS}. */
  maxCells?: number | null;
  /** Work Z of the stock top, mm; absent → 0 (the flat frame's own top). */
  stockTopZ?: number;
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
  target: Pick<EngraveTargetObject, 'sha256' | 'format' | 'data' | 'position' | 'rotation'>,
  opts: SampleGoalOpts = {},
): GoalHeightfield {
  const mesh = targetObjectMesh(target);
  const topZ = opts.stockTopZ ?? 0;
  const requestedPitch = positive(opts.pitchMm) ? (opts.pitchMm as number) : DEFAULT_GRID_PITCH_MM;
  const maxCells = positive(opts.maxCells) ? (opts.maxCells as number) : DEFAULT_MAX_CELLS;

  // The placed mesh's XY footprint, from the LOCAL bbox's four XY corners rotated about the bbox
  // centre (a rotated rectangle), so the grid is sized for the object as it sits on the stock.
  const [cx, cy] = [
    (mesh.bbox.min[0] + mesh.bbox.max[0]) / 2,
    (mesh.bbox.min[1] + mesh.bbox.max[1]) / 2,
  ];
  const maxZLocal = mesh.bbox.max[2];
  const theta = (target.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const place = (px: number, py: number, pz: number): [number, number, number] => {
    const lx = px - cx;
    const ly = py - cy;
    return [
      target.position.x + (lx * cos - ly * sin),
      target.position.y + (lx * sin + ly * cos),
      pz + (target.position.z - maxZLocal),
    ];
  };

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const [bx, by] of [
    [mesh.bbox.min[0], mesh.bbox.min[1]],
    [mesh.bbox.max[0], mesh.bbox.min[1]],
    [mesh.bbox.max[0], mesh.bbox.max[1]],
    [mesh.bbox.min[0], mesh.bbox.max[1]],
  ] as const) {
    const [wx, wy] = place(bx, by, 0);
    xMin = Math.min(xMin, wx);
    xMax = Math.max(xMax, wx);
    yMin = Math.min(yMin, wy);
    yMax = Math.max(yMax, wy);
  }
  const extentX = xMax - xMin;
  const extentY = yMax - yMin;

  // The cap, honoured by COARSENING (design doc §2) — never a refusal. Scale the pitch up by the
  // square root of the overshoot so the cell count lands at the cap.
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

  const x0 = xMin;
  const y0 = yMin;
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

  let minZ = topZ;
  let coveredCount = 0;
  for (let k = 0; k < z.length; k++) {
    if (covered[k] === 1) {
      coveredCount++;
      if ((z[k] as number) < minZ) minZ = z[k] as number;
    }
  }

  const resolutionNote = coarsened
    ? `sampled on a ${pitch.toFixed(4)} mm grid (coarsened from the requested ${requestedPitch} mm: ` +
      `the footprint would need ${Math.ceil(extentX / requestedPitch) * Math.ceil(extentY / requestedPitch)} cells, ` +
      `over the ${maxCells}-cell cap)`
    : `sampled on a ${pitch} mm grid`;

  return { nx, ny, x0, y0, pitch, topZ, minZ, z, covered, coveredCount, resolutionNote };
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

export interface SurfaceOpts {
  /** Roughing allowance left on the goal surface, mm; absent → {@link DEFAULT_STOCK_TO_LEAVE_MM}. */
  stockToLeaveMm?: number;
  /** Sampling pitch ALONG a raster line, mm; absent → the heightfield pitch (tightest sim match). */
  alongStepMm?: number;
  /** Inter-pass retract above the stock top, mm; absent → {@link SAFE_Z}. */
  safeZ?: number;
  /** Intra-pass hop above the stock top, mm; absent → {@link HOP_Z}. */
  hopZ?: number;
  /** Finishing tip-field op budget; absent → {@link DEFAULT_MAX_FINISH_TIP_OPS} (#540). */
  maxFinishTipOps?: number;
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
  opts?: SurfaceOpts;
}

export interface Surface3dResult {
  ir: ToolpathIR;
  /** The roughing operation (0 moves when nothing stands above the goal + allowance). */
  roughing: CamOperation;
  /** The ball-nose finishing operation. */
  finishing: CamOperation;
  /** Labelled placeholders and limitations for the run sheet (feeds, undercuts, flat finish). */
  notes: string[];
}

/**
 * Generate the roughing + finishing surfacing IR for a goal heightfield (stage 2).
 *
 * The two operations share one machine state, so they post as one program. Roughing is operation
 * 1, finishing operation 2 — rough the bulk, then finish the surface.
 */
export function generateSurface3dIR(args: Surface3dArgs): Surface3dResult {
  const { heightfield: hf, tool, feeds, opts = {} } = args;
  const allowance = opts.stockToLeaveMm ?? DEFAULT_STOCK_TO_LEAVE_MM;
  const alongStep = positive(opts.alongStepMm) ? (opts.alongStepMm as number) : hf.pitch;
  const safeZ = opts.safeZ ?? SAFE_Z;
  const hopZ = opts.hopZ ?? HOP_Z;
  const maxFinishTipOps = positive(opts.maxFinishTipOps)
    ? (opts.maxFinishTipOps as number)
    : DEFAULT_MAX_FINISH_TIP_OPS;

  const notes: string[] = [
    'Feeds are the job’s 2.5D feeds reused unchanged; cutting feeds for 3D engagement are the bench slice (#536) and are not tuned here.',
    'A heightfield has one top-Z per (x, y): undercuts and overhangs cannot be expressed, so hidden material below the topmost surface is left standing (the 3-axis answer).',
    `Resolution: ${hf.resolutionNote}.`,
  ];
  if (!tool.ball) {
    notes.push(
      'The finishing cutter is not a ball nose; a flat tool drops onto the highest point under its disc and cannot enter concavities, so the finish is faceted — use a ball for a 3D surface.',
    );
  }

  const roughMoves = roughingMoves(hf, feeds, allowance, alongStep, safeZ, hopZ);
  const finishMoves = finishingMoves(hf, tool, feeds, alongStep, safeZ, hopZ, maxFinishTipOps);

  const depth = Math.max(0, hf.topZ - hf.minZ);
  const roughing: CamOperation = {
    number: 1,
    name: `[T${args.toolNumber}] 3D rough — ${allowance} mm to leave`,
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

  const ir: ToolpathIR = {
    frame: 'flat',
    tool: args.toolObj,
    toolNumber: args.toolNumber,
    spindleRpm: args.spindleRpm,
    air: args.air,
    safeZ,
    hopZ,
    operations: [roughing, finishing],
  };

  return { ir, roughing, finishing, notes };
}

/**
 * Build the surfacing IR straight from a goal `EngraveTargetObject` and a `Tool` (the dispatch's
 * convenience entry). Returns `null` when the field covers nothing — a goal entirely at or above
 * the stock top has no surface to cut.
 */
export function generateSurface3dForGoal(args: {
  target: Pick<EngraveTargetObject, 'id' | 'sha256' | 'format' | 'data' | 'position' | 'rotation'>;
  tool: Tool;
  toolNumber: number;
  spindleRpm: number;
  air: boolean;
  feeds: SurfaceFeeds;
  rapid: RapidEstimate;
  sample?: SampleGoalOpts;
  opts?: SurfaceOpts;
}): (Surface3dResult & { heightfield: GoalHeightfield }) | null {
  const heightfield = sampleGoalHeightfield(args.target, args.sample);
  if (heightfield.coveredCount === 0) return null;
  const d = cuttingDiameter(args.tool);
  const radius = d !== null && d > 0 ? d / 2 : 0;
  const surfaceTool: SurfaceTool = { radius, ball: args.tool.shape === 'ball' || args.tool.shape === 'bull' };
  const result = generateSurface3dIR({
    heightfield,
    tool: surfaceTool,
    toolObj: args.tool,
    toolNumber: args.toolNumber,
    spindleRpm: args.spindleRpm,
    air: args.air,
    feeds: args.feeds,
    rapid: args.rapid,
    labelId: args.target.id,
    opts: args.opts,
  });
  return { ...result, heightfield };
}

/** The height a ball of `radius` rises above its tip at radial distance `d` (0 for a flat tool). */
function ballRise(ball: boolean, radius: number, d: number): number {
  if (!ball || radius <= 0) return 0;
  if (d >= radius) return radius;
  return radius - Math.sqrt(radius * radius - d * d);
}

/** The gouge-safe tip field: the tool dropped onto the heightfield until it just touches. */
function finishTipField(hf: GoalHeightfield, tool: SurfaceTool, maxOps: number): Float32Array {
  const { nx, ny, z, covered, pitch, topZ } = hf;
  const tip = new Float32Array(nx * ny);
  tip.fill(topZ);
  const span = Math.max(0, Math.floor(tool.radius / pitch));
  // Precompute the disc stencil: offsets within the tool radius and the ball rise there.
  const stencil: { di: number; dj: number; rise: number }[] = [];
  for (let dj = -span; dj <= span; dj++) {
    for (let di = -span; di <= span; di++) {
      const d = Math.hypot(di * pitch, dj * pitch);
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
        const jj = j + s.dj;
        if (ii < 0 || ii >= nx || jj < 0 || jj >= ny) {
          // Off the grid is uncut stock at the top face — the tool rides on it.
          best = Math.max(best, topZ - s.rise);
          continue;
        }
        best = Math.max(best, (z[jj * nx + ii] as number) - s.rise);
      }
      tip[idx] = best;
    }
  }
  return tip;
}

/** Contiguous runs of covered columns in grid-row `j`, as `[iStart, iEnd]` inclusive pairs. */
function coveredRuns(hf: GoalHeightfield, j: number): [number, number][] {
  const { nx, covered } = hf;
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < nx; i++) {
    const on = covered[j * nx + i] === 1;
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
function alongColumns(hf: GoalHeightfield, iStart: number, iEnd: number, alongStep: number): number[] {
  const stride = Math.max(1, Math.round(alongStep / hf.pitch));
  const cols: number[] = [];
  for (let i = iStart; i <= iEnd; i += stride) cols.push(i);
  if (cols.length === 0 || cols[cols.length - 1] !== iEnd) cols.push(iEnd);
  return cols;
}

/**
 * RASTER ROUGHING in step-down layers (stage 2a). For each Z layer from the top down, the tool
 * rasters the footprint; at each sample its tip rides at the layer Z, clamped UP to `H + allowance`
 * so it never reaches the goal surface. A sample where the clamp reaches the stock top has no
 * material to remove and opens a gap — the pass retracts and re-enters.
 */
function roughingMoves(
  hf: GoalHeightfield,
  feeds: SurfaceFeeds,
  allowance: number,
  alongStep: number,
  safeZ: number,
  hopZ: number,
): CamMove[] {
  const moves: CamMove[] = [];
  if (hf.coveredCount === 0) return moves;
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
  // The clamp surface: how high the tool must stay at each covered column.
  const floorAt = (i: number, j: number): number => {
    const idx = j * hf.nx + i;
    if (hf.covered[idx] === 0) return topZ; // no goal here: nothing to remove
    return (hf.z[idx] as number) + allowance;
  };
  // Layers: step down from the top until the deepest clamp (minZ + allowance) is reached.
  const deepest = minZ + allowance;
  const levels: number[] = [];
  for (let L = topZ - feeds.stepDown; L > deepest + 1e-9; L -= feeds.stepDown) levels.push(L);
  levels.push(deepest); // the final layer rides the allowance surface exactly
  const rows = rasterRows(hf, feeds.roughStepOver);

  for (const L of levels) {
    let flip = false;
    for (const j of rows) {
      const y = y0 + j * pitch;
      for (const [iS, iE] of coveredRuns(hf, j)) {
        const cols = alongColumns(hf, iS, iE, alongStep);
        const ordered = flip ? [...cols].reverse() : cols;
        // Build the tip along the run, cutting only where the layer is below the clamp surface
        // (there is material above L). Contiguous cut spans become one feed polyline each.
        let open = false;
        for (const i of ordered) {
          const x = x0 + i * pitch;
          const clamp = floorAt(i, j);
          const tip = Math.max(L, clamp);
          const cut = tip < topZ - 1e-9; // something stands above the tip here
          if (cut) {
            if (!open) {
              moves.push({ kind: 'rapid', x, y, z: hopZ });
              moves.push({ kind: 'feed', x, y, z: tip, f: feeds.plungeFeed });
              open = true;
            } else {
              moves.push({ kind: 'feed', x, y, z: tip, f: feeds.feed });
            }
          } else if (open) {
            moves.push({ kind: 'rapid', x, y, z: hopZ });
            open = false;
          }
        }
        if (open) {
          // Retract at the run's end.
          const last = moves[moves.length - 1]!;
          moves.push({ kind: 'rapid', x: last.x, y: last.y, z: hopZ });
        }
      }
      flip = !flip;
    }
  }
  if (moves.length > 0) moves.push({ kind: 'rapid', x: moves[moves.length - 1]!.x, y: moves[moves.length - 1]!.y, z: safeZ });
  return moves;
}

/**
 * BALL-NOSE FINISHING raster (stage 2b). The tool follows the gouge-safe tip field in boustrophedon
 * scan lines spaced by the finishing step-over, sampled along each line at `alongStep` so the dexel
 * sim of the result tracks the goal within the step-over and the grid pitch.
 */
function finishingMoves(
  hf: GoalHeightfield,
  tool: SurfaceTool,
  feeds: SurfaceFeeds,
  alongStep: number,
  safeZ: number,
  hopZ: number,
  maxFinishTipOps: number,
): CamMove[] {
  const moves: CamMove[] = [];
  if (hf.coveredCount === 0) return moves;
  const { pitch, x0, y0 } = hf;
  const tip = finishTipField(hf, tool, maxFinishTipOps);
  const rows = rasterRows(hf, feeds.finishStepOver);
  let flip = false;
  for (const j of rows) {
    const y = y0 + j * pitch;
    for (const [iS, iE] of coveredRuns(hf, j)) {
      const cols = alongColumns(hf, iS, iE, alongStep);
      const ordered = flip ? [...cols].reverse() : cols;
      let open = false;
      for (const i of ordered) {
        const x = x0 + i * pitch;
        const z = tip[j * hf.nx + i] as number;
        if (!open) {
          moves.push({ kind: 'rapid', x, y, z: hopZ });
          moves.push({ kind: 'feed', x, y, z, f: feeds.plungeFeed });
          open = true;
        } else {
          moves.push({ kind: 'feed', x, y, z, f: feeds.feed });
        }
      }
      if (open) {
        const last = moves[moves.length - 1]!;
        moves.push({ kind: 'rapid', x: last.x, y: last.y, z: hopZ });
      }
    }
    flip = !flip;
  }
  if (moves.length > 0) moves.push({ kind: 'rapid', x: moves[moves.length - 1]!.x, y: moves[moves.length - 1]!.y, z: safeZ });
  return moves;
}

function positive(v: number | null | undefined): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}
