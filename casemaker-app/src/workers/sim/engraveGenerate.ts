/**
 * Generate → verify, headless (#206). Turns an `EngraveJob` into the exact `.nc` text that will
 * be saved, running every gate the pipeline has BEFORE the text exists:
 *
 *   findings (#200/#201/#203)  → the job as data, the vise, and the tool-opened geometry
 *   feeds    (#202)            → the cutting parameters for the material and the cutter
 *   cam      (#172)            → the toolpath IR: the region operations off the SAME opened
 *                                polygons stage 1 measured, then the single-line traces (#219)
 *                                appended as their own operations (#287)
 *   post     (#173)            → the `.nc` text
 *   verify   (#174)            → the text, re-parsed and checked against the depth limit
 *   frame    (#244)            → the same toolpath traced in the air, a second `.nc` file
 *
 * Each stage stops the pipeline on an error and reports which stage stopped it. What gets
 * verified is the TEXT, never the IR (`/Simulation.md` §1.2): `verifyProgram` parses the bytes
 * the machine would read, so a post-processor bug cannot hide behind a clean IR.
 *
 * Headless — it takes the Manifold toplevel like `session.ts` and `engravePreview.ts` do, so it
 * runs (and is tested) in plain Node, and `sim.worker.ts` is a thin Comlink shell over it.
 * Pure given `(tl, job)`: the same job produces byte-identical `nc`.
 *
 * The result carries two fields the issue's interface did not name, both because the main thread
 * cannot recompute them without wasm:
 *   - `predicted`: the opened regions per item, which the oracle (#206 §3) compares the
 *     simulation against. `session.oracle` needs them and only this module has the polygons.
 *   - `errors`: the stage failure MESSAGES. The issue's interface has room for `feeds`/`verify`
 *     but not for a CAM or POST refusal, and a refusal with no reason is useless in the panel.
 */

