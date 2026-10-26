/**
 * #672 — THE IMAGE RELIEF'S ONE MAPPING, and nothing else.
 *
 * A greyscale image becomes a top-Z heightfield: every pixel's LUMINANCE maps to a depth below the
 * goal's top face, and the existing goal pipeline (`sampleGoalHeightfield` → `cam/surface3d.ts`)
 * roughs and finishes it like any mesh goal. This module owns the map itself so the sampler, the
 * row and the sheet cannot state different numbers:
 *
 *     white01 = luminance / 255                       (Rec.601; `import/png.ts` decodes)
 *     depth   = D × (invert ? white01 : 1 − white01)  black is deep by default
 *     z       = topZ − depth
 *
 * The TWO numbers are the relief depth D and the direction (`invert`: white at the top face, the
 * default, or black at the top face). D defaults to {@link DEFAULT_RELIEF_DEPTH_MM}, a labelled
 * CAM default whose source word is "the CAM's default" until the operator types one — the #671
 * crease-angle precedent, and deliberately NOT a shop-default seed. Gamma is not part of the map:
 * the issue lists it as a maybe behind a disclosure, and a third curve knob with no measured need
 * is a speculative control.
 */

import type { EngraveReliefSettings } from '@/types/engraveJob';

/** The relief depth a picture runs with when the operator states none, mm — labelled, not measured. */
export const DEFAULT_RELIEF_DEPTH_MM = 1.5;

/** Where the relief depth came from, in the words the row prints. */
export type ReliefDepthSource = 'typed' | 'the CAM’s default';

export interface ReliefNumbers {
  /** The deepest cut the picture asks for, mm below the goal's top face. */
  maxDepthMm: number;
  /** True when BLACK is the top face (the picture's tones inverted). */
  invert: boolean;
  /** Where `maxDepthMm` came from. */
  depthSource: ReliefDepthSource;
}

/** Resolve the target's relief block into the two numbers the sample runs with. */
export function reliefNumbers(settings: EngraveReliefSettings | undefined): ReliefNumbers {
  const typed = settings?.maxDepthMm;
  return {
    maxDepthMm: typed !== undefined && typed > 0 ? typed : DEFAULT_RELIEF_DEPTH_MM,
    invert: settings?.invert === true,
    depthSource: typed !== undefined && typed > 0 ? 'typed' : 'the CAM’s default',
  };
}

/**
 * THE MAP: one luminance byte to one depth below the top face, mm. `grey` 0–255; 255 is the top
 * face unless `invert`, which puts 0 at the top and 255 at `maxDepthMm`.
 */
export function reliefDepthMm(grey: number, maxDepthMm: number, invert: boolean): number {
  const white01 = Math.min(255, Math.max(0, grey)) / 255;
  return maxDepthMm * (invert ? white01 : 1 - white01);
}
