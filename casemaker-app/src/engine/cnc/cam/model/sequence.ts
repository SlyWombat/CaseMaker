/**
 * #961 — THE CUTTER SEQUENCE, CHOSEN BY COST.
 *
 * The vendor's shape on the tray reference (plan v2 §1, #955): the LARGEST FLAT that fits the
 * pockets roughs them, a smaller flat rests the corners it cannot enter, a ball finishes the curved
 * remainder at the stated scallop, and a chamfer breaks the rims. Makera runs 4 cutters in
 * 47.6 min on that part; the sequence this module returns must stay at or under the vendor's count
 * + 1 and its price at or under 2× the vendor's cycle (plan v2 §3).
 *
 * THE METHOD, and where it comes from (prior-art note on #961; Kiri:Moto, FreeCAD Path and
 * OpenCamLib are LOCAL REFERENCES only — the methods are re-implemented from their descriptions,
 * no code is copied or linked):
 *  - neither Kiri:Moto nor FreeCAD Path picks a sequence — both leave the ordered op list and its
 *    tools to the operator. The picker is ours to add.
 *  - the price is the app's own #927 estimate on the POSTED moves (`estimateCycleTerms`: moves +
 *    inter-op entries + spin-up) plus the shop's `toolChange.seconds` for every change after the
 *    loaded first cutter — the same model #858 uses (`planCostSeconds` in `smartPick.ts`), not a
 *    second time model.
 *  - candidates are pruned on GEOMETRY before any move is built (a flat that cannot enter the
 *    feature's inside corner, a flute shorter than the cut), so the expensive planner only sees
 *    candidates that can physically cut the part. The families are the vendor's own: flat, rest,
 *    ball, chamfer.
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

/** The op kinds the engine's plan carries (`PlannedOp['kind']` on #956's interface). */
export type PlannedOpKind = 'pocket' | 'contour' | 'rough' | 'rest' | 'finish' | 'pencil' | 'chamfer';

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
}

/** A candidate sequence, in execution order. */
export interface CandidateSequence {
  steps: SequenceStep[];
}

/**
 * One cutter's price. `estimateSeconds` is #927's own terms on that cutter's posted moves;
 * `toolChanges` is 0 for the loaded first cutter and 1 for every cutter after it; the total adds
 * the shop's allowance. This is the `CycleCost` #956's `SetupPlan.sequence[]` carries.
 */
export interface CycleCost {
  cutterKey: string;
  /** Σ #927 terms on this cutter's steps: moves + inter-op entries + spin-up, s. */
  estimateSeconds: number;
  /** Changes charged to this cutter: 0 for the first, 1 for each cutter after it. */
  toolChanges: number;
  /** The shop's `toolChange.seconds` used, s. */
  toolChangeSeconds: number;
  /** `estimateSeconds + toolChanges × toolChangeSeconds`. */
  totalSeconds: number;
}

/** A whole sequence's price. */
export interface SequenceCost {
  entries: CycleCost[];
  estimateSeconds: number;
  toolChanges: number;
  toolChangeSeconds: number;
  totalSeconds: number;
}

/** The planner seam: build one step's IR (#959/#960 own it), or null when it cannot be planned. */
export type PlanStep = (step: SequenceStep) => ToolpathIR | null;

export interface SequenceOptions {
  /** The machine's rapid model, #927's timing. */
  rapid: RapidEstimate;
  /** The shop's `toolChange.seconds` (#858). */
  toolChangeSeconds: number;
  /** Build the step's moves; the op implementations, or a stand-in. */
  planStep: PlanStep;
  /** Whether a cutter's feeds are rowed or the labelled fallback; absent → rowed. */
  feedsKind?: (tool: Tool) => 'row' | 'fallback';
}

/** One candidate the search looked at: its steps, its price or null, and why it did not win. */
export interface ConsideredSequence {
  steps: { kind: PlannedOpKind; cutterKey: string }[];
  cost: number | null;
  reason: string;
}

