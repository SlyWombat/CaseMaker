/**
 * #766 slice A — THE EVALUATOR: score a cutter plan by what it would actually cut.
 *
 * The rules-based picks ask proxies (2D area share, item kind, the tightest raised gap) and each
 * has failed on a real job (#762, #760, #765). This module answers the question the rule cannot:
 * GIVEN a job and a candidate plan — cutters in cut order, each with the items it owns — measure
 * and report what the plan does, in numbers a chooser can rank and a sentence can say:
 *
 *   - per item fidelity: the share of the design the plan reproduces, the characters it loses,
 *     and for raised text the PINCHES that stay joined (count and where) with the edge a V takes;
 *   - run time and tool changes;
 *   - risk: the reach margin (the same number is the holder clearance this codebase models) and,
 *     when the feeds table carries one, the chip load.
 *
 * TWO STAGES, because a search tries many plans and only a few deserve the full price:
 *
 *   - COARSE is MEASURE-ONLY. It generates nothing: per cutter it runs the geometry measures
 *     (`measureEngraving`, the raised-text detail) against a cloned job, and assembles each
 *     item's fidelity from them. The per-cutter measures are cached on the JOB, not on the plan,
 *     so a hundred plans that reuse the same cutters pay for each cutter once. `seconds` is null
 *     here (a run time needs the CAM) and `ok` means "this plan is structurally evaluable", not
 *     "it posts".
 *   - FULL also runs the real `engraveGenerate` — so the verdict carries the generator's refusal,
 *     the programs' CAM estimates, and (when every program could be swept on the stock the last
 *     one left) the oracle's worst under- and over-cut for the run. Only the top two or three
 *     candidates need this.
 *
 * PURE and CACHED. Every input is handed in — `ctx.tl` is the caller's Manifold toplevel, the
 * tool list and the catalogue are the caller's snapshots — so the module runs in the sim worker,
 * in a headless script and in a unit test with no store and no session of its own. `applyCutterPlan`
 * writes the plan into a clone of the job the way the CLI's engrave path does (toolKey =
 * cutters[0]; one setup with `tools` and `toolItems`), so the evaluator judges the same program the
 * app would post — and a house `inv:` key resolves through the setup path's own tool list, which
 * the legacy single-tool path cannot do.
 */

