/**
 * #961 — THE CUTTER SEQUENCE, CHOSEN BY COST.
 *
 * The vendor's shape on the tray reference (plan v2 §1, #955): the LARGEST FLAT that fits the part
 * roughs what it enters, each next SMALLER flat is added for what the previous cannot reach (a
 * tighter corner, a narrower opening — the op's "needs a cutter ≤ N mm" report) while a cutter in
 * the set can cover it and the cutter budget allows, a ball finishes the curved remainder at the
 * stated scallop, and a chamfer breaks the rims. Makera runs 4 cutters in 47.6 min on that part;
 * the sequence this module returns must stay at or under the vendor's count + 1 and its price at
 * or under 2× the vendor's cycle (plan v2 §3). A pocket no cutter in the budget enters is STATED
 * (`unreachable`), never allowed to shrink the primary — E measured the vendor leaving the tray's
 * ~1 mm features too — and never counted against a chain (`leftBehind`): every chain would carry
 * it, so counting it lets price leave cuttable pockets uncut.
 *
 * THE FREEING CUT is its own LAST step (#959 ruling: the part stays held through every other cut).
 * Its cutter is one already in the chain: the first link that covers the profile (usually the
 * primary — coming back to it after the rests costs a RETURN tool change, which `priceSequence`
 * charges), or the chain's last cutter when it can take the profile (stated flute ≥ depth, stated
 * shape; already loaded, so no return). Both are offered and the cheaper wins; `freeing` says
 * which. A cutter that comes back after another ran is charged the second change — counting one
 * change per cutter key, the older model, under-priced exactly that return.
 *
 * THE METHOD, and where it comes from (prior-art note on #961; Kiri:Moto, FreeCAD Path and
 * OpenCamLib are LOCAL REFERENCES only — the methods are re-implemented from their descriptions,
 * no code is copied or linked):
 *  - neither Kiri:Moto nor FreeCAD Path picks a sequence — both leave the ordered op list and its
 *    tools to the operator. The picker is ours to add.
 *  - the price is the app's own #927 estimate on the POSTED moves (`estimateCycleTerms`: moves +
 *    inter-op entries + spin-up) plus the shop's `toolChange.seconds` for every change between
 *    CONSECUTIVE steps — the same model #858 uses (`planCostSeconds` in `smartPick.ts`), not a
 *    second time model.
 *  - candidates are pruned on GEOMETRY before any move is built (a flat that cannot enter the
 *    feature's opening/corner, a flute shorter than the cut), so the expensive planner only sees
 *    candidates that can physically cut the part. The families are the vendor's own: flat, rest,
 *    ball, chamfer; the rest cutters form a CHAIN, one per prefix, and the price decides whether
 *    the extra cutter earns its change.
 *  - a house cutter is preferred to a catalogue one, and a cutter with a real feeds row to one on
 *    the labelled fallback band (`fallback-fed after rowed`), before price decides. The caller
 *    decides what "house" means: on a simulation-only reference card it fills `house` with the
 *    VENDOR's own set (A's R5), and `sequence[].house` then means "the set this card prices".
 *
 * The op implementations (#959/#960) are not this module's: `planStep` builds one step's moves and
 * the sequence is priced from those IRs. A caller with no ops yet (a test, the panel before the
 * engine lands) supplies a stand-in; the arithmetic is unchanged.
 */

import type { Tool } from '@/engine/cnc/tool';
import { cuttingDiameter } from '@/engine/cnc/tool';
import {
  estimateCycleTerms,
  type RapidEstimate,
  type ToolpathIR,
} from '../ir';
import { PlanMetadataInconsistentError } from './planMeta';
import { memTrace, memTraceEnabled } from '@/engine/cnc/memTrace';
import { bitChangePriceSeconds, flatBitChangeRule, type BitChangeRule } from './bitChange';
import { pickAmongEquals, pickKeysOf, pickNote as pickNoteSentence, REACH_MARGIN_FALLBACK_MM } from './pickAmongEquals';

/** The op kinds the engine's plan carries (`PlannedOp['kind']` on #956's interface). */
export type PlannedOpKind = 'pocket' | 'contour' | 'rough' | 'rest' | 'finish' | 'pencil' | 'chamfer' | 'skin';

/** What a cutter does in the sequence — the vendor's four roles. */
export type CutterRole = 'flat' | 'rest' | 'ball' | 'chamfer';

/** The cutters a card offers: the shop's own set first, the catalogue second. */
export interface CutterCandidates {
  house: Tool[];
  catalogue: Tool[];
  /** A key the operator pinned per op kind; honoured and labelled, never silently replaced. */
  pinned?: Partial<Record<PlannedOpKind, string>>;
}

/**
 * One thing the plan must cut, as the sequence needs to see it. A structural view of the spots of
 * #958's `FeatureTree` that decide reach — the tree itself is A's and the caller derives these.
 */
export interface SequenceFeature {
  /** The feature's id, carried into the step's `regionIds`. */
  id: string;
  /** A pocket floor / island top, the outer contour, a curved remainder, or an edge to break. */
  kind: 'pocket' | 'contour' | 'curved' | 'rim';
  /**
   * The SMALLEST inside corner radius a flat must enter, mm. Only a REST cutter has to meet it: a
   * flat wider than a corner still roughs the pocket the corner belongs to, and the rest cutter is
   * what reaches the corner. Null/absent: unstated.
   */
  cornerRadiusMm?: number | null;
  /**
   * The NARROWEST opening the cutter must pass through (a slot's width, a pocket's waist), mm. A
   * flat wider than this cannot enter the feature at all and is pruned before any move is planned.
   * Null/absent: unstated.
   */
  minOpeningMm?: number | null;
  /** The deepest cut this feature asks for below the stock top, mm (positive). */
  depthMm: number;
  /**
   * The smallest CONCAVE radius on a curved surface, mm: a ball larger than this cannot follow it
   * without gouging. Null/absent: unstated (the ball is not pruned on curvature).
   */
  curvatureRadiusMm?: number | null;
}

/** What the part asks the sequence to cut. */
export interface SequenceDemand {
  features: SequenceFeature[];
  /** The finish's scallop target, mm (curved features only). */
  scallopMm?: number | null;
}

/** One cutter in a candidate, with the facts the choice is ranked on. */
export interface CutterChoice {
  key: string;
  tool: Tool;
  house: boolean;
  pinned: boolean;
  /** A real feeds row for the stock material, or the labelled fallback band (`#926/#927`). */
  feeds: 'row' | 'fallback';
}

/** One step of a candidate: an op kind, its cutter, and the regions it covers. */
export interface SequenceStep {
  kind: PlannedOpKind;
  role: CutterRole;
  cutter: CutterChoice;
  regionIds: string[];
  /**
   * #961 — TRUE on a COVERAGE rest: the optional link that the primary's geometry does not need
   * (it already covers the pocket) and that is included only because its finer pass can recover
   * surface left above the band. It earns its place only when the coverage it buys clears
   * {@link COVERAGE_REST_MIN_MM2_PER_SECOND}; a geometric rest carries no marker and is never
   * priced against that line — without it a pocket is left uncut.
   */
  coverageRest?: true;
}

/** A candidate sequence, in execution order. */
export interface CandidateSequence {
  steps: SequenceStep[];
  /**
   * Pockets this candidate does NOT cover, by feature id — the "needs a cutter ≤ N mm" features no
   * cutter in this candidate's chain can enter. STATED, never a silent pass: the picker prefers a
   * complete chain, and a demand whose every chain leaves one names it.
   */
  unreachable: string[];
  /**
   * Of `unreachable`, how many a cutter in the candidate set COULD have covered — this chain left
   * them. Ranked before price: an uncut cuttable pocket is a different part, not a cheaper plan
   * (E's organizer run on ec77465a: 16 pockets no house flat can enter made every candidate
   * "incomplete", so the complete-first rule tied and price left 27 cuttable pockets uncut).
   * Zero is a complete plan; the pockets no cutter can reach are the part's, not the chain's.
   */
  leftBehind: number;
}

/**
 * One cutter's price. `estimateSeconds` is #927's own terms on that cutter's posted moves;
 * `toolChanges` counts the changes charged to this cutter (0 for the loaded first cutter, 1 for
 * every later visit); `changeSeconds` is what those changes are PRICED at (#1114 — each change's
 * price comes from the program before it, not a flat allowance). This is the `CycleCost` #956's
 * `SetupPlan.sequence[]` carries.
 */
export interface CycleCost {
  cutterKey: string;
  /** Σ #927 terms on this cutter's steps: moves + inter-op entries + spin-up, s. */
  estimateSeconds: number;
  /** Changes charged to this cutter: 0 for the first, 1 for each cutter after it. */
  toolChanges: number;
  /** #1114 — Σ the prices of those changes, s (each priced from its preceding program). */
  changeSeconds: number;
  /** `estimateSeconds + changeSeconds`. */
  totalSeconds: number;
}

/** #1114 — one bit change and what the program before it cost the operator. */
export interface PricedChange {
  /** The program the change follows: its cutter key. */
  afterCutterKey: string;
  /** The cutter the change loads. */
  beforeCutterKey: string;
  /** The preceding program's own cycle estimate, s. */
  afterSeconds: number;
  /** What this change is priced at, s. */
  priceSeconds: number;
}

/** A whole sequence's price. */
export interface SequenceCost {
  entries: CycleCost[];
  estimateSeconds: number;
  toolChanges: number;
  /** #1114 — Σ every change's price, s. */
  changeSeconds: number;
  /** #1114 — every change, in execution order, with the program it follows. */
  changes: PricedChange[];
  totalSeconds: number;
}

/**
 * The planner seam: build one step's IR (#959/#960 own it), or null when it cannot be planned.
 * #961 — `prefix` is the steps this candidate already planned BEFORE this one (in execution
 * order). A coverage rest needs it: its region is the leftover the chain-so-far's own sweep
 * leaves, so the rest cuts what stands, not the whole pocket the primary cleared.
 */
export type PlanStep = (step: SequenceStep, prefix?: readonly SequenceStep[]) => ToolpathIR | null;

