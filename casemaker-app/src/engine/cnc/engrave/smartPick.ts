/**
 * #766 slice B — THE SEARCH: the cutter plans worth trying, and the one to choose.
 *
 * Rules pick by a proxy and each proxy has failed on a real job (#762 area, #760 kind, #765 the
 * tightest gap). This module does not judge a plan at all: it GENERATES the plausible plans and
 * hands each to slice A's evaluator (`evaluatePlan`), then chooses by the stated objective — the
 * most fidelity, then the fewest tool changes, then the shortest time, with owned cutters before
 * catalogue ones and the catalogue winner named so the operator can 'buy this'.
 *
 * THE CANDIDATES. Every plan is kind-valid and reach-filtered before it costs a simulation: the
 * #762 work classes decide which cutter shapes an item accepts, the material gate refuses a
 * cutter the job cannot run, and the reach filter refuses one whose flute cannot cover the cut it
 * owns. Around the kind plan (`planCutters`) the search tries what an operator would: a single
 * clearance flat, and that flat with each of the finest feasible rest cutters — the raised-text
 * pinches are the case that needs it (#765) — plus a sharp V as the rest for raised text, which
 * the simulation measures at its real edge loss.
 *
 * PURE, with the evaluator INJECTED: this module lives in `engine/`, which must not import the
 * worker realm slice A lives in. D binds `evaluatePlan` to it in the CLI, the Design panel and the
 * wizard, so every surface runs the same search (the issue's "same engine for every surface").
 *
 * BUDGET. Coarse-evaluate every pruned candidate, then full-evaluate the finalists
 * (`fullFinalists`, default 3); slice A caches both, so nothing is simulated twice.
 */

import type { EvaluatedItem, PlanEvaluation } from '@/workers/sim/planEvaluate';
import type { CandidatePlan, PinchFact } from '@/workers/sim/planEvaluate';
import type { EngraveJob } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { metalLineFallbackNote } from '@/engine/cnc/feeds';
import type { FeedCatalogueRow, FeedsEntry } from '@/engine/cnc/feeds';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import { statedCuttingSize as stated } from '@/engine/cnc/tool';
import { vCone, vFluteLength } from '@/engine/cnc/vProfile';
import { cutterReachesAllCorners, orderCutterEntries,
  faceCutterOptions,
  faceWorkOf,
  goalRoughOptions,
  kindedWork,
  materialRefusal,
  planCutters,
  reachOf,
  type PlannedCutter,
} from './cutterPlan';
import { goalSideNeedMm } from './goalReach';
import { jobHasItems, jobTargetObjects, pureGoalObject } from './jobSetup';
import { bossBeforeThread } from './threadFit';

export type { CandidatePlan, PinchFact } from '@/workers/sim/planEvaluate';

/**
 * The evaluator, bound by the caller to slice A (workers/sim/planEvaluate).
 *
 * MAY BE ASYNC (#766 D). The Design panel runs this search in the sim worker BETWEEN edits, and a
 * synchronous search would block the preview that shares that worker for its whole run. An async
 * evaluator lets the worker yield to its message queue between plans — so a newer edit's preview
 * request is served, and can cancel the search — while the CLI and the unit tests pass a plain
 * synchronous one.
 */
export type Evaluate = (plan: CandidatePlan, level: 'coarse' | 'full') => PlanEvaluation | Promise<PlanEvaluation>;

/** The evaluator as the loops below consume it: always a promise, whichever form the caller bound. */
type AwaitableEvaluate = (plan: CandidatePlan, level: 'coarse' | 'full') => Promise<PlanEvaluation>;

/** Where a plan's cutters come from. `inv:` keys are the shop's own; catalogue entries are bought. */
export function sourceOf(entry: ToolLibraryEntry): 'owned' | 'catalogue' {
  return entry.key.startsWith('cat:') ? 'catalogue' : 'owned';
}

/** One plan with the numbers the objective ranks. */
export interface ScoredPlan {
  plan: CandidatePlan;
  evaluation: PlanEvaluation;
  /** The WORST item fidelity in the plan, 0…1 — the objective's first key. */
  worstFidelity: number;
  /** The mean item fidelity, 0…1 — the tie-break inside one plan. */
  meanFidelity: number;
  /**
   * #765 — the field still standing in the raised labels' JOINED pinches, mm² (0 when there is no
   * raised text). A raised item's readability is this number, not its area fidelity: a plan that
   * scores 97 % on area and still leaves three pinches bridged reads worse than one that spends a
   * little more time and leaves slighter touches.
   */
  raisedStandingMm2: number;
  /**
   * #857 — the part of `raisedStandingMm2` that stands inside the glyphs' enclosed counters, mm².
   * A plan that keeps every letter apart can still fill an 'e'; this is that loss on its own.
   * Ranked before the pinches. Absent reads as 0 (a hand-built verdict).
   */
  counterStandingMm2?: number;
  /** The number of pinches left joined across the raised labels. */
  raisedJoined: number;
  /** True when every cutter in the plan is an owned one. */
  owned: boolean;
  /**
   * #954 — true when any of the plan's cutters is fed from a LABELLED FALLBACK (Makera publishes
   * no row for the pair, so the numbers are this app's starting point to measure). A fallback is
   * not an equal of a vendor or measured row: at equal fidelity a plan fed by one ranks below a
   * plan fed by rows, whatever the time — see {@link byObjective}.
   */
  fallbackFed: boolean;
  /** The item the worst fidelity belongs to, for the sentence. */
  worstItem: EvaluatedItem | null;
}