/** What the picker returns: the chosen steps, their price, and the field they beat. */
export interface SequenceChoice {
  steps: SequenceStep[];
  cost: SequenceCost;
  considered: ConsideredSequence[];
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

/** Why a cutter cannot pass through the features' narrowest openings, or null when it can. */
function openingRefusal(tool: Tool, features: readonly SequenceFeature[]): string | null {
  const d = diameterOf(tool);
  if (d === null) return 'it states no cutting diameter';
  for (const feature of features) {
    if (feature.minOpeningMm !== null && feature.minOpeningMm !== undefined
        && d > feature.minOpeningMm + EPS) {
      return `⌀${d} cannot enter the ${feature.minOpeningMm} mm opening`;
    }
  }
  return null;
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

/** Why a flat cannot reach the features' tightest inside corner, or null when it can. */
function cornerRefusal(tool: Tool, features: readonly SequenceFeature[]): string | null {
  const d = diameterOf(tool);
  if (d === null) return 'it states no cutting diameter';
  const radius = d / 2;
  for (const feature of features) {
    if (feature.cornerRadiusMm !== null && feature.cornerRadiusMm !== undefined
        && radius > feature.cornerRadiusMm + EPS) {
      return `⌀${d} cannot enter the ${feature.cornerRadiusMm} mm corner`;
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

/** True when every pinned kind this candidate covers chose the pinned cutter. */
function honoursPins(steps: readonly SequenceStep[], pinned: Partial<Record<PlannedOpKind, string>>): boolean {
  for (const step of steps) {
    const key = pinned[step.kind];
    if (key !== undefined && key !== step.cutter.key) return false;
  }
  return true;
}

/**
 * The candidates worth pricing, vendor-shaped: for each flat that can rough the pockets, with and
 * without a smaller rest flat, crossed with each usable ball (when the part is curved) and each
 * usable chamfer (when it has rims). Pairs that cannot cut the part are pruned on geometry alone —
 * no IR is built for them.
 */
export function candidateSequences(
  demand: SequenceDemand,
  cutters: CutterCandidates,
  opts?: Pick<SequenceOptions, 'feedsKind'>,
): CandidateSequence[] {
  const features = demand.features;
  const pocketFeatures = features.filter((f) => f.kind === 'pocket' || f.kind === 'contour');
  const curvedFeatures = features.filter((f) => f.kind === 'curved');
  const rimFeatures = features.filter((f) => f.kind === 'rim');
  const pinned = cutters.pinned ?? {};

  const all = allCutters(cutters, opts);
  // A primary flat must pass the pockets' openings and reach the deepest floor it roughs. Its
  // RADIUS is not constrained by a corner: roughing a pocket with a corner it cannot enter is
  // exactly what the rest cutter is for (the tray's ⌀6 → ⌀3.175 is this rule).
  const roughFeatures = [...pocketFeatures, ...curvedFeatures];
  const fitsPrimary = (tool: Tool): boolean =>
    openingRefusal(tool, pocketFeatures) === null && depthRefusal(tool, roughFeatures) === null;
  const flats = all.filter((c) => isFlat(c.tool) && fitsPrimary(c.tool));
  const ballsAll = all.filter((c) => isBall(c.tool));
  const balls = ballsAll.filter((c) => ballRefusal(c.tool, curvedFeatures) === null);
  const chamfers = all.filter((c) => isChamfer(c.tool) && chamferRefusal(c.tool) === null);

  // A part with pockets needs SOME round tool that reaches the corner. The vendor shape uses a
  // flat; a ball is the fallback only when no flat fits (never on a part a flat can cut).
  const roughs: CandidateCutter[] = flats.length > 0
    ? flats
    : ballsAll.filter((c) => fitsPrimary(c.tool));

  if (pocketFeatures.length > 0 && roughs.length === 0) return [];
  if (curvedFeatures.length > 0 && balls.length === 0) return [];
  if (rimFeatures.length > 0 && chamfers.length === 0) return [];

  const flatChoices = roughs
    .slice()
    .sort((a, b) => (diameterOf(b.tool) ?? 0) - (diameterOf(a.tool) ?? 0));

  // The rest cutter is a smaller flat that also fits the pockets' openings and tightest corner.
  const restCandidates = all
    .filter((c) => isFlat(c.tool)
      && openingRefusal(c.tool, pocketFeatures) === null
      && cornerRefusal(c.tool, pocketFeatures) === null
      && depthRefusal(c.tool, pocketFeatures) === null)
    .sort((a, b) => (diameterOf(b.tool) ?? 0) - (diameterOf(a.tool) ?? 0));

  const ballChoices: (CandidateCutter | null)[] = curvedFeatures.length > 0 ? balls : [null];
  const chamferChoices: (CandidateCutter | null)[] = rimFeatures.length > 0 ? chamfers : [null];

  const out: CandidateSequence[] = [];
  const seen = new Set<string>();

  const add = (steps: SequenceStep[]): void => {
    if (!honoursPins(steps, pinned)) return;
    const signature = steps.map((s) => `${s.kind}:${s.cutter.key}`).join('+');
    if (seen.has(signature)) return;
    seen.add(signature);
    out.push({ steps });
  };

  const flatSteps = (cutter: CandidateCutter, role: CutterRole): SequenceStep[] => {
    const steps: SequenceStep[] = [];
    const pinnedHere = (kind: PlannedOpKind): boolean => pinned[kind] === cutter.key;
    if (pocketFeatures.length > 0) {
      steps.push({
        kind: 'pocket',
        role,
        cutter: choiceOf(cutter, pinnedHere('pocket')),
        regionIds: pocketFeatures.map((f) => f.id),
      });
    }
    if (curvedFeatures.length > 0) {
      steps.push({
        kind: 'rough',
        role,
        cutter: choiceOf(cutter, pinnedHere('rough')),
        regionIds: curvedFeatures.map((f) => f.id),
      });
    }
    return steps;
  };

  for (const primary of flatChoices) {
    const pd = diameterOf(primary.tool) ?? 0;
    // A corner tighter than the primary's radius is not left to the cost model: without a rest
    // cutter that corner is uncut, so the rest step is REQUIRED. When the primary fits every
    // corner the rest is optional and the price decides (usually against: a change costs 91.4 s).
    const needsRest = pocketFeatures.some(
      (f) => f.cornerRadiusMm !== null && f.cornerRadiusMm !== undefined
        && pd / 2 > f.cornerRadiusMm + EPS,
    );
    const smaller = restCandidates.filter((r) => (diameterOf(r.tool) ?? 0) < pd - EPS);
    const restOptions: (CandidateCutter | null)[] = needsRest ? smaller : [null, ...smaller];
    if (needsRest && restOptions.length === 0) continue;
    const base = flatSteps(primary, 'flat');
    for (const rest of restOptions) {
      if (rest !== null) {
        const rd = diameterOf(rest.tool) ?? 0;
        if (!(rd < pd - EPS)) continue;
        if (cornerRefusal(rest.tool, pocketFeatures) !== null) continue;
      }
      for (const ball of ballChoices) {
        for (const chamfer of chamferChoices) {
          const steps = base.slice();
          if (rest !== null) {
            steps.push({
              kind: 'rest',
              role: 'rest',
              cutter: choiceOf(rest, pinned.rest === rest.key),
              regionIds: pocketFeatures.map((f) => f.id),
            });
          }
          if (ball !== null) {
            steps.push({
              kind: 'finish',
              role: 'ball',
              cutter: choiceOf(ball, pinned.finish === ball.key),
              regionIds: curvedFeatures.map((f) => f.id),
            });
          }
          if (chamfer !== null) {
            steps.push({
              kind: 'chamfer',
              role: 'chamfer',
              cutter: choiceOf(chamfer, pinned.chamfer === chamfer.key),
              regionIds: rimFeatures.map((f) => f.id),
            });
          }
          if (steps.length > 0) add(steps);
        }
      }
    }
  }

  // The demanded kinds must all be present: a pin on a kind the candidate cannot serve drops it.
  return out.filter((c) => {
    const kinds = new Set(c.steps.map((s) => s.kind));
    if (pocketFeatures.length > 0 && !kinds.has('pocket')) return false;
    if (curvedFeatures.length > 0 && !kinds.has('finish')) return false;
    if (rimFeatures.length > 0 && !kinds.has('chamfer')) return false;
    return true;
  });
}

/**
 * Price one candidate by #927's terms on its posted moves + the shop's allowance per change. Null
 * when any step cannot be planned — an unpostable candidate is not a cheap one.
 */
export function priceSequence(
  sequence: CandidateSequence,
  opts: Pick<SequenceOptions, 'rapid' | 'toolChangeSeconds' | 'planStep'>,
): SequenceCost | null {
  const seconds = new Map<string, number>();
  const order: string[] = [];
  for (const step of sequence.steps) {
    const ir = opts.planStep(step);
    if (ir === null) return null;
    const total = estimateCycleTerms(ir, opts.rapid).totalSeconds;
    seconds.set(step.cutter.key, (seconds.get(step.cutter.key) ?? 0) + total);
    if (!order.includes(step.cutter.key)) order.push(step.cutter.key);
  }
  if (order.length === 0) return null;
  const entries: CycleCost[] = order.map((key, i) => {
    const estimateSeconds = seconds.get(key) ?? 0;
    const toolChanges = i === 0 ? 0 : 1;
    return {
      cutterKey: key,
      estimateSeconds,
      toolChanges,
      toolChangeSeconds: opts.toolChangeSeconds,
      totalSeconds: estimateSeconds + toolChanges * opts.toolChangeSeconds,
    };
  });
  const estimateSeconds = entries.reduce((sum, e) => sum + e.estimateSeconds, 0);
  const toolChanges = entries.reduce((sum, e) => sum + e.toolChanges, 0);
  return {
    entries,
    estimateSeconds,
    toolChanges,
    toolChangeSeconds: opts.toolChangeSeconds,
    totalSeconds: entries.reduce((sum, e) => sum + e.totalSeconds, 0),
  };
}

/** The rank: house before catalogue, rowed feeds before fallback, then the price, then the key. */
function rankOf(sequence: CandidateSequence, cost: SequenceCost): readonly [number, number, number, string] {
  const catalogue = sequence.steps.filter((s) => !s.cutter.house).length;
  const fallback = sequence.steps.filter((s) => s.cutter.feeds === 'fallback').length;
  const signature = sequence.steps.map((s) => `${s.kind}:${s.cutter.key}`).join('+');
  return [catalogue, fallback, cost.totalSeconds, signature] as const;
}

function compareRank(a: readonly [number, number, number, string], b: readonly [number, number, number, string]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a[3]! < b[3]! ? -1 : a[3]! > b[3]! ? 1 : 0;
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
    throw new Error(
      'no cutter sequence can be planned for this demand: no cutter in the house or catalogue '
      + 'can cut every feature (a flat wide for the tightest corner, a flute short of the deepest '
      + 'floor, or a missing ball/chamfer) — check the cutter set and the pinned keys',
    );
  }

  const priced = candidates.map((sequence) => ({ sequence, cost: priceSequence(sequence, opts) }));
  const considered: ConsideredSequence[] = priced.map(({ sequence, cost }) => ({
    steps: sequence.steps.map((s) => ({ kind: s.kind, cutterKey: s.cutter.key })),
    cost: cost === null ? null : cost.totalSeconds,
    reason: cost === null ? 'an op in this sequence could not be planned' : '',
  }));

  const feasible = priced
    .filter((p): p is { sequence: CandidateSequence; cost: SequenceCost } => p.cost !== null)
    .sort((a, b) => compareRank(rankOf(a.sequence, a.cost), rankOf(b.sequence, b.cost)));

  if (feasible.length === 0) {
    throw new Error(
      'no cutter sequence can be planned for this demand: every candidate had a step the ops '
      + `could not post (${considered.length} candidate${considered.length === 1 ? '' : 's'} priced)`,
    );
  }

  const best = feasible[0]!;
  return { steps: best.sequence.steps, cost: best.cost, considered };
}
