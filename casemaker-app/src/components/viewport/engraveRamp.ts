/**
 * The engrave preview's colours (#205) — a plain module so the ramp can be pinned by a test
 * without a canvas, and so `EngravePreview.tsx` exports components only
 * (`react-refresh/only-export-components`, the same rule that moved the camera helpers into
 * `viewportCamera.ts` under #197).
 *
 * The ramp is FIXED, not per-job: the same depth reads as the same colour in every job, so a
 * 1 mm pocket never looks like a 2 mm one because the job's deepest cut changed.
 *
 * #170 adds a second colouring BESIDE the ramp, not on it: on a blank that states its colour split
 * a floor is drawn by which side of the split it lands on (two stand-in colours), and the depth
 * ramp is what a blank with no split uses. `floorColor` is the one place that choice is made, so
 * the meshes and the legend cannot end up on different ones.
 *
 * The void outline's colour lives here rather than beside the meshes that draw it because BOTH
 * the meshes and the DOM legend (#349) need the same constant, and the meshes' own module
 * (`EngravePreview.tsx`) may export components only — the rule named in the first paragraph above.
 * The constraint is that export rule, not an objection to importing three: this file imports it
 * for the ramp.
 */

import * as THREE from 'three';
import { floorColour, type FloorColour } from '@/engine/cnc/engrave/depthIntent';

/** The ramp's ends: shallowest and deepest, per the issue (#205). */
export const SHALLOW_COLOR = '#ffe08a';
export const DEEP_COLOR = '#7a2e0e';

/** #271 — the amber a declared under-surface void is outlined in, on the face and in the legend. */
export const VOID_COLOR = '#e0c07a';

/**
 * #170 — the two colours a floor is drawn in on a blank that states its colour split, when the
 * question is no longer "how deep" but "which colour".
 *
 * STAND-INS, and named as such in the legend. Nothing in the app maps an extruder to an RGB value
 * (`BadgeParams.bottomExtruder` / `topExtruder` are tool numbers, not colours), so these two are
 * picked to be unmistakable for anything real: one plainly cool, one plainly warm, neither of them
 * the stock's wood tone and neither of them on the depth ramp. A user who reads them as the blank's
 * actual filament colours would be reading a claim this app has not made — which is why the legend
 * calls them stand-ins rather than labelling them "blue" and "orange".
 */
export const SPLIT_TOP_COLOR = '#4c8dff';
export const SPLIT_BOTTOM_COLOR = '#ff7a45';

/** The stand-in for one side of the split — the ONE place the two be swapped for real filament. */
export function splitColor(colour: FloorColour): string {
  return colour === 'top' ? SPLIT_TOP_COLOR : SPLIT_BOTTOM_COLOR;
}

/**
 * Depth → colour on the fixed ramp over `[0, maxDepth]`, where `maxDepth` is
 * `thickness − minFloor` (#205). Out-of-range depths clamp to the ends; a zero or negative
 * `maxDepth` (nothing cuttable) reads as the shallow end rather than dividing by zero.
 */
export function depthColor(depth: number, maxDepth: number): string {
  const t = maxDepth > 0 ? Math.min(Math.max(depth / maxDepth, 0), 1) : 0;
  return `#${new THREE.Color(SHALLOW_COLOR).lerp(new THREE.Color(DEEP_COLOR), t).getHexString()}`;
}

/**
 * The colour a floor is DRAWN in (#170): the two-colour answer where the blank states its split,
 * the depth ramp where it does not.
 *
 * The two are not two aesthetics of one fact — they answer different questions. On a one-colour
 * blank the only thing a floor's appearance can say is how deep it is. On a two-colour blank depth
 * is no longer what the user is looking at: 1.0 mm and 1.4 mm straddling a 1.2 mm split look
 * nearly the same and mean entirely different things, so the ramp would invite exactly the mistake
 * the control exists to prevent. The depth ramp stays for the blank that has only depths.
 *
 * `splitDepth` is `EngravePreview.colourBoundaryDepth`, so the picture and the `item-depth-bound`
 * finding are told the same plane by the same number.
 */
export function floorColor(depth: number, maxDepth: number, splitDepth: number | null): string {
  const colour = floorColour(depth, splitDepth);
  return colour === null ? depthColor(depth, maxDepth) : splitColor(colour);
}
