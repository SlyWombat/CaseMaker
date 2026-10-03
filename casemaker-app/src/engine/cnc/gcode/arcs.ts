/**
 * Tessellate a G2/G3 arc into straight segments, the way the Z1's firmware computes it.
 *
 * Why arcs are here at all: this parser was first drawn with arcs as a contingency,
 * because Studio's own `TopClamp.nc` contains none. Makera's reference corpus has 20 000+
 * `G2`/`G3` lines in 10 of its 25 files, with `G17`, `G18` and `G19`, and the machine's
 * FreeCAD definition sets `split_arcs: false` — the controller TAKES arcs and other CAM
 * emits them (`/Z1-Firmware-Dialect.md` §8). Everything downstream sweeps straight
 * segments, so the parser tessellates and the sweep never sees a curve.
 *
 * The geometry follows `Robot::append_arc` in the firmware, because the firmware is what
 * decides where the cutter goes:
 *
 *  - The centre is `start + (I, J, K)`: offsets are ALWAYS incremental from the start,
 *    whatever `G90`/`G91` says. There is no `R` form.
 *  - Angular travel is the CCW angle start→end about the centre. If start and end
 *    coincide in the plane it is a FULL CIRCLE, ±2π.
 *  - In the XZ plane (`G18`) the sense is flipped, because that plane's handedness is
 *    reversed.
 *  - A start radius that differs from the end radius is NOT rejected. The firmware rotates
 *    the START radius vector through the angular travel, so every intermediate point lies
 *    on the start circle, and only the LAST segment lands on the target. A bad `I`/`J` is
 *    therefore a circle followed by one jump, not a spiral. (An earlier version of this
 *    port interpolated the radius and spiralled while its comment claimed otherwise; the
 *    review caught it, measuring a 2.0 mm radial error on a 10 → 12 mm test.) The caller
 *    reports the mismatch.
 *
 * Segment count comes from `ARC_CHORD_TOLERANCE_MM` (#190), the one shared constant, so
 * the oracle band in `/Simulation.md` §7 can be derived from it rather than guessed.
 */

import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';

export type Plane = 'XY' | 'XZ' | 'YZ';
type V3 = [number, number, number];
type Ax = 0 | 1 | 2;

/** [axis0, axis1, linear axis] as indices into X=0, Y=1, Z=2. */
const PLANE_AXES: Record<Plane, [Ax, Ax, Ax]> = {
  XY: [0, 1, 2], // G17: offsets I, J; linear Z
  XZ: [0, 2, 1], // G18: offsets I, K; linear Y
  YZ: [1, 2, 0], // G19: offsets J, K; linear X
};

/** A runaway guard: a 1 m radius full circle at 5 µm tolerance is ~ 2 000 segments. */
const MAX_SEGMENTS = 100_000;

export interface ArcRequest {
  start: V3;
  end: V3;
  /** I, J, K — incremental offsets from `start` to the centre, in mm. */
  offsets: V3;
  plane: Plane;
  clockwise: boolean;
}

export interface ArcResult {
  /** Points AFTER the start, the last being exactly `end`. */
  points: V3[];
  radiusStart: number;
  radiusEnd: number;
  /** Signed angular travel in radians, as the firmware computes it. */
  angular: number;
}

export type ArcError = { error: 'zero-radius' };

export function tessellateArc(req: ArcRequest): ArcResult | ArcError {
  const [a0, a1, lin] = PLANE_AXES[req.plane];
  const { start, end, offsets } = req;

  const r0 = -offsets[a0];
  const r1 = -offsets[a1];
  const radiusStart = Math.hypot(r0, r1);
  if (radiusStart < 1e-9) return { error: 'zero-radius' };

  const c0 = start[a0] + offsets[a0];
  const c1 = start[a1] + offsets[a1];
  const rt0 = end[a0] - c0;
  const rt1 = end[a1] - c1;
  const radiusEnd = Math.hypot(rt0, rt1);

  let angular: number;
  if (start[a0] === end[a0] && start[a1] === end[a1]) {
    // Everything cancels in atan2, so the firmware takes a full circle. The G18 flip is
    // NOT applied on this branch in the source, and neither is it here.
    angular = req.clockwise ? -2 * Math.PI : 2 * Math.PI;
  } else {
    angular = Math.atan2(r0 * rt1 - r1 * rt0, r0 * rt0 + r1 * rt1);
    const cw = lin === 1 ? !req.clockwise : req.clockwise;
    if (cw) {
      if (angular > 0) angular -= 2 * Math.PI;
    } else if (angular < 0) {
      angular += 2 * Math.PI;
    }
  }

  // Largest angle one chord may span so its sagitta r(1 - cos(dθ/2)) stays within tolerance.
  const tol = ARC_CHORD_TOLERANCE_MM;
  const maxStep = radiusStart > tol ? 2 * Math.acos(1 - tol / radiusStart) : Math.PI / 2;
  const n = Math.min(MAX_SEGMENTS, Math.max(1, Math.ceil(Math.abs(angular) / maxStep)));

  const ux = r0 / radiusStart;
  const uy = r1 / radiusStart;
  const points: V3[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const p: V3 = [0, 0, 0];
    if (i === n) {
      p[0] = end[0];
      p[1] = end[1];
      p[2] = end[2];
    } else {
      const ang = angular * t;
      const cos = Math.cos(ang);
      const sin = Math.sin(ang);
      p[a0] = c0 + radiusStart * (ux * cos - uy * sin);
      p[a1] = c1 + radiusStart * (ux * sin + uy * cos);
      p[lin] = start[lin] + (end[lin] - start[lin]) * t;
    }
    points.push(p);
  }
  return { points, radiusStart, radiusEnd, angular };
}
