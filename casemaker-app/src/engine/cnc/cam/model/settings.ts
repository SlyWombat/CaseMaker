/**
 * cam/model/settings.ts — THE SHARED ENGINE PARAMETERS (#959/#960).
 *
 * One place for the numbers the CAM's stages read as PARAMETERS rather than constants-in-code.
 */
import { readDefault } from '@/platform/defaultsClient';
import type { Tool } from '@/engine/cnc/tool';


/** The ruled value, as a plain-number-returning function for callers that state no override. */
export function flatSurfaceMaxSlopeDeg(): number {
  // #1207 — the ruled 1.93° is the registry's recommendation for `finish.flatSurfaceMaxSlopeDeg`.
  return readDefault(null, 'finish.flatSurfaceMaxSlopeDeg').value;
}

/** The cutter shapes a flat/surface threshold applies to: the flat family, not balls or V bits. */
export function isFlatFamily(tool: Tool): boolean {
  return tool.shape === 'flat' || tool.shape === 'bull';
}

/**
 * THE SKIN PASS'S PER-PASS DEPTH CAP, as a MULTIPLE of the cutter row's own step-down (#959).
 * DECIDED (#943's ruling, 2026-11-05): the maintainer took the per-pass cap itself — "no pass
 * deeper than the row's step-down" — and the one-pass-up-to-1.25x option is NOT taken. 1.0: the
 * ⌀6 row's 1.0 mm step-down gives two passes on the tray's 1.2 mm skin and one on the
 * organizer's 0.8.
 */
export const SKIN_STEPDOWN_FACTOR = {
  value: 1.0,
  status: 'decided' as const,
  note: 'the #943 ruling (2026-11-05): every pass capped at the row’s own step-down; the 1.25x one-pass option was not taken',
} as const;

export function skinStepdownFactor(): number {
  return SKIN_STEPDOWN_FACTOR.value;
}
