/**
 * Depth bounds (#345): every rule about how deep a floor may go, as ONE primitive.
 *
 * A bound is a PLANE at a depth below the engraved face, a SIDE, and a name:
 *
 *   - `above` — the floor must stay shallower than the plane (`d ≤ at − m`). A void's ceiling, the
 *     colour split under a `surface` label, the stock's underside.
 *   - `below` — the floor must go deeper than the plane (`d ≥ at + m`). The colour split under a
 *     `reveal` label, which is the point of a two-colour blank.
 *
 * Strict on both sides, by construction, which is what #345 was opened for: #285's review found the
 * colour test and the breach limit each had a side that `≥`/`≤` decided arbitrarily, and a
 * margin that is ALWAYS subtracted leaves no equality to argue about.
 *
 * WHY ONE PRIMITIVE. The colour split is not special. A two-colour blank is a tiny use case, and
 * the rule it needs — "keep `m` clear of a plane" — is the same rule a magnet pocket's ceiling and
 * the stock's underside need. Everything downstream (the per-move verifier, the per-item finding,
 * the run sheet) reads the same structure, so there is one place where a depth rule lives.
 *
 * WHAT IS *NOT* A BOUND. `minFloor` is material that must REMAIN, not a Z-error margin, so the
 * underside's bound carries `minFloor` as its own margin and the job's `boundaryMargin` never
 * touches it. `edgeMargin` bounds an X/Y distance, and `breakthrough` is how far a through-cut may
 * pass INTO the board — neither is a depth plane, and `depth-exceeds-stock` / the sacrificial limit
 * keep their own owners.
 *
 * The ONE place `minFloor` also sets a ceiling is a void on a blank that states no print (#345
 * decision A, `voidMargin`): with no layer grid there is nothing to align a Z-error margin to, so
 * the structural floor is the only number with a basis and the ceiling keeps `max(boundaryMargin,
 * minFloor)`.
 *
 * PURE. No wasm, no store, no React: the numbers are arithmetic on facts the job already holds
 * (`stock.print`, the keep-outs, the vises), which is what lets the panel, the run sheet and the
 * verifier all read the same rule. The one wasm-backed input — how deep the cutter may go before it
 * reaches a void — arrives as a plain number from the layer stack that computed it.
 *
 * The layer GRID's own arithmetic is the one thing it borrows rather than receives
 * (`colourBoundaryDepthFor`, #362): where the colour split lands is a rule about the printer's
 * layers, so the recommendation must land it on the same line the checker does.
 */

import { DEFAULT_BREAKTHROUGH } from '@/engine/cnc/sacrificial';
import { colourBoundaryDepthFor } from '@/engine/cnc/layerStack';
import { WIRED_PROBE_Z_RESIDUAL_MM } from '@/engine/cnc/probePlan';
import type { EngraveAnyItem, EngraveJob, EngraveLabel, EngraveMargins, FieldSource, MarginSource } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/**
 * The house's thresholds (#345), persisted with the rest of the app settings.
 *
 * `boundaryMargin` and `zTolerance` are what a job COPIES; the other four SEED a new job's own
 * per-job fields (`minFloor`, `edgeMargin`, `breakthrough`, `jawClearance` on the document), which
 * stay the single owner of their quantities. A seed is a starting number the user then has per job,
 * not a second copy of the same rule.
 */
export interface MarginSettings extends Omit<EngraveMargins, 'source'> {
  /**
   * Where the house SETTING came from — a typing user, or the shipped default. `'recommended'` is
   * deliberately not a source a setting can have (`parseMargins` refuses it too): a recommendation
   * is per-job arithmetic on this blank (`recommendMargins`), and a house number that claimed to be
   * one would be describing a blank the next job does not have.
   */
  source: 'default' | 'user';
  /** Material that must remain under the deepest cut, mm — the underside bound's own margin. */
  minFloor: Mm;
  /** No item may come closer than this to a stock edge, mm. */
  edgeMargin: Mm;
  /** How far a through-cut may pass below the part's underside, mm. */
  breakthrough: Mm;
  /**
   * How far a cut's floor must stay above the vise jaws' TOPS, mm (#362) — the clearance the
   * `stock-proud-too-small` check used to carry as a bare `1` in its own arithmetic.
   *
   * A seed, like the three above: a new job takes it as its own `jawClearance`, and the check and
   * `recommendLabelDepth` both read that. The number is a property of the SETUP (how much room over
   * the jaws this operator wants), which is why a job may state its own.
   */
  jawClearance: Mm;
}

/** `0.2` — one printed layer at the layer height most printers use when nothing says otherwise. */
export const DEFAULT_BOUNDARY_MARGIN_MM: Mm = 0.2;

/** The ± a job assumes in Z until it works its own out (`recommendMargins`). */
export const DEFAULT_Z_TOLERANCE_MM: Mm = 0.05;

/** 1.0 / 1.0 — the numbers `defaultEngraveJob` seeded before #345 moved them into a setting. */
export const DEFAULT_MIN_FLOOR_MM: Mm = 1.0;
export const DEFAULT_EDGE_MARGIN_MM: Mm = 1.0;

/**
 * `1.0` — the clearance `validateJob`'s jaw check demanded before #362 made it a setting (#314
 * wrote the sentence, #345's rule moved the number). PROVISIONAL in the same sense the other house
 * thresholds are: it is a clearance an operator wants, not one anyone measured.
 */
