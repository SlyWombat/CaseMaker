import type {
  CaseParameters,
  BoardProfile,
  HatPlacement,
  HatProfile,
  VentSurface,
} from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cube, cylinder, rotate, translate, type Aabb, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;
type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

const HEX_RADIUS = 2.2;
const HEX_GAP = 1.4;
const HEX_INSET_FROM_EDGE = 5;

// Slats / chevron share a tiled grid layout (cols × rows) — same
// coverage-scales-V semantics as hex, just with rectangular cells instead
// of hexagons.
const SLAT_LENGTH = 14;
const SLAT_HEIGHT = 4;
const SLAT_U_GAP = 4;
const SLAT_V_GAP = 4;
const SLAT_INSET_FROM_EDGE = 6;

// Chevron: each cell is a true V (herringbone) — two slot arms at ±45° IN
// THE FACE PLANE meeting at an apex. The previous implementation tilted a
// rectangular cutter 45° through the wall thickness (a louver): functional,
// but from any straight-on view the opening was still a plain rectangle, so
// the pattern was indistinguishable from slots. In-plane arms keep the
// printability story (every slot edge is a 45° overhang, no supports) and
// still shed water (arms drain to the tips) while actually reading as
// chevrons.
const CHEV_ARM_LEN = 8;    // mm — each arm of the V, along its own axis
const CHEV_ARM_W = 2.8;    // mm — slot width of each arm
const CHEV_U_GAP = 3.5;
const CHEV_V_GAP = 3.5;
// Bounding box of one chevron (apex up, arms at 45°):
//   width  = √2 · (arm + w/2)   height = (arm + w) / √2
const CHEV_CELL_U = Math.SQRT2 * (CHEV_ARM_LEN + CHEV_ARM_W / 2);
const CHEV_CELL_V = (CHEV_ARM_LEN + CHEV_ARM_W) * Math.SQRT1_2;

/**
 * Issue #75 — describes one face of the case as a planar rectangle plus a
 * cutting direction. Pattern builders work in the (u, v) plane and extrude
 * along the normal to slice through the wall / floor / lid.
 *
 * `(u, v)` are in-plane axes labelled (`'x'|'y'|'z'`); `originW` is the world
 * coord of the (uMin, vMin, surface) corner. Cutters of length `cutThru`
 * extrude inward from `cutOriginW` along `cutAxis * cutDir`.
 */
interface VentFrame {
  uAxis: 'x' | 'y' | 'z';
  vAxis: 'x' | 'y' | 'z';
  uMax: number;
  vMax: number;
  cutAxis: 'x' | 'y' | 'z';
  cutDir: 1 | -1;
  /** World-coord origin of the cutter — outer surface corner where pattern starts. */
  cutOriginW: { x: number; y: number; z: number };
  /** Cutter length (wall + a small overshoot). */
  cutThru: number;
}

