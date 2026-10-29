/**
 * #766 slice A — THE EVALUATOR: score a cutter plan by what it would actually cut.
 *
 * The rules-based picks ask proxies (2D area share, item kind, the tightest raised gap) and each
 * has failed on a real job (#762, #760, #765). This module answers the question the rule cannot:
 * GIVEN a job and a candidate plan — cutters in cut order, each with the items it owns — run the
 * app's own generator and geometry measures and report what the plan does, in numbers a chooser
 * can rank and a sentence can say:
 *
 *   - per item fidelity: the share of the design the plan reproduces, the characters it loses,
 *     and for raised text the PINCHES that stay joined (count and where) with the edge a V takes;
 *   - run time and tool changes;
 *   - risk: the reach margin (the same number is the holder clearance this codebase models) and,
 *     when the feeds table carries one, the chip load.
 *
 * PURE and CACHED. Every input is handed in — `ctx.tl` is the caller's Manifold toplevel, the
 * tool list and the catalogue are the caller's snapshots — so the module runs in the sim worker,
 * in a headless script and in a unit test with no store and no session of its own. A verdict is
 * memoised on (job content hash, plan, level, a signature of the context) so a search never pays
 * for the same simulation twice; `clearPlanEvaluations` empties it.
 *
 * LEVELS. `coarse` generates the plan and measures the geometry — the answer a candidate sweep
 * needs, without the dexel sweep. `full` adds the swept area under/over per item. Both return the
 * same shape; a field only `full` can fill is `null` at coarse.
 *
 * THE PLAN IS A DOCUMENT CHANGE, not a parallel model: `applyCutterPlan` writes the cutters into
 * a clone of the job the way the CLI's engrave path does (toolKey = cutters[0]; one setup with
 * `tools` and `toolItems`), and the evaluator runs the ordinary `engraveGenerate`. So the
 * evaluator judges the same program the app would post — and a house `inv:` key resolves through
 * the setup path's own tool list, which the legacy single-tool path cannot do.
 */

import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import type { EngraveJob } from '@/types/engraveJob';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow, FeedsEntry } from '@/engine/cnc/feeds';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import type { Tool } from '@/engine/cnc/tool';
import { vCone } from '@/engine/cnc/vProfile';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { jobFingerprint } from '@/engine/cnc/engrave/package';
import { kindedWork } from '@/engine/cnc/engrave/cutterPlan';
import { toPartPlan } from '@/engine/cnc/engrave/partPlan';
import {
  engraveGenerate,
  measureEngraving,
  raisedTextMeasure,
  type EngraveShopOpts,
} from './engraveGenerate';
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
  /** Design-vs-swept area disagreement, mm² — `full` only; `null` at coarse. */
  areaMismatchMm2: number | null;
  /** Raised text only: the pinches that stay joined or take edge (empty otherwise). */
  pinches: PinchFact[];
  /** Why the item is at fidelity 0 / unassigned; absent when the item is cut as designed. */
  reason?: string;
}

