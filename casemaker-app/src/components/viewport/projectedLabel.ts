/**
 * #359 — where a scene-anchored label goes when its box would leave the canvas.
 *
 * The engrave preview's labels are `<Html>`s anchored to a world point with `center`, so the
 * wrapper is translated to that point's projected screen position and the box is centred on it.
 * A box whose anchor sits near the canvas edge therefore runs past it by half its WIDTH, and the
 * canvas-sized wrapper clips it mid-word: measured 2026-10-11 at 1024 × 700 (canvas 344 px wide),
 * `engrave-jaw-source` spanned −55 → 77 px from the canvas's left edge and read "…asured
 * defaults" on screen.
 *
 * The fix is to clamp the box INTO the canvas (issue #359, option 1) rather than flip it to the
 * other side of its anchor or drop the clipping: at that width the ANCHORS are off the canvas too
 * — the jaw projects to x ≈ 11 and the +x axis end to x ≈ −6, because the stock overflows a canvas
 * this narrow — so a flip moves a label from one clip to another, and #348 deliberately puts
 * projected annotations under the chrome rather than over it. A clamp is the only one of the three
 * that works wherever the anchor is.
 *
 * The clamp needs the box's own size (`max(x, pad + w/2)`, not a fixed inset), so the caller
 * measures the box and passes it in — which keeps the arithmetic testable without a canvas.
 */

import * as THREE from 'three';

/** The clearance a clamped label keeps from the canvas edge. */
export const LABEL_PAD = 6;

/** The space the labels are positioned in: r3f's `size`, in CSS pixels. */
export interface CanvasSize {
  width: number;
  height: number;
}

function clampAxis(value: number, box: number, extent: number, pad: number): number {
  const near = pad + box / 2;
  const far = extent - pad - box / 2;
  // A box wider than the space it has: there is no inside to sit in, so centre it. Clipping both
  // edges equally is the honest failure — `Math.min(Math.max(v, near), far)` would silently return
  // `far`, which is LEFT of `near`, putting the box past the very edge being defended.
  if (far < near) return extent / 2;
  return Math.min(Math.max(value, near), far);
}

/**
 * The `[x, y]` at which a box of `box` px, centred on the anchor, keeps the whole box inside the
 * canvas with `pad` to spare (#359). A box already comfortably inside is returned unchanged.
 *
 * The property that makes this sufficient without the leader line the issue mentions: the clamp
 * only moves a box whose anchor is within `pad + w/2` of an edge, and it moves it to exactly
 * `pad + w/2` — so the box still contains the anchor for any anchor at least `pad` inside. Only an
 * anchor that is itself off-canvas (or inside the pad) ends up detached, and a leader line there
 * would be a stub pointing off-canvas at nothing.
 */
export function clampLabelBox(
  x: number,
  y: number,
  box: { width: number; height: number },
  size: CanvasSize,
  pad: number = LABEL_PAD,
): [number, number] {
  return [clampAxis(x, box.width, size.width, pad), clampAxis(y, box.height, size.height, pad)];
}

/** Scratch for `projectToCanvas` — drei keeps module-level vectors for the same reason. */
const projected = new THREE.Vector3();

/**
 * World → canvas pixels: the arithmetic drei's own `defaultCalculatePosition` does, re-stated here
 * because it is module-local in `@react-three/drei` and not exported. It is the identity a label
 * needs to sit ON its anchor — a point on the camera's axis lands at the canvas centre — so a
 * clamped label replaces drei's default rather than drifting from it.
 */
export function projectToCanvas(
  el: THREE.Object3D,
  camera: THREE.Camera,
  size: CanvasSize,
): [number, number] {
  projected.setFromMatrixPosition(el.matrixWorld).project(camera);
  return [
    projected.x * (size.width / 2) + size.width / 2,
    -(projected.y * (size.height / 2)) + size.height / 2,
  ];
}