function frameFor(
  surface: VentSurface,
  outerX: number,
  outerY: number,
  outerZ: number,
  wall: number,
  floor: number,
  lid: number,
  lidTotalZ: number,
): VentFrame | null {
  // Each face: identify the plane, the in-plane (u, v) extents, and the
  // cutting direction + cutter length. The cutter origin sits OUTSIDE the
  // face by 1 mm so the cutter punches cleanly through the material.
  const OVER = 1;
  switch (surface) {
    case 'back': // +y wall
      return {
        uAxis: 'x',
        vAxis: 'z',
        uMax: outerX,
        vMax: outerZ,
        cutAxis: 'y',
        cutDir: -1,
        cutOriginW: { x: 0, y: outerY - wall - OVER, z: 0 },
        cutThru: wall + 2 * OVER,
      };
    case 'front': // -y wall
      return {
        uAxis: 'x',
        vAxis: 'z',
        uMax: outerX,
        vMax: outerZ,
        cutAxis: 'y',
        cutDir: +1,
        cutOriginW: { x: 0, y: -OVER, z: 0 },
        cutThru: wall + 2 * OVER,
      };
    case 'right': // +x wall
      return {
        uAxis: 'y',
        vAxis: 'z',
        uMax: outerY,
        vMax: outerZ,
        cutAxis: 'x',
        cutDir: -1,
        cutOriginW: { x: outerX - wall - OVER, y: 0, z: 0 },
        cutThru: wall + 2 * OVER,
      };
    case 'left': // -x wall
      return {
        uAxis: 'y',
        vAxis: 'z',
        uMax: outerY,
        vMax: outerZ,
        cutAxis: 'x',
        cutDir: +1,
        cutOriginW: { x: -OVER, y: 0, z: 0 },
        cutThru: wall + 2 * OVER,
      };
    case 'bottom': // floor (-z)
      return {
        uAxis: 'x',
        vAxis: 'y',
        uMax: outerX,
        vMax: outerY,
        cutAxis: 'z',
        cutDir: +1,
        cutOriginW: { x: 0, y: 0, z: -OVER },
        cutThru: floor + 2 * OVER,
      };
    case 'top': // lid (+z) — emitted in LID-LOCAL coords so it actually
      // pierces the lid mesh when ProjectCompiler does
      // difference([lidOp, ...lidCuts]) BEFORE translating the lid into
      // world Z. Pre-fix the cut was placed in world coords: subtraction
      // had no overlap with the lid-local geometry and removed nothing.
      // Pierce the TOP-MOST `lid` mm of the lid (the closed-top "ceiling"
      // of a shell lid, OR the entire flat lid plate).
      return {
        uAxis: 'x',
        vAxis: 'y',
        uMax: outerX,
        vMax: outerY,
        cutAxis: 'z',
        cutDir: -1,
        cutOriginW: { x: 0, y: 0, z: lidTotalZ - lid - OVER },
        cutThru: lid + 2 * OVER,
      };
  }
}

/** Translate a (u, v, n) local offset into the world frame defined by `frame`. */
function place(frame: VentFrame, uOff: number, vOff: number): { x: number; y: number; z: number } {
  const w = { x: frame.cutOriginW.x, y: frame.cutOriginW.y, z: frame.cutOriginW.z };
  if (frame.uAxis === 'x') w.x += uOff;
  else if (frame.uAxis === 'y') w.y += uOff;
  else w.z += uOff;
  if (frame.vAxis === 'x') w.x += vOff;
  else if (frame.vAxis === 'y') w.y += vOff;
  else w.z += vOff;
  return w;
}

// Minimum web of wall left between a vent opening and any other cutout on
// the same face. Vent cells whose (inflated) box touches a keep-out are
// skipped — a vent slot clipping a port cutout's corner can sever an island
// of wall into a loose part (found by QA: chevron + Pi 4B front ports).
const KEEPOUT_MARGIN = 2;

/** World AABB of one vent cell (u0..u0+uSize, v0..v0+vSize, full cut depth). */
function cellAabb(frame: VentFrame, u0: number, v0: number, uSize: number, vSize: number): Aabb {
  const a = place(frame, u0, v0);
  const b = place(frame, u0 + uSize, v0 + vSize);
  const min: [number, number, number] = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)];
  const max: [number, number, number] = [Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)];
  // Cutters always span [cutOrigin, cutOrigin + cutThru] along +normal
  // (cutOriginW is the LOW-normal corner on every face).
  const axis = frame.cutAxis === 'x' ? 0 : frame.cutAxis === 'y' ? 1 : 2;
  max[axis] = min[axis]! + frame.cutThru;
  return { min, max };
}

function cellBlocked(
  frame: VentFrame,
  u0: number,
  v0: number,
  uSize: number,
  vSize: number,
  keepOuts: readonly Aabb[],
): boolean {
  if (keepOuts.length === 0) return false;
  const c = cellAabb(frame, u0, v0, uSize, vSize);
  for (const k of keepOuts) {
    if (
      c.min[0] < k.max[0] + KEEPOUT_MARGIN &&
      c.max[0] > k.min[0] - KEEPOUT_MARGIN &&
      c.min[1] < k.max[1] + KEEPOUT_MARGIN &&
      c.max[1] > k.min[1] - KEEPOUT_MARGIN &&
      c.min[2] < k.max[2] + KEEPOUT_MARGIN &&
      c.max[2] > k.min[2] - KEEPOUT_MARGIN
    )
      return true;
  }
  return false;
}

