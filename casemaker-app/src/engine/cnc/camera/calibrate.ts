/**
 * The camera stitch and its re-validation maths (#286) — the half of #189 that needs no camera.
 *
 * ## What is being fitted, and what is NOT
 *
 * The machine is the length standard, not the printed sheet. Each capture is a frame taken at a
 * COMMANDED machine XY, with detectable features (milled crosses, checker corners) located in
 * pixels. A feature at machine position F seen from commanded P lands at
 *
 *     pixel = origin + L · (F − P)
 *
 * where `L` is the camera's linear map from machine millimetres to pixels and `origin` absorbs the
 * image centre and the camera-to-spindle offset. Everything here is measured FROM THE FRAMES:
 * scale, yaw and any residual distortion are properties of the pixels; the machine's own errors —
 * backlash on a return visit, squareness — are NOT, and must never be folded into the optical fit
 * (`/Fabrication.md` §5.7, #286). A repeated node is therefore excluded from the fit and reported
 * separately by `closureResidual`.
 *
 * ## The model: a full 2×2 linear map, reported honestly
 *
 * A camera with square pixels and pure rotation gives `L = s·R(θ)`; a common image convention
 * (v down, y back) adds a reflection, `s·R·diag(1,−1)`. Both have equal singular values, so this
 * module fits a general 2×2 `L` rather than assuming either, then REPORTS what it found:
 *
 *   - `pxPerMm` = √|det L| — the geometric mean of the map's singular values;
 *   - `anisotropy` = σ₁/σ₂ — 1 for square pixels with no distortion, and a visible number rather
 *     than a hidden assumption;
 *   - `yawDeg` — where machine +X points in the image, measured from +u toward +v.
 *
 * ## The pieces (each one of #286's deliverables)
 *
 *   - `fitStitch` — scale, yaw and translation from commanded moves against observed shifts.
 *   - `yawFromAxisMove` — the single-axis reading, as the issue names it, for a quick check.
 *   - `distortionOf` — the deviation across the field, as a first-order radial coefficient plus
 *     the residual it leaves; "distortion from deviation across the field" is a MEASUREMENT here,
 *     not a correction silently applied.
 *   - `closureResidual` — repeated nodes, converted to mm and reported as MACHINE error.
 *   - `cameraToSpindleOffset` — the image-centre-to-cross vector, scaled and rotated.
 *   - `fitScaleVsZ` — mm-per-pixel at two or three heights, interpolated; outside them, nothing is
 *     claimed.
 *   - `heldOutResidual` / `validateHeldOut` — a feature at a node NOT in the fit, predicted and
 *     reported against a tolerance. Fitting residual is not accuracy; this is the number that is.
 *   - `revalidate` — one known feature, checked against the model and a tolerance. Seconds, and it
 *     is what gets run routinely.
 *
 * ## Does not
 *
 * No detection: a feature's pixel position is an input. Finding the crosses and corners (the CV
 * decision) is not in this module, and no dependency is added here.
 */

import type { Mm, Vec2 } from '@/types/units';

/** A position in the frame, pixels. `u` is right, `v` is whichever way the sensor's rows run. */
export interface PixelPoint {
  u: number;
  v: number;
}

/** A position on the machine, mm. */
export interface MachinePoint {
  x: Mm;
  y: Mm;
}

/** One known feature seen in one frame. */
export interface FeatureObservation {
  /** Which known feature this is — an index into the target's own list, stable across frames. */
  id: number;
  /** Where the feature really is, in machine mm (a milled cross by construction, a corner by its
   *  located sheet position). The machine — not the printer — is the standard. */
  at: MachinePoint;
  /** Its centre in this frame, pixels. */
  px: PixelPoint;
}

/** One frame's input: where the machine was commanded, and what was seen there. */
export interface CaptureSample {
  /** The commanded machine XY when the frame was taken, mm. */
  at: MachinePoint;
  /** The frame's size, px — its centre is where the camera's axis lands. */
  width: number;
  height: number;
  features: readonly FeatureObservation[];
  /** The Z this frame was taken at, mm, when it is part of a scale-vs-Z calibration. */
  z?: Mm;
}

