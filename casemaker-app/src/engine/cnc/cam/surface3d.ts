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
import { applyMat, placedSize, rotatedExtents, rotationMatrix, targetScale, targetTurns } from '@/engine/cnc/engrave/targetScale';
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

  // The placed mesh's XY footprint, from the LOCAL bbox's four XY corners turned about its centre
  // (a rotated rectangle), so the grid is sized for the object as it sits on the stock.
  const cx = (mesh.bbox.min[0] + mesh.bbox.max[0]) / 2;
  const cy = (mesh.bbox.min[1] + mesh.bbox.max[1]) / 2;
  const cz = (mesh.bbox.min[2] + mesh.bbox.max[2]) / 2;
  // #722 — the scale applies about the same anchor as the placement (bbox centre in X/Y, the top
  // in Z), BEFORE the turn, so a scaled object stays centred on `position` with its top there.
  const scale = targetScale(target);
  // #723 part 2 — the three turns are about the mesh's bbox CENTRE, Z first then Y then X (the
  // matrix is `rotationMatrix`'s, the same one the viewport's Euler prop applies). The placed
  // anchor is the TURNED bbox's centre in X/Y with its top at `position.z`; for a Z-only or
  // unturned object this reduces exactly to the original contract.
  const turns = targetTurns(target);
  const m = rotationMatrix(turns);
  const size = {
    x: (mesh.bbox.max[0] - mesh.bbox.min[0]) * scale.x,
    y: (mesh.bbox.max[1] - mesh.bbox.min[1]) * scale.y,
    z: (mesh.bbox.max[2] - mesh.bbox.min[2]) * scale.z,
  };
  const ez = rotatedExtents(size, turns).z;
  const place = (px: number, py: number, pz: number): [number, number, number] => {
    // Scaled about the bbox centre, then turned, then placed with the turned bbox's centre in X/Y
    // at `position` and its top at `position.z`.
    const q = applyMat(m, {
      x: (px - cx) * scale.x,
      y: (py - cy) * scale.y,
      z: (pz - cz) * scale.z,
    });
    return [target.position.x + q.x, target.position.y + q.y, target.position.z - ez / 2 + q.z];
  };

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
  /**
   * #535 — how many Z layers the roughing pass stepped through (the final layer included). The
   * operator-facing "levels" number, reported rather than re-derived by a caller.
   */
  roughingLayers: number;
  /** #671 — the scallop pass and its own numbers, or null when it did not run. */
  scallop: { operation: CamOperation; facts: ScallopPassFacts } | null;
  /** #671 — the pencil pass and its own numbers, or null when it did not run. */
  pencil: { operation: CamOperation; facts: PencilPassFacts } | null;
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
  /** Roughing raster pitch, mm. */
  roughStepOverMm: number;
  /** Finishing raster pitch, mm. */
  finishStepOverMm: number;
  /** Roughing allowance left on the goal surface, mm. */
  stockToLeaveMm: number;
  /** Z layers the roughing pass stepped through. */
  roughingLayers: number;
  /**
   * #671 — the scallop pass's numbers, or null when it did not run. ABSENT on a result stored by
   * a build before #671, which is why a reader asks `!= null` rather than `!== null`.
   */
  scallop?: { contours: number; stepOverMm: number; clamped: boolean } | null;
  /** #671 — the pencil pass's numbers, or null when it did not run; absent before #671. */
  pencil?: { paths: number; creaseDeg: number } | null;
  /** The engine's notes for the run sheet: the feeds, undercuts and a flat finishing cutter. */
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
    'The cutting feed, plunge feed, step-down and step-over are the job’s 2.5D feeds, reused unchanged. Measured 3D engagement numbers are not in the feeds table.',
    'A heightfield has one top-Z per (x, y): undercuts and overhangs cannot be expressed, so hidden material below the topmost surface is left standing (the 3-axis answer).',
    `Resolution: ${hf.resolutionNote}.`,
  ];
  if (!tool.ball) {
    notes.push(
      'The finishing cutter is not a ball nose; a flat tool drops onto the highest point under its disc and cannot enter concavities, so the finish is faceted — use a ball for a 3D surface.',
    );
  }

  const rough = roughingMoves(hf, feeds, allowance, alongStep, safeZ, hopZ);
  const roughMoves = rough.moves;
  // #671 — ONE tip field, four passes: the finishing raster, the scallop contours and the pencil
  // paths all ride the same gouge-safe drop, so no pass can promise a depth another one refuses.
  const tip = finishTipField(hf, tool, maxFinishTipOps);
  const finishMoves = finishingMoves(hf, tip, feeds, alongStep, safeZ, hopZ);

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
  const operations: CamOperation[] = [roughing, finishing];

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

  return { ir, roughing, finishing, roughingLayers: rough.layers, scallop, pencil, notes };
}

