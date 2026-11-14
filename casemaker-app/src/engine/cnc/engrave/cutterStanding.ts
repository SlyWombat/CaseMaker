/**
 * #1281 — A CUTTER'S STANDING FOR THE JOB'S MATERIAL.
 *
 * The maintainer's two rules, applied together: "follow the database for recommendations"
 * (2026-10-16, after a 0.6 mm corn bit broke in PLA) and "plan with the owned inventory to the best
 * of its ability and state the tradeoff" (2026-11-05). An owned cutter the catalogue is silent on
 * may still be used (#766: owned cutters vouch for themselves), but it must not out-rank a cutter
 * the catalogue does list, and when it is the only one that can do the job the run says so.
 *
 * A cutter is
 *  - LISTED when the catalogue lists the cutter (or its family) for the job's material AND the feed
 *    it would run on is the catalogue's row or one the shop measured or chose;
 *  - UNLISTED otherwise: the catalogue does not carry the cutter, or lists it for other materials,
 *    or the feed it would run on is the shop's seeded starting value.
 *
 * With NO catalogue synced there is nothing to be listed in: every cutter is then NOT RATED
 * (`rated: false`) — never unlisted, so an offline job ranks and reads exactly as it did.
 *
 * PURE: the same functions `materialRefusal` asks (`catalogueCoverageFor`, `catalogueStandingFor`,
 * `feedsFor`), never a second rule.
 */

import { jobMachine } from '@/engine/cnc/calibration';
import {
  catalogueCoverageFor,
  catalogueStandingFor,
  feedsFor,
  feedsToolForSurface,
  refuseFractionOf,
  type FeedCatalogueRow,
  type FeedsEntry,
} from '@/engine/cnc/feeds';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob } from '@/types/engraveJob';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';

/** Why one cutter is unlisted, as clauses the sentence is built from. */
export interface CutterStanding {
  key: string;
  name: string;
  /** False when no catalogue is synced: the cutter is not rated either way. */
  rated: boolean;
  listed: boolean;
  /** The catalogue does not carry this cutter at all. */
  notInCatalogue: boolean;
  /** The catalogue lists the cutter, but for these materials and not the job's. */
  listedFor: readonly string[] | null;
  /** The feed it would run on is the shop's seeded starting value, not measured or the catalogue's. */
  seededFeed: boolean;
}

export function cutterStanding(
  job: EngraveJob,
  entry: ToolLibraryEntry,
  catalogue: readonly FeedCatalogueRow[],
  defaults: ShopDefaults | null,
  table?: readonly FeedsEntry[] | null,
): CutterStanding {
  const base = { key: entry.key, name: entry.tool.name };
  if (catalogue.length === 0) {
    return { ...base, rated: false, listed: true, notInCatalogue: false, listedFor: null, seededFeed: false };
  }
  const coverage = catalogueCoverageFor(catalogue, job.stock.material, entry.tool);
  const standing = catalogueStandingFor(coverage, job.stock.material, entry.tool.name);
  const notInCatalogue = coverage.kind === 'unlisted' || coverage.kind === 'mismatched';
  const listedFor = coverage.kind === 'not-for-material' ? coverage.listedFor : null;
  const catalogueListed = standing.recommend && coverage.kind === 'covered';
  // The feed it would run on. A thread mill is not resolved by `feedsFor` (its row comes through the
  // thread settings), so it is judged on the catalogue's listing alone.
  let seededFeed = false;
  if (entry.tool.shape !== 'thread') {
    const feeds = feedsFor(
      catalogue,
      job.stock.material,
      feedsToolForSurface(entry.tool),
      jobMachine(job),
      refuseFractionOf(defaults),
      undefined,
      table ?? undefined,
    );
    // A catalogue row answered, or a field is measured: not a guess. Every field `computed` (the
    // shop's starting table) is the seeded guess.
    if (feeds.ok) seededFeed = feeds.catalogue === null && Object.values(feeds.sources).every((v) => v === 'computed');
  }
  return {
    ...base,
    rated: true,
    listed: catalogueListed && !seededFeed,
    notInCatalogue,
    listedFor,
    seededFeed,
  };
}

/** True when the standing is a reason to say something: rated and not listed. */
export const isUnlisted = (s: CutterStanding): boolean => s.rated && !s.listed;

/**
 * The one sentence (#1281 step 2), for the cutters of a plan that are unlisted. Each clause comes
 * from the facts; a cutter that is unlisted only by its seeded feed gets only the last clause.
 */
export function unlistedSentence(job: EngraveJob, unlisted: readonly CutterStanding[]): string {
  const material = MATERIAL_LABELS[job.stock.material];
  const why = (s: CutterStanding): string => {
    const parts: string[] = [];
    if (s.notInCatalogue) parts.push('the catalogue does not carry it');
    else if (s.listedFor !== null) parts.push(`the catalogue lists it for ${s.listedFor.join(', ')}, not ${material}`);
    if (s.seededFeed) parts.push('its feed is the shop’s starting value, not a measured one');
    return `${s.name} — ${parts.join('; ')}`;
  };
  return `No cutter the catalogue lists for ${material} can cut this. Chosen: ${unlisted.map(why).join('; ')}.`;
}
