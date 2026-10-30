// #286 — the stitch and re-validation maths, against fixture frames. A "frame" here is what
// detection would hand this layer: which known feature (by id and true machine position) landed at
// which pixel. The planted camera is a similarity with a reflection (the common v-down/y-back
// convention), a yaw, a spindle-to-camera offset and, in one case, first-order radial distortion —
// so every recovered number has a truth to compare against, and the machine-error fixtures are
// planted OUTSIDE the optical model on purpose.

import { describe, expect, it } from 'vitest';
import {
  cameraToSpindleOffset,
  closureResidual,
  distortionOf,
  fitScaleVsZ,
  fitStitch,
  heldOutResidual,
  machineOf,
  pixelOf,
  revalidate,
  validateHeldOut,
  yawFromAxisMove,
  type CaptureSample,
  type FeatureObservation,
  type MachinePoint,
  type PixelPoint,
} from '@/engine/cnc/camera/calibrate';

const DEG = Math.PI / 180;

interface Planted {
  pxPerMm: number;
  yawDeg: number;
  centre: PixelPoint;
  /** Camera axis relative to the spindle, mm. The camera-to-spindle offset is its negative. */
  spindleToCamera: MachinePoint;
  /** First-order radial coefficient, px⁻². */
  k1: number;
}

const NOMINAL: Planted = {
  pxPerMm: 20,
  yawDeg: 7,
  centre: { u: 320, v: 240 },
  spindleToCamera: { x: 3, y: -2 },
  k1: 0,
};

const W = 640;
const H = 480;

/** Where a feature at `feature` lands when the machine physically sits at `physical`. */
function pixelAt(planted: Planted, physical: MachinePoint, feature: MachinePoint): PixelPoint {
  const dx = feature.x - physical.x - planted.spindleToCamera.x;
  const dy = feature.y - physical.y - planted.spindleToCamera.y;
  const c = Math.cos(planted.yawDeg * DEG);
  const s = Math.sin(planted.yawDeg * DEG);
  const u0 = planted.pxPerMm * (c * dx + s * dy);
  const v0 = planted.pxPerMm * (s * dx - c * dy);
  const r2 = u0 * u0 + v0 * v0;
  const factor = 1 + planted.k1 * r2;
  return { u: planted.centre.u + u0 * factor, v: planted.centre.v + v0 * factor };
}

function inside(px: PixelPoint, margin = 8): boolean {
  return px.u > margin && px.u < W - margin && px.v > margin && px.v < H - margin;
}

/** The features the target supplies: milled crosses at known machine positions. */
const FEATURES: MachinePoint[] = [
  { x: 0, y: 0 },
  { x: 8, y: 0 },
  { x: 0, y: 8 },
  { x: 8, y: 8 },
  { x: -6, y: 4 },
  { x: 4, y: -6 },
];

const NODES: MachinePoint[] = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 0, y: 3 },
  { x: -2, y: 2 },
  { x: 3, y: -2 },
];

/** A frame: commanded at `node`, the machine physically at `node + error`, features seen inside. */
function sampleAt(
  node: MachinePoint,
  planted: Planted,
  error: MachinePoint = { x: 0, y: 0 },
  features: readonly MachinePoint[] = FEATURES,
): CaptureSample {
  const physical = { x: node.x + error.x, y: node.y + error.y };
  return {
    at: node,
    width: W,
    height: H,
    features: features
      .map((at, id): FeatureObservation => ({ id, at, px: pixelAt(planted, physical, at) }))
      .filter((f) => inside(f.px)),
  };
}

function samples(nodes: readonly MachinePoint[], planted: Planted): CaptureSample[] {
  return nodes.map((node) => sampleAt(node, planted));
}

describe('#286 camera stitch — the fit', () => {
  it('recovers the planted scale, yaw, anisotropy and the pixel origin', () => {
    const fit = fitStitch(samples(NODES, NOMINAL));
    expect(fit.pxPerMm).toBeCloseTo(20, 9);
    expect(fit.mmPerPixel).toBeCloseTo(0.05, 12);
    expect(fit.yawDeg).toBeCloseTo(7, 9);
    expect(fit.anisotropy).toBeCloseTo(1, 9);
    expect(fit.origin.u).toBeCloseTo(pixelAt(NOMINAL, { x: 0, y: 0 }, { x: 0, y: 0 }).u, 6);
    expect(fit.rmsPx).toBeLessThan(1e-9);
    expect(fit.used).toBeGreaterThanOrEqual(3);
    // The map and its inverse agree.
    const f = { x: 4, y: -3 };
    const p = { x: -1, y: 2 };
    const back = machineOf(fit, f, pixelOf(fit, f, p));
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('a noisy fixture moves the numbers a little and says so through rmsPx', () => {
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 2 ** 32 - 0.5) * 0.3; // ±0.15 px
    };
    const noisy: CaptureSample[] = samples(NODES, NOMINAL).map((sample) => ({
      ...sample,
      features: sample.features.map((f) => ({ ...f, px: { u: f.px.u + rand(), v: f.px.v + rand() } })),
    }));
    const fit = fitStitch(noisy);
    expect(fit.pxPerMm).toBeCloseTo(20, -1); // within about 0.5 %
    expect(Math.abs(fit.yawDeg - 7)).toBeLessThan(0.3);
    expect(fit.rmsPx).toBeGreaterThan(0);
    expect(fit.rmsPx).toBeLessThan(0.3);
  });

  it('refuses a fit that cannot see two directions, instead of reporting a guessed scale', () => {
    const oneLine: CaptureSample[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ].map((node) => ({
      at: node,
      width: W,
      height: H,
      features: [{ id: 0, at: { x: 0, y: 0 }, px: pixelAt(NOMINAL, node, { x: 0, y: 0 } as MachinePoint) }],
    }));
    expect(() => fitStitch(oneLine)).toThrow(/two directions/);
  });
});