/** A cube cutter aligned with `frame.cutAxis`. Sized (uSize, vSize) in-plane,
 *  cutThru along the cutter axis. */
function planarCutter(frame: VentFrame, uOrigin: number, vOrigin: number, uSize: number, vSize: number): BuildOp {
  const sx =
    frame.uAxis === 'x' ? uSize : frame.vAxis === 'x' ? vSize : frame.cutThru;
  const sy =
    frame.uAxis === 'y' ? uSize : frame.vAxis === 'y' ? vSize : frame.cutThru;
  const sz =
    frame.uAxis === 'z' ? uSize : frame.vAxis === 'z' ? vSize : frame.cutThru;
  return translate([place(frame, uOrigin, vOrigin).x, place(frame, uOrigin, vOrigin).y, place(frame, uOrigin, vOrigin).z], cube([sx, sy, sz]));
}

/** Lay out a tiled grid of short slots over the given frame using the SLAT_*
 *  constants. Coverage scales the usable V range (matching hex's behavior) so
 *  the slider controls "how much of the wall is open" the same way for all
 *  patterns. Returns the column origin / row origin / counts so callers can
 *  emit either flat slot cutters (slats) or rotated cutters (chevron). */
function slatGrid(
  frame: VentFrame,
  coverage: number,
  cellU: number = SLAT_LENGTH,
  cellV: number = SLAT_HEIGHT,
  gapU: number = SLAT_U_GAP,
  gapV: number = SLAT_V_GAP,
): {
  cols: number;
  rows: number;
  uOrigin: number;
  vOrigin: number;
  strideU: number;
  strideV: number;
} | null {
  const usableU = frame.uMax - 2 * SLAT_INSET_FROM_EDGE;
  const usableV = (frame.vMax - 2 * SLAT_INSET_FROM_EDGE) * coverage;
  if (usableU < cellU || usableV < cellV) return null;
  const strideU = cellU + gapU;
  const strideV = cellV + gapV;
  const cols = Math.max(1, Math.floor((usableU + gapU) / strideU));
  const rows = Math.max(1, Math.floor((usableV + gapV) / strideV));
  const totalUsedU = cols * cellU + (cols - 1) * gapU;
  const totalUsedV = rows * cellV + (rows - 1) * gapV;
  const uOrigin = (frame.uMax - totalUsedU) / 2;
  const vOrigin = (frame.vMax - totalUsedV) / 2;
  return { cols, rows, uOrigin, vOrigin, strideU, strideV };
}

function buildSlotsForFrame(frame: VentFrame, coverage: number, keepOuts: readonly Aabb[]): BuildOp[] {
  // Tiled grid of horizontal slats. Each slat is a small flat rectangular
  // cutter (SLAT_LENGTH × SLAT_HEIGHT); tiles fill the wall in cols × rows
  // and coverage scales the V density.
  const grid = slatGrid(frame, coverage);
  if (!grid) return [];
  const ops: BuildOp[] = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const u = grid.uOrigin + c * grid.strideU;
      const v = grid.vOrigin + r * grid.strideV;
      if (cellBlocked(frame, u, v, SLAT_LENGTH, SLAT_HEIGHT, keepOuts)) continue;
      ops.push(planarCutter(frame, u, v, SLAT_LENGTH, SLAT_HEIGHT));
    }
  }
  return ops;
}

