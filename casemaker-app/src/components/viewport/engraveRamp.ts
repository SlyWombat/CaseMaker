/**
 * The engrave preview's colours (#205) — a plain module so the ramp can be pinned by a test
 * without a canvas, and so `EngravePreview.tsx` exports components only
 * (`react-refresh/only-export-components`, the same rule that moved the camera helpers into
 * `viewportCamera.ts` under #197).
 *
 * The ramp is FIXED, not per-job: the same depth reads as the same colour in every job, so a
 * 1 mm pocket never looks like a 2 mm one because the job's deepest cut changed.
 *
 * The void outline's colour lives here rather than beside the meshes that draw it because BOTH
 * the meshes and the DOM legend (#349) need the same constant, and the meshes' own module
 * (`EngravePreview.tsx`) may export components only — the rule named in the first paragraph above.
 * The constraint is that export rule, not an objection to importing three: this file imports it
 * for the ramp.
 */

import * as THREE from 'three';

/** The ramp's ends: shallowest and deepest, per the issue (#205). */
export const SHALLOW_COLOR = '#ffe08a';
export const DEEP_COLOR = '#7a2e0e';

/** #271 — the amber a declared under-surface void is outlined in, on the face and in the legend. */
export const VOID_COLOR = '#e0c07a';

/**
 * Depth → colour on the fixed ramp over `[0, maxDepth]`, where `maxDepth` is
 * `thickness − minFloor` (#205). Out-of-range depths clamp to the ends; a zero or negative
 * `maxDepth` (nothing cuttable) reads as the shallow end rather than dividing by zero.
 */
export function depthColor(depth: number, maxDepth: number): string {
  const t = maxDepth > 0 ? Math.min(Math.max(depth / maxDepth, 0), 1) : 0;
  return `#${new THREE.Color(SHALLOW_COLOR).lerp(new THREE.Color(DEEP_COLOR), t).getHexString()}`;
}