export interface SequenceOptions {
  /** The machine's rapid model, #927's timing. */
  rapid: RapidEstimate;
  /**
   * #1114 — THE SHOP'S BIT-CHANGE RULE: a change costs by the price curve from the program
   * before it. When absent, `toolChangeSeconds` is the pre-#1114 flat allowance (every change the
   * same), so a caller with no durations to price against is unchanged.
   */
  bitChange?: BitChangeRule;
  /** The shop's `toolChange.seconds` (#858) — the flat fallback when `bitChange` is absent. */
  toolChangeSeconds: number;
  /** #1114 — the shop's `reach.marginMm`: the gate a tie's candidates must clear. */
  reachMarginMm?: number;
  /**
   * planner v3 A1 — the leftover two chains may differ by and still rank as equal, in percent of
   * the goal's covered cells (`plan.leftoverEquivalencePct`). Absent or 0: every difference counts.
   */
  leftoverEquivalencePct?: number;
  /** Build the step's moves; the op implementations, or a stand-in. */
  planStep: PlanStep;
  /** Whether a cutter's feeds are rowed or the labelled fallback; absent → rowed. */
  feedsKind?: (tool: Tool) => 'row' | 'fallback';
  /**
   * #1192 rule 3's MORNING MINIMUM — WHICH FLATS MAY BE PRIMARIES. The screen's shortlist by key
   * (the incumbent and the best estimate); a flat off the list is never a primary, but STAYS in
   * the rest/finish pool (a dropped primary remains available as a rest — the fields' rule 2).
   * Absent → every fitting flat is a primary, as rule 1 said.
   */
  allowPrimary?: (cutterKey: string) => boolean;
  /**
   * The most cutters a chain may use, including the primary and the ball/chamfer — the card's
   * "vendor + 1" budget. Absent → no cap; a chain past it is simply not generated.
   */
  maxCutters?: number;
  /**
   * #961 — THE SIMULATED OUTCOME (the maintainer's 11-05 ruling): for a candidate's PLANNED steps,
   * the goal cells its own sweep leaves above the band, and the covered cells they were counted
   * over. The caller owns the goal heightfield and the stamp; fewer leftover cells is better and
   * is the rank's first key. Absent → the old pocket-count (`leftBehind`) first key, unchanged.
   */
  coverage?: (steps: readonly SequenceStep[]) => {
    leftoverCells: number;
    coveredCells: number;
    /** The goal field's own cell area, mm² — the unit the rest price is stated in. */
    cellAreaMm2: number;
    /** planner v3 A1b — cells standing above the shop's tall height; absent counts as 0. */
    tallCells?: number;
    /**
     * #1252 — cells the chain's own stamp leaves BELOW the goal by more than the shop's
     * `plan.cutIntoFloorMm`: a predicted cut into the part. The rank's first key after
     * eligibility; absent counts as 0 (a caller that states no figure cannot claim a cut-in).
     */
    cutIntoCells?: number;
  } | null;
  /**
   * #1038 — a tick at every CANDIDATE's boundary, once before its chain is priced and its outcome
   * simulated. The simulated outcome can be seconds per candidate and a plan is minutes; between
   * the plan's stage reports the run's silence watchdog hears nothing. One callback per candidate
   * costs nothing measurable (no per-cell hooks).
   */
  onCandidate?: (index: number, total: number) => void;
  /**
   * #1038 — THE STOP THE CALLER ALREADY HOLDS, checked once per candidate boundary: the plan is
   * one synchronous call, and without this a stop raised mid-plan waits for the next stage line
   * (429 s on the tray). Checked before the tick, so an aborted plan emits no further report.
   */
  signal?: AbortSignal;
}

/** #1038 — an abort crossed a catch that states step failures: it is the CALLER's stop, not a
 *  failure of the step, so it must keep travelling. */
export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/**
 * #961 — THE COVERAGE REST'S PRICE (the manager's 11-05 follow-up): a coverage rest earns its
 * place only when the surface it recovers pays for the #927 time it adds, measured against the
 * chain without it. The unit is mm² of goal surface brought back inside the 0.1 mm band per
 * second of added cycle.
 *
 * The threshold: **0.01 mm²/s** — one hundredth of a square millimetre of recovered top surface
 * per second of added cutting, i.e. 36 mm² per added hour. The tray's ⌀3.175 rest clears it by
 * ~20× (215.8 mm² for 1,097.5 s = 0.197 mm²/s — the item that made the tray's 99.34 %; it was
 * 0.049 mm²/s before the rest became a floor-level pass, still 4.9× over); a rest that shaves one
 * cell off a chain (0.01 mm² for the 100 s a small flat's extra pass costs, 0.0001 mm²/s) misses
 * it by a hundredfold. Below this line the rest is floor-polishing, not coverage.
 */
export const COVERAGE_REST_MIN_MM2_PER_SECOND = 0.01;

/** One candidate the search looked at: its steps, its price or null, and why it did not win. */
export interface ConsideredSequence {
  steps: { kind: PlannedOpKind; cutterKey: string }[];
  /** The candidate's priced total, s: `estimateSeconds + toolChanges × toolChangeSeconds`. */
  cost: number | null;
  /**
   * #961 acceptance (the maintainer's 11-05 review) — #927's own estimate on this candidate's
   * posted moves, s, so a card can print the estimate BESIDE the total instead of only the price.
   * Null when the candidate could not be priced.
   */
  estimateSeconds: number | null;
  /** Changes charged to this candidate: one for each cutter after the first (a return included). */
  toolChanges: number | null;
  /** How many demanded pockets this candidate left uncut, including the part's own unreachable ones. */
  unreachable: number;
  /**
   * Its rank among the priced candidates (1 = the choice): the simulated outcome (when the caller
   * supplied a goal), then pockets left behind, failures, house/rowed, price.
   */
  rank: number | null;
  /** Steps on a catalogue cutter / on the labelled feed fallback — the two preferences the rank reads. */
  catalogueSteps: number;
  fallbackSteps: number;
  /**
   * #961 — the simulated outcome: the goal cells this candidate's own sweep leaves above the band
   * (`leftoverCells`) over the cells it covered (`coveredCells`). The rank's FIRST key. Null when
   * the caller supplied no goal or the candidate could not be priced.
   */
  leftoverCells: number | null;
  coveredCells: number | null;
  /**
   * #961 — the price of this candidate's coverage rests, against the best chain WITHOUT one: the
   * surface (mm²) it buys back, the #927 seconds it adds, and the rate between them. Null when the
   * candidate carries no coverage rest, or either side could not be simulated. A rate below
   * {@link COVERAGE_REST_MIN_MM2_PER_SECOND} demotes the whole candidate below every chain that
   * clears the line (`rank` order), whatever its leftover count.
   */
  restPrice: { gainMm2: number; seconds: number; mm2PerSecond: number } | null;
  /** Of those, how many a cutter in the set could have covered — what the rank compares. */
  leftBehind: number;
  /** Steps the ops could not plan (their regions are stated unreachable by the chosen chain). */
  unplanned: number;
  reason: string;
}

/**
 * ONE STEP THE OPS COULD NOT PLAN (#960). A planStep that returns null or throws cuts nothing for
 * its regions. The candidate still prices what it DID cut; these regions are stated unreachable
 * with this reason, so a plan never silently loses part of the part. Only the PRIMARY step's
 * failure disqualifies a candidate (nothing is planned at all).
 */
export interface SequenceStepFailure {
  kind: PlannedOpKind;
  cutterKey: string;
  regionIds: string[];
  reason: string;
}

/** A candidate's price plus the steps that could not be planned (none when it all planned). */
export interface PricedSequence {
  cost: SequenceCost;
  /** The steps the ops DID plan, in execution order — what the caller posts. */
  steps: SequenceStep[];
  failures: SequenceStepFailure[];
}

/** What the picker returns: the chosen steps, their price, and the field they beat. */
export interface SequenceChoice {
  steps: SequenceStep[];
  cost: SequenceCost;
  considered: ConsideredSequence[];
  /** The chosen chain's uncovered pockets, by feature id; empty when every pocket is covered. */
  unreachable: string[];
  /**
   * The demand's freeing contour (its own step, always LAST), when the chain posts one: which
   * cutter takes it, whether that costs a RETURN tool change after the last pocket/rest step, and
   * whether the chain's last cutter could have taken the profile at all. The plan's note states
   * which way the pick fell. Null when no freeing step is planned — including when the contour's
   * own step failed (it is then in `unplanned`).
   */
  freeing: { cutterKey: string; extraToolChange: boolean; lastCutterEligible: boolean } | null;
  /**
   * #960 — steps the chosen chain's ops could not plan, in step order, each with its regions and
   * the reason. Their regions are folded into `unreachable` too, so a caller that only reads that
   * list still sees them; this list carries the WHY (a thrown op's message, or that it planned
   * nothing). Empty when every step planned.
   */
  unplanned: SequenceStepFailure[];
  /**
   * #1114 — the row a PRIMARY pick among same-diameter cutters states: two chains tied through
   * every priced key, and `pickAmongEquals` decided (the reach-margin gate, the shortest
   * sufficient flute, or the key). The row names the decider; no policy is pending.
   */
  pickNote?: string | null;
  /**
   * planner v3 A1 — set only when the leftover tolerance changed the pick: the chosen chain is
   * not the least-leftover chain. Cells and seconds are the picker's own numbers.
   */
  leftoverTolerance?: { tolerancePct: number; chosenLeftoverCells: number; bestLeftoverCells: number; cellAreaMm2: number; savedSeconds: number };
  /**
   * #1232 (planner v3 A6) — set only when the TALL rule kept a slower set: the fastest set that
   * was passed over left this many more tall cells, and was this many seconds faster. The sheet
   * states it so a longer job has a reason on it.
   */
  tallGuard?: { extraTallCells: number; cellAreaMm2: number; givenUpSeconds: number };
  /**
   * #1252 — set only when the CHOSEN chain's stamp leaves cells more than the shop's
   * `plan.cutIntoFloorMm` below the goal (every candidate cut in, so the least was chosen): the
   * count and the goal field's cell area, for the sheet's own sentence. Absent when the chosen
   * chain is clean — the normal case — or has no coverage figure.
   */
  cutInto?: { cells: number; cellAreaMm2: number };
}

const EPS = 1e-9;

/** A stable key for a cutter: its record id, else its name. Also what `pinned` matches. */
export function cutterKeyOf(tool: Tool): string {
  return tool.id ?? tool.name;
}

function diameterOf(tool: Tool): number | null {
  const d = cuttingDiameter(tool);
  return d !== null && d > 0 ? d : null;
}

function isFlat(tool: Tool): boolean {
  return tool.shape === 'flat';
}

function isBall(tool: Tool): boolean {
  return tool.shape === 'ball' || tool.shape === 'tapered-ball';
}

function isChamfer(tool: Tool): boolean {
  return (tool.shape === 'chamfer' || tool.shape === 'engraving')
    && (tool.angle !== null || tool.halfAngle !== null);
}

