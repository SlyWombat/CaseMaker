/**
 * #1203 — THE COLLET, IN THE OPERATOR'S WORDS.
 *
 * The wired probe V2's sensor and tip are one unit; its SHANK is a threaded post that swaps for a
 * different collet — 1/8" (6.35 mm) or 6 mm on this bench (the 1/8" post is broken, 2026-11-10).
 * With a 3.175 mm collet still in the spindle from the last cutter, a 6 mm-shank probe does not
 * fit, and a fit-probe prompt that names no collet leaves the operator to discover that at the
 * machine.
 *
 * The unit records the FITTED post's shank diameter (`unit.shankMm`); every "fit the probe"
 * sentence names the collet from it. A record with no shank says to check it rather than guessing
 * — the same honesty `probeFor` keeps about an unmeasured tip.
 */

import { liveShopDefaults, readDefault } from '@/platform/defaultsClient';

/**
 * How close a recorded shank must be to a post's nominal diameter for it to be that post's collet.
 * #1207 — a CHOSEN tolerance, so it is a shop default (`probe.colletMatchMm`), read here with the
 * house's own reader; a caller may pass one (a spec) instead.
 */
export function colletMatchToleranceMm(toleranceMm?: number): number {
  if (toleranceMm !== undefined && Number.isFinite(toleranceMm)) return toleranceMm;
  return readDefault(liveShopDefaults(), 'probe.colletMatchMm').value;
}

/** Whether a recorded shank is the post whose nominal diameter is `nominalMm`. */
export function shankIsPost(shankMm: number | null | undefined, nominalMm: number, toleranceMm?: number): boolean {
  return shankMm !== null && shankMm !== undefined && Number.isFinite(shankMm)
    ? Math.abs(shankMm - nominalMm) <= colletMatchToleranceMm(toleranceMm)
    : false;
}

/** The collet a shank diameter needs, in the operator's words ("6 mm collet", `1/8" collet`). */
export function probeColletWords(shankMm: number | null | undefined, toleranceMm?: number): string {
  if (shankMm === null || shankMm === undefined || !Number.isFinite(shankMm)) return 'check the collet';
  if (shankIsPost(shankMm, 6.35, toleranceMm)) return '1/8" collet';
  return `${Number(shankMm.toFixed(2))} mm collet`;
}

/** The same clause as a sentence's aside: " — 6 mm collet", or " — check the collet". */
export function probeColletClause(shankMm: number | null | undefined): string {
  return ` — ${probeColletWords(shankMm)}`;
}
