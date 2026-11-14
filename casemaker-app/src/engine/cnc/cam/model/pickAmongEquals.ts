/**
 * #1114 — WHICH CUTTER AMONG EQUALS: THE GATE, THEN THE STIFFEST ADEQUATE FLUTE, THEN THE KEY.
 *
 * The maintainer's decision (2026-11-09, on #1114, after #1111's three measured policies): once
 * plans compete on the PRICED cycle (#1114's bit-change rule), a remaining tie among cutters that
 * are otherwise equal is decided in one order, at every site:
 *
 *  1. THE REACH-MARGIN GATE: `fluteLength − deepest cut ≥ reachMarginMm` (the shop's
 *     `reach.marginMm`, recommendation 1.0 mm — #1017/#1018's Z-datum class plus the unmeasured
 *     jaw tops' ±0.5). A candidate below the gate loses while any candidate passes; a cutter that
 *     states no flute has margin 0.
 *  2. THE SHORTEST SUFFICIENT FLUTE — the stiffest adequate tool. Among the candidates that pass
 *     the gate, the shorter flute deflects less and chatters less. This is only a preference among
 *     SUFFICIENT tools: when no candidate passes, none is preferred on flute and the key decides.
 *  3. THE LARGER DIAMETER — at the same sufficient flute, the thicker cutter is the stiffer one
 *     (the Manager's ruling, 2026-11-09: an equal-flute ⌀2 must not beat a ⌀3.175 by key).
 *  4. THE LOWER PRICED STAGE — when the caller has measured the candidate's own stage time.
 *  5. THE CUTTER KEY, lexical — the last resort, so the pick is total and reproducible.
 *
 * The provisional "by key, pending #1114" rows of #1111 are gone: every same-diameter pick states
 * the decider it used ({@link pickNote}).
 */
