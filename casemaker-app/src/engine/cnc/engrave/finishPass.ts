/**
 * #250 — the finish pass's allowance: how much stock the roughing pass leaves on the walls and
 * floor, and where that number came from.
 *
 * PURE, like `restSettings.ts` beside it. The number is a SHOP setting (the maintainer's rule,
 * 2026-10-15: a tunable value lives in the location document, not compiled in), stored under
 * {@link FINISH_STOCK_TO_LEAVE_KEY} and read through `readDefault` on the main thread. The worker
 * cannot see the location, so the resolved value and its source cross as plain data on
 * `EngraveShopOpts.finish`.
 *
 * The fallback is for a build with no location to read — the hosted web build — and is named for
 * what it is. It matches the seed the Rust side writes into a fresh `location.json`
 * (`defaults.rs`), so a fresh bench and a no-service build cut the same allowance.
 *
 * ONE NUMBER FOR BOTH WALLS AND FLOOR. The CAM erodes the roughing region by
 * `toolRadius + stockToLeaveMm` and stops its depth passes at `depth − stockToLeaveMm`; the
 * finishing pass then cuts the ideal region at full depth. There is deliberately no second
 * setting: the issue asks for "stock to leave", and two numbers would be two things to measure
 * before the first cut.
 */

/** The location's shop-defaults key, in `location.json`'s `defaults` section. */
export const FINISH_STOCK_TO_LEAVE_KEY = 'finish.stockToLeaveMm';

/**
 * The allowance a fresh shop is seeded with, mm — CHOSEN, not measured. 0.2 mm is about one
 * printed layer at the common layer height, and it is small enough that the 1 mm flat the default
 * job names still has a cut in the roughing pass. The first bench cut that inspects a floor
 * replaces it.
 */
export const FINISH_STOCK_TO_LEAVE_FALLBACK = 0.2;

/**
 * Where a finish-allowance number came from. The first three are the location document's own
 * provenance vocabulary (`ShopDefaultSchema.source`); `fallback` is this build's no-service value.
 */
export type FinishSettingSource = 'seeded' | 'chosen' | 'measured' | 'fallback';

/** The allowance as the CAM was handed it: the value and where it came from. */
export interface FinishStockToLeave {
  value: number;
  source: FinishSettingSource;
}

/**
 * Where a finish-allowance number came from, as the run sheet says it. Every source is stated —
 * including the good ones — for the same reason `restSourceWords` states every rest source: a
 * sheet that only spoke up when a value was doubtful would imply silence means sound.
 */
export function finishSourceWords(source: FinishSettingSource): string {
  switch (source) {
    case 'seeded':
      return 'the seed this shop was started with';
    case 'chosen':
      return 'a value chosen for this shop';
    case 'measured':
      return 'a measured value';
    case 'fallback':
      return 'the fallback this build carries for it';
  }
}
