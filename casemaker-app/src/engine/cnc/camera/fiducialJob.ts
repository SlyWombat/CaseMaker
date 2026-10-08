/**
 * The milled half of the camera target (#189): a `CameraTargetSpec` as an `EngraveJob`.
 *
 * Cutting the crosses is not a special pipeline. A fiducial is a POCKET — two rectangles crossing,
 * at one depth — so the job is an ordinary engrave job, and it generates, verifies, simulates and
 * posts through everything the app already has (`engraveGenerate`, the emulator, `post/z1.ts`). What
 * this module decides is only the layout, and it decides it by asking `targetSpec` rather than by
 * re-deriving the grid: the milled cross and the printed pocket therefore come from one arithmetic
 * and cannot disagree about where a fiducial is.
 *
 * The builder is PURE — it returns a plain `EngraveJob` — so it is unit-tested without wasm, and
 * `scripts/camera-target.ts` feeds the result straight into the generator.
 */

import type { EngraveJob, EngraveRectShape } from '@/types/engraveJob';
import { cameraTargetFiducials, type CameraTargetSpec } from './targetSpec';

/**
 * A cross as two rectangles. Sharp corners (`cornerRadius: 0`) on purpose: the cutter rounds them
 * anyway, and a radius smaller than the cutter's is a number that means nothing.
 */
function crossArms(id: string, at: [number, number], arm: number, stroke: number, depth: number): EngraveRectShape[] {
  const [x, y] = at;
  const base = { position: { x, y }, rotation: 0, depth, enabled: true, cornerRadius: 0 };
  return [
    { ...base, id: `${id}-h`, name: `Fiducial ${id} away arm`, kind: 'rect', width: arm, height: stroke },
    { ...base, id: `${id}-v`, name: `Fiducial ${id} across arm`, kind: 'rect', width: stroke, height: arm },
  ];
}

/**
 * The job that mills a target's fiducials.
 *
 * `base` supplies what the spec does not: the sheet's THICKNESS and material (the sheet is stock
 * somebody bought), the cutter, the workholding, `minFloor`, `edgeMargin`, the vise and any
 * sacrificial material. Its own items are DISCARDED — the job contains only the crosses, for the
 * same reason a coupon does. The sheet's own width and depth come from the SPEC, because the target
 * has to fit the sheet that was cut for it.
 *
 * Throws on a spec with no fiducials: the caller checks `cameraTargetProblem` first, and a job with
 * no cross is a mis-typed target rather than a program.
 */
export function cameraFiducialJob(spec: CameraTargetSpec, base: EngraveJob): EngraveJob {
  const centres = cameraTargetFiducials(spec);
  if (centres.length === 0) throw new Error(`camera target "${spec.id}" has no fiducials to mill`);

  const { arm, stroke, depth } = spec.fiducials;
  return {
    ...base,
    name: `${spec.title} — fiducials`,
    stock: { ...base.stock, length: spec.sheet.width, width: spec.sheet.depth },
    labels: [],
    shapes: centres.flatMap((at, i) => crossArms(String(i), at, arm, stroke, depth)),
    combined: [],
    traces: [],
    vectors: [],
    drills: [],
    keepOuts: [],
  };
}

/** How many cuts a fiducial job makes, for the script's receipt and for tests. */
export function cameraFiducialCutCount(spec: CameraTargetSpec): number {
  return cameraTargetFiducials(spec).length * 2; // two arms per cross
}