import { feedsFor, feedsToolForSurface, refuseFractionOf, type FeedCatalogue, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { StockMaterial } from '@/types/engraveJob';

/** The shop's recommended reach margin, mm — the fallback when a caller holds no setting. */
export const REACH_MARGIN_FALLBACK_MM = 1.0;

/** The stated facts the gate, the flute, the diameter, the price and the key read. */
export interface PickKeys {
  /** `fluteLength − deepest cut`, mm; no stated flute counts as 0. */
  margin: number;
  /** The stated flute length, mm — shorter wins among sufficient candidates; unstated = +∞. */
  flute: number;
  /** The cutting diameter, mm — larger is stiffer; unstated = 0. */
  diameter: number;
  /** The candidate's own priced stage time, s, when the caller has measured it; +∞ otherwise. */
  priceSeconds: number;
  /** The cutter key (`cutterKeyOf`: its record id, else its name). */
  key: string;
}

export interface PickContext {
  material: StockMaterial;
  /** The caller's feed rows, when it holds them; absent resolves from the feeds table alone. */
  catalogue?: readonly FeedCatalogueRow[] | FeedCatalogue;
  /** The deepest cut this candidate's own program reaches, mm. */
  deepestMm: number;
  /** The candidate's own priced stage time, s, when the caller measured it. */
  priceSeconds?: number;
}

/** The stated facts for one candidate, from its own deepest cut. */
export function pickKeysOf(tool: Tool, deepestMm: number, priceSeconds = Number.POSITIVE_INFINITY): PickKeys {
  return {
    margin: (tool.fluteLength ?? 0) - deepestMm,
    flute: tool.fluteLength ?? Number.POSITIVE_INFINITY,
    diameter: cuttingDiameter(tool) ?? 0,
    priceSeconds,
    key: tool.id ?? tool.name,
  };
}

/** The stated facts for one candidate; the caller's row set is passed through the one resolver. */
export function pickKeysFor(tool: Tool, ctx: PickContext): PickKeys {
  // The feeds resolution is not read by this rule (the gate, the flute and the key only); it is
  // kept so a caller holding a row set can prove the plan's world is the shop's.
  void (ctx.catalogue === undefined ? null : feedsFor(ctx.catalogue, ctx.material, feedsToolForSurface(tool), Z1, refuseFractionOf(null)));
  return pickKeysOf(tool, ctx.deepestMm, ctx.priceSeconds);
}

/** Does this candidate clear the reach-margin gate? */
export function passesReachGate(keys: PickKeys, minMarginMm: number): boolean {
  return keys.margin + 1e-9 >= minMarginMm;
}

/**
 * Positive when `a` beats `b`: the gate first (a passer beats a non-passer while any passes),
 * then the shortest sufficient flute, then the LARGER DIAMETER (stiffer), then the lower priced
 * stage, then the cutter key — the last resort, so the pick is total and reproducible.
 *
 * The diameter step is the Manager's ruling (2026-11-09) on the tray bottom's gap: two flats with
 * the same 12 mm flute are not equal — the ⌀3.175 is both stiffer and faster than the ⌀2 — so a
 * key that hands the curved rough to the ⌀2 after an equal-flute tie contradicts "stiffest
 * adequate". A site whose geometry excludes the big cutter (a narrow channel) never reaches this
 * function with it: the site's own candidate filter decides first.
 */
export function pickAmongEquals(a: PickKeys, b: PickKeys, minMarginMm: number): number {
  const aPass = passesReachGate(a, minMarginMm);
  const bPass = passesReachGate(b, minMarginMm);
  if (aPass !== bPass) return aPass ? 1 : -1;
  // The FLUTE is a stiffness preference among SUFFICIENT cutters only ("the shortest sufficient
  // flute"): when neither passes, no flute length is adequate and the key does not read it.
  if (aPass && a.flute !== b.flute) return a.flute < b.flute ? 1 : -1;
  // The DIAMETER and the PRICE hold whatever the gate said — the stiffer cutter and the cheaper
  // stage are better even when the plan must state that no candidate clears the margin. (A pair
  // of fluteless flats otherwise fell to the key, which handed the strip builder a ⌀2 "primary"
  // where the ⌀6 was stiffer — the #1021 test caught it.)
  if (a.diameter !== b.diameter) return a.diameter > b.diameter ? 1 : -1;
  if (a.priceSeconds !== b.priceSeconds) return a.priceSeconds < b.priceSeconds ? 1 : -1;
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
}

/** Why the pick fell where it did, in the operator's words. */
export function deciderOf(winner: PickKeys, loser: PickKeys, minMarginMm: number): string {
  const wPass = passesReachGate(winner, minMarginMm);
  const lPass = passesReachGate(loser, minMarginMm);
  if (wPass !== lPass) {
    return `the reach-margin gate (${winner.margin.toFixed(2)} mm against ${minMarginMm.toFixed(2)} mm, where the other leaves ${loser.margin.toFixed(2)} mm)`;
  }
  if (wPass && winner.flute !== loser.flute) {
    return `the shortest sufficient flute (${formatFlute(winner.flute)} against ${formatFlute(loser.flute)})`;
  }
  if (winner.diameter !== loser.diameter) {
    return `the larger diameter (${winner.diameter.toFixed(2)} mm against ${loser.diameter.toFixed(2)} mm — the stiffer adequate tool)`;
  }
  if (winner.priceSeconds !== loser.priceSeconds) {
    return `the lower priced stage (${formatPrice(winner.priceSeconds)} against ${formatPrice(loser.priceSeconds)})`;
  }
  return `the cutter key (${winner.key} before ${loser.key})`;
}

function formatPrice(seconds: number): string {
  return Number.isFinite(seconds) ? `${Math.round(seconds)} s` : 'unmeasured';
}

function formatFlute(flute: number): string {
  return Number.isFinite(flute) ? `${flute} mm` : 'an unstated flute';
}

/** The sentence a rank row carries when the pick decided. */
export function pickDecisionSentence(
  winner: Tool,
  w: PickKeys,
  loser: Tool,
  l: PickKeys,
  minMarginMm: number,
  lead = 'tie',
): string {
  return `${lead} — chose ${winner.name} (${w.key}) over ${loser.name} (${l.key}) for ${deciderOf(w, l, minMarginMm)}`;
}

/** The folded #1113 warning: no candidate cleared the gate, and the plan uses the best it has. */
export function reachGateWarning(tool: Tool, keys: PickKeys, minMarginMm: number): string {
  return (
    `no candidate passes the reach-margin gate — ${tool.name} cuts with ${keys.margin.toFixed(2)} mm of margin, ` +
    `under the shop's ${minMarginMm.toFixed(2)} mm (reach.marginMm); the plan still cuts, and the shank and collet want watching`
  );
}

/** The row a same-diameter pick states: the decider it used (the gate, the flute, or the key). */
export function pickNote(chosen: Tool, other: Tool, ck: PickKeys, ok: PickKeys, minMarginMm: number): string {
  return (
    `same diameter — chose ${chosen.name} (${chosen.id ?? chosen.name}) over ${other.name} (${other.id ?? other.name}) ` +
    `for ${deciderOf(ck, ok, minMarginMm)}`
  );
}