export interface SmartPickOptions {
  /** Plans evaluated at all (default 16). */
  maxCandidates?: number;
  /**
   * How many cutter-shape groups (the best single-cutter plan, the best flat-rest pair, the best
   * V-rest pair…) are promoted to `full` as fallbacks BESIDE the whole top-fidelity tier, which is
   * always fully evaluated. Default 3.
   */
  fullFinalists?: number;
  /**
   * How much a catalogue plan must beat the best owned plan's worst fidelity by before it is
   * CHOSEN over it (default 0.02). At or under the margin the owned plan wins and the catalogue
   * plan is named as 'buy this' instead.
   */
  buyThisMargin?: number;
  /**
   * #785 — progress out of the search: the level being measured, and the candidate about to be
   * evaluated. Called before the work is done, so the panel can say "measuring candidates 3 of 12"
   * and the flight recorder has a crumb even if the tab dies in the next evaluation.
   */
  onProgress?: (p: { level: 'coarse' | 'full'; done: number; total: number }) => void;
  /**
   * #858 — the shop's `toolChange.seconds`, resolved by the caller: what each tool change adds to a
   * plan's cost. Absent: the labelled fallback {@link TOOL_CHANGE_SECONDS}.
   */
  toolChangeSeconds?: number;
  /**
   * #940 — the document's SUPPORTING FLOORS (#748, `supportingFloors`), so a cone's reach is the
   * cut it makes below its item's floor instead of the stock-top depth. The caller is the one with
   * a Manifold toplevel; a caller with none leaves it absent and reads the old depth.
   */
  floors?: ReadonlyMap<string, number> | null;
}

/** One library cutter the search could not use, and why — the refusal's evidence (#910). */
export interface CandidateRefusal {
  key: string;
  reason: string;
  /** True when the cutter is simply the wrong shape for every piece of the job's work. */
  shapeOnly?: boolean;
}

/**
 * #910 — THE SEARCH HAD NOTHING TO MEASURE: every cutter in the library was refused before a plan
 * could be built. It used to throw one bare sentence, which dropped why each cutter was out — and
 * the reasons are the answer (a ⌀6 ball refused for feeds it in fact has, a ball refused for a
 * reach the goal never needed). This is a stated result, never an exception.
 */
export interface SmartPickRefusal {
  refused: true;
  /** One sentence for the panel and the CLI. */
  reason: string;
  /** Every cutter the library offered, with the gate that refused it. */
  candidates: readonly CandidateRefusal[];
}

/** The search's answer: the plan to run, what was close, and what to buy. */
export interface SmartPick {
  /** Discriminates a pick from a {@link SmartPickRefusal}. */
  refused?: false;
  /**
   * The QUICK RULE's plan (#211/#760/#762 — `planCutters`' kind plan), which is the first candidate
   * the search scores. The panel's provisional answer is a view of this plan, so this is what its
   * measured answer is compared against when the two differ (slice C's difference sentence) — and
   * what slice C's fallback sentence says is used when it is the only plan that posts. Null when
   * the rule assigns no cutter at all.
   */
  rule: ScoredPlan | null;
  /** The plan to run — a POSTING plan (slice A's `full.ok`), the best of those by the objective. */
  chosen: ScoredPlan;
  /** `chosen` when it posts; null when no plan the search tried posts (the CLI then stops, saying why). */
  runnable: ScoredPlan | null;
  /**
   * The best plan by measured fidelity, POSTING OR NOT — the one C's sentence quotes. Different
   * from `chosen` when the best-measured plan does not post yet (a V rest before its engine
   * lands); the note says why.
   */
  bestMeasured: ScoredPlan;
  /** The best POSTING plan that is not the chosen one, for the 'what the alternative would lose'. */
  runnerUp: ScoredPlan | null;
  /** The best CATALOGUE POSTING plan that would beat the owned choice — the 'buy this' line. */
  buyThis: ScoredPlan | null;
  /** Every plan the search looked at, in the order it scored them (coarse verdicts unless finalists). */
  considered: readonly ScoredPlan[];
  notes: string[];
}

const byDiameter = (a: ToolLibraryEntry, b: ToolLibraryEntry): number =>
  (stated(a.tool) ?? 0) - (stated(b.tool) ?? 0);

/** The canonical identity of a plan, for dedupe and for the evaluator's cache. */
export function planKey(plan: CandidatePlan): string {
  // #842 — the face cutter is part of a plan's identity: two plans that differ only there are two
  // different runs, and they must not dedupe (nor share a cache row).
  const cutters = plan.cutters.map((c) => `${c.key}[${[...c.items].sort().join(',')}]`).join('|');
  // A plan with no face cutter keeps the pre-#842 canonical form byte for byte: the suffix is
  // written only when a face program has a cutter of its own. #869's goal rough follows the same
  // rule, so a plan without one keys exactly as it did before the field existed.
  const faced = plan.faceToolKey === undefined ? cutters : `${cutters}@face:${plan.faceToolKey}`;
  return plan.goalRoughKey === undefined ? faced : `${faced}@rough:${plan.goalRoughKey}`;
}

/**
 * The QUICK RULE's plan: what `planCutters` (#211/#760/#762) assigns, with its rest pair, before
 * any simulation. `candidatePlans` tries it first and `smartPick` keeps its verdict as `rule` — the
 * plan the panel's provisional answer stands for, and what the measured answer is compared with.
 */
export function rulePlanOf(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[] | null,
  /** #940 — the document's supporting floors (#748); a cone's reach is measured from its floor. */
  floors?: ReadonlyMap<string, number> | null,
): CandidatePlan | null {
  const base = planCutters(job, null, tools, catalogue, conditions ?? undefined, table ?? undefined, null, floors);
  if (base.cutters.length === 0) return null;
  return planFrom(base.cutters, tools, base.faceToolKey, base.goalRoughKey);
}

/** A plan from `planCutters`' output, with each cutter's source recorded. */
function planFrom(
  cutters: readonly PlannedCutter[],
  tools: readonly ToolLibraryEntry[],
  faceToolKey?: string,
  goalRoughKey?: string,
): CandidatePlan {
  const source: Record<string, 'owned' | 'catalogue'> = {};
  for (const c of cutters) {
    const entry = tools.find((t) => t.key === c.key);
    source[c.key] = entry === undefined ? 'owned' : sourceOf(entry);
  }
  // #869 — the rough owns no items, but it is a program of the plan: its own source rides too.
  if (goalRoughKey !== undefined) {
    const entry = tools.find((t) => t.key === goalRoughKey);
    source[goalRoughKey] = entry === undefined ? 'owned' : sourceOf(entry);
  }
  return {
    cutters: cutters.map((c) => ({ key: c.key, items: [...c.items] })),
    source,
    ...(faceToolKey === undefined ? {} : { faceToolKey }),
    ...(goalRoughKey === undefined ? {} : { goalRoughKey }),
  };
}

