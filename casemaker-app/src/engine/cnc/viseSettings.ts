/**
 * The vise's chosen tunables, from the shop's defaults (`vise.*` in `location.json`) — never
 * constants in the fixture (#448, the maintainer's rule). The labelled fallbacks live in
 * `fixture.ts` (`VISE_UNCERTAINTY_FALLBACK`, `VISE_DEFAULT_STOCK_PROUD_FALLBACK`,
 * `VISE_MIN_COVERAGE_FRACTION_FALLBACK`) and are used only with no house service.
 *
 * The vise's PRODUCT geometry — the jaw widths, length, ledge and body depth — is NOT here: it is
 * the sourced accessory record `Z1_VISE` in `fixture.ts`, measured on the reference unit.
 */

import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';

export interface ViseSettings {
  /** The band every collision box is grown by, mm (#204). Chosen, not measured. */
  uncertaintyMm: number;
  /** The cap on the stock-derived proud height, mm (#231 item 2, #508). Chosen, not measured. */
  defaultStockProudMm: number;
  /** The share of the stock's width the jaws must cover in Y before `vise-jaw-short` warns. */
  minCoverageFraction: number;
}

export function viseSettings(defaults: ShopDefaults | null): ViseSettings {
  return {
    uncertaintyMm: readDefault(defaults, 'vise.uncertaintyMm').value,
    defaultStockProudMm: readDefault(defaults, 'vise.defaultStockProudMm').value,
    minCoverageFraction: readDefault(defaults, 'vise.minCoverageFraction').value,
  };
}