function buildHexForFrame(frame: VentFrame, coverage: number, keepOuts: readonly Aabb[]): BuildOp[] {
  const usableU = frame.uMax - 2 * HEX_INSET_FROM_EDGE;
  const usableV = (frame.vMax - 2 * HEX_INSET_FROM_EDGE) * coverage;
  if (usableU <= HEX_RADIUS * 2 || usableV <= HEX_RADIUS * 2) return [];
  const strideU = 2 * HEX_RADIUS + HEX_GAP;
  const strideV = Math.sqrt(3) * HEX_RADIUS + HEX_GAP;
  const cols = Math.max(1, Math.floor((usableU - HEX_RADIUS) / strideU));
  const rows = Math.max(1, Math.floor((usableV - HEX_RADIUS) / strideV));
  if (cols < 1 || rows < 1) return [];
  const uOrigin = (frame.uMax - (cols - 1) * strideU) / 2;
  const vOrigin = (frame.vMax - (rows - 1) * strideV) / 2;
  const ops: BuildOp[] = [];
  for (let r = 0; r < rows; r++) {
    const isOdd = r % 2 === 1;
    const uOff = isOdd ? strideU / 2 : 0;
    for (let c = 0; c < cols - (isOdd ? 1 : 0); c++) {
      const u = uOrigin + c * strideU + uOff;
      const v = vOrigin + r * strideV;
      if (cellBlocked(frame, u - HEX_RADIUS, v - HEX_RADIUS, 2 * HEX_RADIUS, 2 * HEX_RADIUS, keepOuts))
        continue;
      const w = place(frame, u, v);
      // 6-segment cylinder oriented along the cut axis. cylinder() builds
      // along +Z; rotate to match cut direction.
      const cyl = cylinder(frame.cutThru, HEX_RADIUS, 6, false);
      let oriented: BuildOp = cyl;
      if (frame.cutAxis === 'y') oriented = rotate([90, 0, 0], cyl);
      else if (frame.cutAxis === 'x') oriented = rotate([0, 90, 0], cyl);
      // For z-axis cuts, no rotation needed (cylinder already along z).
      // Translate the oriented cylinder so its base sits at world (w.x, w.y, w.z).
      // For y-axis: cylinder rotated to lie along y, base at world y means
      // translate by (w.x, w.y, w.z) since rotate doesn't shift the cylinder
      // base. Actually rotate([90,0,0]) on a cylinder spanning z∈[0,h] yields
      // a cylinder spanning y∈[-h,0]. Compensate.
      if (frame.cutAxis === 'y') {
        ops.push(translate([w.x, w.y + frame.cutThru, w.z], oriented));
      } else if (frame.cutAxis === 'x') {
        ops.push(translate([w.x, w.y, w.z], oriented));
      } else {
        ops.push(translate([w.x, w.y, w.z], oriented));
      }
    }
  }
  return ops;
}

function buildChevronForFrame(frame: VentFrame, coverage: number, keepOuts: readonly Aabb[]): BuildOp[] {
  // Herringbone: each cell is a V — two slot arms at ±45° in the face plane
  // meeting at an apex (pointing +v). Arms are centered cube cutters rotated
  // about the face NORMAL, so the opening genuinely reads as a chevron from
  // outside; every slot edge is a 45° overhang → prints support-free.
  const grid = slatGrid(frame, coverage, CHEV_CELL_U, CHEV_CELL_V, CHEV_U_GAP, CHEV_V_GAP);
  if (!grid) return [];
  const c45 = Math.SQRT1_2;
  // Rotation about the normal by θ turns the arm's long axis (along +u) in
  // the (u, v) plane. Right-hand world rotations give axis direction
  // (cosθ, −sinθ) for a +y normal but (cosθ, +sinθ) for +x / +z normals —
  // flip the sign for y so ±θ mean the same thing on every face.
  const rotSign = frame.cutAxis === 'y' ? -1 : 1;
  const rotVecFor = (deg: number): [number, number, number] =>
    frame.cutAxis === 'x' ? [deg, 0, 0] : frame.cutAxis === 'y' ? [0, deg, 0] : [0, 0, deg];
  // Arm cuboid: long axis along u, slot width along v, cutThru along normal.
  const dim = (long: number, wide: number, thru: number) => {
    const sx = frame.uAxis === 'x' ? long : frame.vAxis === 'x' ? wide : thru;
    const sy = frame.uAxis === 'y' ? long : frame.vAxis === 'y' ? wide : thru;
    const sz = frame.uAxis === 'z' ? long : frame.vAxis === 'z' ? wide : thru;
    return [sx, sy, sz] as [number, number, number];
  };
  const ops: BuildOp[] = [];
  const armBox = cube(dim(CHEV_ARM_LEN, CHEV_ARM_W, frame.cutThru), true);
  for (let r = 0; r < grid.rows; r++) {
    for (let cCol = 0; cCol < grid.cols; cCol++) {
      const cellU0 = grid.uOrigin + cCol * grid.strideU;
      const cellV0 = grid.vOrigin + r * grid.strideV;
      if (cellBlocked(frame, cellU0, cellV0, CHEV_CELL_U, CHEV_CELL_V, keepOuts)) continue;
      // Apex sits at the cell's top-center (minus the arm-corner rise so the
      // chevron's topmost point stays inside the cell).
      const apexU = grid.uOrigin + cCol * grid.strideU + CHEV_CELL_U / 2;
      const apexV = grid.vOrigin + r * grid.strideV + CHEV_CELL_V - (CHEV_ARM_W / 2) * c45;
      for (const armSide of [-1, +1] as const) {
        // Arm center: halfway from apex toward the arm tip (down-left / down-right).
        const armU = apexU + armSide * (CHEV_ARM_LEN / 2) * c45;
        const armV = apexV - (CHEV_ARM_LEN / 2) * c45;
        // Left arm lies on the (+u,+v) diagonal → +θ; right arm on (+u,−v) → −θ.
        const rotated = rotate(rotVecFor(rotSign * -armSide * 45), armBox);
        const w = place(frame, armU, armV);
        // Centered cutter: shift half the cut depth along +normal so it spans
        // [cutOrigin, cutOrigin + cutThru] exactly like the corner-anchored
        // planarCutter — cutOriginW is always the LOW-normal corner, so the
        // shift is +cutThru/2 on every face regardless of cutDir.
        const off = frame.cutThru / 2;
        ops.push(
          translate(
            [
              w.x + (frame.cutAxis === 'x' ? off : 0),
              w.y + (frame.cutAxis === 'y' ? off : 0),
              w.z + (frame.cutAxis === 'z' ? off : 0),
            ],
            rotated,
          ),
        );
      }
    }
  }
  return ops;
}