/**
 * The candidate plans, pruned and deduped, in a deterministic order (the kind plan first, then
 * the flat variants by clearance diameter and finer rest).
 */
export function candidatePlans(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[] | null,
  /** #940 — the document's supporting floors (#748), as `planCutters` takes them. */
  floors?: ReadonlyMap<string, number> | null,
): CandidatePlan[] {
  const out: CandidatePlan[] = [];
  const seen = new Set<string>();
  const add = (given: CandidatePlan): void => {
    // #848 — a thread mill whose boss another cutter of the plan raises is cut AFTER that cutter.
    // #941 — THE JOB'S CUTTING ORDER APPLIES TO EVERY CANDIDATE: a stock-rim bevel precedes the
    // cut that frees its edge, so the measured pick cannot post an order the rule forbids.
    const ordered = orderCutterEntries(job, bossBeforeThread(job, given.cutters), (key) => tools.find((t) => t.key === key)?.tool.shape ?? null);
    const plan = ordered === given.cutters ? given : { ...given, cutters: [...ordered] };
    const key = planKey(plan);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(plan);
  };

  /** A plan from bare cutters, with each cutter's provenance filled in from the library. */
  const sourced = (cutters: { key: string; items: readonly string[] }[]): CandidatePlan => {
    const source: Record<string, 'owned' | 'catalogue'> = {};
    for (const c of cutters) {
      const entry = tools.find((t) => t.key === c.key);
      source[c.key] = entry === undefined ? 'owned' : sourceOf(entry);
    }
    return { cutters, source };
  };

  // #786 slice 4c — A NAMED DRILL BIT OR THREAD MILL WITH OTHER WORK KEEPS ITS JOB. The document
  // names the operator's drill (or thread mill) and also asks for regions, traces or threads. No
  // single cutter can do both, and the answer is not to replace the named cutter with a flat that
  // could: it is the SPLIT the operator means — the named cutter for its own holes/threads, and a
  // flat (or the kind plan's other cutters) for the rest. The mixed-tool refusal then has nothing
  // left to refuse, because each program has one cutter that can do its work.
  const work = kindedWork(job);
  const named = tools.find((t) => t.key === job.toolKey);
  const drillIds = new Set(
    (job.drills ?? []).filter((d) => d.enabled).map((d) => d.id),
  );
  const threadIds = new Set(
    (job.threads ?? []).filter((t) => t.enabled).map((t) => t.id),
  );
  const namedKind: 'drill' | 'thread' | null =
    named === undefined
      ? null
      : named.tool.shape === 'drill' && drillIds.size > 0
        ? 'drill'
        : named.tool.shape === 'thread' && threadIds.size > 0
          ? 'thread'
          : null;
  const ownedIds: ReadonlySet<string> = namedKind === 'drill' ? drillIds : namedKind === 'thread' ? threadIds : new Set<string>();
  const otherWork = work.filter((w) => !ownedIds.has(w.id));
  const mixedNamed = namedKind !== null && otherWork.length > 0;

  // The kind plan: one cutter per kind, and — when the reach table is absent — no rest pair. It is
  // the rule-based answer; the search treats it as one candidate among the measured ones. A MIXED
  // NAMED job does not take it: that plan would replace the cutter the operator named.
  const base = planCutters(job, null, tools, catalogue, conditions ?? undefined, table ?? undefined, null, floors);
  const basePlan = planFrom(base.cutters, tools, base.faceToolKey);
  // #842 — A MIXED JOB'S FACE CUTTER IS PART OF THE PLAN. The face rule names one; the search
  // also tries the other fitting face cutters, so a human finding a better one is a selector bug
  // no more. Each face variant rides the rule's item plan.
  const mixedFace = jobHasItems(job)
    ? faceCutterOptions(job, tools, catalogue, conditions ?? undefined, table ?? undefined, true, true)
    : null;
  const defaultFaceKey = base.faceToolKey;
  if (!mixedNamed && basePlan.cutters.length > 0) {
    add(basePlan);
    if (mixedFace !== null) {
      for (const entry of mixedFace.candidates.slice(0, 4)) {
        add({ ...basePlan, faceToolKey: entry.key });
      }
    }
  }
  // The kind plan's NON-FLAT cutters other than the named one — what the split keeps for the thread
  // and cone work. A flat never comes from here: the split chooses its own clearance flat, and the
  // kind plan's flat would own the very items that flat is for.
  const splitOthers = basePlan.cutters.filter((c) => {
    const shape = tools.find((t) => t.key === c.key)?.tool.shape;
    if (shape === undefined || shape === 'flat') return false;
    if (c.key === named?.key) return false;
    return !(namedKind === 'thread' && shape === 'thread');
  });

  // #834 — A JOB WHOSE WORK IS ON THE FACES. The rule plan above is the WIDEST flat end that fits;
  // the search must also measure the narrower ones, because the choice is by simulated TIME at
  // equal fidelity (any fitting width leaves the same face). Each candidate is one cutter owning
  // no items — there are none; its program is the indexed face list.
  const face = faceCutterOptions(job, tools, catalogue, conditions ?? undefined, table ?? undefined);
  if (face !== null) {
    for (const entry of face.candidates.slice(0, 6)) {
      add({ cutters: [{ key: entry.key, items: [] }], source: { [entry.key]: sourceOf(entry) } });
    }
  }

  // #766 fix — A GOAL'S BALL IS CHOSEN BY THE FINISH BUDGET, AND THE BUDGET MAY NOT BE SAMPLABLE
  // HERE. `planCutters` refuses a ball whose finish tip field would exceed the cap (#540) — but
  // only when it can sample the goal heightfield; a job whose goal mesh is attached later (the
  // CLI's store, the panel's worker) samples as null and the rule then names the LARGEST ball,
  // which the generator refuses at `cam` ("3D finishing would need … over the … budget", j06
  // wolf). Try the balls from largest down: each over-budget one is refused cheaply and the
  // largest that FITS posts, so a goal job can always generate.
  //
  // #785 — AND A BALL MUST REACH THE GOAL. A ball whose stated reach (shoulder, else flute) is
  // shorter than the goal is deep would put the holder in the part no matter how well it measures;
  // it is not a candidate, so the search chooses a longer ball instead of picking the largest and
  // being refused at Generate. An UNSTATED reach is not a promise either way: such a ball stays a
  // candidate, and the sweep's holder gate judges it (`holder-unproven`).
  const ballWork = work.filter((w) => w.kind === 'ball');
  // A mixed named job's plans are the split's alone (a ball owns no holes, so its plan would be
  // refused for the unassigned drill items anyway).
  if (ballWork.length > 0 && !mixedNamed) {
    const ids = ballWork.map((w) => w.id);
    const goalDepth = jobTargetObjects(job).reduce((deepest, target) => {
      if ((target.role ?? 'reference') !== 'goal' || !target.enabled || target.format === 'png') return deepest;
      const depth = goalSideNeedMm(target);
      return Number.isFinite(depth) && depth > deepest ? depth : deepest;
    }, 0);
    const reachesGoal = (t: ToolLibraryEntry): boolean => {
      if (!(goalDepth > 0)) return true;
      const reach = reachOf(t);
      return reach === null || goalDepth <= reach + 1e-9;
    };
    const balls = tools
      .filter((t) => t.tool.shape === 'ball' || t.tool.shape === 'bull')
      .filter((t) => (stated(t.tool) ?? 0) > 0 && materialRefusal(job, t, catalogue, conditions, table ?? undefined, { ownedVouches: true }) === null)
      .filter(reachesGoal)
      .sort((a, b) => byDiameter(b, a))
      .slice(0, 6);
    for (const ball of balls) add({ cutters: [{ key: ball.key, items: ids }], source: { [ball.key]: sourceOf(ball) } });
    // #869 — AND THE SAME BALL WITH A FLAT ROUGHING BEFORE IT. A flat takes a deeper step-down and
    // a wider step-over than the ball, so the bulk comes off faster, and the adaptive clearing
    // engine (flat end mills only) becomes available to the goal; the finish is the ball either
    // way. Which is cheaper is a measured question — the split is tried beside the single ball and
    // the run's own cost (seconds plus each tool change, #858) decides. The roughest variants are
    // capped: the top two balls, and three flats for the largest, so the search stays affordable.
    const roughsFor = (ball: ToolLibraryEntry, count: number): CandidatePlan[] => {
      const options = goalRoughOptions(
        job,
        tools,
        catalogue,
        conditions,
        table ?? undefined,
        stated(ball.tool) ?? 0,
      );
      return (options?.candidates ?? []).slice(0, count).map((flat) => ({
        cutters: [{ key: ball.key, items: ids }],
        source: { [ball.key]: sourceOf(ball), [flat.key]: sourceOf(flat) },
        goalRoughKey: flat.key,
      }));
    };
    for (const [i, ball] of balls.slice(0, 2).entries()) {
      for (const plan of roughsFor(ball, i === 0 ? 3 : 1)) add(plan);
    }
  }
  // #829 — A PURE GOAL THAT ASKS FOR A CHAMFER gains the V-bit as a SECOND program in every
  // candidate considered so far: the surfacing cutter still cuts the part and the V bevels its
  // rim. The V owns no items (it is not an item's cutter), exactly as a rest pass's second cutter
  // owns none, and `applyCutterPlanToJob` writes the plan's second key into `chamfer.toolKey` so
  // the generator posts the bevel with the cutter the search measured.
  const pureGoal = pureGoalObject(job);
  if (pureGoal !== null && pureGoal.chamfer !== undefined) {
    // A cone with no feeds for this material is still a CANDIDATE here: the evaluator runs the
    // generator, which refuses it, and the search simply does not choose that plan.
    const cones = tools.filter((t) => vCone(t.tool) !== null).slice(0, 4);
    const surfacing = [...out];
    for (const plan of surfacing) {
      if (plan.cutters.length === 0) continue;
      for (const cone of cones) {
        if (plan.cutters.some((c) => c.key === cone.key)) continue;
        add({
          // #869 — the surfacing plan's own fields ride: a goal rough (and a face cutter) is part
          // of the plan the V joins, not something the chamfer variant drops.
          ...plan,
          cutters: [...plan.cutters, { key: cone.key, items: [] }],
          source: { ...plan.source, [cone.key]: sourceOf(cone) },
        });
      }
    }
  }

  const flatWork = work.filter((w) => w.kind === 'flat');
  if (flatWork.length === 0) {
    // A named thread mill beside other NON-FLAT work (a chamfer) is still a split; the kind plan's
    // other cutters already own that work. Every other job with no flat work has nothing to split.
    if (mixedNamed) {
      add(sourced([{ key: named!.key, items: [...ownedIds] }, ...splitOthers]));
    }
    return out;
  }

  // The flat kind's own numbers, the same rules `planCutters` applies: the deepest cut, the
  // smallest bore, and a through cut-out's depth.
  const through = job.stock.thickness + job.breakthrough;
  const deepest = flatWork.reduce((m, w) => Math.max(m, w.reachMm), 0);
  const bores = (job.drills ?? []).filter((d) => d.enabled && d.mode === 'bore');
  const smallestBore = bores.reduce<number | null>((m, d) => {
    const h = d.diameter !== undefined && d.diameter > 0 ? d.diameter : null;
    return h === null ? m : m === null ? h : Math.min(m, h);
  }, null);
  const hasCutout = (job.cutouts ?? []).some((c) => c.enabled);
  const flatItems = flatWork.map((w) => w.id);

  const gate = (entry: ToolLibraryEntry): boolean =>
    materialRefusal(job, entry, catalogue, conditions, table ?? undefined, { ownedVouches: true }) === null;
  const reaches = (entry: ToolLibraryEntry, need: number): boolean => {
    const reach = reachOf(entry);
    return reach === null || need <= reach + 1e-9;
  };
  /** A flat that may take ALL the flat work: reach, smallest bore, through cut-outs. */
  const feasibleFlat = (entry: ToolLibraryEntry): boolean => {
    const d = stated(entry.tool) ?? 0;
    return (
      d > 0 &&
      gate(entry) &&
      reaches(entry, deepest) &&
      (smallestBore === null || d < smallestBore - 1e-9) &&
      (!hasCutout || reaches(entry, through))
    );
  };
  /** A rest cutter re-cuts the earlier cutter's leftovers: reach only, no bore/through ownership. */
  const feasibleRest = (entry: ToolLibraryEntry): boolean => gate(entry) && reaches(entry, deepest);

  const flats = tools.filter((t) => t.tool.shape === 'flat' && (stated(t.tool) ?? 0) > 0 && feasibleFlat(t)).sort(byDiameter);
  const rests = tools.filter((t) => t.tool.shape === 'flat' && (stated(t.tool) ?? 0) > 0 && feasibleRest(t)).sort(byDiameter);
  // The raised-text pinches want the FINEST TIP first (a 0.1 mm 30° cone opens a 0.28 mm gap with
  // 0.018 mm a side); the flank angle only orders tips of the same width.
  const cones = tools
    .filter((t) => vCone(t.tool) !== null && vFluteLength(t.tool) !== null)
    .filter((t) => gate(t))
    .sort((a, b) => byDiameter(a, b) || (vCone(a.tool)!.halfAngleDeg - vCone(b.tool)!.halfAngleDeg));

  // The non-flat cutters the kind plan chose keep their work in every flat variant: an item left
  // unassigned is a refusal, not a variant.
  const others = base.cutters.filter((c) => {
    const entry = tools.find((t) => t.key === c.key);
    return entry !== undefined && entry.tool.shape !== 'flat';
  });
  const withOthers = (flatCutters: { key: string; items: readonly string[] }[]): CandidatePlan =>
    sourced([...flatCutters, ...others.map((c) => ({ key: c.key, items: [...c.items] }))]);

  // The interesting clearances: the largest, the middle and the two finest a shop would reach for.
  const interesting = (list: readonly ToolLibraryEntry[], n: number): ToolLibraryEntry[] => {
    if (list.length <= n) return [...list];
    const picks = new Set<ToolLibraryEntry>();
    picks.add(list[0]!);
    picks.add(list[Math.floor(list.length / 2)]!);
    picks.add(list[list.length - 2]!);
    picks.add(list[list.length - 1]!);
    return [...picks].slice(0, Math.max(2, n)).sort(byDiameter);
  };
  // Clearance first: the LARGEST interesting flats clear fastest; the rests stay finest-first.
  const clearances = interesting(flats, 4).reverse();

  // The split for a mixed named job: the named cutter for its own items, the best clearance flat
  // for the other flat work, and the kind plan's other (non-flat) cutters for theirs. A thread
  // cutter from the kind plan is dropped when the named cutter IS the thread mill: the thread
  // items belong to the named cutter, and an item is cut once.
  if (mixedNamed) {
    const otherFlatIds = otherWork.filter((w) => w.kind === 'flat').map((w) => w.id);
    for (const clearance of otherFlatIds.length > 0 ? clearances : [null]) {
      const cutters = [
        { key: named!.key, items: [...ownedIds] },
        ...(clearance === null ? [] : [{ key: clearance.key, items: otherFlatIds }]),
        ...splitOthers,
      ];
      add(sourced(cutters));
    }
    return out;
  }

  const restChoices = interesting(rests, 3);
  for (const clearance of clearances) {
    add(withOthers([{ key: clearance.key, items: flatItems }]));
  }
  // Rough + rest pairs: the rest owns no items — it is measured against the earlier program.
  for (const clearance of clearances.slice(0, 3)) {
    // #941 — the rest is planned only when the clearance cutter cannot reach the design's
    // corners; when it can, the corners are already right and the second program is not offered.
    if (cutterReachesAllCorners(job, (stated(clearance.tool) ?? 0) / 2)) continue;
    for (const rest of restChoices) {
      if ((stated(rest.tool) ?? 0) >= (stated(clearance.tool) ?? 0) - 1e-9) continue;
      add(withOthers([{ key: clearance.key, items: flatItems }, { key: rest.key, items: [] }]));
    }
  }
  // Raised text: a sharp V as the rest (the 0.1 mm 30° cuts its pinches to within a few hundredths
  // of a millimetre — #765), and the raised measurement decides by simulation whether that holds.
  const raisedIds = new Set(
    (job.combined ?? [])
      .filter((c) => c.enabled && c.kind === 'cutaway' && c.islands.some((id) => job.labels.some((l) => l.id === id && l.construction === true)))
      .map((c) => c.id),
  );
  if (raisedIds.size > 0) {
    for (const clearance of clearances.slice(0, 2)) {
      for (const cone of cones.slice(0, 3)) {
        add(withOthers([{ key: clearance.key, items: flatItems }, { key: cone.key, items: [] }]));
      }
    }
  }
  // #766 fix — A V CARVES TEXT TOO. On a job whose flat work is ALL text, a small flat can lose
  // whole characters (an ERROR, so no flat plan posts at all) while a V's flank keeps them: j14's
  // dog tag read cleanly with #762's 60° engraver, and the search could not propose it because its
  // only cones were raised-text rests. The evaluator measures whether the V holds; the ranking
  // still prefers a flat that cuts the text faster, so this only wins where it is the only thing
  // that cuts at all. Cones with an unstated reach are tried: the generator says when one is too
  // shallow, and refusing them here is what hid #762's answer.
  const labelIds = new Set(job.labels.filter((l) => l.enabled && l.construction !== true).map((l) => l.id));
  const allText = flatWork.length > 0 && flatWork.every((w) => labelIds.has(w.id));
  if (allText) {
    const textCones = tools
      .filter((t) => vCone(t.tool) !== null)
      .filter((t) => gate(t))
      .sort(byDiameter)
      .slice(0, 2);
    for (const cone of textCones) add(withOthers([{ key: cone.key, items: flatItems }]));
  }
  // #842 — every plan that did not choose a face cutter of its own rides the rule's, so the
  // evaluator writes one to the setup either way.
  return out.map((plan) =>
    plan.faceToolKey === undefined && defaultFaceKey !== undefined ? { ...plan, faceToolKey: defaultFaceKey } : plan,
  );
}