/** Why a cutter is too short to reach the features' floors, or null when it reaches them. */
function depthRefusal(tool: Tool, features: readonly SequenceFeature[]): string | null {
  if (diameterOf(tool) === null) return 'it states no cutting diameter';
  for (const feature of features) {
    if (feature.depthMm > 0 && tool.fluteLength !== null && tool.fluteLength + EPS < feature.depthMm) {
      return `its ${tool.fluteLength} mm flute cannot reach the ${feature.depthMm} mm floor`;
    }
  }
  return null;
}

function ballRefusal(tool: Tool, features: readonly SequenceFeature[]): string | null {
  const d = diameterOf(tool);
  if (d === null) return 'it states no cutting diameter';
  const radius = d / 2;
  for (const feature of features) {
    if (feature.curvatureRadiusMm !== null && feature.curvatureRadiusMm !== undefined
        && radius > feature.curvatureRadiusMm + EPS) {
      return `⌀${d} cannot follow a ${feature.curvatureRadiusMm} mm concave radius`;
    }
  }
  return depthRefusal(tool, features);
}

function chamferRefusal(tool: Tool): string | null {
  const d = diameterOf(tool);
  if (d === null) return 'it states no cutting diameter';
  if (tool.angle === null && tool.halfAngle === null) return 'it states no included angle';
  return null;
}

interface CandidateCutter {
  tool: Tool;
  house: boolean;
  feeds: 'row' | 'fallback';
  key: string;
}

function allCutters(
  candidates: CutterCandidates,
  opts: Pick<SequenceOptions, 'feedsKind'> | undefined,
): CandidateCutter[] {
  const feedsKind = opts?.feedsKind ?? (() => 'row' as const);
  const list: CandidateCutter[] = [];
  for (const [tools, house] of [[candidates.house, true], [candidates.catalogue, false]] as const) {
    for (const tool of tools) {
      list.push({ tool, house, feeds: feedsKind(tool), key: cutterKeyOf(tool) });
    }
  }
  return list;
}

function choiceOf(cutter: CandidateCutter, pinned: boolean): CutterChoice {
  return {
    key: cutter.key,
    tool: cutter.tool,
    house: cutter.house,
    pinned,
    feeds: cutter.feeds,
  };
}

/**
 * True when every pinned kind this candidate covers carries the pinned cutter. A kind may appear
 * on more than one step (a rest chain): the pinned key must be one of them, and only that step is
 * labelled pinned; the others are the engine's own choice.
 */
function honoursPins(steps: readonly SequenceStep[], pinned: Partial<Record<PlannedOpKind, string>>): boolean {
  for (const kind of Object.keys(pinned) as PlannedOpKind[]) {
    const key = pinned[kind]!;
    if (!steps.some((s) => s.kind === kind && s.cutter.key === key)) return false;
  }
  return true;
}

/** Whether a flat can enter a feature's opening. */
function entersFeature(tool: Tool, f: SequenceFeature): boolean {
  const d = diameterOf(tool);
  if (d === null) return false;
  return !(f.minOpeningMm !== null && f.minOpeningMm !== undefined && d > f.minOpeningMm + EPS);
}

/** Whether a cutter's flute reaches a feature's floor. */
function reachesFeature(tool: Tool, f: SequenceFeature): boolean {
  if (diameterOf(tool) === null) return false;
  return !(f.depthMm > 0 && tool.fluteLength !== null && tool.fluteLength + EPS < f.depthMm);
}

/**
 * #1195 — THE FREEING CUT'S STATED-REACH RULE. `reachesFeature` lets an UNSTATED flute "reach" a
 * floor, because for a pocket unknown is not excluded and the op states the risk. The freeing
 * contour must be decided on stated numbers only: an unstated or short flute cannot take it.
 */
function reachesContour(tool: Tool, f: SequenceFeature): boolean {
  if (!(f.depthMm > 0)) return true;
  return tool.fluteLength !== null && tool.fluteLength + EPS >= f.depthMm;
}

/** Whether a flat's radius fits a feature's tightest inside corner. */
function fitsCorner(tool: Tool, f: SequenceFeature): boolean {
  const d = diameterOf(tool);
  if (d === null) return false;
  return !(f.cornerRadiusMm !== null && f.cornerRadiusMm !== undefined && d / 2 > f.cornerRadiusMm + EPS);
}

/** A flat covers a pocket when it enters it, reaches its floor and fits its corner. */
function coversFeature(tool: Tool, f: SequenceFeature): boolean {
  return entersFeature(tool, f) && reachesFeature(tool, f) && fitsCorner(tool, f);
}

/** One link of a rest chain: a cutter and the pockets it is needed for. */
interface ChainLink {
  cutter: CandidateCutter;
  regionIds: string[];
  /** #961 — a coverage rest (see `SequenceStep.coverageRest`): optional, priced against the line. */
  coverage?: true;
}

/**
 * The candidates worth pricing — the vendor shape with a REST CHAIN (B's #961 tray demand).
 *
 * The largest flat that can rough the part starts; each next smaller flat is added ONLY when it
 * covers a pocket the chain so far cannot (its opening, floor or inside corner — the op's "needs a
 * cutter ≤ N mm" report), and it is added while the budget allows. EVERY prefix is a candidate, so
 * one more cutter has to earn its change on price; a pocket no flat in the candidate set can cover
 * is STATED in `unreachable` and never shrinks the primary (E measured the vendor leaving the
 * tray's ~1 mm features: only the chamfer tip reaches them). Such a pocket is the part's own
 * limitation, so it does not count as this chain's incompleteness (`leftBehind`): the tie it used
 * to create made every candidate equal and price chose the primary alone over a cuttable rest.
 *
 * Every candidate is crossed with each usable ball (when the part is curved), each usable chamfer
 * (when it has rims) and the freeing-step cutter choices (the covering chain link, or the chain's
 * last link when it can take the profile), and pruned on geometry alone before any IR is built.
 */
