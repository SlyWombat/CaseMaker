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
 */

import { DEFAULT_BREAKTHROUGH } from '@/engine/cnc/sacrificial';
import { WIRED_PROBE_Z_RESIDUAL_MM } from '@/engine/cnc/probePlan';
import type { EngraveAnyItem, EngraveJob, EngraveLabel, EngraveMargins, MarginSource } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/**
 * The house's thresholds (#345), persisted with the rest of the app settings.
 *
 * `boundaryMargin` and `zTolerance` are what a job COPIES; the other three SEED a new job's own
 * per-job fields (`minFloor`, `edgeMargin`, `breakthrough` on the document), which stay the single
 * owner of their quantities. A seed is a starting number the user then has per job, not a second
 * copy of the same rule.
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
}

/** `0.2` — one printed layer at the layer height most printers use when nothing says otherwise. */
export const DEFAULT_BOUNDARY_MARGIN_MM: Mm = 0.2;

/** The ± a job assumes in Z until it works its own out (`recommendMargins`). */
export const DEFAULT_Z_TOLERANCE_MM: Mm = 0.05;

/** 1.0 / 1.0 — the numbers `defaultEngraveJob` seeded before #345 moved them into a setting. */
export const DEFAULT_MIN_FLOOR_MM: Mm = 1.0;
export const DEFAULT_EDGE_MARGIN_MM: Mm = 1.0;

/**
 * The shipped thresholds, and the fallback whenever a stored setting is missing or malformed. The
 * three seeds are exactly the constants `defaultEngraveJob` used before they moved here, so a fresh
 * install produces the job it always did.
 */
export const MARGIN_DEFAULTS: MarginSettings = {
  boundaryMargin: DEFAULT_BOUNDARY_MARGIN_MM,
  zTolerance: DEFAULT_Z_TOLERANCE_MM,
  minFloor: DEFAULT_MIN_FLOOR_MM,
  edgeMargin: DEFAULT_EDGE_MARGIN_MM,
  breakthrough: DEFAULT_BREAKTHROUGH,
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
 * ONE owner for that rule: `keepOutLimit` (the analytic ceiling the panel and the no-print verifier
 * use), `voidLimit` (the sheet) and the per-item void bound all call it, so the three cannot keep
 * different distances from the same plane.
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
 */
export function checkBounds(
  depth: Mm,
  bounds: readonly DepthBound[],
  margin: Mm,
): BoundViolation | null {
  for (const bound of bounds) {
    const m = bound.margin ?? margin;
    const broke = bound.side === 'above' ? depth > bound.at - m : depth < bound.at + m;
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