import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import type { EngraveJob } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow, FeedsEntry } from '@/engine/cnc/feeds';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import type { Tool } from '@/engine/cnc/tool';
import { jobMachine } from '@/engine/cnc/calibration';
import { vCone } from '@/engine/cnc/vProfile';
import { jobSetups, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { jobFingerprint } from '@/engine/cnc/engrave/package';
import { kindedWork } from '@/engine/cnc/engrave/cutterPlan';
import { toPartPlan, type PartPlan } from '@/engine/cnc/engrave/partPlan';
import type { OracleReport } from '@/engine/cnc/engrave/oracle';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import {
  engraveGenerate,
  measureEngraving,
  raisedTextMeasure,
  type EngraveGenerated,
  type EngraveShopOpts,
} from './engraveGenerate';
import { createSimSession, type SimLoadOk } from './session';
import { measureRaisedTextDetail, type RaisedTextDetail } from './engraveGeometry';

/** One cutter in a candidate plan: its key, and the item ids it owns (`[]` = rest over earlier work). */
export interface CandidateCutter {
  key: string;
  items: readonly string[];
}

/** A candidate plan: cutters in cut order, and where each came from (#766 C's 'buy this'). */
export interface CandidatePlan {
  cutters: readonly CandidateCutter[];
  /** `owned` (the location's library) or `catalogue` (Makera's) per key. */
  source: Readonly<Record<string, 'owned' | 'catalogue'>>;
}

/**
 * #765/#766 — one measured pinch a raised label keeps. `between` names the two glyph components
 * the way the sentence will say them (`['S', 'o']`), falling back to their ordinal when a component
 * cannot be matched to a character (`['glyph 2', 'glyph 3']`).
 */
export interface PinchFact {
  between: [string, string];
  /** The design's clearance at this pinch, mm. */
  gapMm: number;
  /** True when nothing bridges the two components (a V within its edge-loss tolerance included). */
  separated: boolean;
  /** Per side, mm: a cone's top-face opening overshoot over the half-gap (0 for a flat). */
  edgeLossMm: number;
  /** The field still standing in the pinch, mm² (0 when separated). */
  areaMm2: number;
}

/** One item's evaluated fidelity. */
export interface EvaluatedItem {
  id: string;
  name: string;
  /** The cutter class the item's own operation demands (#762's four). */
  kind: 'flat' | 'cone' | 'thread' | 'ball';
  /** 0…1: the share of the item's design the plan reproduces. The components are authoritative. */
  fidelity: number;
  /** Characters whose cut region is empty at this plan's effective cutter. */
  charsLost: number;
  /**
   * Design-vs-cut area disagreement, mm². Raised text fills it from its own pinch measure (the
   * field left standing); other items are judged by the plan's swept `sweep` block, and are null
   * here when nothing per item was measured.
   */
  areaMismatchMm2: number | null;
  /** Raised text only: the pinches that stay joined or take edge (empty otherwise). */
  pinches: PinchFact[];
  /** Why the item is at fidelity 0 / unassigned; absent when the item is cut as designed. */
  reason?: string;
}

/** The oracle's whole-run verdict, on the `full` level — the swept area disagreement. */
export interface PlanSweep {
  /** Worst predicted-but-not-cut area over the run's levels, mm². */
  worstUnderMm2: number;
  /** Worst cut-but-not-predicted area over the run's levels, mm². */
  worstOverMm2: number;
  /** The derived comparison band the verdict used, mm. */
  bandMm: number;
  frame: 'work' | 'surface';
}

/** The evaluator's answer for one plan. */
export interface PlanEvaluation {
  /**
   * COARSE: the plan is structurally evaluable (every key resolves, every item is owned or a rest
   * pass follows). FULL: the real generator posted every program.
   */
  ok: boolean;
  /** The first generator refusal, in operator words (`full` only); null otherwise. */
  refusal: string | null;
  items: EvaluatedItem[];
  /**
   * Estimated cutting time, seconds — the programs' own CAM estimates summed. NULL at coarse: a
   * run time needs the CAM, which coarse deliberately does not pay for.
   */
  seconds: number | null;
  toolChanges: number;
  risk: {
    /**
     * The tightest reach margin over the plan, mm: the cutter's flute or shoulder less the
     * deepest cut it owns. `null` when no cutter states a reach. This IS the holder-clearance
     * number this codebase models (a cutter with no reach check has no separate holder record).
     */
    reachMarginMm: number | null;
    /** The same margin, named for its second role — see {@link PlanEvaluation.risk.reachMarginMm}. */
    holderClearanceMm: number | null;
    /** Feed per tooth vs the catalogue's chip load. `null` until the feeds table carries one. */
    chipLoadRatio: number | null;
  };
  /**
   * FULL only: the swept comparison for the whole run, when every program could be swept on the
   * stock the previous one left. Null at coarse, and null with `sweepNote` when the chain broke.
   */
  sweep?: PlanSweep | null;
  /** Why `sweep` is null on a full evaluation that generated: the chain's stop, in words. */
  sweepNote?: string | null;
}

/** Everything the evaluator may read, handed in by the caller. */
export interface EvalContext {
  tl: ManifoldToplevel;
  /** The library the plan's keys resolve in (owned cutters + catalogue entries). */
  tools: readonly ToolLibraryEntry[];
  catalogue: readonly FeedCatalogueRow[];
  shop: EngraveShopOpts;
  calibration: MachineCalibration | null;
  /** The house's feed table, when the caller has one; absent = the worker's fallback. */
  table?: readonly FeedsEntry[] | null;
  conditions?: ReadonlyMap<string, ConditionSummary> | null;
}

export interface EvalOptions {
  level?: 'coarse' | 'full';
}

/** The per-cutter measures, cached on the job's content — the plan never changes them. */
interface CutterMeasures {
  engravability: ReturnType<typeof measureEngraving>;
  raisedDetails: RaisedTextDetail[];
}

const planCache = new Map<string, PlanEvaluation>();
const cutterCache = new Map<string, CutterMeasures>();
const partCache = new Map<string, { part: PartPlan; raisedOf: Map<string, PartPlan['raisedTexts']> }>();

/** Test hook: drop every memoised verdict and per-cutter measure. */
export function clearPlanEvaluations(): void {
  planCache.clear();
  cutterCache.clear();
  partCache.clear();
}

/**
 * Write a candidate plan into a clone of the job the way the CLI does (#760/#762): the first
 * cutter is the job's tool, and one setup carries the cut order (`tools`) and which items each
 * owns (`toolItems`). One cutter is still one program.
 */
export function applyCutterPlan(job: EngraveJob, plan: CandidatePlan): EngraveJob {
  const applied: EngraveJob = structuredClone(job);
  const first = plan.cutters[0];
  if (first === undefined) return applied;
  applied.toolKey = first.key;
  // EVERY plan is written through the setup path — one cutter included. The legacy single-tool
  // document validates its `toolKey` against the built-in registry (`jobTool`), which by design
  // does not hold the location's `inv:` cutters; the setup path resolves each cutter from the
  // caller's own list (the same seam the CLI and the sim worker use).
  const setup = jobSetups(applied)[0]!;
  applied.setups = [
    {
      ...setup,
      tools: plan.cutters.map((c) => c.key),
      toolItems: Object.fromEntries(plan.cutters.map((c) => [c.key, [...c.items]])),
    },
  ];
  return applied;
}

/** The tool for a plan key, or null. */
function toolFor(tools: readonly ToolLibraryEntry[], key: string): Tool | null {
  return tools.find((t) => t.key === key)?.tool ?? null;
}

/** The flute/shoulder reach of a tool, mm — the body that must clear the stock (the `reachOf` rule). */
function reachOfTool(tool: Tool): number | null {
  return tool.shoulderLength ?? tool.fluteLength;
}

/** A stable signature of everything outside the job that changes a verdict. */
function contextSignature(ctx: EvalContext, level: 'coarse' | 'full'): string {
  return JSON.stringify({
    level,
    tools: ctx.tools.map((t) => [t.key, t.tool]),
    catalogue: ctx.catalogue.length,
    shop: ctx.shop,
    calibration: ctx.calibration === null ? null : [ctx.calibration.machineId, ctx.calibration.measuredAt],
    table: ctx.table?.length ?? null,
    conditions: ctx.conditions === undefined || ctx.conditions === null ? null : [...ctx.conditions.keys()],
  });
}

/** The cache key the search can rely on (job content hash + plan + level + context). */
export function planEvaluationKey(job: EngraveJob, plan: CandidatePlan, ctx: EvalContext, opts: EvalOptions = {}): string {
  const level = opts.level ?? 'coarse';
  return [
    jobFingerprint(job),
    JSON.stringify(plan.cutters.map((c) => [c.key, [...c.items]])),
    JSON.stringify(plan.source),
    contextSignature(ctx, level),
  ].join('\u0000');
}

/** Score one plan. Pure given `ctx`; memoised on {@link planEvaluationKey}. */
export function evaluatePlan(
  job: EngraveJob,
  plan: CandidatePlan,
  ctx: EvalContext,
  opts: EvalOptions = {},
): PlanEvaluation {
  const key = planEvaluationKey(job, plan, ctx, opts);
  const hit = planCache.get(key);
  if (hit !== undefined) return hit;
  const level = opts.level ?? 'coarse';
  const verdict = level === 'full' ? evaluateFull(job, plan, ctx) : evaluateCoarse(job, plan, ctx);
  planCache.set(key, verdict);
  return verdict;
}

/** The job's PartPlan and the cutaways that leave raised text, built once per job content. */
function partOf(job: EngraveJob): { part: PartPlan; raisedOf: Map<string, PartPlan['raisedTexts']> } {
  const key = jobFingerprint(job);
  const hit = partCache.get(key);
  if (hit !== undefined) return hit;
  const part = toPartPlan(job);
  const raisedOf = new Map<string, PartPlan['raisedTexts']>();
  for (const raised of part.raisedTexts) {
    const list = raisedOf.get(raised.id) ?? [];
    list.push(raised);
    raisedOf.set(raised.id, list);
  }
  const built = { part, raisedOf };
  partCache.set(key, built);
  return built;
}

/**
 * The per-cutter measures, cached on (job, cutter). The SAME measures answer any plan using the
 * cutter, which is what makes a candidate sweep affordable.
 */
function measuresFor(
  job: EngraveJob,
  part: PartPlan,
  tool: Tool,
  ctx: EvalContext,
): CutterMeasures {
  const key = `${jobFingerprint(job)}\u0000${JSON.stringify(tool)}`;
  const hit = cutterCache.get(key);
  if (hit !== undefined) return hit;
  const engravability = measureEngraving(ctx.tl, job, tool);
  // The pinch detail rides the raised measure's OWN radius choice: take the rows the pick would
  // see, and ask the detail for exactly the radius each row was measured at.
  const rows = raisedTextMeasure(ctx.tl, job, part)(tool);
  const radiusByCutaway = new Map(rows.map((row) => [row.cutawayId, row.cutterRadius]));
  const cone = vCone(tool) !== null;
  const raisedDetails: RaisedTextDetail[] = [];
  for (const raised of part.raisedTexts) {
    const radius = radiusByCutaway.get(raised.id);
    // Nothing fuses this cutaway at the cutter's width: the letters read perfectly apart.
    if (radius === undefined) continue;
    raisedDetails.push(...measureRaisedTextDetail(ctx.tl, job, [raised], () => radius, { cone }));
  }
  const built = { engravability, raisedDetails };
  cutterCache.set(key, built);
  return built;
}

/** The cutters a plan uses, resolved; null when any key is not in the list. */
function resolveCutters(plan: CandidatePlan, tools: readonly ToolLibraryEntry[]): string | null {
  const missing = plan.cutters.map((c) => c.key).filter((k) => toolFor(tools, k) === null);
  return missing.length === 0 ? null : `the plan names ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the tool list`;
}

/** The last cutter in order that owns the item, or rests over it (`items = []`). */
function effectiveCutter(plan: CandidatePlan, itemId: string): string | null {
  let found: string | null = null;
  for (const cutter of plan.cutters) {
    if (cutter.items.length === 0 || cutter.items.includes(itemId)) found = cutter.key;
  }
  return found;
}

/** The work each item asks for, and the plan's per-item rows, from the measures alone. */
function measureItems(
  job: EngraveJob,
  plan: CandidatePlan,
  ctx: EvalContext,
  tools: readonly ToolLibraryEntry[],
): EvaluatedItem[] {
  const { part, raisedOf } = partOf(job);
  const work = kindedWork(job);
  const hasRest = plan.cutters.some((c) => c.items.length === 0);
  const items: EvaluatedItem[] = [];
  for (const w of work) {
    const cutterKey = effectiveCutter(plan, w.id);
    if (cutterKey === null || (!plan.cutters.some((c) => c.items.includes(w.id)) && !hasRest)) {
      items.push({
        id: w.id,
        name: w.name,
        kind: w.kind,
        fidelity: 0,
        charsLost: 0,
        areaMismatchMm2: null,
        pinches: [],
        reason: `no cutter in the plan owns this item (${w.why})`,
      });
      continue;
    }
    const tool = toolFor(tools, cutterKey);
    if (tool === null) continue;
    const measures = measuresFor(job, part, tool, ctx);
    const raisedIds = new Set((raisedOf.get(w.id) ?? []).map((r) => r.id));
    const raised = measures.raisedDetails.filter((d) => raisedIds.has(d.cutawayId));
    const row = measures.engravability.find((r) => r.labelId === w.id) ?? null;
    const pinches: PinchFact[] = raised.flatMap((d) =>
      d.pinches.map((p) => ({
        between: [p.a, p.b] as [string, string],
        gapMm: p.gapMm,
        separated: p.separated,
        edgeLossMm: p.edgeLossMm,
        areaMm2: p.areaMm2,
      })),
    );
    // Raised text's fidelity and its under-cut area are the raised measure's; a flat region's is
    // the opening's share of its glyph; an item a cutter reaches but that has no area measure (a
    // hole, a thread, a cut-out) is reproduced as designed when the plan places it.
    const raisedFidelity = raised.length === 0 ? null : Math.min(...raised.map((d) => d.fidelity));
    const areaFidelity = row === null ? null : Math.min(1, Math.max(0, row.ratio));
    const fidelity = raisedFidelity ?? areaFidelity ?? 1;
    const raisedSliver = raised.length === 0 ? null : raised.reduce((sum, d) => sum + d.sliverAreaMm2, 0);
    items.push({
      id: w.id,
      name: w.name,
      kind: w.kind,
      fidelity,
      charsLost: row?.emptyChars.length ?? 0,
      areaMismatchMm2: raisedSliver,
      pinches,
    });
  }
  return items;
}

/** The tighter reach margin over the plan, mm. */
function measureReach(job: EngraveJob, plan: CandidatePlan, tools: readonly ToolLibraryEntry[]): number | null {
  const work = kindedWork(job);
  let margin: number | null = null;
  for (const cutter of plan.cutters) {
    const tool = toolFor(tools, cutter.key);
    if (tool === null) continue;
    const reach = reachOfTool(tool);
    if (reach === null) continue;
    const owned = work.filter((w) => cutter.items.includes(w.id));
    const deepest = owned.reduce((m, w) => Math.max(m, w.reachMm), 0);
    const here = reach - deepest;
    margin = margin === null ? here : Math.min(margin, here);
  }
  return margin;
}

function baseVerdict(plan: CandidatePlan): Pick<PlanEvaluation, 'toolChanges' | 'risk'> {
  return {
    toolChanges: Math.max(0, plan.cutters.length - 1),
    risk: { reachMarginMm: null, holderClearanceMm: null, chipLoadRatio: null },
  };
}

/** COARSE — measures only; no generator, no CAM. */
function evaluateCoarse(job: EngraveJob, plan: CandidatePlan, ctx: EvalContext): PlanEvaluation {
  const base = baseVerdict(plan);
  if (plan.cutters.length === 0) return { ...base, ok: false, refusal: 'the plan names no cutter', items: [], seconds: null };
  const missing = resolveCutters(plan, ctx.tools);
  if (missing !== null) return { ...base, ok: false, refusal: missing, items: [], seconds: null };
  if (job.setups !== undefined && job.setups.length > 1) {
    return { ...base, ok: false, refusal: 'a multi-setup job is not evaluated by one plan yet', items: [], seconds: null };
  }
  const reach = measureReach(job, plan, ctx.tools);
  return {
    ...base,
    ok: true,
    refusal: null,
    items: measureItems(job, plan, ctx, ctx.tools),
    seconds: null,
    risk: { reachMarginMm: reach, holderClearanceMm: reach, chipLoadRatio: null },
  };
}

/** FULL — the coarse measures, then the real generator and (when it posts) the swept comparison. */
function evaluateFull(job: EngraveJob, plan: CandidatePlan, ctx: EvalContext): PlanEvaluation {
  const coarse = evaluateCoarse(job, plan, ctx);
  if (!coarse.ok) return coarse;
  const applied = applyCutterPlan(job, plan);
  const shop: EngraveShopOpts = {
    ...ctx.shop,
    tools: shopTools(ctx),
    conditions: ctx.conditions ?? ctx.shop.conditions ?? null,
    ...(ctx.table === undefined ? {} : { feeds: ctx.table }),
  };
  const gen = engraveGenerate(
    ctx.tl,
    applied,
    toolFor(ctx.tools, plan.cutters[0]!.key),
    ctx.catalogue,
    ctx.calibration,
    undefined,
    shop,
  );
  const seconds = gen.ok ? gen.programs.reduce((sum, program) => sum + (program.cam?.estimatedSeconds ?? 0), 0) : null;
  const refusal = gen.ok
    ? null
    : (gen.errors[0]?.message ?? gen.findings.find((f) => f.severity === 'error')?.message ?? 'the plan does not post');
  const { sweep, sweepNote } = gen.ok ? sweepPlan(ctx, applied, gen, shop) : { sweep: null, sweepNote: null };
  // A plan that does not post still carries its measured fidelity: the search may rank it and the
  // sentence can say what it would cut, but `ok` is false and `refusal` names why.
  const items = coarse.items.map((item) =>
    item.reason === undefined && !gen.ok ? { ...item, fidelity: Math.min(item.fidelity, 1) } : item,
  );
  return { ...coarse, ok: gen.ok, refusal, items, seconds, sweep, sweepNote };
}

/**
 * Sweep the run's programs IN ORDER, each on the stock the last one left, and ask the oracle for
 * the whole run. The exact engine seeds a program from an earlier program's removal mesh; the
 * column engine (a V-bit) cannot, so a program it takes is swept FROM THE BLANK with the fact
 * stated, and the run's oracle is then not reported (`sweep` stays null) — a comparison against
 * the wrong stock would be a picture of a cut that will not happen.
 */
function sweepPlan(
  ctx: EvalContext,
  applied: EngraveJob,
  gen: EngraveGenerated,
  shop: EngraveShopOpts,
): { sweep: PlanSweep | null; sweepNote: string | null } {
  let prior: NodeMeshOutput | null = null;
  let report: OracleReport | null = null;
  let note: string | null = null;
  const mill = jobMachine(applied, ctx.calibration);
  const setup = toSetup(applied, mill, shop.mount?.fixture ?? undefined, shop.bed ?? null);
  for (let i = 0; i < gen.programs.length; i++) {
    const program = gen.programs[i]!;
    const tool = toolFor([...(shop.tools ?? [])], program.toolKey);
    if (tool === null) {
      note = `program ${i + 1} names ${program.toolKey}, which is not in the tool list`;
      break;
    }
    const session = createSimSession(ctx.tl);
    try {
      const opts = { breakthroughMm: applied.breakthrough, ...(prior === null ? {} : { priorRemoval: prior }) };
      let load = session.load(program.nc, setup, tool, applied.machineId, opts);
      if (!load.ok && prior !== null && load.diagnostics.some((d) => d.code === 'prior-removal-column')) {
        note =
          'the column engine cannot start from an earlier program’s material; the V program was swept ' +
          'from the blank, so the run’s swept comparison is not reported';
        load = session.load(program.nc, setup, tool, applied.machineId, { breakthroughMm: applied.breakthrough });
      }
      if (!load.ok) {
        note = `program ${i + 1} was refused by the simulation: ${load.diagnostics.map((d) => d.message).join('; ')}`;
        break;
      }
      const ok = load as SimLoadOk;
      prior = ok.meshes.removal;
      if (i === gen.programs.length - 1) report = session.oracle(gen.predicted);
    } finally {
      session.dispose();
    }
  }
  if (note !== null || report === null) return { sweep: null, sweepNote: note ?? 'the run produced no sweep to compare' };
  return {
    sweep: {
      worstUnderMm2: report.worst.underCut,
      worstOverMm2: report.worst.overCut,
      bandMm: report.band,
      frame: report.frame ?? 'work',
    },
    sweepNote: null,
  };
}

/** The shop's tool list plus the evaluator's, deduped by key (the evaluator's entry wins). */
function shopTools(ctx: EvalContext): ToolLibraryEntry[] {
  const byKey = new Map<string, ToolLibraryEntry>();
  for (const t of ctx.shop.tools ?? []) byKey.set(t.key, t);
  for (const t of ctx.tools) byKey.set(t.key, t);
  return [...byKey.values()];
}