export function candidateSequences(
  demand: SequenceDemand,
  cutters: CutterCandidates,
  opts?: Pick<SequenceOptions, 'feedsKind' | 'maxCutters' | 'allowPrimary'>,
): CandidateSequence[] {
  const features = demand.features;
  // The part's freeing cut (the outer contour) is NOT a pocket and is not folded into a pocket
  // step: it is posted LAST, after every rough/rest/finish/chamfer, so the part stays held
  // through all of them (#959 ruling). It gets its own final step, and its cutter is a choice
  // this module prices — see the free-step construction below.
  const contourFeatures = features.filter((f) => f.kind === 'contour');
  const pocketFeatures = features.filter((f) => f.kind === 'pocket');
  const curvedFeatures = features.filter((f) => f.kind === 'curved');
  const rimFeatures = features.filter((f) => f.kind === 'rim');
  const pinned = cutters.pinned ?? {};
  const maxCutters = opts?.maxCutters ?? Number.POSITIVE_INFINITY;

  const all = allCutters(cutters, opts);
  const flatsDesc = all
    .filter((c) => isFlat(c.tool) && diameterOf(c.tool) !== null)
    .sort((a, b) => (diameterOf(b.tool) ?? 0) - (diameterOf(a.tool) ?? 0));
  const ballsAll = all.filter((c) => isBall(c.tool));
  const balls = ballsAll.filter((c) => ballRefusal(c.tool, curvedFeatures) === null);
  const chamfers = all.filter((c) => isChamfer(c.tool) && chamferRefusal(c.tool) === null);

  // #1019 — THE POCKET POOL, PARTITIONED BY ENTERABILITY BEFORE THE SEARCH. A pocket no cutter in
  // the set can ENTER (`entersFeature`: its opening is narrower than every round cutter's
  // diameter) is not something the primary can rough, and it must not take every candidate down
  // with it: the search runs on the enterable pockets, and each un-enterable one is stated by its
  // own number. The line-902 refusal stays for a demand a cutter could enter but none can reach
  // or fit.
  const roundPool = [...flatsDesc, ...ballsAll];
  const entersSome = (f: SequenceFeature): boolean => roundPool.some((c) => entersFeature(c.tool, f));
  const searchPockets = pocketFeatures.filter(entersSome);
  const unenterablePockets = pocketFeatures.filter((f) => !entersSome(f));
  const cutterWords = roundPool.map((c) => `⌀${diameterOf(c.tool)} ${isFlat(c.tool) ? 'flat' : 'ball'}`).join(', ');
  const unenterable = unenterablePockets.map((f) =>
    f.minOpeningMm === null || f.minOpeningMm === undefined
      ? `${f.id}: not cut — no cutter in the set can enter it`
      : `${f.id}: not cut — ${f.minOpeningMm.toFixed(3)} mm opening, narrower than every cutter in the set (${cutterWords}) — left standing`,
  );
  // A primary must reach the curved remainder's floors and, when the part has pockets, rough at
  // least one of them. A flat that fits no pocket is not a primary: the chain never shrinks the
  // primary to a feature — it adds a smaller cutter for what the primary cannot reach.
  const reachesCurved = (c: CandidateCutter): boolean => curvedFeatures.every((f) => reachesFeature(c.tool, f));
  const canRoughPocket = (c: CandidateCutter): boolean =>
    searchPockets.some((f) => entersFeature(c.tool, f) && reachesFeature(c.tool, f));
  // A primary must have SOMETHING to cut: a pocket it can rough, or the freeing profile. A part
  // whose only pocket is too narrow for every flat still needs its contour cut (the pocket is
  // stated, not silently dropped) — before the contour had its own step this was satisfied by the
  // contour being one of the "pocket" features; now it is said explicitly.
  const canCutSomething = (c: CandidateCutter): boolean =>
    canRoughPocket(c)
    // #1195 — geometry only HERE: a primary may still be proposed for a contour it cannot PROVE
    // it frees; such a chain posts no freeing step, is stated with the contour unreachable, and
    // loses the rank's completeness key to a chain that frees. Refusing the plan outright would
    // hide the pocket work the cutter CAN do (and turned 31 fixture files red on the guard alone).
    || contourFeatures.some((f) => coversFeature(c.tool, f))
    || (searchPockets.length === 0 && contourFeatures.length === 0);
  // #1186 — EVERY FLAT THAT CAN ROUGH THE PART IS PROPOSED. "The largest flat is the one primary"
  // (#961) was an ORDERING rule, and it assumed the largest is also the fastest: on a borrowed feed
  // row it is not (the m1 tray: ⌀6 on the 3.2 mm row at F400/0.5 mm against ⌀3.175 at F1000/1.0).
  // Rule 1 of #1186's fields: an ordering rule may only PROPOSE candidates; the priced total
  // decides. The chains are still complete-part chains — a smaller primary keeps its rest/contour
  // steps, and `leftBehind` still ranks an uncut feature above price — so proposing them cannot
  // silently shrink the job; it can only let a cheaper complete chain win, which is the point.
  // #1192 rule 3 (the morning minimum) — only the shortlisted flats may PRIMARY; a flat off the
  // list keeps its rest/finish roles through `flatsDesc` below, never a program of its own.
  const mayPrimary = (c: CandidateCutter): boolean => opts?.allowPrimary === undefined || opts.allowPrimary(c.key);
  // #1192/#1195 — THE SHORTLIST MAY NARROW THE PICK, NEVER EMPTY IT. Its two names are the
  // incumbent (the largest flat) and the best own-row flat; on a part whose only capable flat is
  // neither (a V-floor pocket only a ⌀0.6 flat enters, against a larger flat that cannot enter it)
  // filtering by name left NO primary and refused a plan the engine could make. The screen applies
  // only while it leaves at least one flat that can actually cut something.
  const eligiblePrimaries = flatsDesc.filter((c) => reachesCurved(c) && canCutSomething(c));
  const shortlisted = eligiblePrimaries.filter(mayPrimary);
  const chosenPrimaries = shortlisted.length > 0 ? shortlisted : eligiblePrimaries;
  // #1195 — THE SHORTLIST MAY NOT STARVE THE FREEING CONSTRAINT. Set B's shortlist picked the
  // ⌀3.175 ×25 by price, and only the ×42 proves the 25.3 mm profile: with the ×42 off the
  // shortlist, every chain was excluded and the plan refused on a part main freed. When none of
  // the shortlisted cutters can free the profile, the eligible cutters that CAN join them.
  const canFree = (c: CandidateCutter): boolean =>
    contourFeatures.every((f) => coversFeature(c.tool, f) && reachesContour(c.tool, f));
  const freed = contourFeatures.some((f) => (f.depthMm ?? 0) > 0);
  const primaries = freed && !chosenPrimaries.some(canFree)
    ? [...chosenPrimaries, ...eligiblePrimaries.filter((c) => canFree(c) && !chosenPrimaries.includes(c))]
    : chosenPrimaries;
  // A part with pockets needs SOME round tool; a ball is the fallback only when no flat can.
  // #1192/#1195 — THE BALL FALLBACK IS NOT THE SHORTLIST'S. The shortlist is a rule about FLATS
  // (the incumbent and the best own-row flat); the fallback exists precisely for the demand NO
  // flat can cut, so gating it by a list of flats emptied the candidate set and refused plans the
  // engine could plan (a V-floor part whose only cutter is the ball: "no cutter sequence").
  const roughs: CandidateCutter[] = primaries.length > 0
    ? primaries
    : ballsAll.filter((c) => reachesCurved(c) && canCutSomething(c));
  if (curvedFeatures.length > 0 && balls.length === 0) { return []; }
  if (rimFeatures.length > 0 && chamfers.length === 0) { return []; }
  // #1019 — a demand whose pockets are ALL un-enterable, with no contour to cut, is trivially
  // satisfied the way #987 treats an empty demand: nothing for the pocket chain, every pocket
  // stated by its own number. It is NOT the line-902 refusal, which is reserved for a demand a
  // cutter could enter but none can reach or fit.
  if (roundPool.length > 0 && pocketFeatures.length > 0 && searchPockets.length === 0 && contourFeatures.length === 0) {
    // #1019 review (finding 3) — the sentence IS the entry: no bare id beside it (the plan reads
    // the id off the sentence), so the operator sees one line per pocket, never two.
    return [{ steps: [], unreachable: [...unenterable], leftBehind: 0 }];
  }
  if (searchPockets.length > 0 && roughs.length === 0) { return []; }

  const ballChoices: (CandidateCutter | null)[] = curvedFeatures.length > 0 ? balls : [null];
  const chamferChoices: (CandidateCutter | null)[] = rimFeatures.length > 0 ? chamfers : [null];

  // Candidates are built with the features each one COVERS; `leftBehind` is filled in after the
  // search, against what ANY candidate can cover. A feature no candidate reaches is the part's
  // own limitation (the organizer's 16 sub-3.175 holes) and must not count against a chain —
  // every chain carries it, so counting it made completeness a tie every time.
  interface Built {
    steps: SequenceStep[];
    unreachable: string[];
    covered: Set<string>;
  }
  const out: Built[] = [];
  const seen = new Set<string>();
  const add = (steps: SequenceStep[], unreachable: string[], covered: Set<string>): void => {
    if (steps.length === 0 || !honoursPins(steps, pinned)) return;
    const signature = steps.map((s) => `${s.kind}:${s.cutter.key}`).join('+');
    if (seen.has(signature)) return;
    seen.add(signature);
    // #1019 review (finding 3) — an un-enterable pocket is stated by its own sentence ONLY: its
    // bare id is dropped here (it would add the legacy "needs a cutter" line beside the sentence),
    // the V-floor walk reads the id off the sentence.
    const unenterableIds = new Set(unenterablePockets.map((f) => f.id));
    out.push({ steps, unreachable: [...unreachable.filter((id) => !unenterableIds.has(id)), ...unenterable], covered });
  };

  /** The chain from one primary: each link names the pockets that cutter is needed for. */
  const chainFrom = (primary: CandidateCutter): ChainLink[] => {
    const chain: ChainLink[] = [];
    const covered = new Set<string>();
    const addLink = (cutter: CandidateCutter): void => {
      const regionIds: string[] = [];
      for (const f of pocketFeatures) {
        if (covered.has(f.id)) continue;
        if (coversFeature(cutter.tool, f)) {
          covered.add(f.id);
          regionIds.push(f.id);
        }
      }
      // The primary also names the pockets it can ROUGH even where its corner leaves a rest —
      // the rest step names the same pocket again for the corner, and the ops union.
      if (chain.length === 0) {
        for (const f of searchPockets) {
          if (!regionIds.includes(f.id) && entersFeature(cutter.tool, f) && reachesFeature(cutter.tool, f)) {
            regionIds.push(f.id);
          }
        }
      }
      chain.push({ cutter, regionIds });
    };
    addLink(primary);
    let last = diameterOf(primary.tool) ?? 0;
    while (chain.length < maxCutters) {
      const next = flatsDesc.find((c) => {
        const d = diameterOf(c.tool) ?? 0;
        if (!(d < last - EPS)) return false;
        return searchPockets.some((f) => !covered.has(f.id) && coversFeature(c.tool, f));
      });
      if (next === undefined) break;
      addLink(next);
      last = diameterOf(next.tool) ?? 0;
    }
    return chain;
  };

  /**
   * #961/#975 — THE COVERAGE RESTS, ONE CANDIDATE EACH. A smaller flat whose pocket the primary
   * already enters earns no geometric link, but its tighter step-over can still buy back surface
   * the primary's passes left above the band (the tray's 2 mm crest between the scoop halves,
   * #959). It is an ALTERNATIVE to the geometric chain, never a tail appended to it: appending
   * made the list depend on the size order — with a ⌀1 in the set the ⌀3.175 fell after a bigger
   * last link and lost its link entirely, so adding a bit REPLACED a rest choice and the ideal
   * plan could read worse than the owned one (the tray's 98.38 % against 99.34 %, #975 review).
   * Each eligible flat now gets its own variant, so adding a cutter adds a candidate and never
   * removes one.
   */
  const coverageRestChains = (primary: CandidateCutter, geometric: ChainLink[]): ChainLink[][] => {
    const primaryD = diameterOf(primary.tool) ?? 0;
    const out: ChainLink[][] = [];
    for (const c of flatsDesc) {
      const d = diameterOf(c.tool) ?? 0;
      if (!(d < primaryD - EPS)) continue;
      if (geometric.some((link) => link.cutter.key === c.key)) continue;
      const regionIds = searchPockets.filter((f) => coversFeature(c.tool, f)).map((f) => f.id);
      if (regionIds.length === 0) continue;
      if (geometric.length + 1 > maxCutters) continue;
      out.push([...geometric, { cutter: c, regionIds, coverage: true }]);
    }
    return out;
  };

  // The freeing step's cutter is a CHAIN cutter, never a new one: the chain was sized for the
  // pockets. Both links that can take it — the cover link (the first chain cutter that covers the
  // profile, usually the primary) and the chain's LAST cutter (so no return change) — need the
  // same two clauses: the geometry a pocket gets (floor reach, stated opening and corner) AND a
  // STATED flute at least as long as the profile's floor. An unstated flute is unknown, and the
  // freeing cut is the one cut that must not be guessed (a cutter one flute-length short would
  // rub its shank through the part on the last pass). `coversFeature` deliberately lets an
  // unstated flute "reach" a pocket floor — right for a pocket, wrong here.
  const coversContour = (c: CandidateCutter): boolean =>
    contourFeatures.every((f) => coversFeature(c.tool, f) && reachesContour(c.tool, f));
  // #1195 — the cover link used to check GEOMETRY ONLY, so a chain whose primary's flute fell
  // short of the profile handed the freeing cut to the first link `coversFeature` accepted — an
  // unstated-flute rest bit. On Set B top (1186-planner-time @ 079d3f75c, 2026-11-10) that posted
  // a 1 h 51 min contour for a 25.3 mm profile on the ⌀0.9 PCB router bit. Both links now share
  // the one rule; a chain with no stated-reaching cutter posts NO freeing step, is STATED with
  // the contour unreachable, and loses the rank's completeness key to a chain that frees.
  const canFreeLast = coversContour;

  for (const primary of roughs) {
    const geometric = chainFrom(primary);
    for (const chain of [geometric, ...coverageRestChains(primary, geometric)]) {
    const primaryLink = chain[0]!;
    for (let k = 1; k <= chain.length; k++) {
      const links = chain.slice(0, k);
      const base: SequenceStep[] = [];
      if (primaryLink.regionIds.length > 0) {
        base.push({
          kind: 'pocket',
          role: 'flat',
          cutter: choiceOf(primaryLink.cutter, pinned.pocket === primaryLink.cutter.key),
          regionIds: primaryLink.regionIds,
        });
      }
      if (curvedFeatures.length > 0) {
        base.push({
          kind: 'rough',
          role: 'flat',
          cutter: choiceOf(primaryLink.cutter, pinned.rough === primaryLink.cutter.key),
          regionIds: curvedFeatures.map((f) => f.id),
        });
      }
      for (const link of links.slice(1)) {
        base.push({
          kind: 'rest',
          role: 'rest',
          cutter: choiceOf(link.cutter, pinned.rest === link.cutter.key),
          regionIds: link.regionIds,
          // #961 — a coverage rest is OPTIONAL (the primary already covers the pocket); the rank
          // prices it against the chain without it. A geometric rest carries no marker.
          ...(link.coverage === true ? { coverageRest: true as const } : {}),
        });
      }
      // The pockets this prefix covers; the rest are STATED for this candidate.
      const coveredNow = new Set<string>();
      for (const link of links) {
        for (const f of searchPockets) if (coversFeature(link.cutter.tool, f)) coveredNow.add(f.id);
      }
      // Every demanded pocket the chain does not cover is listed by id — the un-enterable ones
      // INCLUDED: the plan's V-floor run walks `unreachable`'s ids to find pockets a V can still
      // floor-cut (a mould's cavity has no V, the tray's 0.9 mm slots do), and a sentence would
      // hide them from it. The sentences ride beside the ids for the operator's statement.
      const unreachablePockets = pocketFeatures.filter((f) => !coveredNow.has(f.id)).map((f) => f.id);
      // The freeing cut, posted LAST. Its cutter is the first chain link that covers the profile
      // (the largest — usually the primary; coming back to it after the rests costs a RETURN tool
      // change, which `priceSequence` now charges), or the chain's last cutter when it can take
      // the profile (it is already loaded, so no return). Both are offered and the cheaper wins.
      const lastLink = links[links.length - 1]!;
      const freeLinks: ChainLink[] = [];
      const coverLink = links.find((l) => coversContour(l.cutter));
      if (coverLink !== undefined) {
        freeLinks.push(coverLink);
        if (lastLink !== coverLink && canFreeLast(lastLink.cutter)) freeLinks.push(lastLink);
      }
      // #1195 (the analyst's field, 6784826782) — THE FREEING REACH IS A HARD CONSTRAINT ON THE
      // PICK: a chain with no cutter whose STATED flute reaches the profile (plus the cut-through)
      // is not a candidate at all, not merely out-ranked. It is #1114's "sufficient" applied to
      // the freeing cut. The refusal below is the last line of defence, for when NO owned cutter
      // reaches or the operator pinned one that does not.
      if (contourFeatures.length > 0 && freeLinks.length === 0) continue;
      const freeChoices: (ChainLink | null)[] = contourFeatures.length === 0 ? [null] : freeLinks;
      for (const ball of ballChoices) {
        for (const chamfer of chamferChoices) {
          for (const free of freeChoices) {
            const ballStep: SequenceStep | null = ball === null ? null : {
              kind: 'finish',
              role: 'ball',
              cutter: choiceOf(ball, pinned.finish === ball.key),
              regionIds: curvedFeatures.map((f) => f.id),
            };
            const chamferStep: SequenceStep | null = chamfer === null ? null : {
              kind: 'chamfer',
              role: 'chamfer',
              cutter: choiceOf(chamfer, pinned.chamfer === chamfer.key),
              regionIds: rimFeatures.map((f) => f.id),
            };
            const contourStep: SequenceStep | null = free === null ? null : {
              kind: 'contour',
              role: 'flat',
              cutter: choiceOf(free.cutter, pinned.contour === free.cutter.key),
              regionIds: contourFeatures.map((f) => f.id),
            };
            // #1114 — ORDERING IS PRICED WORK. The ball finish and the rim chamfer are independent
            // (different regions, no prefix dependence); both orders are offered when both exist,
            // and the priced rank decides which one changes bits after the shorter program. The
            // freeing contour stays LAST in either order (the part must be held throughout).
            const orders: (SequenceStep | null)[][] = ballStep !== null && chamferStep !== null
              ? [[ballStep, chamferStep], [chamferStep, ballStep]]
              : [[ballStep, chamferStep]];
            for (const order of orders) {
              const steps = [...base, ...order.filter((s): s is SequenceStep => s !== null)];
              if (contourStep !== null) steps.push(contourStep);
              const unreachable = free !== null || contourFeatures.length === 0
                ? unreachablePockets
                : [...unreachablePockets, ...contourFeatures.map((f) => f.id)];
              const covered = new Set(coveredNow);
              if (free !== null) for (const f of contourFeatures) covered.add(f.id);
              add(steps, unreachable, covered);
            }
          }
        }
      }
    }
    }
  }

  // Completeness against what the search could actually cover: a feature no candidate reaches is
  // the part's own limitation, not this chain's — see the `Built` note above.
  const coverableAny = new Set<string>();
  for (const candidate of out) for (const id of candidate.covered) coverableAny.add(id);
  return out.map((candidate) => ({
    steps: candidate.steps,
    unreachable: candidate.unreachable,
    leftBehind: candidate.unreachable.filter((id) => coverableAny.has(id)).length,
  }));
}

