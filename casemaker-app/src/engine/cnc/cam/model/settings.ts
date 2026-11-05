/**
 * cam/model/settings.ts — the settings the model engine SHARES between its own ops (#960).
 *
 * One constant lives here because two ops must agree on it: the flat/ball decision in the finish
 * (`ops/finish.ts`, #960) and the skin pass's flat (C's #959). A second copy in either module
 * would let the two drift apart silently, which is exactly the class of bug the engine's one
 * interface exists to prevent.
 */
import type { Tool } from '@/engine/cnc/tool';

/**
 * THE SLOPE ABOVE WHICH A FLAT CUTTER IS NOT WORTH USING, degrees — the shared flat/surface
 * threshold. The finish reads it as a PARAMETER (`FinishOpOptions`/`planModelCam`'s
 * `flatFinishMaxSlopeDeg`), so a caller may override it; this is the default every caller that
 * states none gets.
 *
 * The value is PENDING the manager's ruling on #960's picture (the equal-cusp derivation gives
 * 1.93° on a ⌀6 ball at a 0.027 mm scallop; the vendor-like reading gives 7.1°). Both ops read
 * this ONE number, so the ruling changes it here and nowhere else.
 */
export const FLAT_SURFACE_MAX_SLOPE_DEG = 1.93;

/** The cutter shapes a flat/surface threshold applies to: the flat family, not balls or V bits. */
export function isFlatFamily(tool: Tool): boolean {
  return tool.shape === 'flat' || tool.shape === 'bull';
}