/** #721 — true for a goal MESH marked as a mold (a PNG relief and an item are never molds). */
export function isMold(target: Pick<EngraveTargetObject, 'format' | 'goalMode'>): boolean {
  return target.goalMode === 'mold' && target.format !== 'png';
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
export function generateSurface3dForGoal(args: {
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
  opts?: SurfaceOpts;
}): (Surface3dResult & { heightfield: GoalHeightfield }) | null {
  const sampled = sampleGoalHeightfield(args.target, args.sample);
  if (sampled.coveredCount === 0) return null;
  // #721 — a MOLD is the same part turned over and sunk from the stock top. The part's base is its
  // placed top less its placed height (the scale is the one #722 applies).
  const heightfield =
    isMold(args.target)
      ? moldHeightfield(sampled, args.target.position.y, args.target.position.z - placedSize(args.target).z)
      : sampled;
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

/**
 * The gouge-safe tip field: the tool dropped onto the heightfield until it just touches.
 *
 * #723 — `wrapRows` reads the field's ROW axis as a cylinder's circumference (the rotary map):
 * the stencil wraps modulo `ny` instead of treating the off-grid neighbours as uncut stock, so a
 * pass on the first (or last) row is not lifted to the stock's surface by the seam. The COLUMN
 * axis keeps the flat rule — beyond the sampled X range the stock really does continue.
 */
export function finishTipField(
  hf: GoalHeightfield,
  tool: SurfaceTool,
  maxOps: number,
  opts: { wrapRows?: boolean } = {},
): Float32Array {
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
 *
 * #738 — every hop out of a cut is TWO moves, as the house rule in `ir.ts` (`rapidRate`) states:
 * a Z-only retract at the point the cut stopped, then the next span's XY traverse at `hopZ`. A
 * single `G0 X.. Z..` from a cut depth climbs away diagonally through material the program has
 * not removed yet, which the geometry check refuses (j06/j07 on the bench).
 */
function roughingMoves(
  hf: GoalHeightfield,
  feeds: SurfaceFeeds,
  allowance: number,
  alongStep: number,
  safeZ: number,
  hopZ: number,
): { moves: CamMove[]; layers: number } {
  const moves: CamMove[] = [];
  if (hf.coveredCount === 0) return { moves, layers: 0 };
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
  /** #738 — a Z-only retract at the point the cut stopped; the traverse comes after it. */
  const retract = (z: number): void => {
    const last = moves[moves.length - 1]!;
    moves.push({ kind: 'rapid', x: last.x, y: last.y, z });
  };

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
            // Lift clear where the cut stopped. The rapid to the current (no-material) column
            // is gone: the next span's start traverse already runs at `hopZ` from here, and going
            // to the gap first would have meant lifting diagonally to reach it (#738).
            retract(hopZ);
            open = false;
          }
        }
        if (open) {
          // Retract at the run's end.
          retract(hopZ);
        }
      }
      flip = !flip;
    }
  }
  if (moves.length > 0) retract(safeZ);
  return { moves, layers: levels.length };
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
): CamMove[] {
  const moves: CamMove[] = [];
  if (hf.coveredCount === 0) return moves;
  const { pitch, x0, y0 } = hf;
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
      moves.push({ kind: 'rapid', x: first[0], y: first[1], z: hopZ });
      moves.push({ kind: 'feed', x: first[0], y: first[1], z: tipAt(hf, tip, first[0], first[1]), f: feeds.plungeFeed });
      for (let p = 1; p < pts.length; p++) {
        const q = pts[p]!;
        moves.push({ kind: 'feed', x: q[0], y: q[1], z: tipAt(hf, tip, q[0], q[1]), f: feeds.feed });
      }
      // Close the loop: the contour is a closed curve, so the last point returns to the first.
      const last = pts[pts.length - 1]!;
      if (last[0] !== first[0] || last[1] !== first[1]) {
        moves.push({ kind: 'feed', x: first[0], y: first[1], z: tipAt(hf, tip, first[0], first[1]), f: feeds.feed });
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
    moves.push({ kind: 'rapid', x: first[0], y: first[1], z: hopZ });
    moves.push({ kind: 'feed', x: first[0], y: first[1], z: tipAt(hf, tip, first[0], first[1]), f: feeds.plungeFeed });
    for (let p = 1; p < path.length; p++) {
      const q = path[p]!;
      moves.push({ kind: 'feed', x: q[0], y: q[1], z: tipAt(hf, tip, q[0], q[1]), f: feeds.feed });
    }
    const last = path[path.length - 1]!;
    moves.push({ kind: 'rapid', x: last[0], y: last[1], z: hopZ });
  }
  if (moves.length > 0) moves.push({ kind: 'rapid', x: moves[moves.length - 1]!.x, y: moves[moves.length - 1]!.y, z: safeZ });
  return { moves, paths: paths.length };
}
