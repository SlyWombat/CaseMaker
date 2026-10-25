/**
 * #608 — the blank's top is a TILT, not a refusal: fit a plane to the surface touches and post the
 * program against it.
 *
 * The five `surfaceTouchCount` readings land on a printed blank whose colour line is a PLANE and
 * whose top can sit tilted in the mount (the 2026-10-23 bench: a 0.45 mm tilt toward +X/+Y read as
 * `blank-bowed` under the spread-only rule). A tilt is followable — the colour plane tilts WITH the
 * blank, so a program whose Z follows the fitted plane keeps the colour plane at the programmed
 * depth everywhere. What a tilt does NOT explain is the RESIDUAL: how far the readings still miss
 * the best plane. That leftover is the bow the old rule was really about, and it is the only thing
 * that still refuses a blank.
 *
 * THIS MODULE IS PURE ARITHMETIC: points and a plane in, numbers out. `surfaceSpread.ts` uses the
 * fit to decide the verdict; the worker (`engraveGenerate.ts`) uses {@link applySurfaceLift} to post
 * the program's Z against the same plane, so the two halves cannot disagree about the surface.
 *
 * THE PLANE is `z = offset + slopeX·x + slopeY·y` in the readings' own Z frame (machine Z). The
 * reference `z0` is the LOWEST touch — the Z0 the origin is written from — and the lift at a work
 * XY is `plane(x, y) − z0`: the fitted top's height above the reference there, which is the shift a
 * cut must take to stay a fixed depth below the colour plane.
 */

import type { ToolpathIR } from '@/engine/cnc/cam/ir';

/** The least-squares plane `z = offset + slopeX·x + slopeY·y`, in the readings' Z frame. */
export interface SurfacePlane {
  /** The plane's value at the origin (x = 0, y = 0), mm. */
  offset: number;
  /** dZ per mm of X. */
  slopeX: number;
  /** dZ per mm of Y. */
  slopeY: number;
}

/** A fitted plane plus how far the readings still miss it. */
export interface SurfacePlaneFit extends SurfacePlane {
  /** `'plane'` — the least-squares plane. Reserved so a later bilinear fit can join the union. */
  kind: 'plane';
  /** `max |reading − plane(x, y)|` over the points — the bow a tilt cannot explain, mm. */
  residual: number;
}

/**
 * Least-squares plane through the points, or null with fewer than three (a plane needs three).
 *
 * The slopes are solved from the centred covariances (numerically stable; the points sit hundreds
 * of mm from the origin in machine Z), and `offset` is then the intercept that makes the plane pass
 * through the centroid. Degenerate (collinear) points fall back to per-axis slopes so the caller
 * still gets a plane rather than a NaN.
 */
export function fitSurfacePlane(points: readonly { x: number; y: number; z: number }[]): SurfacePlaneFit | null {
  const n = points.length;
  if (n < 3) return null;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
    mz += p.z;
  }
  mx /= n;
  my /= n;
  mz /= n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sxz = 0;
  let syz = 0;
  for (const p of points) {
    const dx = p.x - mx;
    const dy = p.y - my;
    const dz = p.z - mz;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
    sxz += dx * dz;
    syz += dy * dz;
  }

  const det = sxx * syy - sxy * sxy;
  let slopeX: number;
  let slopeY: number;
  if (Math.abs(det) < 1e-12) {
    // Collinear points (a single line of touches): fit each axis that has any spread, and 0 the rest.
    slopeX = sxx > 1e-12 ? sxz / sxx : 0;
    slopeY = syy > 1e-12 ? syz / syy : 0;
  } else {
    slopeX = (sxz * syy - sxy * syz) / det;
    slopeY = (sxx * syz - sxy * sxz) / det;
  }
  const offset = mz - slopeX * mx - slopeY * my;

  let residual = 0;
  for (const p of points) {
    const r = Math.abs(p.z - (offset + slopeX * p.x + slopeY * p.y));
    if (r > residual) residual = r;
  }
  return { kind: 'plane', offset, slopeX, slopeY, residual };
}

/** The fitted top's height above the reference `z0` at work (x, y), mm — the lift a cut takes there. */
export function surfaceLift(plane: SurfacePlane, z0: number, x: number, y: number): number {
  return plane.offset - z0 + plane.slopeX * x + plane.slopeY * y;
}

/**
 * #649 — THE HIGHEST LIFT THE PLANE PUTS UNDER ANY XY OF THE STOCK, mm. A plane is linear, so the
 * maximum over the stock's rectangle is at a corner; 0 when it never rises above `z0`. The CAM
 * raises every hop by this, so an inter-loop rapid still clears the tilted top by the nominal hop
 * instead of ending inside the blank.
 */
export function maxSurfaceLift(plane: SurfacePlane, z0: number, lengthMm: number, widthMm: number): number {
  const corners: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [lengthMm, 0],
    [0, widthMm],
    [lengthMm, widthMm],
  ];
  return Math.max(0, ...corners.map(([x, y]) => surfaceLift(plane, z0, x, y)));
}

/**
 * #623 — the fitted surface a package was POSTED against: the plane and the reference Z0 the origin
 * was written from (the LOWEST touch).
 *
 * ONE VALUE FOR THE WHOLE PACKAGE. It reaches the generator — which lifts the FEED moves at
 * {@link applySurfaceLift} — and the simulation, which UN-LIFTS the program back into this frame
 * before it sweeps (#625, #628) and judges it there. A program posted in this frame but judged in
 * the flat work frame is how a correct tilt-following post came to read as a whole-pattern under-cut
 * (the 2026-10-24 bench, issue #623): the comparison has to be told which frame the file speaks.
 */
export interface SurfaceFrame {
  plane: SurfacePlane;
  /** The reference reading the origin was written from — the LOWEST touch. */
  z0: number;
}

/**
 * True when the plane is flat — both slopes within rounding of zero — so the lift is zero at every
 * XY and the program would be byte-identical to the flat one. This is the test that decides whether
 * a registration's fit is worth re-posting against (#608): a flat top has nothing to follow.
 */
export function isFlatPlane(plane: SurfacePlane): boolean {
  return Math.abs(plane.slopeX) < 1e-9 && Math.abs(plane.slopeY) < 1e-9;
}

/**
 * Post an IR against the fitted surface: every FEED move's Z is shifted by the surface lift at its
 * XY, so the floor follows the tilted colour plane. Rapids and hops are NOT lifted — they are air
 * moves above the top — so the CAM raises the hop by the plane's highest lift over the stock
 * ({@link maxSurfaceLift}, #649): a rapid ending at the flat `HOP_Z` would sit inside a blank the
 * tilt lifts more than that. Only feeds move here, so the verifier's rapid floor and the frame file
 * (an air trace at `FRAME_Z`) are untouched.
 */
export function applySurfaceLift(ir: ToolpathIR, plane: SurfacePlane, z0: number): ToolpathIR {
  return {
    ...ir,
    operations: ir.operations.map((op) => ({
      ...op,
      moves: op.moves.map((m) =>
        m.kind === 'feed' ? { ...m, z: m.z + surfaceLift(plane, z0, m.x, m.y) } : m,
      ),
    })),
  };
}