/** The fitted map and what it says about the camera. */
export interface StitchFit {
  /** `pixel = origin + L·(feature − commanded)`, per axis. */
  origin: PixelPoint;
  /** The 2×2 map: u = a·dx + b·dy, v = c·dx + d·dy. */
  l: { a: number; b: number; c: number; d: number };
  /** Pixels per millimetre: the geometric mean of the map's singular values. */
  pxPerMm: number;
  mmPerPixel: Mm;
  /** Where machine +X points in the image, degrees from +u toward +v. */
  yawDeg: number;
  /** σ₁/σ₂. 1 for square pixels; a departure is reported, not corrected away. */
  anisotropy: number;
  /** The frame centre the distortion/tie-point maths use, px. */
  centrePx: PixelPoint;
  /** Observations used, after repeat visits were excluded (see `fitStitch`). */
  used: number;
  /** Residual RMS and maximum, px. A FIT quality, not an accuracy claim. */
  rmsPx: number;
  maxPx: number;
}

/** Why a fit was refused. */
export class StitchRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StitchRefusal';
  }
}

const DEG = Math.PI / 180;
const EPS = 1e-9;

/**
 * Fit the stitch from capture samples.
 *
 * REPEATED COMMANDED POSITIONS DO NOT ENTER THE FIT. A capture grid that returns to its origin
 * (the closure check) yields two frames of the same node; a machine with backlash shows the
 * feature at a different pixel the second time. Including both would pull the optical fit toward a
 * machine error, which is exactly the confusion #286 forbids. So the first frame per (commanded
 * position, feature) is used, and the repeats are left for `closureResidual`.
 *
 * Refused: fewer than three observations, or observations that do not span two directions (a fit
 * from points on one line cannot recover a 2-D map — it would report a scale that is a guess).
 */
export function fitStitch(samples: readonly CaptureSample[]): StitchFit {
  const rows: Array<{ dx: number; dy: number; u: number; v: number }> = [];
  const seen = new Set<string>();
  let width = 0;
  let height = 0;
  for (const sample of samples) {
    width = Math.max(width, sample.width);
    height = Math.max(height, sample.height);
    for (const feature of sample.features) {
      const key = `${sample.at.x.toFixed(6)}|${sample.at.y.toFixed(6)}|${feature.id}`;
      if (seen.has(key)) continue; // a repeat visit — left for `closureResidual`
      seen.add(key);
      rows.push({
        dx: feature.at.x - sample.at.x,
        dy: feature.at.y - sample.at.y,
        u: feature.px.u,
        v: feature.px.v,
      });
    }
  }
  if (rows.length < 3) {
    throw new StitchRefusal(`a stitch needs at least three feature observations; got ${rows.length}`);
  }

  // u = a + l.a·dx + l.b·dy and v = b + l.c·dx + l.d·dy are independent 3-parameter fits.
  const [ua, ub, uc] = solve3(rows.map((r) => [1, r.dx, r.dy]), rows.map((r) => r.u), 'u');
  const [vc, vd, ve] = solve3(rows.map((r) => [1, r.dx, r.dy]), rows.map((r) => r.v), 'v');
  const l = { a: ub, b: uc, c: vd, d: ve };
  const det = l.a * l.d - l.b * l.c;
  if (!(Math.abs(det) > EPS)) {
    throw new StitchRefusal('the fitted camera map is degenerate (zero area): the observations do not span two directions');
  }
  // Singular values of a 2×2 map: λ = (τ ± √(τ² − 4Δ²)) / 2 on LᵀL.
  const trace = l.a * l.a + l.b * l.b + l.c * l.c + l.d * l.d;
  const disc = Math.max(0, trace * trace - 4 * det * det);
  const s1 = Math.sqrt((trace + Math.sqrt(disc)) / 2);
  const s2 = Math.sqrt(Math.max(EPS, (trace - Math.sqrt(disc)) / 2));
  const pxPerMm = Math.sqrt(Math.abs(det));
  const yawDeg = Math.atan2(l.c, l.a) / DEG;

  let sumSq = 0;
  let maxPx = 0;
  for (const r of rows) {
    const pu = ua + l.a * r.dx + l.b * r.dy;
    const pv = vc + l.c * r.dx + l.d * r.dy;
    const resid = Math.hypot(r.u - pu, r.v - pv);
    sumSq += resid * resid;
    maxPx = Math.max(maxPx, resid);
  }
  return {
    origin: { u: ua, v: vc },
    l,
    pxPerMm,
    mmPerPixel: 1 / pxPerMm,
    yawDeg,
    anisotropy: s2 > 0 ? s1 / s2 : Infinity,
    centrePx: { u: width / 2, v: height / 2 },
    used: rows.length,
    rmsPx: Math.sqrt(sumSq / rows.length),
    maxPx,
  };
}