describe('#286 camera stitch — the single-axis yaw reading', () => {
  const feature = { x: 0, y: 0 };

  it('reads the planted yaw from a commanded X move', () => {
    const from = pixelAt(NOMINAL, { x: 0, y: 0 }, feature);
    const to = pixelAt(NOMINAL, { x: 10, y: 0 }, feature); // machine moved +10 in X
    const reading = yawFromAxisMove({ from, to }, 'x', 10);
    expect(reading.yawDeg).toBeCloseTo(7, 9);
    expect(reading.pxPerMm).toBeCloseTo(20, 9);
  });

  it('reads it from a commanded Y move too', () => {
    const from = pixelAt(NOMINAL, { x: 0, y: 0 }, feature);
    const to = pixelAt(NOMINAL, { x: 0, y: 10 }, feature);
    const reading = yawFromAxisMove({ from, to }, 'y', 10);
    expect(reading.yawDeg).toBeCloseTo(7, 9);
    expect(reading.pxPerMm).toBeCloseTo(20, 9);
  });
});

describe('#286 camera stitch — distortion across the field', () => {
  it('a clean fixture leaves no distortion to report', () => {
    const fit = fitStitch(samples(NODES, NOMINAL));
    const report = distortionOf(fit, samples(NODES, NOMINAL));
    expect(report.maxPx).toBeLessThan(1e-6);
    expect(Math.abs(report.k1)).toBeLessThan(1e-12);
  });

  it('finds a planted radial term, and the residual it leaves is smaller than the deviation', () => {
    const curved: Planted = { ...NOMINAL, k1: 5e-7 };
    const fit = fitStitch(samples([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }], { ...curved, k1: 0 }));
    const report = distortionOf(fit, samples([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }], curved));
    expect(report.maxPx).toBeGreaterThan(1);
    expect(report.rmsBeforePx).toBeGreaterThan(0);
    expect(report.rmsAfterPx).toBeLessThan(report.rmsBeforePx);
    expect(report.maxMm).toBeCloseTo(report.maxPx * fit.mmPerPixel, 9);
  });
});

describe('#286 camera stitch — closure is machine error, not optical', () => {
  it('a return visit does not bend the fit, and its shift is reported in machine mm', () => {
    const clean = samples(NODES, NOMINAL);
    const repeat = sampleAt(NODES[0]!, NOMINAL, { x: 0.12, y: 0.05 });
    const fitClean = fitStitch(clean);
    const fitRepeat = fitStitch([...clean, repeat]);

    // The repeat was excluded, so every optical number is unchanged.
    expect(fitRepeat.pxPerMm).toBe(fitClean.pxPerMm);
    expect(fitRepeat.mmPerPixel).toBe(fitClean.mmPerPixel);
    expect(fitRepeat.l).toEqual(fitClean.l);
    expect(fitRepeat.origin).toEqual(fitClean.origin);

    const closure = closureResidual(fitRepeat, [...clean, repeat]);
    expect(closure.nodes).toHaveLength(1);
    expect(closure.nodes[0]!.at).toEqual(NODES[0]);
    expect(closure.nodes[0]!.visits).toBe(2);
    expect(closure.nodes[0]!.dxMm).toBeCloseTo(0.12, 6);
    expect(closure.nodes[0]!.dyMm).toBeCloseTo(0.05, 6);
    expect(closure.rmsMm).toBeCloseTo(Math.hypot(0.12, 0.05), 6);
  });

  it('a grid with no repeated node reports no closure at all', () => {
    const fit = fitStitch(samples(NODES, NOMINAL));
    const closure = closureResidual(fit, samples(NODES, NOMINAL));
    expect(closure.nodes).toEqual([]);
    expect(closure.rmsMm).toBe(0);
  });
});