/** The evaluator's answer for one plan. */
export interface PlanEvaluation {
  ok: boolean;
  /** The first generator refusal, in operator words, when the plan does not post; else null. */
  refusal: string | null;
  items: EvaluatedItem[];
  /** Estimated cutting time, seconds — the programs' own CAM estimates summed. */
  seconds: number;
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

const cache = new Map<string, PlanEvaluation>();

/** Test hook: drop every memoised verdict. */
export function clearPlanEvaluations(): void {
  cache.clear();
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
  // caller's own list (the same seam the CLI and the sim worker use). One cutter is still one
  // program, and the generator documents the two paths as byte-identical there.
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
function toolFor(plan: CandidatePlan, tools: readonly ToolLibraryEntry[], key: string): Tool | null {
  const entry = tools.find((t) => t.key === key);
  return entry?.tool ?? null;
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
    calibration: ctx.calibration?.id ?? null,
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

/**
 * Score one plan. Pure given `ctx`; memoised on {@link planEvaluationKey}.
 */
export function evaluatePlan(
  job: EngraveJob,
  plan: CandidatePlan,
  ctx: EvalContext,
  opts: EvalOptions = {},
): PlanEvaluation {
  const key = planEvaluationKey(job, plan, ctx, opts);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const verdict = evaluate(job, plan, ctx, opts.level ?? 'coarse');
  cache.set(key, verdict);
  return verdict;
}

/** The uncached evaluation. */
function evaluate(
  job: EngraveJob,
  plan: CandidatePlan,
  ctx: EvalContext,
  level: 'coarse' | 'full',
): PlanEvaluation {
  const empty: PlanEvaluation = {
    ok: false,
    refusal: null,
    items: [],
    seconds: 0,
    toolChanges: Math.max(0, plan.cutters.length - 1),
    risk: { reachMarginMm: null, holderClearanceMm: null, chipLoadRatio: null },
  };
  if (plan.cutters.length === 0) return { ...empty, refusal: 'the plan names no cutter' };
  const missing = plan.cutters.map((c) => c.key).filter((k) => toolFor(plan, ctx.tools, k) === null);
  if (missing.length > 0) {
    return {
      ...empty,
      refusal: `the plan names ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the tool list`,
    };
  }
  // #766 slice A judges one setup. A multi-setup job's plan is per setup and is B's later slice.
  if (job.setups !== undefined && job.setups.length > 1) {
    return { ...empty, refusal: 'a multi-setup job is not evaluated by one plan yet' };
  }

  const applied = applyCutterPlan(job, plan);
  const tools = [...ctx.tools];
  const shop: EngraveShopOpts = {
    ...ctx.shop,
    tools: shopTools(ctx, tools),
    conditions: ctx.conditions ?? ctx.shop.conditions ?? null,
    ...(ctx.table === undefined ? {} : { feeds: ctx.table }),
  };
  const gen = engraveGenerate(
    ctx.tl,
    applied,
    toolFor(plan, tools, plan.cutters[0]!.key),
    ctx.catalogue,
    ctx.calibration,
    undefined,
    shop,
  );

  // ── The items, and which cutter is the LAST one to touch each ────────────────────────────────
  const work = kindedWork(applied);
  const planPart = toPartPlan(applied);
  const raisedOfItem = new Map<string, typeof planPart.raisedTexts>();
  for (const raised of planPart.raisedTexts) {
    const list = raisedOfItem.get(raised.id) ?? [];
    list.push(raised);
    raisedOfItem.set(raised.id, list);
  }
  /** The last cutter in order that owns the item, or rests over it (items = []). */
  const effectiveCutter = (itemId: string): string | null => {
    let found: string | null = null;
    for (const cutter of plan.cutters) {
      if (cutter.items.length === 0 || cutter.items.includes(itemId)) found = cutter.key;
    }
    return found;
  };
  const ownedByAny = (itemId: string): boolean =>
    plan.cutters.some((c) => c.items.includes(itemId));

  // Measures, once per cutter that the plan actually uses.
  const usedKeys = [...new Set(plan.cutters.map((c) => c.key))];
  const engravability = new Map<string, ReturnType<typeof measureEngraving>>();
  const raisedDetails = new Map<string, RaisedTextDetail[]>();
  for (const key of usedKeys) {
    const tool = toolFor(plan, tools, key);
    if (tool === null) continue;
    engravability.set(key, measureEngraving(ctx.tl, applied, tool));
    // The pinch detail rides the measure's OWN radius choice: take the rows the pick would see,
    // and ask the detail for exactly the radius each row was measured at.
    const rows = raisedTextMeasure(ctx.tl, applied, planPart)(tool);
    const radiusByCutaway = new Map(rows.map((row) => [row.cutawayId, row.cutterRadius]));
    const cone = vCone(tool) !== null;
    const details: RaisedTextDetail[] = [];
    for (const raised of planPart.raisedTexts) {
      const radius = radiusByCutaway.get(raised.id);
      if (radius === undefined) {
        // Nothing fuses this cutaway at the cutter's width: the letters read perfectly apart.
        continue;
      }
      details.push(
        ...measureRaisedTextDetail(ctx.tl, applied, [raised], () => radius, { cone }),
      );
    }
    raisedDetails.set(key, details);
  }

  /** The raised labels under one cutaway, measured with the cutter that finishes them. */
  const raisedFor = (itemId: string, cutterKey: string): RaisedTextDetail[] => {
    const raised = raisedOfItem.get(itemId);
    if (raised === undefined || raised.length === 0) return [];
    const ids = new Set(raised.map((r) => r.id));
    return (raisedDetails.get(cutterKey) ?? []).filter((d) => ids.has(d.cutawayId));
  };

  const items: EvaluatedItem[] = [];
  for (const w of work) {
    const cutterKey = effectiveCutter(w.id);
    const raised = cutterKey === null ? [] : raisedFor(w.id, cutterKey);
    if (cutterKey === null || (!ownedByAny(w.id) && !plan.cutters.some((c) => c.items.length === 0))) {
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
    const tool = toolFor(plan, tools, cutterKey);
    const rows = engravability.get(cutterKey) ?? [];
    const row = rows.find((r) => r.labelId === w.id) ?? null;
    const pinches: PinchFact[] = raised.flatMap((d) =>
      d.pinches.map((p) => ({
        between: [p.a, p.b] as [string, string],
        gapMm: p.gapMm,
        separated: p.separated,
        edgeLossMm: p.edgeLossMm,
        areaMm2: p.areaMm2,
      })),
    );
    // Raised text's fidelity is the raised measure's; a flat region's is the opening's share of
    // its glyph; an item a cutter reaches but that has no area measure (a hole, a thread, a
    // cut-out) is reproduced as designed when the generator posts it.
    const raisedFidelity = raised.length === 0 ? null : Math.min(...raised.map((d) => d.fidelity));
    const areaFidelity = row === null ? null : Math.min(1, Math.max(0, row.ratio));
    const fidelity = raisedFidelity ?? areaFidelity ?? (gen.ok ? 1 : 0);
    items.push({
      id: w.id,
      name: w.name,
      kind: w.kind,
      fidelity,
      charsLost: row?.emptyChars.length ?? 0,
      areaMismatchMm2: null,
      pinches,
    });
  }

  // ── Time and risk ────────────────────────────────────────────────────────────────────────────
  let seconds = 0;
  if (gen.ok) {
    for (const program of gen.programs) {
      seconds += program.cam?.estimatedSeconds ?? 0;
    }
  }
  let reachMargin: number | null = null;
  for (const cutter of plan.cutters) {
    const tool = toolFor(plan, tools, cutter.key);
    if (tool === null) continue;
    const reach = reachOfTool(tool);
    if (reach === null) continue;
    const owned = work.filter((w) => cutter.items.includes(w.id));
    const deepest = owned.reduce((m, w) => Math.max(m, w.reachMm), 0);
    const margin = reach - deepest;
    reachMargin = reachMargin === null ? margin : Math.min(reachMargin, margin);
  }

  const refusal = gen.ok
    ? null
    : (gen.errors[0]?.message ?? gen.findings.find((f) => f.severity === 'error')?.message ?? 'the plan does not post');

  return {
    ok: gen.ok,
    refusal,
    items,
    seconds,
    toolChanges: Math.max(0, plan.cutters.length - 1),
    risk: {
      reachMarginMm: reachMargin,
      holderClearanceMm: reachMargin,
      // The feeds table carries no chip-load column yet; a ratio here would be invented.
      chipLoadRatio: null,
    },
  };
}

/** The shop's tool list plus the evaluator's, deduped by key (the later entry wins). */
function shopTools(ctx: EvalContext, tools: readonly ToolLibraryEntry[]): ToolLibraryEntry[] {
  const byKey = new Map<string, ToolLibraryEntry>();
  for (const t of ctx.shop.tools ?? []) byKey.set(t.key, t);
  for (const t of tools) byKey.set(t.key, t);
  return [...byKey.values()];
}