/**
 * The worst and mean fidelity over the plan's items (all enabled items, so an uncut one counts).
 *
 * `exactWhenEmpty` (#834): a FACE job has no items at all, and its fidelity is the FACE's — every
 * fitting cutter leaves the same plane at the same depth, so the items' absence is a perfect
 * result, not a zero. Ranking then falls to the run's own time, which is the point.
 */
function fidelityOf(
  evaluation: PlanEvaluation,
  exactWhenEmpty = false,
): { worst: number; mean: number; worstItem: EvaluatedItem | null } {
  if (evaluation.items.length === 0) {
    return exactWhenEmpty ? { worst: 1, mean: 1, worstItem: null } : { worst: 0, mean: 0, worstItem: null };
  }
  let worst = 1;
  let sum = 0;
  let worstItem: EvaluatedItem | null = null;
  for (const item of evaluation.items) {
    const f = Math.max(0, Math.min(1, item.fidelity));
    sum += f;
    if (f < worst) {
      worst = f;
      worstItem = item;
    }
  }
  return { worst, mean: sum / evaluation.items.length, worstItem };
}

function toScored(plan: CandidatePlan, evaluation: PlanEvaluation, exactWhenEmpty = false, fallbackFed = false): ScoredPlan {
  const { worst, mean, worstItem } = fidelityOf(evaluation, exactWhenEmpty);
  let raisedStandingMm2 = 0;
  let raisedJoined = 0;
  let counterStandingMm2 = 0;
  for (const item of evaluation.items) {
    for (const pinch of item.pinches) {
      if (!pinch.separated) {
        raisedStandingMm2 += pinch.areaMm2;
        raisedJoined += 1;
      }
    }
    // #857 — a counter left standing is field the eye reads as filled, exactly as a bridged pinch.
    for (const counter of item.counters ?? []) counterStandingMm2 += counter.standingMm2;
  }
  raisedStandingMm2 += counterStandingMm2;
  return {
    plan,
    evaluation,
    worstFidelity: worst,
    meanFidelity: mean,
    raisedStandingMm2: Math.round(raisedStandingMm2 * 1e6) / 1e6,
    counterStandingMm2: Math.round(counterStandingMm2 * 1e6) / 1e6,
    raisedJoined,
    owned: plan.cutters.every((c) => plan.source[c.key] !== 'catalogue'),
    fallbackFed,
    worstItem,
  };
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * #766 — WHAT A TOOL CHANGE COSTS, in run time. The issue's objective is fidelity, then the fewest
 * tool changes, then the shortest time; taken literally that chooses a 4.6-hour one-cutter run over
 * a 3-minute two-cutter one to save a single change (j02, measured). A change is not free, so it is
 * counted at an allowance and the last two keys become one cost.
 *
 * #858 — the allowance is the SHOP'S, `toolChange.seconds` (seeded 91.4 s: the run plan's own bit
 * change, fitting the cutter by hand plus the measured M491). The caller resolves it and hands it
 * in as `SmartPickOptions.toolChangeSeconds`; this is the LABELLED FALLBACK for a caller with no
 * location (the hosted web build, a direct-engine test), and it is the same number as the seed.
 */
