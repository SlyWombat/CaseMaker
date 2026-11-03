/**
 * #922 — ONE place both `casemaker cut` and the worker's `engraveGenerate` resolve a cutter's
 * feeds / step-down / rpm from, for the same job and location.
 *
 * BEFORE THIS FILE, each side quietly built its own answer. The UI's `engraveRunStore` reads the
 * shop's committed feeds table — installed into `engine/cnc/feeds.ts` module state by
 * `store/feedTableStore.ts` after a house-service read of the location's own `feeds` section — and
 * sends the resolved rows across to the worker as `EngraveShopOpts.feeds` (a worker is a separate
 * module realm; that global cannot reach it). The CLI's headless bootstrap never read
 * `location.json`'s `feeds` section at all, so its `shop.feeds` stayed undefined and every
 * `feedsFor` call inside the generator fell back to the compiled, UNMEASURED starting table instead
 * of the shop's real, committed numbers — a different rpm/feed/plunge/step-down for the identical
 * job, cutter and location (#922: `j13-tool-tray` posted 10000/F1000/300 from the app against
 * 12000/F500/200 from the CLI, and the same gap made the CLI refuse some jobs at feeds a stage
 * earlier than the app did).
 *
 * TWO FUNCTIONS CLOSE THE GAP, not two more copies of the same logic:
 *
 *  - {@link installLocationFeedsTable} is what a headless entry point now calls once, right after
 *    it reads the location document (`platform/headless/bootstrap.ts`'s `loadLocation`) — the same
 *    move the browser's `feedTableStore` has always made on a read. It installs the rows into the
 *    one piece of module state `feedsFor` already defaults against
 *    (`engine/cnc/feeds.ts`'s `resolvedFeedsTable`), so every OTHER call that resolves feeds without
 *    an explicit table — `materialRefusal`, `planCutters`, `smartPick`, `candidatePlans`, all shared
 *    by the panel and the CLI already — picks up the shop's real numbers too, not only the calls
 *    inside the generator. That is also what makes a feeds refusal agree between the two paths
 *    (deliverable 4): both now ask the one resolver against the one table.
 *  - {@link engraveFeedsFor} is the one call shape `engraveGenerate.ts` now uses everywhere it used
 *    to write `feedsFor(catalogue, material, tool, machine, override, shop.feeds ?? undefined,
 *    context)` — one options object (the `shop` the caller already built, worker or CLI) instead of
 *    the same `shop.feeds ?? undefined` fragment repeated at each call site. It changes nothing a
 *    caller could observe; it is the plumbing that makes "both resolve through one function" true
 *    rather than merely intended.
 */
import {
  feedsFor,
  resolvedFeedsTable,
  setLocatedFeedTable,
  type CutParams,
  type FeedCatalogue,
  type FeedCatalogueRow,
  type FeedsEntry,
  type FeedsResult,
  type StoredFeedRow,
} from '@/engine/cnc/feeds';
import type { Mill } from '@/engine/cnc/machine';
import type { Tool } from '@/engine/cnc/tool';
import type { StockMaterial } from '@/types/engraveJob';
import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import { drillSettings } from '@/engine/cnc/cam/drillBit';
import { getTools } from '@/engine/cnc/toolRegistry';
import { dedupeCutterEntries } from '@/engine/cnc/toolLibrary';
import { inventoryConditions } from '@/engine/cnc/toolCondition';

/**
 * The slice of `EngraveShopOpts` a feeds resolution needs. A structural type rather than an import
 * of `EngraveShopOpts` itself, so this module — which `engraveGenerate.ts` imports — never imports
 * back from it.
 */
export interface EngraveFeedsShop {
  feeds?: readonly FeedsEntry[] | null;
}

/**
 * The one call every feeds/step-down/rpm resolution in `engraveGenerate.ts` now goes through.
 * Identical to calling `feedsFor` directly with `shop.feeds ?? undefined` as the table — this
 * function exists so that fragment is written once, not at every one of the generator's call
 * sites, and so a future shop-side option feeds resolves through can be added in one place.
 */
export function engraveFeedsFor(
  shop: EngraveFeedsShop,
  catalogue: readonly FeedCatalogueRow[] | FeedCatalogue,
  material: StockMaterial,
  tool: Tool,
  machine: Mill,
  override?: Partial<CutParams>,
  context?: { slotting?: boolean },
  refuseFraction?: number,
): FeedsResult {
  return refuseFraction === undefined
    ? feedsFor(catalogue, material, tool, machine, override, shop.feeds ?? undefined, context)
    : feedsFor(catalogue, material, tool, machine, override, shop.feeds ?? undefined, context, refuseFraction);
}