/**
 * Price one candidate by #927's terms on its posted moves + the shop's allowance per change.
 *
 * #960 — A STEP THAT CANNOT PLAN DOES NOT KILL THE CANDIDATE (B's per-region catch in `plan.ts`,
 * carried into the price). The ops can refuse a step the geometry prune let through — today
 * `rough()` on a curved remainder — by returning null or throwing. Only the PRIMARY step's
 * failure disqualifies the candidate (it is the roughing; nothing is planned without it). Any
 * later failed step plans nothing for its regions: they are recorded with the reason, the
 * candidate is priced on what it DID cut, and the caller states them unreachable.
 *
 * A change is charged when the step's cutter DIFFERS from the previous PLANNED step's: the first
 * step's cutter is loaded, and a cutter that comes BACK after another ran (the deferred freeing
 * contour returning to the primary, when the chain chose that) costs a second change to load it
 * again. Counting one change per cutter key — the older model — under-priced exactly that return.
 *
 * #1114 — AND THE CHANGE IS PRICED FROM THE PROGRAM BEFORE IT. Consecutive steps on one cutter
 * post as ONE program; the change after them is priced from that program's whole duration (the
 * operator has been standing there for all of it, or has walked away). A step that failed to plan
 * posts nothing, so it neither lengthens the run nor stands before a change.
 */
export function priceSequence(
  sequence: CandidateSequence,
  opts: Pick<SequenceOptions, 'rapid' | 'planStep'> & { bitChange?: BitChangeRule; toolChangeSeconds?: number },
): PricedSequence | null {
  const rule = opts.bitChange ?? flatBitChangeRule(opts.toolChangeSeconds ?? 0);
  const seconds = new Map<string, number>();
  const order: string[] = [];
  const changeCounts = new Map<string, number>();
  const changeSeconds = new Map<string, number>();
  const pricedChanges: PricedChange[] = [];
  const planned: SequenceStep[] = [];
  const failures: SequenceStepFailure[] = [];
  let previous: string | null = null;
  /** The current program's own duration: consecutive steps on `previous`'s cutter. */
  let runSeconds = 0;
  for (let i = 0; i < sequence.steps.length; i++) {
    const step = sequence.steps[i]!;
    let ir: ToolpathIR | null;
    let thrown: string | null = null;
    try {
      ir = opts.planStep(step, planned);
    } catch (e) {
      // #1025 — a metadata contradiction is never a step failure to price around: it refuses the
      // whole plan, here as at every other catch on the planning path (see `planMeta.ts`).
      if (e instanceof PlanMetadataInconsistentError) throw e;
      // #1038 — a stop raised at a boundary hook is not a step failure: it must reach the caller.
      if (isAbortError(e)) throw e;
      ir = null;
      thrown = e instanceof Error ? e.message : String(e);
    }
    if (ir === null) {
      // The first step is the PRIMARY's (its pockets, or the curved remainder when there are no
      // pockets): a candidate that cannot rough anything is not a plan. Later failures are stated.
      if (i === 0) return null;
      failures.push({
        kind: step.kind,
        cutterKey: step.cutter.key,
        regionIds: [...step.regionIds],
        reason: thrown ?? `the ${step.kind} op planned nothing for its regions`,
      });
      continue;
    }
    const key = step.cutter.key;
    const total = estimateCycleTerms(ir, opts.rapid).totalSeconds;
    seconds.set(key, (seconds.get(key) ?? 0) + total);
    if (!order.includes(key)) order.push(key);
    if (previous !== null && previous !== key) {
      // #1114 — the program that just ended is the one the operator was watching; its own
      // duration sets this change's price.
      const priceSeconds = bitChangePriceSeconds(rule, runSeconds);
      changeCounts.set(key, (changeCounts.get(key) ?? 0) + 1);
      changeSeconds.set(key, (changeSeconds.get(key) ?? 0) + priceSeconds);
      pricedChanges.push({ afterCutterKey: previous, beforeCutterKey: key, afterSeconds: runSeconds, priceSeconds });
      runSeconds = 0;
    }
    runSeconds += total;
    previous = key;
    planned.push(step);
  }
  if (order.length === 0) return null;
  const entries: CycleCost[] = order.map((key) => {
    const estimateSeconds = seconds.get(key) ?? 0;
    const toolChanges = changeCounts.get(key) ?? 0;
    const priced = changeSeconds.get(key) ?? 0;
    return {
      cutterKey: key,
      estimateSeconds,
      toolChanges,
      changeSeconds: priced,
      totalSeconds: estimateSeconds + priced,
    };
  });
  const estimateSeconds = entries.reduce((sum, e) => sum + e.estimateSeconds, 0);
  const toolChanges = entries.reduce((sum, e) => sum + e.toolChanges, 0);
  const totalChangeSeconds = entries.reduce((sum, e) => sum + e.changeSeconds, 0);
  return {
    cost: {
      entries,
      estimateSeconds,
      toolChanges,
      changeSeconds: totalChangeSeconds,
      changes: pricedChanges,
      totalSeconds: estimateSeconds + totalChangeSeconds,
    },
    steps: planned,
    failures,
  };
}