describe('#286 camera stitch — held-out validation and re-validation', () => {
  const heldNode: MachinePoint = { x: 3, y: -2 };
  const train = NODES.filter((n) => n.x !== heldNode.x || n.y !== heldNode.y);

  it('a feature at a node NOT in the fit is predicted, and the error is the planted machine error', () => {
    const fit = fitStitch(samples(train, NOMINAL));
    const held = sampleAt(heldNode, NOMINAL, { x: 0.08, y: -0.04 });
    const report = heldOutResidual(fit, held);
    expect(report.maxMm).toBeCloseTo(Math.hypot(0.08, 0.04), 6);
    expect(report.residuals.length).toBeGreaterThan(0);
  });

  it('the held-out tolerance is the caller’s, and a fitting residual is not a pass', () => {
    const fit = fitStitch(samples(train, NOMINAL));
    const held = sampleAt(heldNode, NOMINAL, { x: 0.08, y: -0.04 });
    expect(validateHeldOut(fit, held, 0.05).pass).toBe(false);
    expect(validateHeldOut(fit, held, 0.2).pass).toBe(true);
    expect(() => validateHeldOut(fit, held, 0)).toThrow(/tolerance/);
  });

  it('re-validation photographs one feature: pass, fail by the stated tolerance, and no verdict without one', () => {
    const fit = fitStitch(samples(train, NOMINAL));
    const known = sampleAt(heldNode, NOMINAL, { x: 0.1, y: 0 });

    expect(revalidate({ fit, sample: known, toleranceMm: 0.15 }).pass).toBe(true);
    expect(revalidate({ fit, sample: known, toleranceMm: 0.05 }).pass).toBe(false);
    // A scale from another height is the caller's to state; at twice the scale the same pixel
    // error is twice the millimetres.
    const atOtherHeight = revalidate({ fit, sample: known, toleranceMm: 0.15, mmPerPixel: fit.mmPerPixel * 2 });
    expect(atOtherHeight.pass).toBe(false);
    expect(atOtherHeight.report.maxMm).toBeCloseTo(0.2, 6);

    const empty: CaptureSample = { at: heldNode, width: W, height: H, features: [] };
    const noFeature = revalidate({ fit, sample: empty, toleranceMm: 0.2 });
    expect(noFeature.pass).toBe(false);
    expect(noFeature.problem).toMatch(/no known feature/);
    const noTolerance = revalidate({ fit, sample: known, toleranceMm: 0 });
    expect(noTolerance.pass).toBe(false);
    expect(noTolerance.problem).toMatch(/tolerance/);
  });
});

describe('#286 camera stitch — the tie-point', () => {
  it('a cross milled by the spindle, seen with the spindle over it, gives the camera-to-spindle offset', () => {
    const fit = fitStitch(samples(NODES, NOMINAL));
    const sample = sampleAt({ x: 0, y: 0 }, NOMINAL);
    // The camera axis sits T = (3, −2) from the spindle, so the camera-to-spindle vector is (−3, 2).
    const offset = cameraToSpindleOffset(fit, sample, 0);
    expect(offset.x).toBeCloseTo(-3, 6);
    expect(offset.y).toBeCloseTo(2, 6);
  });

  it('a cross somewhere else still reads the same offset once its own position is accounted for', () => {
    const fit = fitStitch(samples(NODES, NOMINAL));
    // The frame was taken at (0,0) and feature id 1 is at (8,0): the general reading must agree.
    const sample = sampleAt({ x: 0, y: 0 }, NOMINAL);
    const offset = cameraToSpindleOffset(fit, sample, 1);
    expect(offset.x).toBeCloseTo(-3, 6);
    expect(offset.y).toBeCloseTo(2, 6);
  });
});

describe('#286 camera stitch — scale against Z', () => {
  it('interpolates between calibrated heights and claims nothing outside them', () => {
    const model = fitScaleVsZ([
      { z: 10, pxPerMm: 16 },
      { z: 0, pxPerMm: 20 },
      { z: 5, pxPerMm: 18 },
    ]);
    expect(model.at(5)).toEqual({ pxPerMm: 18, mmPerPixel: 1 / 18, interpolated: false });
    const mid = model.at(7.5);
    expect(mid?.interpolated).toBe(true);
    expect(mid?.pxPerMm).toBeCloseTo(17, 9);
    expect(model.at(12)).toBeNull();
    expect(model.at(-1)).toBeNull();
  });

  it('refuses one height, a non-positive scale, and two scales for one height', () => {
    expect(() => fitScaleVsZ([{ z: 0, pxPerMm: 20 }])).toThrow(/at least two heights/);
    expect(() => fitScaleVsZ([{ z: 0, pxPerMm: 20 }, { z: 5, pxPerMm: 0 }])).toThrow(/positive/);
    expect(() =>
      fitScaleVsZ([
        { z: 0, pxPerMm: 20 },
        { z: 0, pxPerMm: 19 },
      ]),
    ).toThrow(/one height has one scale/);
  });
});