/**
 * Install the location's own feeds table — its `feeds` section, read exactly once by whichever
 * headless entry point just loaded the document — as the table `feedsFor` resolves against when
 * nobody hands it one explicitly. This is the same effect the browser's `feedTableStore` has after
 * every read (`setLocatedFeedTable`); a headless run now gets it from one place too, instead of
 * running every main-thread-shaped call (`materialRefusal`, `planCutters`, `smartPick`, the CLI's own
 * cutter pick) against the compiled starting table while only the generator's own calls could be
 * told otherwise.
 *
 * `null` or an empty list is "this location states no table": `setLocatedFeedTable` already reads
 * either as "no service answered", and the compiled starting table answers instead, labelled as the
 * fallback it is.
 */
export function installLocationFeedsTable(rows: readonly StoredFeedRow[] | null | undefined): void {
  setLocatedFeedTable(rows ?? null);
}

/**
 * The table installed above (or the compiled fallback, if nothing was), exactly in the shape
 * `EngraveShopOpts.feeds` wants it — what the CLI now sends the generator, the same value
 * `engraveRunStore` has always read for the browser's own worker call.
 */
export function shopFeedsTable(): readonly FeedsEntry[] {
  return resolvedFeedsTable().table;
}

/**
 * ONE options object, built the way `engraveRunStore.ts` builds `shop` for the worker — every
 * field below is one of that function's lines, read from the location's own `defaults` map, in the
 * same order. `tests/unit/pipelineIdentity.spec.ts`'s `appShop` is the reference this mirrors field
 * for field, and is what caught the gap this closes.
 *
 * #922's defect was not only the feeds table (above): the CLI's own `shop` literal
 * (`scripts/lib/casemaker/engrave.ts`) set `tools`, `drill` and `rest` and NOTHING else, so every
 * other field a posted program's numbers depend on — `lostDetailWarnRatio`, `peckClearanceMm`, the
 * whole `defaults` map (several of the generator's own `readDefault` calls take it directly), the
 * condition summaries, and the FINISH ALLOWANCE in particular — fell back to the generator's own
 * labelled fallback instead of the location's real, committed numbers. A finish allowance of 0
 * (the pre-#250 fallback) cuts in one pass; the location's own allowance splits flat regions into a
 * rough pass and a finish pass, which is a different program for the identical job (j13: 2934 depth
 * passes against 2932, the run-time header differing from the first line after it) — not only a
 * different S/F.
 *
 * `mount`/`bed` and a calibrated machine are deliberately NOT built here: they gate FINDINGS (the
 * mount's obstacles, a through-cut sentence), not the posted S/F/Z numbers, and a caller that needs
 * them resolves them where the job asks for a bracket mount or a calibration file — exactly as
 * before this function existed.
 */
export function engraveShopOpts(defaults: ShopDefaults | null): {
  lostDetailWarnRatio: number;
  peckClearanceMm: number;
  defaults: ShopDefaults | null;
  feeds: readonly FeedsEntry[];
  tools: readonly ReturnType<typeof getTools>[number][];
  conditions: ReturnType<typeof inventoryConditions>;
  rest: {
    overlap: ReturnType<typeof readDefault>;
    thirdToolPct: ReturnType<typeof readDefault>;
    visibleDepth: ReturnType<typeof readDefault>;
  };
  finish: { stockToLeaveMm: ReturnType<typeof readDefault> };
  drill: ReturnType<typeof drillSettings>;
  surfaceGrid: { pitchMm: ReturnType<typeof readDefault> };
} {
  return {
    lostDetailWarnRatio: readDefault(defaults, 'engrave.lostDetailWarnRatio').value,
    peckClearanceMm: readDefault(defaults, 'drill.peckClearanceMm').value,
    defaults,
    feeds: shopFeedsTable(),
    // #922 — one entry per physical cutter, the owned key over the catalogue's definition, so
    // the app's `/tools`+inventory and the CLI's `--location` registry choose the same key.
    tools: dedupeCutterEntries(getTools()),
    conditions: inventoryConditions(),
    rest: {
      overlap: readDefault(defaults, 'rest.overlapMm'),
      thirdToolPct: readDefault(defaults, 'rest.thirdToolPct'),
      visibleDepth: readDefault(defaults, 'rest.visibleDepthMm'),
    },
    finish: { stockToLeaveMm: readDefault(defaults, 'finish.stockToLeaveMm') },
    drill: drillSettings(defaults),
    surfaceGrid: { pitchMm: readDefault(defaults, 'sim.columnFlatPitchYMm') },
  };
}