/** A feasible candidate with its price and the steps that failed — what the rank compares. */
interface RankedSequence {
  sequence: CandidateSequence;
  /** The steps the ops planned — what the chosen chain posts. */
  steps: SequenceStep[];
  cost: SequenceCost;
  failures: SequenceStepFailure[];
  /** `CandidateSequence.leftBehind` plus the failed POCKET/CONTOUR regions (#960). */
  leftBehind: number;
  /** #961 — the simulated cells left above the band; null when the caller supplied no goal. */
  coverage: number | null;
  /** The goal's covered cell count the caller reported with `coverage`; null with no goal. */
  coveredCells: number | null;
  /** Cells standing more than the shop's tall height above the goal; null with no goal. */
  tallCells: number | null;
  /** #1252 — cells this chain's stamp leaves more than the cut-into floor below the goal; null
   *  with no coverage figure (ranked as 0 for its key). */
  cutIntoCells: number | null;
  /** The goal field's cell area, mm² — with `coverage`, the leftover expressed in mm². */
  cellAreaMm2: number | null;
  /** #961 — what this candidate's coverage rests buy and cost against the chain without them. */
  restPrice: { gainMm2: number; seconds: number; mm2PerSecond: number } | null;
  /** FALSE when a coverage rest fails {@link COVERAGE_REST_MIN_MM2_PER_SECOND}: ranked after every chain that clears it. */
  eligible: boolean;
}

/**
 * The rank: a coverage rest that misses the price line ranks after every chain that clears it;
 * then a chain that cuts into the goal ranks after every chain that does not (#1252); then the
 * SIMULATED leftover, pockets left behind, failed steps, house/rowed, price.
 */
function rankOf(ranked: RankedSequence, leftoverFloor: number | null = null, tallTerm = true): readonly [number, number, number, number, number, number, number, number, number, number, string] {
  // A COMPLETE chain beats an incomplete one first: an uncut pocket is not a cheaper plan, it is a
  // different part. "Complete" means every pocket a cutter in the set COULD cover is covered —
  // `leftBehind`, not `unreachable`, or the pockets no cutter can reach would tie every candidate
  // and price would decide (E's organizer run on ec77465a left 27 cuttable pockets that way).
  // #960 — next, a candidate whose steps ALL planned beats one whose op failed: the failure means
  // features that other candidates cut, left uncut here. Within that, the old order stands (house
  // before catalogue, rowed before fallback, then price).
  const catalogue = ranked.sequence.steps.filter((s) => !s.cutter.house).length;
  const fallback = ranked.sequence.steps.filter((s) => s.cutter.feeds === 'fallback').length;
  const signature = ranked.sequence.steps.map((s) => `${s.kind}:${s.cutter.key}`).join('+');
  // #1114 — THE SAME-DIAMETER DECIDER MUST COME BEFORE THE RAW SIGNATURE. The signature was added
  // (#1186 rule 1) to make equal chains deterministic across house orders, but as the last key it
  // also decided same-diameter ties by KEY — the ⌀3.175 × 22 ball beat the × 10 and the × 25 flat
  // beat the × 12 (lexicographically smaller ids), overriding the stiffest-adequate rule the
  // maintainer ruled on. The flute sum is that rule as a key: identical chains differ only in the
  // tied cutter, so the shorter stated flute sorts first; an unstated flute sorts last, after
  // every stated one (unknown is not preferred).
  const fluteRank = ranked.sequence.steps.reduce(
    (n, s) => n + (s.cutter.tool.fluteLength ?? Number.POSITIVE_INFINITY),
    0,
  );
  // #961 — the maintainer's ruling: completeness is the SURFACE left above the band after the
  // chain (the caller's simulated outcome), not the pocket count. A candidate the caller could
  // not simulate ranks after every simulated one; with no goal at all every key is +∞ and the
  // old order (leftBehind first) stands unchanged.
  // planner v3 A1 + A1b — with the tolerance on: fewer TALL cells always ranks first (the factor
  // makes one tall cell outweigh any leftover count), and a leftover at or under the floor ranks AS
  // the floor. With the tolerance off (`leftoverFloor` null) this is the plain leftover, as before.
  // planner v3 A6 (#1232) — `tallTerm = false` is the rank #1217 had before A1b: the same floor,
  // the same keys, the tall term ignored. It is used ONLY to ask what the pick would have been
  // without the tall rule; the real sort always passes the default.
  const floored =
    ranked.coverage === null
      ? Number.POSITIVE_INFINITY
      : leftoverFloor !== null && ranked.coverage <= leftoverFloor
        ? leftoverFloor
        : ranked.coverage;
  const leftover =
    leftoverFloor === null || ranked.coverage === null
      ? floored
      : (tallTerm ? (ranked.tallCells ?? 0) * 2 * ((ranked.coveredCells ?? 0) + 1) : 0) + floored;
  const demoted = ranked.eligible ? 0 : 1;
  // #1252 — A CHAIN THAT CUTS INTO THE GOAL NEVER BEATS ONE THAT DOES NOT. The planner already
  // stamps every candidate against the goal to count leftover and tall cells; the cells its stamp
  // leaves more than `plan.cutIntoFloorMm` BELOW the goal are a predicted cut into the part, and
  // they rank ahead of every other comparison (and after eligibility). A chain with no coverage
  // figure cannot claim a cut-in and is ranked as 0 for this key; a null/positive count is its own
  // key, never folded into the leftover/tall composite.
  // #1186 — ONE CURRENCY FIRST: the priced total (cutting at the feed each cutter really runs +
  // the priced bit changes) ranks BEFORE owned/catalogue and rowed/fallback; those only break a tie,
  // after the change count (#1186 rule 1: ties to fewer bit changes, then to owned).
  return [
    demoted,
    ranked.cutIntoCells ?? 0,
    leftover,
    ranked.leftBehind,
    ranked.failures.length,
    ranked.cost.totalSeconds,
    ranked.cost.toolChanges,
    catalogue,
    fallback,
    // #1114's stiffest-adequate preference, then the raw signature as the last resort.
    fluteRank,
    signature,
  ] as const;
}

/**
 * #1232 (planner v3 A6) — DID THE TALL RULE KEEP A SLOWER SET? The leftover tolerance (#1217)
 * treats sets within a share of each other as equal on leftover and lets time decide; the tall
 * rule (#1224) refuses a faster set that leaves more material standing above the shop's tall
 * limit. When that rule is what kept a slower set, the sheet has had no reason to give.
 *
 * The set that counts is the one the pick WOULD have been with the tall term taken out and
 * everything else the same (`chooseSequence` sorts a copy with `tallTerm = false`); this helper
 * states what that displacement cost, or null when there is nothing to say. A set that is not
 * taller, not faster, or is the chosen set itself was not passed over for tall material.
 */
export interface TallGuardNote {
  /** How many more cells it would leave standing above the tall limit than the chosen set. */
  extraTallCells: number;
  /** How many seconds faster it was. */
  givenUpSeconds: number;
}

export function tallGuardOf(
  chosen: { tallCells: number; totalSeconds: number },
  displaced: { tallCells: number; totalSeconds: number },
): TallGuardNote | null {
  const extraTallCells = displaced.tallCells - chosen.tallCells;
  const givenUpSeconds = Math.round(chosen.totalSeconds - displaced.totalSeconds);
  if (!(extraTallCells > 0) || !(givenUpSeconds > 0)) return null;
  return { extraTallCells, givenUpSeconds };
}

/** The rank WITHOUT the coverage keys — the order the picker used before #961, and the one the
 *  price baseline (the best chain with no coverage rest) is chosen on. */
function priceBaselineRank(ranked: RankedSequence): readonly [number, number, number, number, number, string] {
  const catalogue = ranked.sequence.steps.filter((s) => !s.cutter.house).length;
  const fallback = ranked.sequence.steps.filter((s) => s.cutter.feeds === 'fallback').length;
  const signature = ranked.sequence.steps.map((s) => `${s.kind}:${s.cutter.key}`).join('+');
  return [ranked.leftBehind, ranked.failures.length, catalogue, fallback, ranked.cost.totalSeconds, signature] as const;
}