export const TOOL_CHANGE_SECONDS = 91.4;

/**
 * #857 — THE SMALLEST COUNTER DIFFERENCE THAT DECIDES, mm². A patch the visible ridge width on a
 * side: `RAISED_RIB_VISIBLE_MM` (0.15 mm, #818's bench-derived width a ridge must reach before the
 * eye reads it) squared. Below it two plans leave the same counters to the eye, and the difference
 * is the sweep's own cusps — two programs cutting the same counter differ by about 0.01 mm² — which
 * must not outrank a run several times faster.
 */
export const COUNTER_TIE_MM2 = 0.15 * 0.15;

/**
 * #857 — FIDELITY THAT TIES, as a share: 0.1 %. Two plans within it reproduce the same design to
 * the precision the run sheet states (whole percent), and the measured difference is sweep noise
 * (a counter's cusps move the scalar by about 0.0001); the run's cost then decides, which is the
 * objective's own order ('rank by simulated time at equal fidelity').
 */
export const FIDELITY_TIE = 0.001;

/**
 * The fidelity half of the objective, 0 when two plans reproduce the design equally.
 *
 *  1. #857 — the COUNTERS left standing inside the raised glyphs, first: a filled counter changes
 *     the letter itself (an 'e' reads as a blob, an 'a' as a 'd'), where a join between two
 *     letters leaves both letterforms readable. Within {@link COUNTER_TIE_MM2} they tie.
 *  2. #765 — the field standing in the joined PINCHES, so a plan that leaves the letters' gaps
 *     bridged cannot win on a high field-area percentage; then how many stay joined.
 *  3. The worst item's fidelity, then the mean, each within {@link FIDELITY_TIE}.
 */