import type { EngraveItem, EngraveJob, EngraveMargins } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
// package.json version for the post's `;@MKR|CAM|v=` header. Read from package.json directly
// rather than Vite's `__APP_VERSION__` define: Vite replaces the define at build time, but a
// headless run under `tsx`/Node (the bench-file generator, CI) has no such define and used to
// fall back to `dev`, so a generated-then-committed `.nc` was not byte-identical to the app's
// own save (#231 item 4). package.json is the single source in every environment.
import { version as CAM_VERSION } from '../../../package.json';
import type { MillProfile } from '@/engine/cnc/machine';
import { jobMachine, type MachineCalibration } from '@/engine/cnc/calibration';
import { feedsFor, type FeedsResult, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { cuttingForTrace, isVTraceTool, traceRadiusAt, type Tool } from '@/engine/cnc/tool';
import { isMetalTool } from '@/engine/cnc/registerCutter';
import { MATERIAL_LABELS, isMetalMaterial } from '@/engine/cnc/materials';
import { toPartPlan, labelProfile, jobDepthLimit, keepOutNameAt, type PartPlan } from '@/engine/cnc/engrave/partPlan';
import { dedupeFindings, toSetup, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { validateVise } from '@/engine/cnc/fixture';
import { generateEngrave, type EngraveRegion } from '@/engine/cnc/cam/engraveJob';
import { generateTrace } from '@/engine/cnc/cam/trace';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { concatToolpathIR, estimateCycleSeconds, HOP_Z, type CamMove, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { FRAME_Z } from '@/engine/cnc/engrave/runSheet';
import type { Setup } from '@/engine/cnc/setup';
import { verifyProgram, type DepthLimit, type VerifyReport } from '@/engine/cnc/verify';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import {
  bindingVoidsByRegion,
  itemDepthBoundFindings,
  engraveCutRegions,
  engravabilityFindings,
  keepOutFindings,
  measureLabels,
  traceCutRegions,
  type CutRegion,
  type LabelEngravability,
  type LabelRatioAt,
  type PerCharGlyph,
} from './engraveGeometry';
import { colourBoundaryFor, stackDepthLimit, type StackDepthLimit } from './stackDepthLimit';
import { ceilingName, effectiveMargins, MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';
import type { OraclePredicted } from '@/engine/cnc/engrave/oracle';

/** The stage that stopped the pipeline, or `done` when everything passed. */
export type EngraveStage = 'findings' | 'feeds' | 'cam' | 'post' | 'verify' | 'done';

/** A stage refusal with its reason, so the panel can list it under the right row. */
export interface EngraveFailure {
  stage: EngraveStage;
  message: string;
}

/** The CAM's own counts, for the panel's "Toolpath generated" row. */
export interface EngraveCamSummary {
  operations: number;
  cuttingMoves: number;
  estimatedSeconds: number;
  passes: number;
}

export interface EngraveGenerated {
  /** False as soon as any stage reports an error. */
  ok: boolean;
  /** The stage that stopped it, or `done`. */
  stage: EngraveStage;
  /** #200, #201, #203. */
  findings: JobFinding[];
  /** #202. */
  feeds: FeedsResult | null;
  cam: EngraveCamSummary | null;
  /** The exact text to be saved. */
  nc: string | null;
  /** #174. */
  verify: VerifyReport | null;
  /**
   * #244 — the frame file: a tiny air trace of the job's XY extent at `FRAME_Z`, emitted as
   * `<job>-frame.nc` beside the job. Null when the run never reached the post (nothing to
   * trace) or the job was refused. It is produced by THIS gated action, from the same toolpath,
   * and checked below by the same verifier.
   */
  frameNc: string | null;
  /** #244 — `verifyProgram`'s report on `frameNc`, or null when no frame was produced. */
  frameVerify: VerifyReport | null;
  /**
   * The regions the CAM cut and the oracle must match (#206 §3): each region item's opened
   * polygons, each drill's discs, and — since #287 — each single-line trace's swept region.
   */
  predicted: OraclePredicted[];
  /** Stage refusals, in stage order. Empty on a clean run. */
  errors: EngraveFailure[];
}

/**
 * #201's measurement for ONE cutter and nothing else: how much of each item its opening reaches.
 *
 * `engraveRegions` computes exactly these rows on its way to a toolpath, which is the right price
 * for a job you are about to cut and the wrong one for a scan over a dozen candidate cutters
 * (#410's reachability table), most of which will not be picked. Same `measureLabels` call, same
 * `perChar`, same `toPartPlan`, so a share reported by a scan is the share the run would measure —
 * the scan cannot disagree with the program it is deciding.
 *
 * Returns `[]` for a cutter that cannot open a region at all: a non-flat, or a V-bit, whose groove
 * width is a function of depth (#405). Nothing was measured, so nothing is claimed.
 */
export function measureEngraving(tl: ManifoldToplevel, job: EngraveJob, tool: Tool): LabelEngravability[] {
  const usable = cuttingForTrace(tool);
  if (!usable.ok || usable.tool.shape !== 'flat') return [];
  return measureLabels(tl, toPartPlan(job), usable.tool.radius, job.edgeMargin, perCharFor(job));
}

/** `perChar` for a job: one single-character glyph profile per character, in text order. */
function perCharFor(job: EngraveJob): (labelId: string) => PerCharGlyph[] {
  return (labelId) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return [];
    return [...label.text].map((char) => ({
      char,
      profile: labelProfile({ ...label, text: char }, job.customFonts),
    }));
  };
}

/**
 * `ratioAt` for a job at a given cutter radius: re-typeset one label at a candidate cap height
 * and re-measure only that label (#201/#205). Copied from `engravePreview.ts` because that
 * helper is private to its module and this file must not edit it.
 */
function ratioAtFor(tl: ManifoldToplevel, job: EngraveJob, radius: number): LabelRatioAt {
  return (labelId, size) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return 0;
    const probe: EngraveJob = { ...job, shapes: [], labels: [{ ...label, size }] };
    return measureLabels(tl, toPartPlan(probe), radius, job.edgeMargin, perCharFor(probe))[0]?.ratio ?? 0;
  };
}

/** The text an engrave region pockets: a label's text, empty for a shape. */
function regionText(item: EngraveItem | undefined): string {
  return item && !('kind' in item) ? item.text : '';
}

/**
 * The measured opening of a job: the plan, its engravability measurements, the ready-to-cut regions
 * and every cut the program makes. Exported so `engraveOracle.spec.ts` can build a bad-step-over
 * toolpath off the SAME polygons `engraveGenerate` would have cut, without re-deriving them — and so
 * `engravePreview` can DRAW those same polygons instead of measuring a second set of its own (#288).
 */
export interface EngraveRegions {
  plan: ReturnType<typeof toPartPlan>;
  measured: LabelEngravability[];
  /** What the REGION CAM is handed: labels, shapes and drills (#220). Traces are not here — see `cuts`. */
  regions: EngraveRegion[];
  /**
   * EVERY cut the program makes, in cutting order, one entry per item (#288): the region CAM's own
   * list above, then the single-line traces, which are CAM'd separately (`generateTrace`) and so are
   * deliberately absent from `regions` — a swept line is not a pocketed region.
   *
   * This is the ONE list the oracle's prediction and the preview's picture are both built from, so a
   * class added here reaches the prediction, the picture and the program together, and a class left
   * out is missing from all three loudly rather than from the picture quietly (#288: the preview
   * walked `plan.engraves` on its own, so it never drew a drill's hole or a trace's groove).
   */
  cuts: CutRegion[];
  predicted: OraclePredicted[];
  tool: Tool | null;
  radius: number | null;
  findings: JobFinding[];
  /**
   * The blank's colour split, mm below the engraved face, ON a real layer line (#285), or null
   * when the job states no print and there are no colour layers to speak of.
   *
   * Read here rather than in the preview so both halves of the pipe — the picture and the
   * generated program — are told the same plane by the same call: the preview draws it and
   * `item-depth-bound` is raised against it, and the verifier's limit comes from the same stack.
   */
  colourBoundaryDepth: Mm | null;
  /**
   * The depth margins this job ran with (#345), resolved from the job's own record or from the
   * house setting the caller handed in. Returned so the preview draws and reports the SAME numbers
   * the findings and the verifier used instead of resolving a second set of its own.
   */
  margins: EngraveMargins;
}

/**
 * What a V-BIT in a job means (#405): the two findings that are about the job rather than about the
 * geometry, both of which need the PLAN, which is why they are raised here and not in
 * `engravabilityFindings` (that module is handed measurements, not items).
 *
 * `null` tool, or any cutter that is not a cone, answers nothing: every job before #405 had a flat
 * end mill and must produce exactly the findings it produced before.
 */
function vCutterFindings(job: EngraveJob, plan: PartPlan, tool: Tool | null): JobFinding[] {
  if (tool === null || !isVTraceTool(tool)) return [];
  const findings: JobFinding[] = [];

  // 1. A REGION needs ONE cutting width. Opening a glyph or a pocket means offsetting its outline
  // by the cutter's radius (`generateEngrave`), and a cone has no single radius: its width at the
  // depth the path is at is part of the answer. The toolpath that does cut a region with a V-bit is
  // a medial-axis V-carve — #221's remaining piece — so this is a refusal by name, on the item that
  // asked, rather than a refusal of the cutter (which traces perfectly well).
  const region = plan.engraves[0];
  if (region !== undefined) {
    const others = plan.engraves.length - 1;
    findings.push({
      severity: 'error',
      code: 'region-v-carve-unavailable',
      labelId: region.id,
      message:
        `${region.name} is a REGION${others > 0 ? ` (and ${others} other item${others === 1 ? '' : 's'})` : ''}: opening it needs the cutter's ` +
        `width, and a V-bit's width changes with the depth of the cut — cutting a region with one is a V-carve, ` +
        `which this app does not do yet (#221). Use a flat end mill for regions, or make the artwork a stroke trace.`,
    });
  }

  // 2. Makera's "for Metal" line: REFUSED by name on a blank that is not metal (#405 review, the
  // maintainer's 2026-10-09 ruling). This was a warning, and it stopped the 60° bit only by
  // accident — that bit's 0.1 mm tip falls outside every PLA V row, so the job died at the feeds
  // stage for a reason that says nothing about the line. A metal 30° 0.3 mm ENGRAVER has the same
  // name and a tip INSIDE the V row's band, so it would have cut PLA on numbers nobody measured
  // for it with nothing but a sentence on the sheet.
  //
  // A cutter ground for metal is not the cutter for a plastic or a wood — the claim is about the
  // PAIR, and this half of it fails — so the job does not run. `isMetalTool` reads every statement
  // of the line a cutter can carry: the NAME (`(Metal)` as a catalogue row spells it, `for Metal`
  // as the printed label spells it — the form an owned `inv:` cutter actually reaches a job with)
  // and the `-M-` box code, so a cutter filed under a code is refused too.
  if (isMetalTool(tool) && !isMetalMaterial(job.stock.material)) {
    findings.push({
      severity: 'error',
      code: 'tool-metal-line',
      message:
        `"${tool.name}" is on Makera's "for Metal" line, and this job cuts ${MATERIAL_LABELS[job.stock.material]}: ` +
        `the bit's geometry and its coating are ground for metal, and no feed row was written for it on this material. ` +
        `Pick a wood/plastic cutter for this blank, or change the stock to a metal before cutting.`,
    });
  }

  return findings;
}

/**
 * The disc a plunge drill opens at one hole: radius `r`, polygonized with the same segment count
 * `segmentsForRadius` picks everywhere else (#190). The holes are unioned so a dense array whose
 * discs overlap still yields one region per drill item rather than double-counted overlap — the
 * oracle and the preview both compare against a single region.
 */
function drillPolygons(tl: ManifoldToplevel, holes: readonly [number, number][], radius: number): Polygons {
  const CS = tl.CrossSection;
  const discs = holes.map(([x, y]) => CS.circle(radius, segmentsForRadius(radius)).translate([x, y]));
  if (discs.length === 0) return [];
  const union = discs.length === 1 ? discs[0]! : CS.union(discs);
  if (discs.length > 1) discs.forEach((d) => d.delete());
  const polygons = union.toPolygons() as Polygons;
  union.delete();
  return polygons;
}

/**
 * `tool` is HANDED IN (#305): this is worker-side, where neither the job store nor the tool
 * registry is visible, so the caller resolves it — `jobTool(job)` on the main thread, or
 * `toolForJob(job, tools)` from the list the preview was sent. One `Tool` object then feeds the
 * measurement, the findings, the CAM and the verifier, so the run can never disagree with itself
 * about which cutter it used.
 */
export function engraveRegions(
  tl: ManifoldToplevel,
  job: EngraveJob,
  tool: Tool | null,
  margins: EngraveMargins = effectiveMargins(job, MARGIN_DEFAULTS),
): EngraveRegions {
  const plan = toPartPlan(job);
  const perChar = perCharFor(job);
  // The cutter, split into the two things the pipeline needs from it (#405). `radius` is the FLAT
  // radius the REGION stages take: measuring a glyph's opening, opening it with an offset, sweeping
  // it into a drill disc. A V-bit has none — its width is a function of depth — so it answers null
  // there and is refused a region by name below. A trace, by contrast, needs only the width at the
  // trace's own depth, which `traceRadiusAt` gives for both shapes.
  const usable = tool === null ? null : cuttingForTrace(tool);
  const radius = usable !== null && usable.ok && usable.tool.shape === 'flat' ? usable.tool.radius : null;
  const traceRadius = tool === null ? null : (depth: number): number | null => traceRadiusAt(tool, depth);

  const measured = radius === null ? [] : measureLabels(tl, plan, radius, job.edgeMargin, perChar);
  const engFindings = radius === null ? [] : engravabilityFindings(job, measured, ratioAtFor(tl, job, radius), tool);

  // #171/#345 — the cut regions a void check reads, built ONCE: the engrave openings plus the
  // swept traces (#270). A void-free job is the common case and pays for nothing here — sweeping
  // the traces means wasm, and #205 calls this on a debounce.
  const voidCuts: CutRegion[] =
    plan.stock.keepOuts.length === 0
      ? []
      : [...engraveCutRegions(plan, measured), ...(traceRadius === null ? [] : traceCutRegions(tl, plan, traceRadius))];

  // #345 decision B — ONE scan decides which void binds each region, and BOTH stages read it: the
  // per-move warning (#171) and the per-item bound, so the banner and the item cannot name
  // different voids for the same overlap.
  const bindingVoids = bindingVoidsByRegion(tl, job, plan, voidCuts, margins.boundaryMargin);
  const voidFindings = keepOutFindings(job, voidCuts, bindingVoids);

  // #285 — the colour boundary, when the job states its print. PURE grid arithmetic (#285 review):
  // the boundary is a rule about the layer grid, not a measurement of the solid, so it is read
  // straight off `colourBoundaryFor` rather than by building the stack here and freeing it again.
  // The verifier builds its own stack below; this used to be a second one, live on every keystroke.
  const colourBoundaryDepth = colourBoundaryFor(plan, job);

  // `job.sacrificial` is threaded so the generate path's `vise-grip-shallow` judges what the
  // jaws actually grip (#213 §2), not the raw stock: the argument `validateVise` has accepted
  // since `454110a` but this call never passed.
  const findings = dedupeFindings([
    ...validateJob(job),
    ...validateVise(job.stock, job.workholding.vise, job.sacrificial),
    ...engFindings,
    ...vCutterFindings(job, plan, tool),
    ...voidFindings,
    // #345 — every item judged against every bound under its footprint: the split on the side its
    // own `depthIntent` put it, and the ceiling of any void it sits over. A no-op for a job with
    // neither.
    ...itemDepthBoundFindings(job, colourBoundaryDepth, margins.boundaryMargin, bindingVoids),
  ]);

  const byId = new Map(measured.map((m) => [m.labelId, m] as const));
  const itemById = new Map<string, EngraveItem>();
  for (const l of job.labels) itemById.set(l.id, l);
  for (const s of job.shapes) itemById.set(s.id, s);

  const regions: EngraveRegion[] = plan.engraves.map((e) => ({
    id: e.id,
    text: regionText(itemById.get(e.id)),
    name: e.name,
    depth: e.depth,
    polygons: byId.get(e.id)?.polygons ?? [],
  }));

  // Plunge drills (#220): a region whose cut is the cutter's own disc per hole, so the preview
  // and the oracle see it exactly as the CAM will cut it. A `through` hole is refused by
  // `drill-through-unavailable` before the pipeline reaches CAM, so it contributes no region —
  // but a job that still carried one here would cut a floor, never break through.
  for (const d of plan.drills) {
    if (d.through) continue;
    regions.push({
      id: d.id,
      text: '',
      // The diameter is only known once the tool is resolved, so the region builder appends it —
      // the same division of labour `toPartPlan` documents (#220).
      name: radius === null ? d.name : `${d.name} ⌀${radius * 2}`,
      depth: d.depth,
      polygons: radius === null ? [] : drillPolygons(tl, d.holes, radius),
      drill: { holes: d.holes.map(([x, y]) => [x, y] as [number, number]) },
    });
  }

  // #287 — a single-line trace cuts the region its cutter SWEEPS (#270): one entry per trace, at
  // the trace's own floor. The builder is the same `traceCutRegions` the void warning uses, so the
  // warning, the oracle and the picture cannot disagree about where a trace cuts. Empty — a no-op —
  // when the job has no trace or no usable cutter, the same "nothing measured" rule as above.
  //
  // The list is `cuts` rather than a private array because it is the ONE place the cut classes are
  // enumerated (#288): the prediction below and `engravePreview`'s picture are both its projection,
  // so a fourth class (#218's cut-outs) lands in the program, the oracle and the preview together.
  const cuts: CutRegion[] = [...regions, ...(traceRadius === null ? [] : traceCutRegions(tl, plan, traceRadius))];
  const predicted: OraclePredicted[] = cuts.map((c) => ({ depth: c.depth, polygons: c.polygons }));

  return { plan, measured, regions, cuts, predicted, tool, radius, findings, colourBoundaryDepth, margins };
}

/** Count what the panel reports: operations, cutting moves, estimated seconds, depth passes. */
function summarize(ir: ReturnType<typeof generateEngrave>): EngraveCamSummary {
  let cuttingMoves = 0;
  let passes = 0;
  let estimatedSeconds = 0;
  for (const op of ir.operations) {
    estimatedSeconds += op.estimatedSeconds;
    const zs = new Set<number>();
    for (const m of op.moves) {
      if (m.kind !== 'feed') continue;
      cuttingMoves++;
      zs.add(m.z);
    }
    passes += zs.size;
  }
  return { operations: ir.operations.length, cuttingMoves, estimatedSeconds, passes };
}

/**
 * The XY trace of the job's cut footprint (#244), as a closed rectangle of RAPID moves at
 * height `z`: `(minX,minY) → (maxX,minY) → (maxX,maxY) → (minX,maxY) → (minX,minY)`. The
 * extent is every positioned move endpoint in the toolpath, GROWN BY THE CUTTER RADIUS so the
 * trace is the cutter's footprint, not just its centre path. Null when the toolpath has no
 * positioned move — nothing to trace. Pure, so the geometry is tested without wasm.
 */
export function frameCorners(ir: ToolpathIR, radius: number, z: number): CamMove[] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const op of ir.operations) {
    for (const m of op.moves) {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      minX = Math.min(minX, m.x);
      maxX = Math.max(maxX, m.x);
      minY = Math.min(minY, m.y);
      maxY = Math.max(maxY, m.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  const x0 = minX - radius;
  const x1 = maxX + radius;
  const y0 = minY - radius;
  const y1 = maxY + radius;
  return [
    { kind: 'rapid', x: x0, y: y0, z },
    { kind: 'rapid', x: x1, y: y0, z },
    { kind: 'rapid', x: x1, y: y1, z },
    { kind: 'rapid', x: x0, y: y1, z },
    { kind: 'rapid', x: x0, y: y0, z },
  ];
}

/**
 * The frame file's program (#244): the corner trace, posted by the SAME post (#173) and checked
 * by the SAME verifier (#174) as the job. Rapids only — it cuts nothing — so the verifier's cut
 * checks have nothing to flag; the point is that the dialect, the preamble and the ending are
 * the post's own, never a hand-written second dialect the machine might refuse. Returns the
 * posted text plus its verify report, or the reason it could not be produced.
 */
function frameProgram(
  ir: ToolpathIR,
  ctx: PostContext,
  machine: MillProfile,
  setup: Setup,
  tool: Tool,
  limit: DepthLimit,
): { nc: string; verify: VerifyReport } | { error: string } {
  // The cutter's footprint in XY, grown by the SAME rule the corner box has always been built with
  // (#244): the disc the toolpath removes. A V-bit's is the groove at the DEEPEST cut in the program
  // (#405) — a cone's opening widens with depth, and the frame has to cover the widest cut it makes,
  // not the tip's 0.3 mm. `traceRadiusAt` answers both shapes, so a flat end mill's frame is
  // unchanged to the last digit.
  const deepestCut = ir.operations.reduce((deepest, op) => Math.max(deepest, op.depth), 0);
  const radius = traceRadiusAt(tool, deepestCut);
  const moves = frameCorners(ir, radius ?? 0, FRAME_Z);
  if (moves === null) return { error: 'the toolpath has no positioned move to trace' };
  const frameIr: ToolpathIR = {
    frame: 'flat', // the frame trace is a flat-frame air move; no rotary frame exists yet (#237)
    tool: ir.tool,
    toolNumber: ir.toolNumber,
    spindleRpm: ir.spindleRpm,
    air: ir.air,
    // The trace IS the safe height: the preamble retracts to FRAME_Z and every trace rapid is at
    // FRAME_Z, so there is no operator offset to set or clear. `hopZ` stays HOP_Z (the job's own
    // rapid floor): the post's fixed ending retracts to Z15 and homes, so the frame's verifier
    // must not demand a rapid floor above the post's own ending.
    safeZ: FRAME_Z,
    hopZ: HOP_Z,
    operations: [
      {
        number: 1,
        name: 'Frame trace',
        labelId: '',
        depth: 0,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, machine.rapidEstimate),
      },
    ],
  };
  const posted = postZ1(frameIr, ctx, machine);
  if (!posted.ok) return { error: posted.errors.join('; ') };
  const verify = verifyProgram(posted.text, { setup, machine, tool, depthLimit: limit, minRapidZ: frameIr.hopZ });
  return { nc: posted.text, verify };
}

/**
 * The tail of the `cut-too-deep` sentence: WHICH plane the limit at (x, y) is (#285, #345).
 *
 * Two answers, and the difference is what the operator acts on. Over a void the solid itself
 * stopped the cutter, so the sentence names the plane the floor would have crossed — the void's
 * ceiling, named by the same `ceilingName` the bound model uses, so the sentence and the per-item
 * finding cannot describe one plane two ways. Everywhere else the limit is the job's own floor
 * under the stock (or the sacrificial height), and naming a ceiling there would send the operator
 * looking for a pocket that is not there.
 *
 * Exported so the branch is directly testable: over solid stock nothing can reach the verifier
 * today — `validateJob` refuses the same depth first — so only the void half is reachable through
 * the pipeline, and the floor half would otherwise be an unverified string.
 */
export function depthLimitReason(stack: StackDepthLimit, job: EngraveJob, x: Mm, y: Mm): string {
  if (stack.reasonAt(x, y) === 'stock') return '— the floor the job keeps under the stock';
  return `— ${ceilingName(keepOutNameAt(job, x, y) ?? '')}`;
}

/**
 * Generate, post and verify one engrave job.
 *
 * `tool` is the resolved cutter, HANDED IN (#305): this runs in the sim worker, where neither the
 * job store nor the tool registry can be read, so the caller resolves it (`jobTool(job)` on the
 * main thread) and the same object reaches the findings, the feeds, the CAM, the post and the
 * verifier. `null` is not an error to swallow — it stops at the feeds stage with "the job has no
 * usable cutter", which is exactly what `tool-missing` says above it.
 *
 * `catalogue` is Makera's feed rows, HANDED IN for the same reason (#324): `feeds.ts`'s own copy
 * lives in this worker's module realm and is always empty, so resolving feeds here without the
 * caller's rows would post the STARTING TABLE's numbers under a panel showing the catalogue's. The
 * `.nc` and the run sheet are cut from this call's result, so it is the numbers the operator reads
 * against the numbers the machine runs that is at stake.
 *
 * `margins` is the job's depth thresholds as the MAIN THREAD resolved them (#345), for the same
 * reason `catalogue` is handed in: the house setting lives in `useSettingsStore`, which this realm
 * cannot read. Omitted — a test, or a caller with no settings — the job's own record answers, and a
 * job that carries none falls back to the shipped default, so nothing here needs a store to be
 * correct.
 *
 * `calibration` is the machine's own frame, if the user has one saved (#279). The machine is resolved
 * from it ONCE here (#297) and that one object feeds the feeds, the post, the setup, the verifier and
 * the frame file — the same object the caller loads the simulation with. Before this, the verifier
 * expanded `M6`, `G28` and the probe cycle against the vendor's anchors while the simulation expanded
 * them against the calibrated ones, so the gate and the sim judged two different machines for one .nc.
 */
export function engraveGenerate(
  tl: ManifoldToplevel,
  job: EngraveJob,
  tool: Tool | null,
  catalogue: readonly FeedCatalogueRow[],
  calibration: MachineCalibration | null = null,
  margins: EngraveMargins = effectiveMargins(job, MARGIN_DEFAULTS),
): EngraveGenerated {
  // #347 — the JOB's machine, not the app's only one: the envelope, the spindle ceiling and the
  // frame below are read off the profile the document names. The POST is still `postZ1`'s dialect,
  // which is the only post this app has; a second mill is a second post, and this line is where a
  // job naming it would have to be refused until there is one.
  const mill = jobMachine(job, calibration);
  const { plan, regions, predicted, findings } = engraveRegions(tl, job, tool, margins);
  const errors: EngraveFailure[] = [];

  const stop = (stage: EngraveStage, extra?: { feeds?: FeedsResult | null; message?: string }): EngraveGenerated => {
    if (extra?.message !== undefined) errors.push({ stage, message: extra.message });
    return {
      ok: false,
      stage,
      findings,
      feeds: extra?.feeds ?? null,
      cam: null,
      nc: null,
      verify: null,
      frameNc: null,
      frameVerify: null,
      predicted,
      errors,
    };
  };

  // 1. findings (#200/#201/#203). Any error stops before feeds are even resolved.
  if (findings.some((f) => f.severity === 'error')) return stop('findings');

  // 2. feeds (#202). A tool the library cannot resolve reads as `tool-missing` above; a tool with
  // no row, or a step-over past the radius (#191), refuses here. A V-BIT passes this gate since
  // #405 — it is a cutter this CAM can trace with, and `radius` being null only says it opens no
  // region — so the refusal is the trace path's own (`cuttingForTrace`), which names a ball nose,
  // a bull nose, or a cone whose header states no tip or angle.
  if (tool === null) return stop('feeds', { message: 'the job has no usable cutter' });
  const usable = cuttingForTrace(tool);
  if (!usable.ok) return stop('feeds', { message: usable.reason });
  const feeds = feedsFor(catalogue, job.stock.material, tool, mill, job.cutOverride);
  if (!feeds.ok) return stop('feeds', { feeds, message: feeds.reason });

  // 3. the CAM core (#172), on the SAME opened polygons stage 1 measured.
  let ir: ToolpathIR;
  try {
    // A job with no REGION item has nothing for the region CAM to open — and since #405 it must not
    // be handed an empty list either: a trace-only job can now reach this line with a CONE for a
    // tool, and `generateEngrave` refuses a V-bit by name (rightly: opening a region needs the
    // offset radius). The two CAMs return IRs describing the same machine state, so a job with no
    // regions simply IS the trace IR, and its `.nc` is unchanged.
    const regionIr = regions.length === 0 ? null : generateEngrave(tl, regions, tool, feeds.params, mill.rapidEstimate);
    // #287 — single-line traces (#219) are their own CAM: the cutter's centre follows the path,
    // so there is no region to open, no offset and no pocketing. They are appended AFTER the
    // region operations, so a trace can shift no pocket's ordering, and a job with none joins an
    // empty list — the renumbering is a no-op, so its `.nc` is byte-identical to before. Both
    // calls are inside this `try` so a trace CAM refusal reports the same `cam` stage a region
    // refusal does.
    //
    // ORDERING, for whoever adds a class inside `generateEngrave` next (#218's cut-outs are the
    // one already planned): the classes here end up drills → pockets → cut-outs → traces. Drills
    // lead for the reason `generateEngrave` states (#220: a peck cycle leaves the blank
    // unweakened). A trace wants to be cut BEFORE a cut-out releases the part, so #218 should
    // place traces ahead of its cut-out class rather than leaving this append at the end — a
    // released part can shift under the tape, which is exactly what the drills-first rule avoids.
    const traceIr = generateTrace(plan.traces, tool, feeds.params, mill.rapidEstimate);
    if (regionIr === null) ir = traceIr;
    else ir = traceIr.operations.length > 0 ? concatToolpathIR(regionIr, traceIr) : regionIr;
  } catch (e) {
    return stop('cam', { feeds, message: e instanceof Error ? e.message : String(e) });
  }
  const cam = summarize(ir);

  // 4. the post-processor (#173).
  const ctx: PostContext = {
    jobName: job.name,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: CAM_VERSION,
    // #332: the key the JOB names, not anything off the `Tool` — a clone's rendered cutter carries
    // no identity of its own, and this is the line that lets the file say which cutter it was for.
    toolKey: job.toolKey,
  };
  let nc: string;
  try {
    const posted = postZ1(ir, ctx, mill);
    if (!posted.ok) return stop('post', { feeds, message: posted.errors.join('; ') });
    nc = posted.text;
  } catch (e) {
    return stop('post', { feeds, message: e instanceof Error ? e.message : String(e) });
  }

  // 5. the verifier (#174) on the TEXT, with the depth limit the JOB implies: the CNC-2 stock
  // limit, tightened where an under-surface void leaves a thinner membrane (#231 item 3). On a
  // job that states its print (#285) the whole limit comes from the layer stack instead, so the
  // void membrane is layer-aligned and the verifier's number is the one the printer will honour.
  // The stack owns wasm cross-sections, so it lives no longer than the two verifier calls below.
  const stack = stackDepthLimit(tl, plan, job, margins.boundaryMargin);
  const limit: DepthLimit = stack?.limit ?? jobDepthLimit(job, margins.boundaryMargin);
  const limitReasonAt = stack
    ? (x: number, y: number): string => depthLimitReason(stack, job, x, y)
    : undefined;
  const setup = toSetup(job, mill);

  try {
    const verify = verifyProgram(nc, { setup, machine: mill, tool, depthLimit: limit, minRapidZ: ir.hopZ, ...(limitReasonAt ? { limitReasonAt } : {}) });
    if (verify.findings.some((f) => f.severity === 'error')) {
      errors.push({ stage: 'verify', message: `${verify.findings.filter((f) => f.severity === 'error').length} verifier error(s)` });
      return { ok: false, stage: 'verify', findings, feeds, cam, nc, verify, frameNc: null, frameVerify: null, predicted, errors };
    }

    // 6. the frame file (#244): the job's XY extent traced in the air, beside the job. Produced by
    // THIS gated action from the same toolpath, and checked by the SAME verifier — a frame the
    // operator cannot run at the wrong Z, because the Z is in the file.
    const frame = frameProgram(ir, ctx, mill, setup, tool, limit);
    if ('error' in frame) {
      errors.push({ stage: 'verify', message: `the frame file could not be produced: ${frame.error}` });
      return { ok: false, stage: 'verify', findings, feeds, cam, nc, verify, frameNc: null, frameVerify: null, predicted, errors };
    }
    const frameErrors = frame.verify.findings.filter((f) => f.severity === 'error');
    if (frameErrors.length > 0) {
      errors.push({ stage: 'verify', message: `the frame file has ${frameErrors.length} verifier error(s)` });
      return { ok: false, stage: 'verify', findings, feeds, cam, nc, verify, frameNc: frame.nc, frameVerify: frame.verify, predicted, errors };
    }

    return {
      ok: true,
      stage: 'done',
      findings,
      feeds,
      cam,
      nc,
      verify,
      frameNc: frame.nc,
      frameVerify: frame.verify,
      predicted,
      errors,
    };
  } finally {
    stack?.dispose();
  }
}