export const DEFAULT_JAW_CLEARANCE_MM: Mm = 1.0;

/**
 * The shipped thresholds, and the fallback whenever a stored setting is missing or malformed. The
 * seeds are exactly the constants `defaultEngraveJob` used before they moved here, so a fresh
 * install produces the job it always did.
 */
export const MARGIN_DEFAULTS: MarginSettings = {
  boundaryMargin: DEFAULT_BOUNDARY_MARGIN_MM,
  zTolerance: DEFAULT_Z_TOLERANCE_MM,
  minFloor: DEFAULT_MIN_FLOOR_MM,
  edgeMargin: DEFAULT_EDGE_MARGIN_MM,
  breakthrough: DEFAULT_BREAKTHROUGH,
  jawClearance: DEFAULT_JAW_CLEARANCE_MM,
  source: 'default',
};

/**
 * `0.8`, not `0.80000000000000004` — a margin is read by a person, not parsed.
 *
 * Exported so the panel's margins row and the recommendation's own basis text cannot write the same
 * number two ways; `runSheet`'s `fmtNum` is the same rule for the sheet's rows.
 */
export function mm(v: number): string {
  return `${Number(v.toFixed(3))}`;
}

/**
 * The machine's Z resolution, and the number of steps a recommended depth is rounded to in the
 * THOUSANDS domain below: 0.001 mm, the smallest move the controller makes and the precision the
 * panel's field shows. A recommendation is written onto the document and read back by a person, so
 * it cannot be the binary-float tail of `3.81 − 2.3 − 1.0` (`0.5100000000000002`).
 */
const DEPTH_STEPS = 1000;

/**
 * A computed depth, quantised to that same thousandth — the number written onto the document.
 *
 * The two-state control writes a floor clear of the colour split (#170), and both operands are layer
 * lines the grid computes as sums: the default badge's boundary is `0.2 + 3 × 0.2` and its `surface`
 * floor comes back as `0.8 − 0.2` = `0.6000000000000001`. The depth field shows THAT, and the
 * verifier then judges a floor against a plane it differs from by a trillionth. Rounding to the
 * unit the machine moves in is not a tidy-up: it is the value the document is allowed to hold.
 *
 * Nearest, and NOT directional like `deeper`/`shallower`: this is the rule for a number with no plane
 * to land clear of — a typed override, or the arithmetic #362 reports. A floor that DOES have a bound
 * (`depthForIntent`, `recommendLabelDepth`) quantises toward it instead, or the app writes a depth its
 * own checker refuses (#170 review, #362 review).
 */
export function roundDepth(v: Mm): Mm {
  return Math.round(v * DEPTH_STEPS) / DEPTH_STEPS;
}

/**
 * How far a floor may miss a plane and still count as ON it, mm — the binary-float tail of `at ± margin`.
 *
 * A recommendation is quantised to the thousandth (`deeper`/`shallower`) and the checker re-derives
 * `at − margin` from the two numbers the document actually holds, so the two sides can land on values
 * that differ only in the last bits — `1.2 − 0.28` is `0.9199999999999999` to a float and `0.92` to
 * the rounding, and the app's own recommendation was refused by the bound it was computed against
 * (#362 review). `1e-9` is nothing on a machine whose smallest move is 0.001 mm: it absorbs the
 * representation error (tails run to ~1e-14 at these magnitudes) and nothing else — a floor half a
 * step past the plane is still a violation.
 *
 * ONE constant for both sides — the band test in `recommendLabelDepth` and `checkBounds` — because
 * they are the same judgement about the same plane and must not carry different tolerances.
 */
const DEPTH_EPS = 1e-9;

/**
 * A candidate floor that must land at or PAST a plane (the colour split, which a `reveal` bound
 * requires to be `≥ at + m`): rounded UP, by at most one step. Rounding it down is the one way to
 * write a depth that the checker then refuses against its own bound.
 *
 * Exported for `depthForIntent`, which writes the two-state control's own depth onto the document
 * (#170 review): a state's floor has a bound to respect exactly as a recommendation's does — `reveal`
 * at or past `split + margin`, `surface` short of `split − margin` — so the control and the #362 row
 * beside it must quantise the same way. `roundDepth` is the other rule and not this one: it is for a
 * depth with NO bound to respect, where the nearest thousandth is the honest answer.
 *
 * The epsilon mirrors `shallower`'s, and it is what keeps "one layer past the plane" reading as one
 * layer: these operands are grid sums, so `3.6 + 0.2` is `3.8000000000000003` and `0.1 + 0.2` is
 * `0.30000000000000004`. Bare, those ceil to `3.801` and `0.301` — a thousandth deeper than the
 * number the person pressed for, on a floor that was never meant to be off the grid. `1e-6` on the
 * scaled value swallows that tail (it is ~1e-12 at these magnitudes) and nothing else: a genuine
 * thousandth still rounds up, because a whole thousandth is three orders above the tolerance.
 */
export function deeper(v: number): Mm {
  return Math.ceil(v * DEPTH_STEPS - 1e-6) / DEPTH_STEPS;
}