export function byFidelity(a: ScoredPlan, b: ScoredPlan): number {
  const ca = a.counterStandingMm2 ?? 0;
  const cb = b.counterStandingMm2 ?? 0;
  if (Math.abs(ca - cb) > COUNTER_TIE_MM2 + 1e-9) return ca - cb;
  const pa = a.raisedStandingMm2 - ca;
  const pb = b.raisedStandingMm2 - cb;
  if (round6(pa) !== round6(pb)) return pa - pb;
  if (a.raisedJoined !== b.raisedJoined) return a.raisedJoined - b.raisedJoined;
  if (Math.abs(a.worstFidelity - b.worstFidelity) > FIDELITY_TIE + 1e-12) return b.worstFidelity - a.worstFidelity;
  if (Math.abs(a.meanFidelity - b.meanFidelity) > FIDELITY_TIE + 1e-12) return b.meanFidelity - a.meanFidelity;
  return 0;
}

/**
 * #858 — A PLAN'S COST, seconds: its simulated cutting time plus the shop's allowance for each tool
 * change. Infinite when the plan has no time (a coarse verdict, or a plan that does not post).
 */
export function planCostSeconds(evaluation: PlanEvaluation, toolChangeSeconds: number = TOOL_CHANGE_SECONDS): number {
  return (evaluation.seconds ?? Number.POSITIVE_INFINITY) + evaluation.toolChanges * toolChangeSeconds;
}

/**
 * The objective: the most fidelity (worst item first, then mean), then the cost of the run —
 * its cutting seconds plus a stated allowance per tool change — then the plan key for
 * determinism. `ownedFirst` is applied by the caller: an owned plan within the margin outranks a
 * catalogue one.
 */
