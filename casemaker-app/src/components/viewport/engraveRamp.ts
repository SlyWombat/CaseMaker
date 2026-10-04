/**
 * The engrave preview's depth ramp (#205) — a plain module so the ramp can be pinned by a test
 * without a canvas, and so `EngravePreview.tsx` exports components only
 * (`react-refresh/only-export-components`, the same rule that moved the camera helpers into
 * `viewportCamera.ts` under #197).
 *
 * The ramp is FIXED, not per-job: the same depth reads as the same colour in every job, so a
 * 1 mm pocket never looks like a 2 mm one because the job's deepest cut changed.
 */

import * as THREE from 'three';

/** The ramp's ends: shallowest and deepest, per the issue (#205). */
export const SHALLOW_COLOR = '#ffe08a';
export const DEEP_COLOR = '#7a2e0e';

/**
 * Depth → colour on the fixed ramp over `[0, maxDepth]`, where `maxDepth` is
 * `thickness − minFloor` (#205). Out-of-range depths clamp to the ends; a zero or negative
 * `maxDepth` (nothing cuttable) reads as the shallow end rather than dividing by zero.
 */
export function depthColor(depth: number, maxDepth: number): string {
  const t = maxDepth > 0 ? Math.min(Math.max(depth / maxDepth, 0), 1) : 0;
  return `#${new THREE.Color(SHALLOW_COLOR).lerp(new THREE.Color(DEEP_COLOR), t).getHexString()}`;
}
