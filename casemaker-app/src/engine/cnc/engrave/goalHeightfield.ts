/**
 * THE GOAL HEIGHTFIELD — the gate's own sampling of a goal mesh (or picture) to a top-Z grid.
 *
 * #967 — This is the MEASUREMENT side of the goal pipeline, moved out of `cam/surface3d.ts` so it
 * does not die with the CAM engine #966 removes. The goal check, the design check, the coverage
 * measure and the page's own checker all read the field this module samples; the CAM plans
 * against it but does not define it.
 *
 * The pitch here is the MEASUREMENT's pitch — the page's fixed 0.1 mm (`DEFAULT_GRID_PITCH_MM`,
 * the shop's `sim.columnFlatPitchYMm` fallback), coarsened only by the cell cap and always
 * stated in `resolutionNote`. It is not a planning budget.
 */

import { readDefault } from '@/platform/defaultsClient';
import type { EngraveTargetObject } from '@/types/engraveJob';
import { targetObjectMesh } from '@/engine/import/targetObject';
import { base64ToArrayBuffer } from '@/engine/import/base64';
import { decodePng } from '@/engine/import/png';
import { reliefDepthMm, reliefNumbers } from './relief';
import { placeTarget } from './targetPlace';

/**
 * The FLAT grid's default pitch, mm — the LABELLED FALLBACK for the shop's `sim.columnFlatPitchYMm`
 * (#438), the same number the column sim falls back to (`COLUMN_FLAT_PITCH_Y_FALLBACK_MM`). Kept as
 * its own constant so this module does not import the geometry worker; the two values are the
 * one shop default and must stay equal.
 */
export const DEFAULT_GRID_PITCH_MM = 0.1;

/**
 * The heightfield grid cap (design doc §2): above it the pitch is coarsened rather than the job
 * refused. 4 M cells at 4 bytes is 16 MB — the same comfort the sim's ~16 M-cell bed figure is
 * sized against, held lower here because a CAM pass walks the grid many times.
 */

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
  /** #1092 (gate v8) — the blank's thickness, mm: the silhouette proof's legitimate floor beside
   *  the part is `−(thickness + breakthrough)`. Absent on a caller that does not know it. */
  stockThicknessMm?: number;
  /** #1092 — the job's breakthrough, mm (the through rule's extra depth at a through feature). */
  breakthroughMm?: number;
  /** The resolution this field is good to, in words, for the panel/run sheet to quote. */
  resolutionNote: string;
}

export interface SampleGoalOpts {
  /** The shop's `sim.columnFlatPitchYMm`; absent → {@link DEFAULT_GRID_PITCH_MM}. */
  pitchMm?: number | null;
  /** The grid cap; absent → {@link readDefault(null, 'goal.maxCells').value}. */
  maxCells?: number | null;
  /** Work Z of the stock top, mm; absent → 0 (the flat frame's own top). */
  stockTopZ?: number;
  /** The blank's thickness, mm — carried onto the field for the v8 silhouette proof. */
  stockThicknessMm?: number;
  /** The job's breakthrough, mm — carried onto the field for the v8 silhouette proof. */
  breakthroughMm?: number;
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
  const maxCells = positive(opts.maxCells) ? (opts.maxCells as number) : readDefault(null, 'goal.maxCells').value;

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

  return {
    nx, ny, x0, y0, pitch, topZ, minZ, z, covered, coveredCount, resolutionNote,
    ...(opts.stockThicknessMm === undefined ? {} : { stockThicknessMm: opts.stockThicknessMm }),
    ...(opts.breakthroughMm === undefined ? {} : { breakthroughMm: opts.breakthroughMm }),
  };
}

/**
 * #764 — each cell's distance to the nearest COVERED cell, mm. The same exact separable transform
 * as `distanceField` in `cam/surface3d.ts`, seeded the other way round (covered cells are the
 * sources), so a ring
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
  const maxCells = positive(opts.maxCells) ? (opts.maxCells as number) : readDefault(null, 'goal.maxCells').value;
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

// Until #966 removes `cam/surface3d.ts`, it imports these two shared helpers from here.
export function positive(v: number | null | undefined): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** The 1-D squared Euclidean distance transform (Felzenszwalb–Huttenlocher), in place. */
export function edt1d(f: Float64Array, d: Float64Array, n: number, v: Int32Array, z: Float64Array): void {
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
