/**
 * #964 / C2 — WHICH FEED ROW FED EACH CUTTER, ON THE CARD.
 *
 * The catalogue door makes Makera's full catalogue the default of every acceptance run. This is
 * the receipt: for each cutter the plan may use, the resolver is asked the same question the CAM
 * asks (`feedsFor` with the tool, the material and the installed catalogue), and the answer names
 * the row that actually answered — the catalogue row (its cutter id and material) or the compiled
 * starting/local row — with the four numbers it gave.
 *
 * `feedsToolForSurface` is the CAM's own proxy (a ball looks its row up through a flat proxy that
 * keeps the Makera id), so this receipt can never name a different row from the one that cut.
 */
import { feedCatalogueSnapshot, feedsFor, feedsToolForSurface } from '@/engine/cnc/feeds';
import type { StockMaterial } from '@/types/engraveJob';
import type { FeedRowFact } from './sevenLines';
import type { Tool } from '@/engine/cnc/tool';
import { Z1 } from '@/engine/cnc/machine';
import { NO_SHOP } from './noShop';

/** One cutter's row, as the resolver answered it (`rowDiameter` is the diameter it matched on). */
export function feedRowFor(tool: Tool, material: StockMaterial): FeedRowFact {
  const cutter = tool.name || tool.id || `${tool.shape} cutter`;
  const resolved = feedsFor(feedCatalogueSnapshot(), material, feedsToolForSurface(tool), Z1, NO_SHOP.refuse);
  if (!resolved.ok) {
    return {
      cutter,
      row: `refused by the resolver: ${resolved.reason}`,
      feed: 0,
      plunge: 0,
      stepDown: 0,
      rpm: 0,
      provenance: resolved.reason,
    };
  }
  const row = resolved.catalogue;
  return {
    cutter,
    row:
      row === null
        ? `compiled/location ${resolved.entry.material} row ${resolved.entry.minDiameter}–${resolved.entry.maxDiameter} mm (status: ${resolved.entry.status})`
        : `Makera catalogue cutter ${row.cutterId}, ${row.material} row (matched at ${resolved.rowDiameter} mm)`,
    feed: resolved.params.feed,
    plunge: resolved.params.plungeFeed,
    stepDown: resolved.params.stepDown,
    rpm: resolved.params.rpm,
    provenance: resolved.provenance,
  };
}

/** Every cutter in a set, in the plan's own name order. */
export function feedRowsFor(tools: readonly Tool[], material: StockMaterial): FeedRowFact[] {
  return tools.map((tool) => feedRowFor(tool, material));
}