function comparePriceBaseline(
  a: readonly [number, number, number, number, number, string],
  b: readonly [number, number, number, number, number, string],
): number {
  for (let i = 0; i < 5; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a[5]! < b[5]! ? -1 : a[5]! > b[5]! ? 1 : 0;
}

/**
 * The picker: every pruned candidate priced, then the first by rank — house before catalogue,
 * rowed before fallback, cheapest within the group. A pinned key is a constraint, not a preference
 * (`honoursPins`), so a pinned candidate is the only one of its kind that survives.
 *
 * Throws when nothing can be planned: the caller turns the sentence into its finding. The message
 * names what was missing so a refusal is actionable.
 */
export function chooseSequence(
  demand: SequenceDemand,
  cutters: CutterCandidates,
  opts: SequenceOptions,
): SequenceChoice {
  const candidates = candidateSequences(demand, cutters, opts);
  if (candidates.length === 0) {
    // #1195 (the analyst's field) — THE REFUSAL IS NAMED AND ONLY WHEN IT MUST BE: no owned
    // cutter with a STATED flute reaches the profile, or the operator pinned a cutter that does
    // not. The sentence always carries the way out — the cutters that reach, or the ones whose
    // flute needs stating. A cutter the PLANNER wrote back into the job is not a pin; only
    // `job.sources.tool === 'user'` sets `pinned.contour` (engraveGenerate).
    const contourDepth = demand.features
      .filter((f) => f.kind === 'contour')
      .reduce((m, f) => Math.max(m, f.depthMm ?? 0), 0);
    const depthWords = Number(contourDepth.toFixed(3));
    if (contourDepth > 0) {
      const all = [...cutters.house, ...cutters.catalogue];
      const reaching = all.filter((tool) => tool.fluteLength !== null && tool.fluteLength + 1e-9 >= contourDepth);
      const unstated = all.filter((tool) => tool.fluteLength === null);
      const names = (list: readonly Tool[]): string => list.map((tool) => tool.name || tool.id || 'cutter').join(', ');
      const pinnedContourKey = cutters.pinned?.['contour'];
      const pinnedTool = pinnedContourKey === undefined ? undefined : all.find((tool) => cutterKeyOf(tool) === pinnedContourKey);
      const pinnedReaches = pinnedTool !== undefined
        && pinnedTool.fluteLength !== null
        && pinnedTool.fluteLength + 1e-9 >= contourDepth;
      if (pinnedTool !== undefined && !pinnedReaches) {
        const what = pinnedTool.name || pinnedTool.id || 'the chosen cutter';
        const flute = pinnedTool.fluteLength === null ? 'not stated' : `${pinnedTool.fluteLength} mm`;
        throw new Error(
          `the chosen cutter ${what} cannot free this part: its flute is ${flute} against a ${depthWords} mm profile — `
          + (reaching.length > 0
            ? `${names(reaching)} reaches it; choose that cutter, or state this one's flute length`
            : 'none of your cutters has a stated flute of that length; state a flute length on: ' + (names(unstated) || 'no cutter')),
        );
      }
      if (reaching.length === 0) {
        throw new Error(
          `nothing can free this part: none of your cutters has a stated flute of ${depthWords} mm or more — `
          + 'state a flute length on: ' + (names(unstated) || 'no cutter'),
        );
      }
    }
    throw new Error(
      'no cutter sequence can be planned for this demand: no cutter in the house or catalogue '
      + 'can cut every feature (a flat wide for the tightest corner, a flute short of the deepest '
      + 'floor, or a missing ball/chamfer) — check the cutter set and the pinned keys',
    );
  }

  const priced = candidates.map((sequence, candidateIndex) => {
    opts.signal?.throwIfAborted();
    opts.onCandidate?.(candidateIndex, candidates.length);
    // #1019 — an EMPTY chain is the trivially-satisfied demand (every pocket un-enterable, no
    // contour): it prices at zero so it is feasible and chosen, never ranked as "could not be
    // priced"; nothing is posted for it and its `unreachable` states the pockets.
    if (sequence.steps.length === 0) {
      return {
        sequence,
        priced: { cost: { entries: [], estimateSeconds: 0, toolChanges: 0, changeSeconds: 0, changes: [], totalSeconds: 0 }, steps: [], failures: [] },
        coverage: null,
      };
    }
    const price = priceSequence(sequence, opts);
    // The simulated outcome runs on the PLANNED steps (a failed step posts nothing).
    const coverage = price === null || opts.coverage === undefined ? null : opts.coverage(price.steps);
    return { sequence, priced: price, coverage };
  });
  // planner v3 C1 — trace-only: what the real planner priced, per cutter, for every chain. With
  // no trace file this block does not run.
  if (memTraceEnabled()) {
    for (const p of priced) {
      if (p.priced === null) continue;
      const round = (x: number): number => Math.round(x * 1000) / 1000;
      memTrace('chain:price', {
        signature: p.sequence.steps.map((s) => `${s.kind}:${s.cutter.key}`).join('+'),
        totalSeconds: round(p.priced.cost.totalSeconds),
        // #1252 — the rank's new first key, so the tables can see which chains were passed over
        // for a cut into the part. A chain with no coverage figure ranks as 0 on this key, so the
        // row states the value the rank used.
        cutIntoCells: p.coverage === null ? 0 : (p.coverage.cutIntoCells ?? 0),
        estimateSeconds: round(p.priced.cost.estimateSeconds),
        changeSeconds: round(p.priced.cost.changeSeconds),
        toolChanges: p.priced.cost.toolChanges,
        entries: JSON.stringify(p.priced.cost.entries.map((e) => [e.cutterKey, round(e.estimateSeconds), round(e.changeSeconds)])),
      });
    }
  }
  // No local threshold between the two freeing-cut options: both are priced on the real steps
  // (the return change included) and the cheaper wins. plan v2's 3× stop rule is a package-vs-
  // vendor line on the reference card, not a per-profile gate here.
  const considered: ConsideredSequence[] = priced.map(({ sequence, priced: price, coverage }) => ({
    steps: sequence.steps.map((s) => ({ kind: s.kind, cutterKey: s.cutter.key })),
    leftoverCells: coverage === null ? null : coverage.leftoverCells,
    coveredCells: coverage === null ? null : coverage.coveredCells,
    restPrice: null,
    cost: price === null ? null : price.cost.totalSeconds,
    estimateSeconds: price === null ? null : price.cost.estimateSeconds,
    toolChanges: price === null ? null : price.cost.toolChanges,
    unreachable: sequence.unreachable.length,
    leftBehind: sequence.leftBehind,
    unplanned: price === null ? 0 : price.failures.length,
    // Filled after the rank sort below; null for a candidate that could not be priced at all.
    rank: null,
    catalogueSteps: sequence.steps.filter((s) => !s.cutter.house).length,
    fallbackSteps: sequence.steps.filter((s) => s.cutter.feeds === 'fallback').length,
    reason: price === null
      ? 'the primary step could not be planned'
      : price.failures.length > 0
        ? `${price.failures.length} step${price.failures.length === 1 ? '' : 's'} could not be planned`
        : '',
  }));

  // #960 — A FAILED STEP IS NOT A DISCOUNT. A candidate whose ops could not plan part of the part
  // ranks as if that part were unreachable: its failed POCKET/CONTOUR regions count against
  // `leftBehind` (an uncut cuttable feature), and the failed-step count breaks the next tie before
  // price does — a plan that posts everything another candidate posts, and more, wins even when it
  // is dearer (the same principle as `leftBehind`).
  const demandFeatureIds = new Set(
    demand.features.filter((f) => f.kind === 'pocket' || f.kind === 'contour').map((f) => f.id),
  );
  const feasible: RankedSequence[] = priced
    .filter((p): p is { sequence: CandidateSequence; priced: PricedSequence; coverage: { leftoverCells: number; coveredCells: number; cellAreaMm2: number; tallCells?: number; cutIntoCells?: number } | null } => p.priced !== null)
    .map(({ sequence, priced: price, coverage }) => {
      const failedFeatures = new Set(
        price.failures.flatMap((f) => f.regionIds).filter((id) => demandFeatureIds.has(id)),
      );
      return {
        sequence,
        steps: price.steps,
        cost: price.cost,
        failures: price.failures,
        leftBehind: sequence.leftBehind + failedFeatures.size,
        coverage: coverage === null ? null : coverage.leftoverCells,
        coveredCells: coverage === null ? null : coverage.coveredCells,
        tallCells: coverage === null ? null : (coverage.tallCells ?? 0),
        cutIntoCells: coverage === null ? null : (coverage.cutIntoCells ?? 0),
        cellAreaMm2: coverage === null ? null : coverage.cellAreaMm2,
        restPrice: null,
        eligible: true,
      };
    });

  // #961 — THE COVERAGE REST'S PRICE (the manager's 11-05 follow-up). Every candidate that carries
  // a coverage rest is measured against the best chain WITHOUT one — the chain it would otherwise
  // be choosing between — and only keeps its place when the surface it recovers clears
  // `COVERAGE_REST_MIN_MM2_PER_SECOND`. A rest that misses the line ranks after every chain that
  // clears it, whatever its leftover count: coverage bought at any price is floor-polishing.
  // Without a simulated field on both sides the price cannot be judged and the rest is left to the
  // price order, exactly as before.
  const carriesCoverageRest = (r: RankedSequence): boolean => r.sequence.steps.some((st) => st.coverageRest === true);
  if (feasible.some(carriesCoverageRest)) {
    const baseline = feasible
      .filter((r) => !carriesCoverageRest(r))
      .sort((a, b) => comparePriceBaseline(priceBaselineRank(a), priceBaselineRank(b)))[0];
    if (baseline !== undefined && baseline.coverage !== null) {
      for (const r of feasible) {
        if (!carriesCoverageRest(r)) continue;
        if (r.coverage === null || r.cellAreaMm2 === null) {
          // The caller simulated the baseline but not this candidate: an unjustified rest.
          r.eligible = false;
          continue;
        }
        const gainMm2 = (baseline.coverage - r.coverage) * r.cellAreaMm2;
        const seconds = r.cost.totalSeconds - baseline.cost.totalSeconds;
        const mm2PerSecond = seconds > 0 ? gainMm2 / seconds : Number.POSITIVE_INFINITY;
        r.restPrice = { gainMm2, seconds, mm2PerSecond };
        r.eligible = gainMm2 > 0 && (seconds <= 0 || mm2PerSecond >= COVERAGE_REST_MIN_MM2_PER_SECOND);
      }
    }
  }
  // #1114 — A TIE THROUGH THE PRICED KEYS IS THE PICK'S: the reach-margin gate, then the shortest
  // sufficient flute, then the key (`pickAmongEquals`), before the chain signature's own key order.
  // The rank's keys 0..6 (completeness, coverage, failures, house/rowed, priced cycle) are
  // unchanged; only a tie through all of them reaches the pick.
  const deepestFeatureMm = demand.features.reduce((m, f) => Math.max(m, f.depthMm ?? 0), 0);
  const reachMarginMm = opts.reachMarginMm ?? REACH_MARGIN_FALLBACK_MM;
  const primaryOf = (r: RankedSequence): Tool | undefined => r.sequence.steps[0]?.cutter.tool;
  // planner v3 A1 — the floor, from the eligible chains that have a leftover number.
  const tolerancePct = opts.leftoverEquivalencePct ?? 0;
  const measured = feasible.filter((r) => r.eligible && r.coverage !== null);
  let leftoverFloor: number | null = null;
  let bestLeftover: number | null = null;
  if (tolerancePct > 0 && measured.length > 0) {
    const fewestTall = Math.min(...measured.map((r) => r.tallCells ?? 0));
    const cleanest = measured.filter((r) => (r.tallCells ?? 0) === fewestTall);
    bestLeftover = Math.min(...cleanest.map((r) => r.coverage!));
    const coveredCells = Math.max(...measured.map((r) => r.coveredCells ?? 0));
    leftoverFloor = bestLeftover + (tolerancePct / 100) * coveredCells;
  }
  // planner v3 A6 (#1232) — the comparator takes the floor and whether the tall term is in, so
  // the pick with the tall term OFF (the note's question) is the same keys in the same order.
  const compareRankedWith = (floor: number | null, tallTerm: boolean) =>
    (a: RankedSequence, b: RankedSequence): number => {
      const ra = rankOf(a, floor, tallTerm);
      const rb = rankOf(b, floor, tallTerm);
      // #1252 — keys 0..8 now: eligibility, cut-into, leftover, leftBehind, failures, seconds,
      // changes, catalogue, fallback.
      for (let i = 0; i < 9; i++) {
        if (ra[i]! < rb[i]!) return -1;
        if (ra[i]! > rb[i]!) return 1;
      }
      const ta = primaryOf(a);
      const tb = primaryOf(b);
      if (ta !== undefined && tb !== undefined && cuttingDiameter(ta) === cuttingDiameter(tb)) {
        const picked = pickAmongEquals(
          // The chains' own priced stage time is the pick's last key before the signature.
          pickKeysOf(ta, deepestFeatureMm, a.cost.estimateSeconds),
          pickKeysOf(tb, deepestFeatureMm, b.cost.estimateSeconds),
          reachMarginMm,
        );
        if (picked !== 0) return picked > 0 ? -1 : 1;
      }
      // #1186 — the tuple's tail: the flute rank (index 9), then the signature (index 10). The
      // signature used to sit at 8 and decide same-diameter ties by id before #1114's preference
      // could; the flute rank now takes that place (#1252 moved both one place along).
      if (ra[9]! < rb[9]!) return -1;
      if (ra[9]! > rb[9]!) return 1;
      return ra[10]! < rb[10]! ? -1 : ra[10]! > rb[10]! ? 1 : 0;
    };
  const compareRanked = compareRankedWith(leftoverFloor, true);
  feasible.sort(compareRanked);
  // planner v3 A1 — did the tolerance change the pick? Compare with the order the old rule gives.
  let leftoverTolerance: SequenceChoice['leftoverTolerance'];
  const chosenRanked = feasible[0];
  if (leftoverFloor !== null && bestLeftover !== null && chosenRanked !== undefined && chosenRanked.coverage !== null && chosenRanked.coverage > bestLeftover) {
    const strict = [...feasible].sort((a, b) => {
      const ra = rankOf(a);
      const rb = rankOf(b);
      // Through fallback (index 8); #1252 moved it from 7 along with the new cut-into key.
      for (let i = 0; i < 9; i++) {
        if (ra[i]! < rb[i]!) return -1;
        if (ra[i]! > rb[i]!) return 1;
      }
      return 0;
    })[0]!;
    leftoverTolerance = {
      tolerancePct,
      chosenLeftoverCells: chosenRanked.coverage,
      bestLeftoverCells: bestLeftover,
      cellAreaMm2: chosenRanked.cellAreaMm2 ?? 0,
      savedSeconds: Math.round(strict.cost.totalSeconds - chosenRanked.cost.totalSeconds),
    };
  }
  // planner v3 A6 — did the tall rule keep a slower set? (the sheet says so)
  let tallGuard: SequenceChoice['tallGuard'];
  if (tolerancePct > 0 && chosenRanked !== undefined && chosenRanked.coverage !== null && measured.length > 0) {
    // The pick as #1217 had it, for the note only: the floor from ALL measured sets (not the
    // cleanest ones #1224 uses), every key in the same order, and the tall term off.
    const coveredCells = Math.max(...measured.map((r) => r.coveredCells ?? 0));
    const plainFloor = Math.min(...measured.map((r) => r.coverage!)) + (tolerancePct / 100) * coveredCells;
    const displaced = [...feasible].sort(compareRankedWith(plainFloor, false))[0];
    if (displaced !== undefined && displaced !== chosenRanked && displaced.coverage !== null) {
      const note = tallGuardOf(
        { tallCells: chosenRanked.tallCells ?? 0, totalSeconds: chosenRanked.cost.totalSeconds },
        { tallCells: displaced.tallCells ?? 0, totalSeconds: displaced.cost.totalSeconds },
      );
      if (note !== null) {
        tallGuard = { extraTallCells: note.extraTallCells, cellAreaMm2: chosenRanked.cellAreaMm2 ?? 0, givenUpSeconds: note.givenUpSeconds };
      }
    }
  }
  // #1114 — the row still exists, but it states the DECIDER (the gate, the shortest sufficient
  // flute, or the key) instead of deferring to a policy issue.
  let pickNote: string | null = null;
  if (feasible.length > 1) {
    const first = feasible[0]!;
    const second = feasible[1]!;
    const ra = rankOf(first);
    const rb = rankOf(second);
    let priceTies = true;
    // Through catalogue (index 7); #1252's cut-into key sits at 1 and moved the rest along.
    for (let i = 0; i < 8; i++) if (ra[i] !== rb[i]) { priceTies = false; break; }
    const t1 = primaryOf(first);
    const t2 = primaryOf(second);
    if (priceTies && t1 !== undefined && t2 !== undefined && cuttingDiameter(t1) === cuttingDiameter(t2)
        && (t1.id ?? t1.name) !== (t2.id ?? t2.name)) {
      pickNote = pickNoteSentence(
        t1,
        t2,
        pickKeysOf(t1, deepestFeatureMm),
        pickKeysOf(t2, deepestFeatureMm),
        reachMarginMm,
      );
    }
  }

  if (feasible.length === 0) {
    throw new Error(
      'no cutter sequence can be planned for this demand: every candidate had a step the ops '
      + `could not post (${considered.length} candidate${considered.length === 1 ? '' : 's'} priced)`,
    );
  }

  // #961 acceptance — the rank the CARD prints is the engine's own: the same `rankOf` order (its
  // completeness includes the failed regions' fold), matched back to the considered entries by the
  // step signature. Unpriced candidates stay null, after every priced one.
  const signatureOf = (steps: readonly { kind: string; cutterKey: string }[]): string =>
    steps.map((s) => `${s.kind}:${s.cutterKey}`).join('+');
  for (let i = 0; i < feasible.length; i++) {
    const signature = signatureOf(feasible[i]!.sequence.steps.map((s) => ({ kind: s.kind as string, cutterKey: s.cutter.key })));
    const entry = considered.find((c) => c.rank === null && signatureOf(c.steps) === signature);
    if (entry !== undefined) {
      entry.rank = i + 1;
      entry.restPrice = feasible[i]!.restPrice;
      const price = feasible[i]!.restPrice;
      if (!feasible[i]!.eligible && price !== null) {
        entry.reason = price.gainMm2 <= 0
          ? 'its coverage rest recovers no surface the chain without it does not already have'
          : `its coverage rest recovers ${price.gainMm2.toFixed(2)} mm² for ${price.seconds.toFixed(0)} s (${price.mm2PerSecond.toFixed(4)} mm²/s), below the ${COVERAGE_REST_MIN_MM2_PER_SECOND} mm²/s price`;
      }
    }
  }

  const best = feasible[0]!;
  // #960 — the steps the ops actually planned; a failed step is not posted (its regions are
  // stated in `unreachable`/`unplanned` instead).
  const steps = best.steps;
  const last = steps[steps.length - 1];
  const beforeLast = steps[steps.length - 2];
  const contourFeatures = demand.features.filter((f) => f.kind === 'contour');
  // The same capability gate `canFreeLast` applies in the search, for the note: a cutter can take
  // the freeing profile only with a STATED flute reaching the floor and the profile's own shape.
  const canFree = (tool: Tool): boolean =>
    contourFeatures.length > 0 && contourFeatures.every((f) =>
      coversFeature(tool, f)
      && !(f.depthMm > 0 && (tool.fluteLength === null || tool.fluteLength + EPS < f.depthMm)));
  const freeing = last === undefined || last.kind !== 'contour'
    ? null
    : {
        cutterKey: last.cutter.key,
        extraToolChange: beforeLast !== undefined && beforeLast.cutter.key !== last.cutter.key,
        lastCutterEligible: beforeLast === undefined
          ? true
          : beforeLast.cutter.key === last.cutter.key || canFree(beforeLast.cutter.tool),
      };
  // #960 — the failed steps' regions are part of what this plan does NOT cut: fold them into
  // `unreachable` (so a caller that only reads that list still sees them) and keep the reasons in
  // `unplanned` for the plan's own sentence.
  const unreachable = [
    ...new Set([...best.sequence.unreachable, ...best.failures.flatMap((f) => f.regionIds)]),
  ];
  // #1252 — every eligible chain cut in, so the least was chosen: the sheet states it (the
  // picker never says it when a clean chain was available and passed over).
  const cutInto = best.cutIntoCells === null || best.cutIntoCells <= 0
    ? undefined
    : { cells: best.cutIntoCells, cellAreaMm2: best.cellAreaMm2 ?? 0 };
  return {
    steps,
    cost: best.cost,
    considered,
    unreachable,
    freeing,
    unplanned: best.failures,
    ...(pickNote === null ? {} : { pickNote }),
    ...(leftoverTolerance === undefined ? {} : { leftoverTolerance }),
    ...(tallGuard === undefined ? {} : { tallGuard }),
    ...(cutInto === undefined ? {} : { cutInto }),
  };
}

/**
 * THE TOOL-CHANGE BATCH (#964's own measurement): the curved pipeline plans region by region —
 * rough, rest, finish, pencil, then the next region's rough again — so a part with N remainder
 * regions posts the flat and the ball ALTERNATING N times, N-1 unnecessary tool changes the
 * fixture never asked for (F's tray count: 14 alternations, 29 changes; the shop's own
 * `toolChange.seconds` default charges ~91 s of real machine time for each one).
 *
 * The ruling this keeps: a program is an execution-ORDER run, and a cutter MAY appear twice —
 * but only where the order actually demands it (the freeing cut returning to an earlier cutter
 * because taking the profile with it is dearer, `chooseSequence`'s own `freeing` field). Nothing
 * here re-prices that choice; it only closes the gap the curved pipeline's own per-region loop
 * opens, where no such choice was ever made — region A's rough has no reason to run before or
 * after region B's rough relative to EITHER region's own ball stage, because the two regions
 * never touch each other's material.
 *
 * THE SAFETY RULE: two ops may trade places only if neither is the OTHER's own dependency — in
 * this engine that is exactly "do they touch the same region" (`sameRegion`). Every real
 * dependency (rough before rest before finish before pencil; a pocket's rest after its own
 * primary) is between ops on the SAME region, always in that fixed relative order already, by
 * construction, before this pass ever runs — grouping by cutter and keeping each cutter's own
 * internal order never reverses a same-region pair, because both of a pair's members stay inside
 * their own cutter's list, in the order they arrived in. Cross-region ops have no dependency on
 * each other at all, so freely interleaving them across cutter groups is always safe.
 *
 * THE FREEING CUT NEVER MOVES (the issue's own instruction): `isSentinel` marks the ops this pass
 * must leave exactly where they are — today, the one `'contour'` op a tree ever plans, already
 * last by construction (`planTreePrograms`'s own header). Pulling it into an earlier cutter's
 * group the moment that cutter matches would un-free the part before the last pocket/curved stage
 * ran, which is #959's own ruling 1 this file already exists to prevent.
 */
export function batchSameCutterRuns<T>(
  ops: readonly T[],
  cutterKeyOf: (op: T) => string,
  isSentinel: (op: T) => boolean,
): T[] {
  const sentinels: T[] = [];
  const movable: T[] = [];
  for (const op of ops) (isSentinel(op) ? sentinels : movable).push(op);
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const op of movable) {
    const key = cutterKeyOf(op);
    let g = groups.get(key);
    if (g === undefined) {
      g = [];
      groups.set(key, g);
      order.push(key);
    }
    g.push(op);
  }
  return [...order.flatMap((key) => groups.get(key)!), ...sentinels];
}