/**
 * A candidate floor that must STOP SHORT of a plane (a void's ceiling, the blank's underside, the
 * jaws, and the colour split under a `surface`): rounded DOWN, by at most one step. The epsilon is
 * for the binary tail the other way — `0.905 × 1000` is `904.9999999999999` in a float, and flooring
 * that unguarded would write `0.904` for a budget of exactly `0.905`.
 *
 * Exported for `depthForIntent` — see `deeper`.
 */
export function shallower(v: number): Mm {
  return Math.floor(v * DEPTH_STEPS + 1e-6) / DEPTH_STEPS;
}

/**
 * The boundary margin a job with no stated one runs on: ONE PRINTED LAYER.
 *
 * That is the smallest distance a floor can be from a plane and still be on a different printed
 * layer — below it, sanding or a slightly deep cut reaches the plane. A blank that states its print
 * (`stock.print.layerHeight`, #285) tells us the real layer height; every other blank gets the
 * common 0.2.
 */
export function defaultBoundaryMargin(job: Pick<EngraveJob, 'stock'>): Mm {
  return job.stock.print?.layerHeight ?? DEFAULT_BOUNDARY_MARGIN_MM;
}

/**
 * The margins a job runs with, resolved once (#345).
 *
 * A job that states its own `margins` keeps them. A job that does not runs on the house setting —
 * except that when the house setting is still the SHIPPED default, "one printed layer" is read off
 * the blank's own print, so a badge with 0.2 mm layers gets 0.2 and one with 0.3 mm layers gets 0.3
 * without anyone typing it. A setting the user chose is never second-guessed.
 */
export function effectiveMargins(job: EngraveJob, settings: MarginSettings): EngraveMargins {
  if (job.margins) return job.margins;
  return {
    boundaryMargin: houseBoundaryMargin(job, settings),
    zTolerance: settings.zTolerance,
    source: settings.source,
  };
}

/**
 * The boundary margin the HOUSE setting puts in force for THIS job (#345 review), mm.
 *
 * The house number is both the margin a job with none of its own runs on AND the floor under the
 * recommendation, and in either role it must be the number really in force: while the setting is
 * still the shipped default, "one printed layer" is read off the blank's own print
 * (`defaultBoundaryMargin`), so a 0.3 mm-layer blank runs 0.3 — not the 0.2 the settings box shows.
 * Reading the raw `settings.boundaryMargin` instead let the panel and the run sheet print an advice
 * BELOW the margin that blank was already running on.
 *
 * ONE owner, so the margin in force (`effectiveMargins`) and the floor under the advice
 * (`recommendMargins`) cannot be two different numbers.
 */
export function houseBoundaryMargin(
  job: Pick<EngraveJob, 'stock'>,
  settings: Pick<MarginSettings, 'boundaryMargin' | 'source'>,
): Mm {
  return settings.source === 'default' ? defaultBoundaryMargin(job) : settings.boundaryMargin;
}

/**
 * Where a job's margins came from, in words (#345) — ONE namer, so the panel's row and the run
 * sheet's block cannot describe the same source two ways.
 *
 * `recommended` is "this job's" rather than "the app's" on purpose: the recommendation is per-job
 * arithmetic on THIS blank (`recommendMargins`), and saying so is what makes the other two readable
 * — the house default is not this job's, and a typed number is the user's.
 */
export function marginSourceWords(source: MarginSource): string {
  if (source === 'default') return 'the house default';
  if (source === 'recommended') return "this job's recommendation";
  return 'set for this job';
}

/** Where a bound's plane came from — the same provenance discipline the fixtures use (decision 28). */
export type DepthBoundSource = 'split' | 'void' | 'underside';

/**
 * One plane a floor must stay clear of (#345).
 *
 * `margin` overrides `boundaryMargin` for bounds whose rule is a different quantity: only the
 * stock's underside sets it, to `minFloor`, because material that must REMAIN is not a Z-error
 * budget. Everything else leaves it absent and takes the job's `boundaryMargin`.
 */
export interface DepthBound {
  /** The plane, as a depth below the engraved face, mm. */
  at: Mm;
  /** `above`: the floor must stay shallower. `below`: it must go deeper. */
  side: 'above' | 'below';
  /** The plane in words, for a finding: "the colour split", "the magnet pocket's ceiling". */
  name: string;
  source: DepthBoundSource;
  /** This bound's own margin, mm; absent = the job's `boundaryMargin`. */
  margin?: Mm;
}

/** A floor that broke a bound, with the margin that was in force for it. */
export interface BoundViolation {
  bound: DepthBound;
  /** The margin this bound was checked with, mm — `bound.margin` when it has one. */
  margin: Mm;
}