function byObjective(a: ScoredPlan, b: ScoredPlan, toolChangeSeconds: number = TOOL_CHANGE_SECONDS): number {
  const fidelity = byFidelity(a, b);
  if (fidelity !== 0) return fidelity;
  // #954 — A LABELLED FALLBACK IS NOT AN EQUAL OF A ROW. At equal fidelity, the plan fed by
  // Makera's or the shop's own numbers outranks one whose feeds are the app's starting point for
  // an unrated pair — before the clock, because the fallback's numbers are a guess and a shorter
  // guess is not a better plan.
  if (a.fallbackFed !== b.fallbackFed) return a.fallbackFed ? 1 : -1;
  const cost = (s: ScoredPlan): number => planCostSeconds(s.evaluation, toolChangeSeconds);
  const ca = round6(cost(a));
  const cb = round6(cost(b));
  if (ca !== cb) return ca - cb;
  return planKey(a.plan) < planKey(b.plan) ? -1 : planKey(a.plan) > planKey(b.plan) ? 1 : 0;
}

/**
 * Run the search. `evaluate` is slice A's `evaluatePlan` bound to a context; every call is the
 * same job and plan shape the evaluator caches, so finalists are cheap the second time.
 */
export async function smartPick(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  evaluate: Evaluate,
  opts: SmartPickOptions = {},
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[] | null,
): Promise<SmartPick | SmartPickRefusal> {
  const maxCandidates = opts.maxCandidates ?? 16;
  const fullFinalists = Math.max(1, opts.fullFinalists ?? 3);
  const margin = opts.buyThisMargin ?? 0.02;
  const notes: string[] = [];
  // #954 — the cutters whose feeds are this app's labelled starting point for the pair. The rank
  // uses the SAME predicate the feeds table writes its note with, so the two cannot disagree.
  const fallbackFedKeys = new Set(
    tools
      .filter((entry) => metalLineFallbackNote(entry.tool, job.stock.material, catalogue) !== null)
      .map((entry) => entry.key),
  );
  const planFedFromFallback = (plan: CandidatePlan): boolean =>
    plan.cutters.some((c) => fallbackFedKeys.has(c.key)) ||
    (plan.faceToolKey !== undefined && fallbackFedKeys.has(plan.faceToolKey)) ||
    (plan.goalRoughKey !== undefined && fallbackFedKeys.has(plan.goalRoughKey));
  const rulePlan = rulePlanOf(job, tools, catalogue, conditions, table, opts.floors);
  // #834 — a face job's plans have no items to score; their fidelity is the face's (see fidelityOf).
  const exactWhenEmpty = faceWorkOf(job) !== null;
  const plans = candidatePlans(job, tools, catalogue, conditions, table, opts.floors).slice(0, maxCandidates);
  if (plans.length === 0) {
    const candidates = candidateRefusals(job, tools, catalogue, conditions, table);
    // The sentence names every cutter of the right shape and why it is out; the wrong-shaped rest
    // are counted (a full library is a hundred drills and flats), and listed in `candidates`.
    const named = candidates.filter((c) => c.shapeOnly !== true);
    const others = candidates.length - named.length;
    const parts = [
      ...named.map((c) => `${c.key} — ${c.reason}`),
      ...(others === 0 ? [] : [`${others} other cutter${others === 1 ? ' is' : 's are'} not the shape this work needs`]),
    ];
    return {
      refused: true,
      reason:
        parts.length === 0
          ? 'the search found no candidate cutter plan for this job: the tool library offers no cutters'
          : `the search found no candidate cutter plan for this job: ${parts.join('; ')}`,
      candidates,
    };
  }
  // #785 — the search's own progress. `total` is the level's candidate list; the counts are
  // reported BEFORE each evaluation, because that call is the seconds-long work.
  let coarseDone = 0;
  let fullDoneCount = 0;
  let fullTotal = 0;
  const evaluateAsync: AwaitableEvaluate = async (plan, level) => {
    if (level === 'coarse') opts.onProgress?.({ level, done: ++coarseDone, total: plans.length });
    else opts.onProgress?.({ level, done: ++fullDoneCount, total: Math.max(fullTotal, fullDoneCount) });
    return evaluate(plan, level);
  };
  // COARSE FIRST — measure-only: every candidate is scored cheaply, and the top few are promoted
  // to a FULL evaluation, which is the level that says whether a plan actually posts.
  const verdicts = new Map<string, ScoredPlan>();
  for (const plan of plans) {
    verdicts.set(planKey(plan), toScored(plan, await evaluateAsync(plan, 'coarse'), exactWhenEmpty, planFedFromFallback(plan)));
  }
  // COARSE ok IS NOT POSTING: it says the plan is structurally evaluable. Only a full verdict's
  // `ok` is the generator's fact (slice A's seam), so the posting pool is drawn from this set.
  const fullDone = new Set<string>();
  const full = async (plan: CandidatePlan): Promise<ScoredPlan> => {
    const scoredFull = toScored(plan, await evaluateAsync(plan, 'full'), exactWhenEmpty, planFedFromFallback(plan));
    verdicts.set(planKey(plan), scoredFull);
    fullDone.add(planKey(plan));
    return scoredFull;
  };
  const toolChangeSeconds = opts.toolChangeSeconds ?? TOOL_CHANGE_SECONDS;
  const ordered = (): ScoredPlan[] => [...verdicts.values()].sort((a, b) => byObjective(a, b, toolChangeSeconds));
  // FINALISTS. A coarse verdict has no time (slice A measures only), so the cost cannot tell a
  // single-cutter plan from a two-cutter one yet — and that difference is the whole question
  // (j02's 4½-hour single corn against a 3-minute pair). So every plan whose coarse fidelity ties
  // the best is fully evaluated (that is where the real time and the posting fact come from),
  // plus the best plan of each cutter-shape group as a fallback when the top tier does not post.
  const bestWorst = Math.max(...ordered().map((s) => s.worstFidelity));
  const fullList = ordered().filter((s) => s.worstFidelity >= bestWorst - 1e-9).slice(0, maxCandidates);
  // #857 — and every plan that ties the BEST BY THE OBJECTIVE'S FIDELITY (counters, pinches,
  // fidelity): the objective ranks counters before the worst fidelity, so the plan it would choose
  // must be timed and posted even when its scalar is a few tenths of a percent lower.
  const top = ordered()[0]!;
  for (const s of ordered()) {
    if (byFidelity(s, top) !== 0) break;
    if (!fullList.includes(s)) fullList.push(s);
  }
  const lastShape = (plan: CandidatePlan): string => {
    const last = plan.cutters[plan.cutters.length - 1];
    const entry = last === undefined ? undefined : tools.find((t) => t.key === last.key);
    return `${plan.cutters.length}:${entry?.tool.shape ?? '?'}`;
  };
  const byShape = new Map<string, ScoredPlan>();
  for (const s of ordered()) if (!byShape.has(lastShape(s.plan))) byShape.set(lastShape(s.plan), s);
  const shapeFallbacks = [...byShape.keys()]
    .sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0]))
    .slice(0, fullFinalists)
    .map((k) => byShape.get(k)!);
  for (const s of shapeFallbacks) if (!fullDone.has(planKey(s.plan))) fullList.push(s);
  fullTotal = fullList.filter((s) => !fullDone.has(planKey(s.plan))).length;
  for (const finalist of fullList) if (!fullDone.has(planKey(finalist.plan))) await full(finalist.plan);

  // POSTING FIRST. A plan slice A's generator refuses is not a candidate to hand over, however
  // well its geometry measures; promote further plans until at least one posts.
  const postsSoFar = (): boolean => [...verdicts.entries()].some(([k, s]) => fullDone.has(k) && s.evaluation.ok);
  if (!postsSoFar()) {
    for (const candidate of ordered()) {
      const key = planKey(candidate.plan);
      if (!fullDone.has(key)) await full(candidate.plan);
      if (verdicts.get(key)!.evaluation.ok) break;
    }
  }
  const all = ordered();
  const postings = all.filter((s) => fullDone.has(planKey(s.plan)) && s.evaluation.ok);
  const bestMeasured = all[0]!;
  const bestOwnedPosting = postings.filter((s) => s.owned)[0] ?? null;
  const bestCataloguePosting = postings.filter((s) => !s.owned)[0] ?? null;
  const catalogueWins =
    bestCataloguePosting !== null &&
    (bestOwnedPosting === null ||
      round6(bestCataloguePosting.worstFidelity) > round6(bestOwnedPosting.worstFidelity) + margin - 1e-9);
  const chosen = (catalogueWins ? bestCataloguePosting : bestOwnedPosting) ?? bestMeasured;
  const runnable = postings.length > 0 ? chosen : null;
  if (runnable === null) {
    const why = bestMeasured.evaluation.refusal ?? 'the generator refuses every candidate';
    notes.push(`No plan the search tried posts: ${why}`);
  } else if (!sameCutters(chosen.plan, bestMeasured.plan)) {
    notes.push(
      `The best-measured plan (${planKey(bestMeasured.plan)}) does not post: ${bestMeasured.evaluation.refusal ?? 'the generator refuses it'} — the best plan that does post is run instead.`,
    );
  }
  const runnerUp = postings.find((s) => !sameCutters(s.plan, chosen.plan)) ?? null;
  const buyThis = catalogueWins ? bestCataloguePosting : null;
  if (buyThis !== null) {
    notes.push(
      `A catalogue cutter would measure better than your own: ${planKey(buyThis.plan)} (worst item fidelity ${round6(buyThis.worstFidelity)} against ${round6(bestOwnedPosting?.worstFidelity ?? 0)}).`,
    );
  }
  const rule = rulePlan === null ? null : (verdicts.get(planKey(rulePlan)) ?? null);
  return { rule, chosen, runnable, bestMeasured, runnerUp, buyThis, considered: all, notes };
}