export interface VentilationCutouts {
  /** Cutters for surfaces that are part of the case shell (sides + bottom). */
  shellCuts: BuildOp[];
  /** Cutters for the lid (the 'top' surface) — applied separately by
   *  ProjectCompiler so they actually pierce the lid mesh. Until this split
   *  existed, top-surface vents were placed in shellCuts and silently
   *  removed nothing because the shell has no material at lid Z. */
  lidCuts: BuildOp[];
}

export function buildVentilationCutouts(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
  /** World AABBs of other cutouts on the shell (port openings etc.) that
   * vent cells must keep KEEPOUT_MARGIN clear of. Shell surfaces only —
   * lid ('top') cuts are in lid-local coords and skip the check. */
  keepOuts: readonly Aabb[] = [],
): VentilationCutouts {
  const empty: VentilationCutouts = { shellCuts: [], lidCuts: [] };
  if (!params.ventilation.enabled) return empty;
  if (params.ventilation.coverage <= 0) return empty;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const surfaces: VentSurface[] =
    params.ventilation.surfaces && params.ventilation.surfaces.length > 0
      ? params.ventilation.surfaces
      : ['back'];
  const coverage = clamp01(params.ventilation.coverage);
  const shellCuts: BuildOp[] = [];
  const lidCuts: BuildOp[] = [];
  const lidTotalZ = params.lidThickness + (params.lidCavityHeight ?? 0);
  for (const s of surfaces) {
    const frame = frameFor(
      s,
      dims.outerX,
      dims.outerY,
      dims.outerZ,
      params.wallThickness,
      params.floorThickness,
      params.lidThickness,
      lidTotalZ,
    );
    if (!frame) continue;
    const dest = s === 'top' ? lidCuts : shellCuts;
    const ko = s === 'top' ? [] : keepOuts;
    if (params.ventilation.pattern === 'slots') {
      dest.push(...buildSlotsForFrame(frame, coverage, ko));
    } else if (params.ventilation.pattern === 'hex') {
      dest.push(...buildHexForFrame(frame, coverage, ko));
    } else if (params.ventilation.pattern === 'chevron') {
      dest.push(...buildChevronForFrame(frame, coverage, ko));
    }
  }
  return { shellCuts, lidCuts };
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
