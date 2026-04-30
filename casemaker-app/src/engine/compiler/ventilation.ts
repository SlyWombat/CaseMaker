import type {
  CaseParameters,
  BoardProfile,
  HatPlacement,
  HatProfile,
  VentSurface,
} from '@/types';
import { cube, cylinder, rotate, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;

const SLOT_WIDTH = 3;
const SLOT_GAP = 3;
const SLOT_INSET_FROM_EDGE = 6;

const HEX_RADIUS = 2.2;
const HEX_GAP = 1.4;
const HEX_INSET_FROM_EDGE = 5;

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
    case 'top': // lid (+z)
      return {
        uAxis: 'x',
        vAxis: 'y',
        uMax: outerX,
        vMax: outerY,
        cutAxis: 'z',
        cutDir: -1,
        cutOriginW: { x: 0, y: 0, z: outerZ - lid - OVER },
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

function buildSlotsForFrame(frame: VentFrame, coverage: number): BuildOp[] {
  // For walls: u = horizontal (along wall), v = vertical (Z). Slots run vertically
  //   (along v) and are spaced along u.
  // For top/bottom: u = X, v = Y. Slots run along v (Y direction), spaced along u.
  const slotHeight = (frame.vMax - 4) * coverage;
  if (slotHeight <= 1) return [];
  // Vertical inset of 2 mm from the lower edge of the face.
  const vStart = 2;
  const usable = frame.uMax - 2 * SLOT_INSET_FROM_EDGE;
  const stride = SLOT_WIDTH + SLOT_GAP;
  const slotCount = Math.max(1, Math.floor(usable / stride));
  const totalUsed = slotCount * stride - SLOT_GAP;
  const startU = (frame.uMax - totalUsed) / 2;
  const ops: BuildOp[] = [];
  for (let i = 0; i < slotCount; i++) {
    const u = startU + i * stride;
    ops.push(planarCutter(frame, u, vStart, SLOT_WIDTH, slotHeight));
  }
  return ops;
}

function buildHexForFrame(frame: VentFrame, coverage: number): BuildOp[] {
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
): VentilationCutouts {
  const empty: VentilationCutouts = { shellCuts: [], lidCuts: [] };
  if (!params.ventilation.enabled) return empty;
  if (params.ventilation.coverage <= 0) return empty;
  const dims = computeShellDims(board, params, hats, resolveHat);
  const surfaces: VentSurface[] =
    params.ventilation.surfaces && params.ventilation.surfaces.length > 0
      ? params.ventilation.surfaces
      : ['back'];
  const coverage = clamp01(params.ventilation.coverage);
  const shellCuts: BuildOp[] = [];
  const lidCuts: BuildOp[] = [];
  for (const s of surfaces) {
    const frame = frameFor(
      s,
      dims.outerX,
      dims.outerY,
      dims.outerZ,
      params.wallThickness,
      params.floorThickness,
      params.lidThickness,
    );
    if (!frame) continue;
    const dest = s === 'top' ? lidCuts : shellCuts;
    if (params.ventilation.pattern === 'slots') {
      dest.push(...buildSlotsForFrame(frame, coverage));
    } else if (params.ventilation.pattern === 'hex') {
      dest.push(...buildHexForFrame(frame, coverage));
    }
  }
  return { shellCuts, lidCuts };
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