/**
 * #910 — why each library cutter is not a candidate for this job, by the gates `candidatePlans`
 * applies: the work's cutter shape, the material/broken/catalogue/feeds gate, then the reach the
 * work needs.
 */
export function candidateRefusals(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions?: ReadonlyMap<string, ConditionSummary> | null,
  table?: readonly FeedsEntry[] | null,
): CandidateRefusal[] {
  const work = kindedWork(job);
  const shapes: Record<string, readonly string[]> = { ball: ['ball', 'bull'], flat: ['flat'], thread: ['thread'] };
  const fits = (entry: ToolLibraryEntry, kind: string): boolean =>
    kind === 'cone' ? vCone(entry.tool) !== null : (shapes[kind] ?? []).includes(entry.tool.shape);
  const mm = (v: number): string => `${Number(v.toFixed(3))} mm`;
  return tools.map((entry) => {
    const mine = work.filter((w) => fits(entry, w.kind));
    if (mine.length === 0) {
      const kinds = [...new Set(work.map((w) => w.kind))].join(' or ');
      return { key: entry.key, shapeOnly: true, reason: `a ${entry.tool.shape} cutter does none of this job's work (it needs ${kinds || 'no cutter'})` };
    }
    const material = materialRefusal(job, entry, catalogue, conditions, table ?? undefined, { ownedVouches: true });
    if (material !== null) return { key: entry.key, reason: material };
    const need = mine.reduce((m, w) => Math.max(m, w.reachMm), 0);
    const reach = reachOf(entry);
    if (reach !== null && need > reach + 1e-9) {
      return { key: entry.key, reason: `it reaches ${mm(reach)}, and the work is ${mm(need)} deep` };
    }
    return { key: entry.key, reason: 'it passes every gate, but no plan the search builds uses it' };
  });
}

function sameCutters(a: CandidatePlan, b: CandidatePlan): boolean {
  return planKey(a) === planKey(b);
}

/** The pinches a plan leaves joined, across every item — C's sentence source. */
export function joinedPinches(evaluation: PlanEvaluation): { item: EvaluatedItem; pinch: PinchFact }[] {
  const out: { item: EvaluatedItem; pinch: PinchFact }[] = [];
  for (const item of evaluation.items) {
    for (const pinch of item.pinches) {
      if (!pinch.separated) out.push({ item, pinch });
    }
  }
  return out;
}
