/**
 * Camera maths and the camera command, shared by the viewport components (#197 §6, §7).
 *
 * Plain `.ts` on purpose: `activeSceneBounds` and the camera-event dispatcher are values, not
 * components, and exporting them from a component file failed
 * `react-refresh/only-export-components` (the review on #197). Keeping them here also gives the
 * presets, `AutoFrame` and the toolbar ONE place to agree about where the scene is — and gives
 * #205's engrave-preview branch a single module to extend.
 */

import * as THREE from 'three';
import type { NodeVariant } from '@/types/variant';
import { isAlternativeNode } from '@/engine/exporters/parts';

/** An axis-aligned box, as every `NodeMeshOutput.bbox` is: one min and one max per axis. */
export type SceneBox = { min: readonly number[]; max: readonly number[] };

/** Everything `activeSceneBounds` needs — the function itself stays pure and testable (#197 §6). */
export interface SceneBoundsInput {
  /** The case's compiled nodes, exactly as `jobStore.nodes` holds them. */
  nodes: Map<string, { stats: { bbox: SceneBox } }>;
  /**
   * The boxes the SIMULATION draws — its stock mesh first, then one per fixture obstacle — or
   * `null` when no simulation owns the viewport, in which case the case's nodes are framed.
   * A path-only session (#194) has no material at all, so its path's own extent is passed here
   * instead: the camera must still centre on the one thing that is drawn.
   */
  simBoxes: readonly SceneBox[] | null;
  /**
   * The boxes the ENGRAVE PREVIEW draws (#205) — its stock mesh first, then one per vise jaw —
   * or `null`/absent when the engrave section is not the one on screen. An empty list means the
   * section IS open but the preview has not arrived yet: nothing is framed (the camera keeps its
   * place) rather than falling back to a case that is not drawn.
   */
  engraveBoxes?: readonly SceneBox[] | null;
}

/** Centre + diagonal of everything currently in the scene, or null if empty. */
function sceneBounds(
  nodes: Map<string, { stats: { bbox: SceneBox }; variant?: NodeVariant }>,
): { center: THREE.Vector3; diag: number } | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const [id, n] of nodes.entries()) {
    // The map is keyed by id, so the id is not on the value — hand the
    // predicate both halves of what it needs.
    if (isAlternativeNode({ id, variant: n.variant })) continue; // same geometry as what it fuses
    for (let a = 0; a < 3; a++) {
      if (n.stats.bbox.min[a]! < min[a]!) min[a] = n.stats.bbox.min[a]!;
      if (n.stats.bbox.max[a]! > max[a]!) max[a] = n.stats.bbox.max[a]!;
    }
  }
  if (!Number.isFinite(min[0]!)) return null;
  const diag = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  if (diag <= 0) return null;
  return {
    center: new THREE.Vector3(
      (min[0]! + max[0]!) / 2,
      (min[1]! + max[1]!) / 2,
      (min[2]! + max[2]!) / 2,
    ),
    diag,
  };
}

/** Centre + diagonal of a set of boxes, or null when there are none worth framing. */
function boundsOfBoxes(boxes: Iterable<SceneBox>): { center: THREE.Vector3; diag: number } | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let any = false;
  for (const b of boxes) {
    any = true;
    for (let a = 0; a < 3; a++) {
      if (b.min[a]! < min[a]!) min[a] = b.min[a]!;
      if (b.max[a]! > max[a]!) max[a] = b.max[a]!;
    }
  }
  if (!any || !Number.isFinite(min[0]!)) return null;
  const diag = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  if (diag <= 0) return null;
  return {
    center: new THREE.Vector3(
      (min[0]! + max[0]!) / 2,
      (min[1]! + max[1]!) / 2,
      (min[2]! + max[2]!) / 2,
    ),
    diag,
  };
}

/**
 * Issue #197 §6 — the bounds of whatever is actually ON SCREEN. Both camera presets and AutoFrame
 * read this, so Top / Front / Side / Perspective / Fit can never centre on a case that is not
 * being drawn while a simulation (or, later, an engrave preview) is up.
 */
export function activeSceneBounds(input: SceneBoundsInput): { center: THREE.Vector3; diag: number } | null {
  if (input.simBoxes !== null) return boundsOfBoxes(input.simBoxes);
  // #205 — while the engrave section owns the viewport, frame the preview's stock and jaws, never
  // the case, which is not drawn. `!= null` (not a truthiness test) so an EMPTY list still takes
  // the branch and frames nothing, instead of leaking the case's nodes in.
  if (input.engraveBoxes != null) return boundsOfBoxes(input.engraveBoxes);
  return sceneBounds(input.nodes);
}

/**
 * Issue #197 review, fix 3 — whether `AutoFrame` should move the camera. `forced` is set when the
 * thing on screen changed identity: a program LOAD, or the END of a simulation. Otherwise the
 * camera only moves on a substantial (>35%) change in the scene's diagonal, so it never fights
 * the user's own orbiting.
 *
 * The diagonal alone is not enough to decide: a stock about the size of the case but centred
 * somewhere else in the work frame passes the size rule, so on close the camera would be left
 * looking at nothing. That transition is exactly why closing the simulation forces a re-frame.
 */
export function shouldReframe(prevDiag: number, nextDiag: number, forced: boolean): boolean {
  if (forced) return true;
  if (prevDiag <= 0) return true;
  return nextDiag >= prevDiag * 1.35 || nextDiag <= prevDiag / 1.35;
}

/**
 * Issue #197 §7 — the zoom group's three commands. The toolbar is OUTSIDE the `<Canvas>`, so
 * these are delivered to the camera as a window event rather than through a store: the stores
 * hold plain data only, never a three object.
 */
export const VIEWPORT_CAMERA_EVENT = 'casemaker:viewport-camera';
export type ViewportCameraCommand = 'zoom-in' | 'zoom-out' | 'fit';

/** Ask the in-canvas camera to zoom or to fit. A no-op before the Canvas has mounted. */
export function dispatchViewportCamera(command: ViewportCameraCommand): void {
  window.dispatchEvent(new CustomEvent<ViewportCameraCommand>(VIEWPORT_CAMERA_EVENT, { detail: command }));
}