/** `magnet pocket` — a bound's name reads as a clause, so a user's capital does not shout. */
function lowerFirst(name: string): string {
  return name.length === 0 ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * How a void's ceiling is named ("the magnet pocket's ceiling") (#345).
 *
 * ONE namer, exported, so the `cut-too-deep` sentence and the per-item finding cannot describe the
 * same plane two ways. An unnamed void gets the generic clause rather than an invented name, the
 * same rule `keepOutNameAt` follows.
 */
export function ceilingName(name: string): string {
  return name.length === 0 ? "the void's ceiling" : `the ${lowerFirst(name)}'s ceiling`;
}

/**
 * The colour split's bound for one item, from the item's stated intent, or null.
 *
 * `depthIntent` does exactly this and nothing else since #345: `surface` puts the bound above the
 * split, `reveal` puts it below, and `custom` — or no intent at all, which is every item authored
 * before #170's control — produces NO bound, because an item that states no expectation has
 * nothing to be wrong about. A job whose stock states no split gets null for every intent: a
 * one-colour blank has no boundary to keep clear of, so two-colour costs nothing when it is absent.
 */
export function splitBound(intent: EngraveLabel['depthIntent'], splitDepth: Mm | null): DepthBound | null {
  if (splitDepth === null) return null;
  if (intent === 'surface') return { at: splitDepth, side: 'above', name: 'the colour split', source: 'split' };
  if (intent === 'reveal') return { at: splitDepth, side: 'below', name: 'the colour split', source: 'split' };
  return null;
}

/**
 * The margin a VOID'S CEILING keeps (#345 decision A), mm.
 *
 * A blank that states its print gets the Z-error margin like every other plane: the layer grid
 * quantises the ceiling, so keeping one printed layer clear of it is a distance the printer can
 * hold. A blank that states NO print has no grid to align to — the 0.2 can straddle the roof layer
 * — and it is also the blank the app knows least about, so it keeps whichever of the two numbers
 * is larger, `boundaryMargin` or the structural `minFloor`. The LEAST-known blank must not get the
 * THINNEST membrane.
 *
 * ONE owner for that rule: `keepOutLimitParts` (which the panel, the preview and the run sheet all
 * read), the per-item void bound in `bindingVoidsByRegion` and the stack's own limit in
 * `stackDepthLimit` all call it, so none of them can keep a different distance from the same plane.
 */
export function voidMargin(job: Pick<EngraveJob, 'stock' | 'minFloor'>, boundaryMargin: Mm): Mm {
  return job.stock.print === undefined ? Math.max(boundaryMargin, job.minFloor) : boundaryMargin;
}

/**
 * WHICH of those two numbers `voidMargin` returned, in words (#345) — so a row that prints the
 * number can also name the rule that set it instead of hard-coding one of the two and being wrong
 * on the other. Mirrors `voidMargin`'s own arithmetic; `marginSourceWords` is the same discipline
 * for the house/job/recommendation provenance.
 */
export function voidMarginWords(
  job: Pick<EngraveJob, 'stock' | 'minFloor'>,
  boundaryMargin: Mm,
): string {
  const keepsFloor = job.stock.print === undefined && job.minFloor >= boundaryMargin;
  return keepsFloor
    ? `the ${mm(job.minFloor)} mm minimum floor`
    : `the ${mm(boundaryMargin)} mm boundary margin`;
}

/**
 * The bound a void's ceiling makes (#345), from how deep a cutter may go there before it reaches
 * the void (`maxDepthAt`, or the analytic membrane where there is no layer grid).
 *
 * `breach` is the CEILING — a DEPTH below the engraved face, not a height: the caller has already
 * flipped the void's part-frame `zCeiling` into the work frame every bound lives in, and aligned it
 * to the printer's layers when the blank states a print. It is the PLANE, not the limit; subtracting
 * the margin is `checkBounds`/`boundFloor`'s job.
 *
 * `margin` is this bound's own margin where its rule differs from the job's `boundaryMargin` — a
 * void on a no-print blank, whose margin `voidMargin` works out (#345 decision A).
 */
export function voidBound(name: string, breach: Mm, margin?: Mm): DepthBound {
  return {
    at: breach,
    side: 'above',
    name: ceilingName(name),
    source: 'void',
    ...(margin === undefined ? {} : { margin }),
  };
}

/**
 * The stock's underside as a bound. Its plane is the blank's own thickness and its margin is the
 * job's `minFloor` — the material that must remain, which is a different quantity from the Z-error
 * margin and deliberately not replaced by it (#345's table).
 *
 * `depth-exceeds-stock` (`jobSetup.ts`) is this bound's enforcing owner on the per-item side, and
 * the sacrificial limit is its owner on the per-move side. It is carried here so the model has one
 * shape rather than three, and so the run sheet can print it with the rest.
 */
export function undersideBound(job: EngraveJob): DepthBound {
  return {
    at: job.stock.thickness,
    side: 'above',
    name: "the stock's underside",
    source: 'underside',
    margin: job.minFloor,
  };
}

/**
 * What the caller knows about the item's own place on the blank, which the item itself does not
 * hold: where the colour split lands, and whether the item sits over a void.
 */
export interface ItemBoundPlanes {
  /** The split's depth below the engraved face, mm, or null when the blank states no split. */
  split: Mm | null;
  /**
   * The shallowest breach depth over the item's own footprint, mm — the number the layer stack (or
   * the analytic membrane) answered for the material under it — or null when it sits over no void.
   */
  overVoid?: { name: string; breach: Mm } | null;
}

/**
 * Every bound ONE item is judged against (#345), in the order a violation is reported.
 *
 * The split comes first because it is the item's OWN stated intent — when a floor breaks both its
 * intent and a plane under it, the intent is the one the person can act on. The underside comes
 * last, and its violation is `depth-exceeds-stock`'s to report: the per-item check drops that
 * source so one over-deep item does not produce two errors saying the same thing (see
 * `itemDepthBoundFindings`).
 *
 * A void's bound carries its OWN margin (`voidMargin`), which is not `boundaryMargin` on a blank
 * that states no print (#345 decision A) — so the caller's number is the boundary margin, and the
 * rule for this plane is applied here rather than trusting each caller to remember it.
 */
export function boundsFor(
  job: EngraveJob,
  item: EngraveAnyItem,
  planes: ItemBoundPlanes,
  boundaryMargin: Mm = defaultBoundaryMargin(job),
): DepthBound[] {
  const bounds: DepthBound[] = [];
  const split = splitBound('depthIntent' in item ? item.depthIntent : undefined, planes.split);
  if (split) bounds.push(split);
  if (planes.overVoid) {
    bounds.push(voidBound(planes.overVoid.name, planes.overVoid.breach, voidMargin(job, boundaryMargin)));
  }
  bounds.push(undersideBound(job));
  return bounds;
}

/**
 * The first bound a floor at `depth` breaks, or null when it satisfies every one of them.
 *
 * Strict both ways: an `above` bound needs `d ≤ at − m`, a `below` bound needs `d ≥ at + m`. A
 * floor sitting exactly ON a plane is refused — it is in the plane, not clear of it — which is the
 * equality #285's review flagged and this margin always subtracts away.
 *
 * The comparison carries `DEPTH_EPS` so it judges the same number the recommendation computes
 * (#362 review): `at − m` in floats is `0.9199999999999999` where the rounded floor it is judging is
 * `0.92`, and without the tolerance the app's own number broke its own bound. The tolerance is the
 * float tail and nothing more — a floor a thousandth past the plane still fails.
 */
export function checkBounds(
  depth: Mm,
  bounds: readonly DepthBound[],
  margin: Mm,
): BoundViolation | null {
  for (const bound of bounds) {
    const m = bound.margin ?? margin;
    const broke =
      bound.side === 'above' ? depth > bound.at - m + DEPTH_EPS : depth < bound.at + m - DEPTH_EPS;
    if (broke) return { bound, margin: m };
  }
  return null;
}

/**
 * The floor ONE `above` bound allows: `at − margin`, never below 0 (#345).
 *
 * The clamp is the honest reading of a plane closer to the face than the margin: there is no depth
 * left to cut, and a negative one is not a number an operator can act on. `sacrificialDepthLimit`
 * already answers 0 for "nothing may be cut here", so this is the same vocabulary.
 */
export function boundFloor(bound: DepthBound, margin: Mm): Mm {
  return Math.max(0, bound.at - (bound.margin ?? margin));
}

/**
 * The floor a void's ceiling allows, mm — its `breach` less the margin in force (#345), clamped at
 * 0 by `boundFloor`.
 *
 * The bridge between the two ways a ceiling is known: `breach` is the depth the cutter would reach
 * the void at, whether the layer stack worked it out from the printed solid (`maxDepthAt − margin`,
 * #285) or the design's own membrane arithmetic did (`keepOutLimit`, #213) — and both then keep the
 * same margin clear of it. One rule, so the sheet and the verifier cannot drift apart.
 */
export function voidFloor(breach: Mm, margin: Mm, name = ''): Mm {
  return boundFloor(voidBound(name, breach), margin);
}

/** What the recommendation is built from — what THIS setup and THIS blank are known to be out by. */
export interface ZBudgetInputs {
  /** The probe's own ± in Z, mm. Defaults to the wired probe's measured repeatability. */
  probeUncertainty?: Mm;
  /** The autolevel grid's residual in Z, mm, when this job runs one (#176). */
  gridResidual?: Mm;
  /**
   * The ± on the blank's thickness, mm. Callers pass it when the thickness is a MEASURED value
   * (#254's source) — the model's thickness is exact, a caliper's is not.
   */
  thicknessUncertainty?: Mm;
}

/** What `recommendMargins` worked out, and the arithmetic in words for the panel and the sheet. */
export interface MarginRecommendation {
  /** The Z budget this job should be carrying, mm. */
  zTolerance: Mm;
  /** `max(setting, zTolerance)` — the margin every bound then uses, mm. */
  boundaryMargin: Mm;
  /** One clause per contribution, in the order they were added. */
  basis: string[];
}

/**
 * What THIS job's Z margins should be, from what is known about THIS blank and THIS setup (#345).
 *
 * The budget is a SUM of the things that actually move Z:
 *
 *   - the probe's own repeatability (`inputs.probeUncertainty`, the wired probe's measured 0.001 by
 *     default — the model's other probe figure, `PROBE_RESIDUAL_MM`, is the 3D probe's assumed one);
 *   - PLUS either the autolevel grid's residual (`inputs.gridResidual`, #176) when the job runs a
 *     grid, or the blank's stated dome (`stock.flatness`, #345) when it does not. A grid is what
 *     measures the dome away, so carrying both would double-count the same error;
 *   - PLUS the thickness' own ± when the blank was measured rather than modelled.
 *
 * A blank that states no flatness and runs no grid gets NO dome term and says so ("flatness
 * unknown") rather than inventing 0 — the honest answer is a budget that may be too small, and the
 * basis is what tells the user to check.
 *
 * The margin is then `max(setting, zTolerance)`: the house setting is a floor under the advice, so
 * a job with nothing special about it is not talked into a tighter margin than the house runs.
 *
 * `setting` is the HOUSE setting, and deliberately not the margins a job is running on (#345
 * review). A job that has already taken a recommendation carries it in `job.margins`; feeding that
 * back in would let the job's own number raise its own advice, so the recommendation could only
 * ever ratchet and the panel would have nothing to offer the second time round.
 *
 * The floor under the advice is `houseBoundaryMargin(job, setting)` — the house number AS THIS JOB
 * runs it, one printed layer of this blank while the setting is still the shipped default — so a
 * recommendation can never come out below the margin already in force (#345 review).
 */
export function recommendMargins(
  job: EngraveJob,
  setting: Pick<MarginSettings, 'boundaryMargin' | 'source'>,
  inputs: ZBudgetInputs = {},
): MarginRecommendation {
  const basis: string[] = [];
  const probe = inputs.probeUncertainty ?? WIRED_PROBE_Z_RESIDUAL_MM;
  let zTolerance = probe;
  basis.push(`the wired probe adds ${mm(probe)} mm`);

  if (inputs.gridResidual !== undefined) {
    zTolerance += inputs.gridResidual;
    basis.push(
      `the autolevel grid's residual adds ${mm(inputs.gridResidual)} mm`,
    );
  } else {
    const flatness = job.stock.flatness;
    if (flatness) {
      zTolerance += flatness.dome;
      basis.push(
        `the blank is domed ${mm(flatness.dome)} mm across its ${flatness.across} and this job runs no autolevel grid`,
      );
    } else {
      basis.push('flatness unknown: no number for the dome');
    }
  }

  if (inputs.thicknessUncertainty !== undefined) {
    zTolerance += inputs.thicknessUncertainty;
    basis.push(`the measured thickness adds ${mm(inputs.thicknessUncertainty)} mm`);
  }

  return {
    zTolerance,
    boundaryMargin: Math.max(houseBoundaryMargin(job, setting), zTolerance),
    basis,
  };
}

/**
 * The ± a MEASURED stock thickness carries, mm. A caliper on a printed blank: the same order as the
 * vise jaws' own residual, and PROVISIONAL the same way (#208 owes the bench measurement). Used
 * only when `sources.stock.thickness` says the number was measured rather than computed.
 */
export const MEASURED_THICKNESS_TOLERANCE_MM: Mm = 0.05;

/**
 * The `ZBudgetInputs` THIS job supplies by itself (#345 review) — the facts that live on the
 * document and nowhere else. The panel and the run sheet both call this and then hand the result to
 * `recommendMargins`, so the number the operator reads on the printout and the number the panel
 * offers are the same arithmetic over the same inputs. Two callers each deciding for themselves
 * which inputs apply is two answers waiting to disagree.
 *
 * The grid's residual (#176) is NOT here: nothing produces one yet, and a job that runs a grid will
 * have to say so on the document before either caller can read it.
 */
export function zBudgetInputsFor(job: EngraveJob): ZBudgetInputs {
  return {
    thicknessUncertainty:
      job.sources?.stock?.thickness === 'measured' ? MEASURED_THICKNESS_TOLERANCE_MM : undefined,
  };
}

/**
 * Where the colour split lands below the engraved face, mm — or null when the blank states no print
 * (#166/#285).
 *
 * The GRID's answer, not the nominal `thickness − split`: the boundary is a fact about the
 * printer's layers, and `colourBoundaryDepthFor` is the one function that says where it is
 * (`colourBoundaryFor` asks it for the per-move verifier and `item-depth-bound`). A recommendation
 * that used the nominal height would sit up to half a layer away from the plane the checker then
 * judges it against — which is how a recommendation ends up failing its own check.
 */
export function splitDepthOf(job: Pick<EngraveJob, 'stock'>): Mm | null {
  const print = job.stock.print;
  if (print === undefined) return null;
  return colourBoundaryDepthFor(
    job.stock.thickness,
    print.split,
    print.layerHeight,
    print.firstLayerHeight ?? print.layerHeight,
  );
}

/** What `recommendLabelDepth` needs that the item itself does not hold. */
export interface LabelDepthInputs {
  /**
   * The shallowest limit among the voids THIS ITEM's own extent reaches, mm, with the void it
   * belongs to — or null when the item sits clear of every one (`voidLimitForItem`, #365).
   *
   * Per ITEM, and not one number for the blank. It used to be the blank-wide `shallowestVoidLimit`,
   * on the reasoning that a caller with no plan in hand must not guess at the glyphs' true extent —
   * which is still true, and is why the item is reduced to its ink BOX: the verifier is positional,
   * cutting at the toolpath's own points, and those points lie inside that box, so the box reaches a
   * superset of the voids the checker can refuse against. The recommendation therefore still never
   * permits more than the checker allows; it only stops charging a line for a void its own extent
   * misses, which was half the depth the blank allowed on the badge's own seeded line.
   *
   * `estimated` says the box behind this answer was the fallback estimate rather than a measurement
   * — a face that is not parsed yet (#180). That estimate is an UPPER bound, so such an answer is
   * the timid one, and the clause built from it says so rather than reading as if the glyphs had
   * been measured.
   *
   * REQUIRED, `null` included, and not optional-with-a-default: this module cannot compute it (the
   * void's arithmetic lives in `partPlan`, which is built on this one), so the alternative to an
   * argument is silently recommending a depth that cuts straight through a pocket. A caller with
   * voids must say what they leave; a caller with none must say so.
   */
  voidLimit: { name: string; limit: Mm; estimated?: boolean } | null;
  /**
   * How near THIS ITEM's own extent comes to the vise's jaws, in XY — `labelJawReach`, or the
   * `idJawReach` reading for a kind whose own extent cannot be measured (#369, #394).
   *
   * The jaw floor is `stockProud − clearance`, a Z rule, and it used to be charged to every line on
   * the blank whatever its position. It applies only where a jaw can actually reach the cut, which
   * is an XY question `partPlan` answers; this module cannot compute it, because `partPlan` is built
   * ON this one and the import would be a cycle. So it arrives as an argument, in the same shape
   * `voidLimit` does.
   *
   * REQUIRED, and with the same reasoning as `voidLimit`: a caller that passed nothing would get a
   * jaw bound charged to a line the jaws cannot reach — the exact bug — and there is no honest
   * default, because "the jaws bind everything" is the reading #369 removed.
   */
  // Structurally `partPlan.JawReach`, restated rather than imported: `partPlan` is built ON this
  // module, so the edge would be a cycle — and a `type`-only import is still an edge a reader has
  // to trace. Only `jaw` and `gap` are read below; the flags are the caller's to interpret.
  jawReach: { jaw: 'fixed' | 'moving'; gap: Mm; reaches: boolean; overJaw: boolean };
  /**
   * The Z-error margin in force for this job, mm — `effectiveMargins`' `boundaryMargin`, as the
   * checker will resolve it. REQUIRED for the same reason: this module does not read the settings
   * store, and a margin guessed here rather than passed would be a second, invisible opinion about
   * a number the check then holds the floor to.
   */
  boundaryMargin: Mm;
  /**
   * WHO stated the item's `depthIntent`, from `sources.labels[id].depthIntent` (#362 review). Omit
   * when the item states none.
   *
   * It exists because this module writes an intent of its OWN. `'reveal'` on a two-colour blank is
   * the recommendation's statement, not the user's, and the guard below declines any item that
   * states an intent — so without this a label the recommendation itself stamped would be locked
   * out of every later re-depth and keep a depth for a blank it is no longer on. `'computed'` says
   * "ours, and ours to rewrite"; anything else — or a stated intent with no provenance at all, which
   * is every document written by hand — is a person's and is left alone.
   */
  intent?: FieldSource;
}

/** What `recommendLabelDepth` worked out, and the arithmetic in words for the panel and the sheet. */
export interface LabelDepthRecommendation {
  /** The depth to cut at, mm — the shallowest any constraint under this item allows. */
  depth: Mm;
  /**
   * `'reveal'` when this recommendation places the floor PAST the blank's colour split, which is
   * what a two-colour blank is for — the intent the route is asserting for an item that states none
   * of its own.
   *
   * ABSENT when the blank states no print (there is no split to reveal) and when the split's own
   * depth did not win (a jaw clearance tighter than the reveal is not a reveal, and stamping one
   * would make the item fail `checkBounds` against its own stated intent).
   */
  depthIntent?: EngraveLabel['depthIntent'];
  /** One clause per constraint considered, the BINDING one first — `MarginRecommendation.basis`' rule. */
  basis: string[];
}

/**
 * The depth THIS blank lets THIS item be cut at, and the arithmetic that decided it (#362).
 *
 * The issue this answers is a clash of three defaults that never knew about each other: a 3.81 mm
 * badge blank (`badgeBlankFor`, #352), the vise standing it 1.905 mm proud (the `defaultStockProud`
 * of the day, #344; since #391 it SEATS the blank on the jaws' 3.1 mm ledges, 0.71 mm) and the 2 mm
 * label depth the 12 mm softwood job shipped with — so the wizard handed over a job its own findings
 * already complained about. The route that knows the blank now also says how deep it may be cut.
 *
 * The answer is the SHALLOWEST of four floors, each of which is a real plane or a real budget:
 *
 *   1. the colour split, by ONE margin — `split + boundaryMargin`, which is the *below* bound
 *      `checkBounds` holds a `reveal` floor to;
 *   2. the void's ceiling, taken as the blank's own shallowest `keepOutLimit` (`inputs.voidLimit`);
 *   3. the blank's underside: `thickness − minFloor`;
 *   4. the jaws: `stockProud − max(job.jawClearance, boundaryMargin)` — the max is #345's rule that
 *      a per-job recommendation may be stricter than the setting, so a domed blank (whose boundary
 *      margin covers the dome) keeps more room over the jaws than the house number alone. Only
 *      where this item's own extent comes within the jaws' reach (`inputs.jawReach`, #369): a line
 *      with material between it and both jaw faces gets no jaw bound at all, and the basis says so.
 *
 * A blank that leaves no depth at all (`≤ 0` on a stock thinner than the clearance it must keep) is
 * NOT given a made-up 0.1 mm: this returns null, nothing is written, and the jaw check goes on
 * saying what is wrong with the setup — which is a thing to fix, not a depth to cut.
 *
 * EMPTY for an item that states its own `depthIntent`, and for a construction label that cuts
 * nothing: an item that has told us what it means is the user's to place, and re-depthing it under a
 * different intent would be this module overruling a statement nobody asked it to review. The one
 * intent this does NOT decline is its own — `inputs.intent === 'computed'` is a `'reveal'` a
 * previous call wrote, and a recommendation that could not revise itself would freeze a label onto
 * the blank it was first measured against (#362 review).
 */
export function recommendLabelDepth(
  job: EngraveJob,
  item: EngraveAnyItem,
  inputs: LabelDepthInputs,
): LabelDepthRecommendation | null {
  if ('construction' in item && item.construction === true) return null;
  const stated = 'depthIntent' in item ? item.depthIntent : undefined;
  if (stated !== undefined && inputs.intent !== 'computed') return null;

  const margin = inputs.boundaryMargin;
  const candidates: { depth: Mm; clause: string }[] = [];

  const split = splitDepthOf(job);
  if (split !== null) {
    candidates.push({
      depth: deeper(split + margin),
      clause:
        `the colour split is ${mm(split)} mm under the face, so reaching the bottom colour needs ` +
        `${mm(deeper(split + margin))} mm`,
    });
  }

  if (inputs.voidLimit) {
    const { name, limit, estimated } = inputs.voidLimit;
    const depth = shallower(limit);
    const who =
      name.length === 0 ? 'the void under this line' : `"${name}"`;
    candidates.push({
      depth,
      clause:
        `${who} leaves ${mm(depth)} mm of material` +
        // #365 — say which box the overlap was measured against. The fallback box is an upper
        // bound, so an answer that used it is the TIMID one: named, rather than left to read as a
        // measurement the app did not make.
        (estimated === true ? ", measured against the line's estimated extent — its face is not parsed yet" : ''),
    });
  }

  const blank = shallower(job.stock.thickness - job.minFloor);
  candidates.push({
    depth: blank,
    clause: `the blank's ${mm(job.minFloor)} mm minimum floor allows ${mm(blank)} mm`,
  });

  const clearance = Math.max(job.jawClearance, margin);
  const { stockProud } = job.workholding.vise;
  // #369 — the jaw floor is a Z rule with an XY precondition, and the basis states which one held
  // rather than which number won. `reaches` is that precondition: the swept cut can come over a jaw
  // once the vise's own band is allowed for (#394), which is the same reading `stock-proud-too-small`
  // warns on, so a depth recommended here is never one the app's own warning refuses. The gap is
  // measured against the line's own extent — MEASURED where its face is up, and `inkBoxOf`'s
  // documented estimate where it is not (#394) — and either way that box CONTAINS the ink, so the
  // real distance is at least the number quoted: hence "at least", and hence "within" on the other
  // side.
  const { jaw, gap, reaches } = inputs.jawReach;
  if (reaches) {
    candidates.push({
      depth: shallower(stockProud - clearance),
      clause:
        `the line comes within ${mm(gap)} mm of the ${jaw} jaw; the stock stands ` +
        `${mm(stockProud)} mm above the jaw tops and a floor has to stay ${mm(clearance)} mm clear ` +
        'of them',
    });
  }

  const winner = candidates.reduce((a, b) => (b.depth < a.depth ? b : a));
  if (winner.depth <= 0) return null;

  const notBinding = candidates.filter((c) => c !== winner).map((c) => `${c.clause} — not binding`);
  // A clear item still states that the jaws were CONSIDERED and set no limit. Silence here would be
  // indistinguishable from a check that never ran, and the reader of a basis sentence is deciding
  // how deep it is safe to cut. `— not binding` is not the right suffix for it: it is not a limit
  // that lost, it is no limit at all.
  if (!reaches) {
    notBinding.push(`clear of both jaws by at least ${mm(gap)} mm; the jaws set no limit here`);
  }

  // The BAND between the two colour bounds, `(split − m, split + m)`: past the plane, but not far
  // enough past it for a `reveal`, and not short enough for a `surface`. A floor landing here is
  // neither bound's business, so nothing checks it — and on a domed blank the two-tone floor it
  // would leave is exactly what the margin exists to prevent. It is demoted to a `surface` floor,
  // which is the deepest depth in the band a bound can actually hold the floor to (#362 review).
  if (split !== null && winner.depth > split - margin + DEPTH_EPS && winner.depth < split + margin - DEPTH_EPS) {
    const surface = shallower(split - margin);
    // `surface ≤ 0` is a two-colour blank whose split is too near the face for any floor to stay in
    // the top colour: there is nothing to demote TO, so the winner stands and the basis says so.
    if (surface > 0) {
      return {
        depth: surface,
        depthIntent: 'surface',
        basis: [
          `the shallowest this blank allows is ${mm(winner.depth)} mm (${winner.clause}), which lands ` +
            `inside the colour split's ±${mm(margin)} mm band at ${mm(split)} mm — neither colour is ` +
            `decided there, so the floor stops in the top colour at ${mm(surface)} mm`,
          ...notBinding,
        ],
      };
    }
  }

  // The intent, only where the floor really is on the far side of the split by the margin a
  // `reveal` bound demands.
  const reveal = split !== null && winner.depth >= split + margin - DEPTH_EPS;

  return {
    depth: winner.depth,
    ...(reveal ? { depthIntent: 'reveal' as const } : {}),
    basis: [winner.clause, ...notBinding],
  };
}
