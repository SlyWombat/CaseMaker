/**
 * #1111 — THE BALL RANK'S PICK AMONG EQUALS: THE REACH-MARGIN GATE, THEN THE KEY.
 *
 * Two ball candidates equal on the rank's own keys (leftover, then cycle) must not be separated by
 * the order the house happened to arrive in — the M1 tray's finish chose a 10 mm-flute metal ball on
 * the app and the 22 mm on the CLI for the same toolpath. 0f's narrowed ruling (#1111 comment
 * 6729368477, after two corrections):
 *
 *  1. THE GATE: `fluteLength − deepest cut ≥ reachMarginMm` (the shop's `reach.marginMm`,
 *     recommendation 1.0 mm — #1017/#1018's Z-datum class plus the unmeasured jaw tops' ±0.5). A
 *     candidate below the gate loses while any candidate passes; a cutter that states no flute has
 *     margin 0. On the tray: the 10 mm ball's 0.387 mm margin is out, the 22 mm ball's 12.4 mm in.
 *  2. A remaining tie falls to the cutter KEY, lexically — and the row says "by key, pending #1114":
 *     WHICH cutter among equals a plan should prefer (stiffness, reach, bit changes, time) is the
 *     maintainer's policy call, filed as #1114. Two measured rules produced two different bench
 *     plans, so the app states the key it used and does not pretend to know better.
 *
 * The other same-diameter sites (the sequence's primary, `reachingFlatFor`, `restBallFor`) keep
 * their pre-#1111 behaviour under the canonical order and state the same "by key, pending #1114"
 * row where the order decided (0f's (c)).
 */
import { feedsFor, feedsToolForSurface, type FeedCatalogue, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import type { Tool } from '@/engine/cnc/tool';
import type { StockMaterial } from '@/types/engraveJob';

/** The shop's recommended reach margin, mm — the fallback when a caller holds no setting. */
export const REACH_MARGIN_FALLBACK_MM = 1.0;

/** The policy issue that owns "which cutter among equals" (#1114) — printed on every by-key row. */
export const PICK_POLICY_ISSUE = 1114;

/** The stated facts the gate and the key read for one candidate. */
export interface PickKeys {
  /** `fluteLength − deepest cut`, mm; no stated flute counts as 0. */
  margin: number;
  /** The cutter key (`cutterKeyOf`: its record id, else its name). */
  key: string;
}

export interface PickContext {
  material: StockMaterial;
  /** The caller's feed rows, when it holds them; absent resolves from the feeds table alone. */
  catalogue?: readonly FeedCatalogueRow[] | FeedCatalogue;
  /** The deepest cut this candidate's own program reaches, mm. */
  deepestMm: number;
}

/** The stated facts for one candidate. */
export function pickKeysFor(tool: Tool, ctx: PickContext): PickKeys {
  // The feeds resolution is not read by this rule (the gate and the key only); it is kept so a
  // caller holding a row set can prove the plan's world is the shop's when the policy lands.
  void (ctx.catalogue === undefined ? null : feedsFor(ctx.catalogue, ctx.material, feedsToolForSurface(tool), Z1));
  return { margin: (tool.fluteLength ?? 0) - ctx.deepestMm, key: tool.id ?? tool.name };
}

/** Does this candidate clear the reach-margin gate? */
export function passesReachGate(keys: PickKeys, minMarginMm: number): boolean {
  return keys.margin + 1e-9 >= minMarginMm;
}

/**
 * Positive when `a` beats `b`: the gate first (a passer beats a non-passer while any passes), then
 * the cutter key, lexically — the stated last resort, printed as "by key, pending #1114".
 */
export function pickAmongEquals(a: PickKeys, b: PickKeys, minMarginMm: number): number {
  const aPass = passesReachGate(a, minMarginMm);
  const bPass = passesReachGate(b, minMarginMm);
  if (aPass !== bPass) return aPass ? 1 : -1;
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
}

/** The sentence a rank row carries when the gate or the key decided. */
export function pickDecisionSentence(
  winner: Tool,
  w: PickKeys,
  loser: Tool,
  l: PickKeys,
  minMarginMm: number,
  lead = 'tie',
): string {
  const wPass = passesReachGate(w, minMarginMm);
  const lPass = passesReachGate(l, minMarginMm);
  const why =
    wPass !== lPass
      ? `the reach-margin gate (${w.margin.toFixed(2)} mm against ${minMarginMm.toFixed(2)} mm, where ${loser.name} leaves ${l.margin.toFixed(2)} mm)`
      : `the cutter key (${w.key} before ${l.key}) — by key, pending #${PICK_POLICY_ISSUE}`;
  return `${lead} — chose ${winner.name} (${w.key}) for ${why}`;
}

/** The folded #1113 warning: no candidate cleared the gate, and the plan uses the best it has. */
export function reachGateWarning(tool: Tool, keys: PickKeys, minMarginMm: number): string {
  return (
    `no candidate passes the reach-margin gate — ${tool.name} cuts with ${keys.margin.toFixed(2)} mm of margin, ` +
    `under the shop's ${minMarginMm.toFixed(2)} mm (reach.marginMm); the plan still cuts, and the shank and collet want watching`
  );
}

/** The row a same-diameter pick outside the ball rank states (0f's (c)): by key, visibly provisional. */
export function byKeyPendingNote(chosen: Tool, other: Tool): string {
  return (
    `same diameter — chose ${chosen.name} (${chosen.id ?? chosen.name}) over ${other.name} (${other.id ?? other.name}) ` +
    `by key, pending #${PICK_POLICY_ISSUE}`
  );
}