/** Solve the 3×3 normal equations of a 3-parameter linear least squares. */
function solve3(rows: number[][], values: number[], axis: string): [number, number, number] {
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atb = [0, 0, 0];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as number[];
    const y = values[i] as number;
    for (let p = 0; p < 3; p++) {
      atb[p] = (atb[p] as number) + (r[p] as number) * y;
      const ataRow = ata[p] as number[];
      for (let q = 0; q < 3; q++) ataRow[q] = (ataRow[q] as number) + (r[p] as number) * (r[q] as number);
    }
  }
  const solution = gauss(ata, atb);
  if (solution === null) {
    throw new StitchRefusal(`the ${axis} map cannot be fitted: the observations do not span two directions`);
  }
  return solution;
}

/** Gaussian elimination with partial pivoting; null when the system is singular. */
function gauss(matrix: number[][], rhs: number[]): [number, number, number] | null {
  const m = matrix.map((row, i) => [...row, rhs[i] as number]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let row = col + 1; row < 3; row++) {
      if (Math.abs(m[row]![col]!) > Math.abs(m[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    if (pivot !== col) [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    const p = m[col]!;
    for (let row = col + 1; row < 3; row++) {
      const factor = m[row]![col]! / p[col]!;
      for (let k = col; k < 4; k++) m[row]![k] = m[row]![k]! - factor * p[k]!;
    }
  }
  const x = [0, 0, 0];
  for (let row = 2; row >= 0; row--) {
    let acc = m[row]![3]!;
    for (let col = row + 1; col < 3; col++) acc -= m[row]![col]! * x[col]!;
    x[row] = acc / m[row]![row]!;
  }
  return [x[0]!, x[1]!, x[2]!];
}

/** Where the model says a feature lands in the frame. */
export function pixelOf(fit: StitchFit, commanded: MachinePoint, feature: MachinePoint): PixelPoint {
  const dx = feature.x - commanded.x;
  const dy = feature.y - commanded.y;
  return { u: fit.origin.u + fit.l.a * dx + fit.l.b * dy, v: fit.origin.v + fit.l.c * dx + fit.l.d * dy };
}

/** The machine position the model assigns to a pixel in a frame taken at `commanded`. */
export function machineOf(fit: StitchFit, commanded: MachinePoint, px: PixelPoint): MachinePoint {
  const det = fit.l.a * fit.l.d - fit.l.b * fit.l.c;
  const du = px.u - fit.origin.u;
  const dv = px.v - fit.origin.v;
  return {
    x: commanded.x + (fit.l.d * du - fit.l.b * dv) / det,
    y: commanded.y + (-fit.l.c * du + fit.l.a * dv) / det,
  };
}

/** A pixel vector, as a machine vector, mm. For differences within one frame. */
function pixelVectorToMm(fit: StitchFit, du: number, dv: number): MachinePoint {
  const det = fit.l.a * fit.l.d - fit.l.b * fit.l.c;
  return { x: (fit.l.d * du - fit.l.b * dv) / det, y: (-fit.l.c * du + fit.l.a * dv) / det };
}

export interface AxisMoveReading {
  /** Camera yaw over that move, degrees from the commanded axis. */
  yawDeg: number;
  /** Pixels per millimetre over that move. */
  pxPerMm: number;
}

/**
 * The single-axis reading #286 names: command a move along ONE machine axis and measure how the
 * image content shifted. `axis: 'x'` expects the feature to move along image +u at zero yaw; a
 * yawed camera tilts the observed shift off that axis, and the angle is the camera yaw.
 *
 * This is a CHECK, not the fit: one move cannot see distortion or separate squareness from yaw.
 * `fitStitch` over a grid is the calibration; this is what a person reads at the machine.
 */
export function yawFromAxisMove(
  observed: { from: PixelPoint; to: PixelPoint },
  axis: 'x' | 'y',
  commandedMm: Mm,
): AxisMoveReading {
  if (!(commandedMm > 0)) throw new StitchRefusal(`a single-axis move needs a positive commanded distance, got ${commandedMm}`);
  const du = observed.to.u - observed.from.u;
  const dv = observed.to.v - observed.from.v;
  // IMAGE CONVENTION, stated once: u runs right and v runs down; machine +Y runs away from the
  // operator, which a downward-looking camera sees as up the image. Under that convention a
  // commanded +X move shifts the CONTENT toward −u (angle 180°), and a +Y move toward +v (90°).
  // The reading is the observed shift's angle minus that expectation: 0° is a camera whose rows
  // are square to the machine, and any rotation reads as itself.
  const observedDeg = Math.atan2(dv, du) / DEG;
  const expectedDeg = axis === 'x' ? 180 : 90;
  let delta = observedDeg - expectedDeg;
  while (delta > 180) delta -= 360;
  while (delta <= -180) delta += 360;
  return { yawDeg: delta, pxPerMm: Math.hypot(du, dv) / commandedMm };
}

export interface DistortionReport {
  /** First-order radial coefficient, px⁻² (positive: points pushed away from the centre). */
  k1: number;
  /** Residual RMS before and after the radial term, px. */
  rmsBeforePx: number;
  rmsAfterPx: number;
  /** Largest deviation across the field, px and mm at the fit's own scale. */
  maxPx: number;
  maxMm: Mm;
  /** The radius the maximum was measured at, px. */
  maxRadiusPx: number;
}

/**
 * The deviation across the field, measured from the residuals the linear fit left. A first-order
 * radial term is fitted THROUGH the origin (the centre is not distorted); `k1` and the residual it
 * fails to explain are both reported. Nothing is corrected: the caller learns how much the linear
 * model is out, and by how much a radial model would improve it.
 */
export function distortionOf(fit: StitchFit, samples: readonly CaptureSample[]): DistortionReport {
  let sumSqBefore = 0;
  let sumSqAfter = 0;
  let n = 0;
  let maxPx = 0;
  let maxRadiusPx = 0;
  const radial: Array<{ r2: number; value: number }> = [];
  const centre = fit.centrePx;
  const points: Array<{ du: number; dv: number; ru: number; rv: number }> = [];
  for (const sample of samples) {
    for (const feature of sample.features) {
      const predicted = pixelOf(fit, sample.at, feature.at);
      const du = feature.px.u - predicted.u;
      const dv = feature.px.v - predicted.v;
      const rx = predicted.u - centre.u;
      const ry = predicted.v - centre.v;
      const radius2 = rx * rx + ry * ry;
      if (radius2 < EPS) continue;
      const radius = Math.sqrt(radius2);
      const value = (du * rx + dv * ry) / radius; // radial component of the residual
      radial.push({ r2: radius2, value });
      points.push({ du, dv, ru: (value * rx) / radius, rv: (value * ry) / radius });
      sumSqBefore += du * du + dv * dv;
      maxPx = Math.max(maxPx, Math.hypot(du, dv));
      if (Math.hypot(du, dv) >= maxPx) maxRadiusPx = radius;
      n++;
    }
  }
  let num = 0;
  let den = 0;
  for (const r of radial) {
    num += r.value * r.r2;
    den += r.r2 * r.r2;
  }
  const k1 = den > EPS ? num / den : 0;
  for (const p of points) {
    const after = Math.hypot(p.du - k1 * p.ru, p.dv - k1 * p.rv);
    sumSqAfter += after * after;
  }
  return {
    k1,
    rmsBeforePx: n > 0 ? Math.sqrt(sumSqBefore / n) : 0,
    rmsAfterPx: n > 0 ? Math.sqrt(sumSqAfter / n) : 0,
    maxPx,
    maxMm: maxPx * fit.mmPerPixel,
    maxRadiusPx,
  };
}

export interface ClosureNode {
  at: MachinePoint;
  /** How many frames were taken at this node (the first is the reference). */
  visits: number;
  /** The observed shift of the later visits against the first, as MACHINE millimetres. */
  dxMm: Mm;
  dyMm: Mm;
}

export interface ClosureReport {
  /** One entry per repeated node that shared a feature between visits. */
  nodes: ClosureNode[];
  /** RMS of the per-node shifts, mm. 0 when nothing repeated. */
  rmsMm: Mm;
}

/**
 * The closure residual: a grid that returns to an earlier commanded position should see the same
 * feature at the same pixel. What it actually sees, converted through the camera's scale and yaw,
 * is a MACHINE error — backlash or squareness — and it is reported here, never subtracted from
 * the optical fit (`fitStitch` excludes the repeats for exactly this reason).
 */
export function closureResidual(fit: StitchFit, samples: readonly CaptureSample[]): ClosureReport {
  const groups = new Map<string, CaptureSample[]>();
  for (const sample of samples) {
    const key = `${sample.at.x.toFixed(6)}|${sample.at.y.toFixed(6)}`;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [sample]);
    else list.push(sample);
  }
  const nodes: ClosureNode[] = [];
  let sumSq = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const reference = list[0] as CaptureSample;
    const refById = new Map(reference.features.map((f) => [f.id, f] as const));
    let sumX = 0;
    let sumY = 0;
    let n = 0;
    for (let i = 1; i < list.length; i++) {
      for (const feature of (list[i] as CaptureSample).features) {
        const first = refById.get(feature.id);
        if (first === undefined) continue;
        const mm = pixelVectorToMm(fit, feature.px.u - first.px.u, feature.px.v - first.px.v);
        sumX += mm.x;
        sumY += mm.y;
        n++;
      }
    }
    if (n === 0) continue;
    // The observed shift is the NEGATIVE of the machine's error: a machine that physically sits
    // e mm past the commanded node sees its features shifted by −L·e. Report e, the machine's.
    const dxMm = -sumX / n;
    const dyMm = -sumY / n;
    nodes.push({ at: reference.at, visits: list.length, dxMm, dyMm });
    sumSq += dxMm * dxMm + dyMm * dyMm;
  }
  return { nodes, rmsMm: nodes.length > 0 ? Math.sqrt(sumSq / nodes.length) : 0 };
}

/**
 * The camera-to-spindle offset: the vector from the camera's axis to the spindle, in machine mm.
 *
 * THE MILLED CROSS IS THE EVIDENCE. The cutter puts a cross at the spindle's true position, so a
 * frame taken with the spindle commanded over that cross shows it offset from the image centre by
 * the camera-to-spindle vector — scaled by the camera and rotated by its yaw. The arithmetic is
 * `inverse(L)·(cross − centre)`, and the commanded position cancels when it equals the cross's.
 */
export function cameraToSpindleOffset(fit: StitchFit, sample: CaptureSample, featureId: number): MachinePoint {
  const feature = sample.features.find((f) => f.id === featureId);
  if (feature === undefined) {
    throw new StitchRefusal(`feature ${featureId} is not in the frame taken at (${sample.at.x}, ${sample.at.y})`);
  }
  // pixel = centre + L·(F − P − T) for a spindle-to-camera offset T. inverse(L)·(cross − centre)
  // is the camera-axis→cross vector, F − P − T; moving from the cross to the spindle adds P − F,
  // leaving −T, the camera-axis→spindle vector — the offset the issue names. With the spindle
  // commanded over the cross (P = F) the two are the same reading.
  const fromCentre = pixelVectorToMm(fit, feature.px.u - fit.centrePx.u, feature.px.v - fit.centrePx.v);
  return {
    x: fromCentre.x + (sample.at.x - feature.at.x),
    y: fromCentre.y + (sample.at.y - feature.at.y),
  };
}

export interface ScaleSample {
  z: Mm;
  /** Pixels per millimetre measured at this Z. */
  pxPerMm: number;
}

export interface ScaleZModel {
  samples: readonly ScaleSample[];
  /** The scale claimed at `z`, or null outside the calibrated heights. */
  at(z: Mm): { pxPerMm: number; mmPerPixel: Mm; interpolated: boolean } | null;
}

/**
 * Scale against Z: a camera above the work sees fewer pixels per millimetre as it rises, so one
 * mm-per-pixel for every job is the assumption #286 forbids. Calibrate at two or three heights and
 * interpolate linearly between them; OUTSIDE them nothing is claimed — a null rather than an
 * extrapolated number, because below the lowest height the lens, the focus and eventually the
 * geometry stop being the same linear map.
 */
export function fitScaleVsZ(samples: readonly ScaleSample[]): ScaleZModel {
  if (samples.length < 2) {
    throw new StitchRefusal(`a scale-vs-Z model needs at least two heights; got ${samples.length}`);
  }
  for (const s of samples) {
    if (!(s.pxPerMm > 0)) throw new StitchRefusal(`pxPerMm must be positive at Z ${s.z}, got ${s.pxPerMm}`);
  }
  const sorted = [...samples].sort((p, q) => p.z - q.z);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as ScaleSample;
    const cur = sorted[i] as ScaleSample;
    if (Math.abs(cur.z - prev.z) < EPS) {
      throw new StitchRefusal(`two scale samples state Z ${cur.z} with different scales; one height has one scale`);
    }
  }
  const rows = sorted;
  return {
    samples: rows,
    at(z: Mm) {
      for (const row of rows) {
        if (Math.abs(row.z - z) < EPS) return { pxPerMm: row.pxPerMm, mmPerPixel: 1 / row.pxPerMm, interpolated: false };
      }
      for (let i = 1; i < rows.length; i++) {
        const lo = rows[i - 1] as ScaleSample;
        const hi = rows[i] as ScaleSample;
        if (z > lo.z && z < hi.z) {
          const t = (z - lo.z) / (hi.z - lo.z);
          const pxPerMm = lo.pxPerMm + (hi.pxPerMm - lo.pxPerMm) * t;
          return { pxPerMm, mmPerPixel: 1 / pxPerMm, interpolated: true };
        }
      }
      return null;
    },
  };
}

export interface FeatureResidual {
  id: number;
  /** Observed minus predicted, px. */
  px: PixelPoint;
  /** The same, in machine mm through the fit's own map. */
  mm: MachinePoint;
  /** Its length, mm. */
  normMm: Mm;
}

export interface HeldOutReport {
  residuals: FeatureResidual[];
  /** The worst feature's length, mm; null when the sample showed no known feature. */
  maxMm: Mm | null;
  worstId: number | null;
}

/**
 * The held-out reading: given a fit made WITHOUT this sample, predict where each of the sample's
 * known features lands and report the error. The caller is responsible for excluding the node from
 * `fitStitch`; this function cannot know what went in, and pretending otherwise is how a fitting
 * residual gets reported as accuracy.
 */
export function heldOutResidual(fit: StitchFit, sample: CaptureSample): HeldOutReport {
  const residuals: FeatureResidual[] = [];
  let maxMm: Mm | null = null;
  let worstId: number | null = null;
  for (const feature of sample.features) {
    const predicted = pixelOf(fit, sample.at, feature.at);
    const pu = feature.px.u - predicted.u;
    const pv = feature.px.v - predicted.v;
    const mm = pixelVectorToMm(fit, pu, pv);
    const normMm = Math.hypot(mm.x, mm.y);
    residuals.push({ id: feature.id, px: { u: pu, v: pv }, mm, normMm });
    if (maxMm === null || normMm > maxMm) {
      maxMm = normMm;
      worstId = feature.id;
    }
  }
  return { residuals, maxMm, worstId };
}

export interface HeldOutCheck extends HeldOutReport {
  toleranceMm: Mm;
  pass: boolean;
}

/** `heldOutResidual` against a STATED tolerance. The tolerance is the caller's claim, not ours. */
export function validateHeldOut(fit: StitchFit, sample: CaptureSample, toleranceMm: Mm): HeldOutCheck {
  if (!(toleranceMm > 0)) throw new StitchRefusal(`a held-out tolerance must be positive, got ${toleranceMm}`);
  const report = heldOutResidual(fit, sample);
  return { ...report, toleranceMm, pass: report.maxMm !== null && report.maxMm <= toleranceMm };
}

export interface RevalidationResult {
  /** True only when a residual was measured AND it is inside the tolerance. */
  pass: boolean;
  toleranceMm: Mm;
  /** The scale used to turn the pixel residual into mm. */
  mmPerPixel: Mm;
  report: HeldOutReport;
  /**
   * Why no verdict can be given (no known feature, no scale at this height, a bad tolerance), or
   * null. A check that cannot be made is NOT a pass.
   */
  problem: string | null;
}

/**
 * The routine re-validation: photograph one known feature and check it against the model. This is
 * the seconds-long check that gets run before a job, against the full grid's fit.
 *
 * `mmPerPixel` defaults to the fit's own scale — the honest default, because the fit's geometry
 * and the scale must come from the SAME height. A caller that calibrated the fit at one Z and is
 * re-validating at another passes `fitScaleVsZ(...).at(z)`; if the model claims nothing at that
 * height the answer is a problem, never a pass.
 */
export function revalidate(args: {
  fit: StitchFit;
  sample: CaptureSample;
  toleranceMm: Mm;
  mmPerPixel?: Mm;
}): RevalidationResult {
  const toleranceMm = args.toleranceMm;
  const mmPerPixel = args.mmPerPixel ?? args.fit.mmPerPixel;
  const base: Omit<RevalidationResult, 'report'> = {
    pass: false,
    toleranceMm,
    mmPerPixel,
    problem: null,
  };
  if (!(toleranceMm > 0)) {
    return { ...base, problem: `the tolerance must be positive, got ${toleranceMm}`, report: { residuals: [], maxMm: null, worstId: null } };
  }
  if (!(mmPerPixel > 0)) {
    return { ...base, problem: `the scale must be positive, got ${mmPerPixel}`, report: { residuals: [], maxMm: null, worstId: null } };
  }
  const report = heldOutResidual(args.fit, args.sample);
  if (report.maxMm === null) {
    return { ...base, problem: 'the frame shows no known feature to check', report };
  }
  // The residuals' mm are computed at the FIT's scale; restate them at the scale the caller chose
  // (a different Z), keeping the pixel error that was actually observed.
  const scale = mmPerPixel / args.fit.mmPerPixel;
  const rescaled = report.residuals.map((r) => {
    const mm = { x: r.mm.x * scale, y: r.mm.y * scale };
    return { ...r, mm, normMm: Math.hypot(mm.x, mm.y) };
  });
  let maxMm: Mm | null = null;
  let worstId: number | null = null;
  for (const r of rescaled) {
    if (maxMm === null || r.normMm > maxMm) {
      maxMm = r.normMm;
      worstId = r.id;
    }
  }
  const final: HeldOutReport = { residuals: rescaled, maxMm, worstId };
  return { ...base, pass: maxMm !== null && maxMm <= toleranceMm, report: final };
}

/** A stated pair of machine points, for callers assembling a grid from the target's own list. */
export function machinePoint(x: Mm, y: Mm): MachinePoint {
  return { x, y };
}

/** A fiducial's sheet position as a machine point, given the sheet origin (mm, machine frame). */
export function sheetToMachine(sheet: Vec2, origin: MachinePoint): MachinePoint {
  return { x: origin.x + sheet[0], y: origin.y + sheet[1] };
}
