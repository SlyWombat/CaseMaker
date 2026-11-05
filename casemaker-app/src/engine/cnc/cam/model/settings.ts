/**
 * cam/model/settings.ts — THE SHARED ENGINE PARAMETERS (#959, #960; 2026-11-05 ruling).
 *
 * One place for the numbers the CAM's stages read as PARAMETERS rather than constants-in-code.
 * Each is a named value a caller (or a spec) may override; none is a job-document field yet.
 */
import type { Tool } from '@/engine/cnc/tool';

/**
 * THE SLOPE WHERE THE FLAT SURFACE-FOLLOWING PASS TAKES OVER (#959; shared with D's #960
 * flat/ball choice). A surface cell at or under this slope is cut by the flat's surface-following
 * pass (`skin`, and the flat's own finish choice); a steeper cell is left to the ball.
 *
 * RULED 1.93° by the manager on 2026-11-05 (#960): the equal-cusp derivation on a ⌀6 ball at the
 * vendor's 0.027 mm scallop. The vendor-like 7.1° reading was not taken. Every caller reads it
 * through this object; the specs pass both candidates to prove it is a parameter, not baked in.
 */
export const FLAT_SURFACE_MAX_SLOPE_DEG = {
  value: 1.93,
  status: 'ruled' as const,
  note: 'the manager ruled 1.93° on 2026-11-05 (#960); the candidates were 1.9–7.1',
} as const;

/** The ruled value, as a plain number for callers that state no override. */
export function flatSurfaceMaxSlopeDeg(): number {
  return FLAT_SURFACE_MAX_SLOPE_DEG.value;
}

/**
 * THE SKIN PASS'S PER-PASS DEPTH CAP, as a MULTIPLE of the cutter row's own step-down (#959;
 * the maintainer's decision pending on #943, the manager recommending one pass up to 1.25x).
 * 1.0 today: the ⌀6 row's 1.0 mm step-down gives two passes on the tray's 1.2 mm skin and one on
 * the organizer's 0.8; 1.25 would take the tray in one. One-line change either way.
 */
export const SKIN_STEPDOWN_FACTOR = {
  value: 1.0,
  status: 'provisional' as const,
  note: 'the maintainer’s #943 decision pending (1.0 vs one pass up to 1.25x the row)',
} as const;

export function skinStepdownFactor(): number {
  return SKIN_STEPDOWN_FACTOR.value;
}

/** The cutter shapes a flat/surface threshold applies to: the flat family, not balls or V bits. */
export function isFlatFamily(tool: Tool): boolean {
  return tool.shape === 'flat' || tool.shape === 'bull';
}
