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
 * Since #419 J3 the whole of that runs ONCE PER PROGRAM: a job with `setups[]` is one file per setup
 * and cutter, and the result carries them as a list. One file has one tool, so the post's `M6`, the
 * verifier's single-tool checks and the frame all keep their single-tool shape.
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
import { feedsFor, type FeedsEntry, type FeedsResult, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { cuttingDiameter, cuttingForTrace, isVTraceTool, traceRadiusAt, type Tool } from '@/engine/cnc/tool';
import { threadMillIR, threadSettings, type ThreadMillPlan, type ThreadSettingsResult } from '@/engine/cnc/cam/threadMill';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import { vCone } from '@/engine/cnc/vProfile';
import { isMetalTool } from '@/engine/cnc/registerCutter';
import { MATERIAL_LABELS, isMetalMaterial } from '@/engine/cnc/materials';
import { toPartPlan, labelProfile, jobDepthLimit, keepOutNameAt, type PartPlan } from '@/engine/cnc/engrave/partPlan';
import { dedupeFindings, jobSetups, setupProgramFindings, toSetup, validateJob, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import { jobForSetup, setupPrograms, type JobProgramRef } from '@/engine/cnc/engrave/programs';
import { programHash } from '@/engine/cnc/programHash';
import { validateVise } from '@/engine/cnc/fixture';
import { generateEngrave, zPasses, type EngraveRegion } from '@/engine/cnc/cam/engraveJob';
import { generateFacing, type FacingCamSummary } from '@/engine/cnc/cam/facing';
import { chooseFacingTool } from '@/engine/cnc/engrave/facingTool';
import { facingRefusal } from '@/engine/cnc/stockStart';
import { generateTrace } from '@/engine/cnc/cam/trace';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { concatToolpathIR, estimateCycleSeconds, HOP_Z, travelStats, type CamMove, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { postZ1, type PostContext, type VacuumSpan } from '@/engine/cnc/post/z1';
import { FRAME_Z } from '@/engine/cnc/engrave/runSheet';
import type { Setup } from '@/engine/cnc/setup';
import type { MountObstacles } from '@/engine/cnc/mounts/bracket';
import { unfacedBands } from '@/engine/cnc/mounts/inPath';
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

/**
 * The shop defaults the engrave pipeline reads but this realm cannot (#451): the location lives on
 * the main thread, so the caller sends each chosen number as plain data. `null`/absent means the
 * caller had no location — the receiving module then keeps its own LABELLED fallback, never an
 * unlabelled literal.
 *
 * `lostDetailWarnRatio` is `engrave.lostDetailWarnRatio` (the share of an item's area a cutter must
 * keep before `item-detail-lost` is raised). `peckClearanceMm` is `drill.peckClearanceMm` (how far
 * above the floor just cut a peck's re-entry rapid stops). Both are read by `engraveRunStore` and
 * `engravePreviewStore` — the preview needs only the ratio; the run needs both.
 */
export interface EngraveShopOpts {
  lostDetailWarnRatio?: number | null;
  peckClearanceMm?: number | null;
  /**
   * #450 slice 3 — the table `feedsFor` resolves against, resolved on the caller's side
   * (`resolvedFeedsTable().table`) because the location lives on the main thread and a worker's own
   * module state has no located table. Absent: the worker's compiled `FEEDS_TABLE` fallback.
   */
  feeds?: readonly FeedsEntry[] | null;
  /**
   * #445 — the whole shop-defaults map, because the thread settings carry a SOURCE per key and
   * `readDefault` resolves each one against the location. `engraveRunStore` passes the same map
   * it reads the two numbers above from, so a run's thread numbers and its peck clearance are one
   * snapshot. `null`/absent means no location: `readDefault` then labels each fallback.
   */
  defaults?: ShopDefaults | null;
  /**
   * #432 slice 2 — the registry snapshot (`getTools()`), handed in for the same reason `catalogue`
   * is: the sim worker cannot see the tool registry, so the facing pass's own cutter is chosen from
   * the list the picker is showing rather than from the worker's empty module state. Absent: no
   * facing tool can be chosen, and a job that faces has its facing program refused with that
   * reason — the engraving still generates.
   */
  tools?: readonly ToolLibraryEntry[] | null;
  /**
   * #432 review R10 — the inventory's condition summaries (`inventoryConditions()`), handed in for
   * the same reason `tools` is: `toolCondition`'s map is main-thread module state, and the sim
   * worker's copy is empty. The facing pick skips a cutter every copy of which is marked broken and
   * prefers a fresher copy only on an equal diameter. Absent/null is "nothing known": no cutter is
   * excluded as broken and a worn one stays eligible, exactly as before the table was passed.
   */
  conditions?: ReadonlyMap<string, ConditionSummary> | null;
  /**
   * #442's #427 item — the mount's obstacles (the bracket's arms and the top clamps, with the fit),
   * or `null` when the job is held in the vise. Resolved on the CALLER's side for the same reason
   * `defaults` is: the bracket sizes are shop defaults the location owns, and this worker must not
   * pull the defaults client in (`verify.ts`'s boundary, `mounts/bracket.ts`'s import).
   *
   * Absent or null changes nothing: the verifier is handed no obstacles and the simulation checks
   * the vise's own envelope, exactly as every pre-#427 run did.
   */
  mount?: MountObstacles | null;
}

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
  /**
   * #487 — XY travel of the whole program: the rapid (air) distance and the cutting distance,
   * mm. The receipt and the run sheet print them against the pre-#487 order, so the gain is a
   * number rather than a claim. OPTIONAL because a generated object stored by an older build
   * still has a `cam` without them, and the sheet must then say nothing rather than invent a
   * number; `summarize` always fills them.
   */
  rapidMm?: number;
  cutMm?: number;
  /** The same program under the pre-#487 loop order, mm. Equal to `rapidMm` when there was nothing to order. */
  baselineRapidMm?: number;
  /** `'proximity'` when the region CAM placed loops by #487; null when the program had no region loops. */
  ordering?: 'proximity' | null;
}

/**
 * ONE program of the job (#419 J3): a single setup cut with a single cutter, posted, verified and
 * keyed. The job's programs are a LIST because the run is a list — one file per tool, loaded and
 * played in order, with the vacuum left on across the changes between them.
 *
 * `programHash` is FNV over `nc` (decision 3) — the same key the run confirmation and
 * `finishedHashes` use, so a program that finished on this machine is recognised across reloads.
 *
 * Only a program that POSTED and PASSED THE VERIFIER appears here: a withheld file is not a program,
 * and `EngraveGenerated.ok` is false whenever one is missing from the list it should have been in.
 */
export interface EngraveProgram {
  /** 1-based, the operator's "Setup 2". */
  setupIndex: number;
  setupId: string;
  /** The cutter this file runs — the setup's tool, and the header's `;@CM|TOOL|key=` line. */
  toolKey: string;
  nc: string;
  verify: VerifyReport;
  /** This program's own frame file (#244), checked by the same verifier; null when not produced. */
  frameNc: string | null;
  frameVerify: VerifyReport | null;
  /** FNV-1a over `nc` — `programHash` in `engine/cnc/programHash.ts`. */
  programHash: string;
  cam: EngraveCamSummary | null;
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
  /**
   * #445 — one plan per thread item, in document order: the pass radii, the run-out and the plain
   * `simThreads` the simulator load needs. `null` for every job with no thread, so a job before
   * #445 reads exactly as it did.
   */
  threads: ThreadMillPlan[] | null;
  /**
   * #445 phase B — the numbers the thread program was cut with, AND where each came from.
   *
   * `threads` states the geometry but not its provenance: the same 300 mm/min could be a catalogue
   * row for this cutter or the shop's labelled placeholder. The run sheet has to say which, so the
   * worker hands the resolved settings and their per-key sources across instead of letting the
   * sheet re-resolve them — a second resolution could print numbers the file was not cut with.
   * `null` for every job with no thread, and for a run that never resolved them. OPTIONAL because
   * a generated object can arrive without it — one stored by an older build, or the bench script's
   * — and the sheet must then say the source was not recorded rather than guess.
   */
  threadMachining?: ThreadSettingsResult | null;
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
   * #432 slice 2 — the FACING program, as its own `.nc` beside the job: the skim of the blank's
   * top, posted against the PROBED top (Z = 0 is the blank as the probe found it) with its own
   * cutter (`facingToolKey`). The engraving program is NOT shifted — it stays in the document's
   * frame, whose Z = 0 is the faced surface — because slice 4 re-zeros Z on that surface between the
   * two files; the two programs meet physically, never arithmetically.
   *
   * `null` when the job does not face, when the run stopped before the artefact was built, or when
   * it could not be produced — `facingError` then says why. A null here never fails the run: the
   * engraving still generates and is still savable.
   */
  facingNc: string | null;
  /**
   * #432 — `verifyProgram`'s report on `facingNc`, or null when none was produced. A report with
   * errors means the file was WITHHELD (see `facingError`): no unchecked program is handed over.
   */
  facingVerify: VerifyReport | null;
  /**
   * #432 — the registry key of the cutter the facing program was written for, or null with
   * `facingNc`. The operator loads it for the facing file alone; it is deliberately not the job's
   * `toolKey`, which is the cutter the engraving runs.
   */
  facingToolKey: string | null;
  /** #432 — why the facing program is absent, or null. Never a stage refusal: the run is not stopped. */
  facingError: string | null;
  /**
   * #432 slice 3 — what the facing program was cut with: its OWN cutter, the pass count and the
   * numbers from its feeds row. Null when no facing file was produced (see `facingError`), so the
   * run sheet can state a face the file actually makes and say why when there is none. It is
   * `FacingCamSummary`, not the sheet's own re-derivation: passes are `zPasses`' answer for this
   * depth and this row, and a second computation could print a pass count the file does not make.
   */
  facingCam: FacingCamSummary | null;
  /**
   * #419 J3 — the job's programs, in cut order: one per setup, each with its own `.nc`, verifier
   * report, frame file and FNV key. A single-setup job has exactly one, and the top-level `nc` /
   * `verify` / `cam` fields above are that same program — the adapter the panels and the bench
   * scripts read today.
   *
   * Empty when nothing was posted (a refusal before the CAM, or a withheld file). Callers that need
   * the whole run — the package freeze, the run plan — must check `ok` first: a partial list is a
   * diagnosis, not a runnable job.
   */
  programs: EngraveProgram[];
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
 * Makera's "for Metal" line: REFUSED by name on a blank that is not metal (#405 review, the
 * maintainer's 2026-10-09 ruling). This is a finding about the PAIR — the bit's line and the blank's
 * material — so it is judged for EVERY cutter a job resolves, whatever its shape (#407).
 *
 * This was a warning, and it stopped the 60° bit only by accident — that bit's 0.1 mm tip falls
 * outside every PLA V row, so the job died at the feeds stage for a reason that says nothing about
 * the line. A metal 30° 0.3 mm ENGRAVER has the same name and a tip INSIDE the V row's band, so it
 * would have cut PLA on numbers nobody measured for it with nothing but a sentence on the sheet.
 *
 * A cutter ground for metal is not the cutter for a plastic or a wood — the claim is about the
 * PAIR, and this half of it fails — so the job does not run. `isMetalTool` reads every statement
 * of the line a cutter can carry: the NAME (`(Metal)` as a catalogue row spells it, `for Metal`
 * as the printed label spells it — the form an owned `inv:` cutter actually reaches a job with)
 * and the `-M-` box code, so a cutter filed under a code is refused too.
 *
 * The reach is deliberate (#407): this lived inside `vCutterFindings`, which only runs for
 * engraving/chamfer shapes, so a metal FLAT end mill on PLA — the built-in
 * `3.175*12mm Flat End(Metal)` is exactly that bit — was never judged. Nothing about the hazard is
 * specific to a V, so the flat family cannot slip past it.
 *
 * `null` tool answers nothing: there is no cutter to name.
 */
function metalLineFindings(job: EngraveJob, tool: Tool | null): JobFinding[] {
  if (tool === null || !isMetalTool(tool) || isMetalMaterial(job.stock.material)) return [];
  return [
    {
      severity: 'error',
      code: 'tool-metal-line',
      message:
        `"${tool.name}" is on Makera's "for Metal" line, and this job cuts ${MATERIAL_LABELS[job.stock.material]}: ` +
        `the bit's geometry and its coating are ground for metal, and no feed row was written for it on this material. ` +
        `Pick a wood/plastic cutter for this blank, or change the stock to a metal before cutting.`,
    },
  ];
}

/**
 * What a V-BIT in a job means (#405): the finding about the job rather than about the geometry,
 * which needs the PLAN, which is why it is raised here and not in `engravabilityFindings` (that
 * module is handed measurements, not items).
 *
 * `null` tool, or any cutter that is not a cone, answers nothing: every job before #405 had a flat
 * end mill and must produce exactly the findings it produced before. The metal-line refusal is not
 * here — it is a claim about the pair and so is judged for every cutter, in
 * {@link metalLineFindings} (#407).
 */
function vCutterFindings(plan: PartPlan, tool: Tool | null): JobFinding[] {
  if (tool === null || !isVTraceTool(tool)) return [];

  // A REGION needs ONE cutting width. Opening a glyph or a pocket means offsetting its outline
  // by the cutter's radius (`generateEngrave`), and a cone has no single radius: its width at the
  // depth the path is at is part of the answer. The toolpath that does cut a region with a V-bit is
  // a medial-axis V-carve — #221's remaining piece — so this is a refusal by name, on the item that
  // asked, rather than a refusal of the cutter (which traces perfectly well).
  const region = plan.engraves[0];
  if (region === undefined) return [];
  const others = plan.engraves.length - 1;
  return [
    {
      severity: 'error',
      code: 'region-v-carve-unavailable',
      labelId: region.id,
      message:
        `${region.name} is a REGION${others > 0 ? ` (and ${others} other item${others === 1 ? '' : 's'})` : ''}: opening it needs the cutter's ` +
        `width, and a V-bit's width changes with the depth of the cut — cutting a region with one is a V-carve, ` +
        `which this app does not do yet (#221). Use a flat end mill for regions, or make the artwork a stroke trace.`,
    },
  ];
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
 *
 * `shop` carries the caller's engrave shop defaults (#451); only the warn ratio is read here, since
 * this stage measures and finds rather than emitting a peck path. See {@link EngraveShopOpts}.
 */
export function engraveRegions(
  tl: ManifoldToplevel,
  job: EngraveJob,
  tool: Tool | null,
  margins: EngraveMargins = effectiveMargins(job, MARGIN_DEFAULTS),
  shop: EngraveShopOpts = {},
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
  const engFindings = radius === null ? [] : engravabilityFindings(job, measured, ratioAtFor(tl, job, radius), tool, shop.lostDetailWarnRatio ?? null);

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
    ...metalLineFindings(job, tool),
    ...vCutterFindings(plan, tool),
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
  const traceCuts: CutRegion[] = traceRadius === null ? [] : traceCutRegions(tl, plan, traceRadius);
  const cuts: CutRegion[] = [...regions, ...traceCuts];

  // #408 — a V TRACE's PREDICTION is a groove, not a region. What a cone removes at a level depends
  // on how far below its tip that level is, so a trace entry cannot be the mouth's polygon set the
  // picture uses: at the trace's own floor that set is 3x too wide and the oracle would call the
  // real cut an under-cut. The entry carries the cone and the CAM's OWN passes instead (a bold
  // stroke arrives at `plan.traces` already widened into parallel passes), and the oracle dilates
  // them by the reach at each level — the mouth at the top face, the tip's own flat at the floor.
  //
  // So the two tool shapes produce the prediction DIFFERENTLY rather than one supplementing the
  // other: a flat cutter keeps `traceCutRegions`' region, and a cone replaces it. Adding the groove
  // beside the mouth would predict both at once and fail every V job on the overlap.
  const cone = tool === null ? null : vCone(tool);
  const predicted: OraclePredicted[] = [
    ...regions.map((c): OraclePredicted => ({ depth: c.depth, polygons: c.polygons })),
    ...(cone === null
      ? traceCuts.map((c): OraclePredicted => ({ depth: c.depth, polygons: c.polygons }))
      : plan.traces.map((t): OraclePredicted => ({ depth: t.depth, polygons: [], groove: { paths: t.paths, closed: t.closed, cone } }))),
  ];

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
  // #487 — the program's own travel, and the same program had its region loops been placed in
  // document order. The report's two region numbers differ by exactly the ordering's doing, so
  // swapping them in leaves every non-region move (a trace, a drill) where it was.
  const travel = travelStats(ir.operations.flatMap((op) => op.moves));
  const ordering = ir.ordering;
  const baselineRapidMm =
    ordering === undefined
      ? travel.rapidMm
      : travel.rapidMm - ordering.rapidMm + ordering.baselineRapidMm;
  return {
    operations: ir.operations.length,
    cuttingMoves,
    estimatedSeconds,
    passes,
    rapidMm: travel.rapidMm,
    cutMm: travel.cutMm,
    baselineRapidMm,
    ordering: ordering === undefined || ordering.order !== 'proximity' ? null : 'proximity',
  };
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
/**
 * The verifier's view of the mount (#442's #427 item): the obstacles and the fit, or nothing at all
 * when the job is held in the vise — and then `verify.ts` behaves exactly as it did before #427.
 */
function mountCtx(mount: MountObstacles | null | undefined): { mountObstacles?: { obstacles: MountObstacles['obstacles']; uncertainty: number } } {
  return mount ? { mountObstacles: { obstacles: mount.obstacles, uncertainty: mount.uncertainty } } : {};
}

function frameProgram(
  ir: ToolpathIR,
  ctx: PostContext,
  machine: MillProfile,
  setup: Setup,
  tool: Tool,
  limit: DepthLimit,
  mount: MountObstacles | null | undefined,
): { nc: string; verify: VerifyReport } | { error: string } {
  // The cutter's footprint in XY, grown by the SAME rule the corner box has always been built with
  // (#244): the disc the toolpath removes. A V-bit's is the groove at the DEEPEST cut in the program
  // (#405) — a cone's opening widens with depth, and the frame has to cover the widest cut it makes,
  // not the tip's 0.3 mm. `traceRadiusAt` answers both shapes, so a flat end mill's frame is
  // unchanged to the last digit.
  const deepestCut = ir.operations.reduce((deepest, op) => Math.max(deepest, op.depth), 0);
  // A flat end mill or a V-bit answers here. A THREAD MILL does not trace (#445): its cut is the
  // annulus around the orbit, and `traceRadiusAt` refuses the shape by name, so the frame would
  // otherwise trace the tool's CENTRE path and miss the cutter's own radius. Growing by the
  // cutting radius is the same rule the disc gets; it is an air trace, so nothing else changes.
  const radius = traceRadiusAt(tool, deepestCut) ?? (tool.shape === 'thread' ? (cuttingDiameter(tool) ?? 0) / 2 : 0);
  const moves = frameCorners(ir, radius, FRAME_Z);
  if (moves === null) return { error: 'the toolpath has no positioned move to trace' };
  const frameIr: ToolpathIR = {
    frame: 'flat', // the frame trace is a flat-frame air move; no rotary frame exists yet (#237)
    tool: ir.tool,
    toolNumber: ir.toolNumber,
    spindleRpm: ir.spindleRpm,
    // #419 Q-F — THE FRAME FILE CARRIES NO VACUUM WORDS. An air trace cuts nothing, so the vacuum
    // buys it nothing, and a `M332` here would switch the mode OFF between two cutting programs
    // (or an `M331` switch it on and leave the mode changed after an operator's own check). The
    // span below is belt and braces: `air: false` alone would already suppress both words.
    air: false,
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
  const posted = postZ1(frameIr, ctx, machine, { vacuum: 'none' });
  if (!posted.ok) return { error: posted.errors.join('; ') };
  const verify = verifyProgram(posted.text, { setup, machine, tool, depthLimit: limit, minRapidZ: frameIr.hopZ, ...mountCtx(mount) });
  return { nc: posted.text, verify };
}

/**
 * The FACING program (#432 slice 2): the skim of the blank's top, as its own file.
 *
 * Posted against the PROBED top — Z0 is the blank as the probe found it, which is the surface this
 * program removes — with the facing pass's OWN cutter (`chooseFacingTool`), its own feeds row, and
 * the SAME post and verifier as the job. The file's header names that cutter, not the job's: the
 * operator loads it for this file alone, and a header claiming the engraving bit would send them to
 * the wrong station.
 *
 * A verifier error WITHHOLDS the file: `nc` comes back null with the report attached, because the
 * one rule this pipeline has is that a program is only handed over after it has been checked.
 *
 * Nothing here can fail the RUN. Every refusal — no suitable cutter, no feeds row, an unsupported
 * geometry, a verifier error — comes back as `error` with `nc: null`, and the caller keeps the
 * engraving the run already produced.
 */
function facingProgram(
  job: EngraveJob,
  depth: Mm,
  ctx: PostContext,
  machine: MillProfile,
  setup: Setup,
  limit: DepthLimit,
  mount: MountObstacles | null | undefined,
  tools: readonly ToolLibraryEntry[],
  /**
   * #432 review R10 — the bench's condition summaries, handed in from `shop.conditions` for the
   * same worker-realm reason as `tools` (see `EngraveShopOpts`). Null: nothing is known broken.
   */
  conditions: ReadonlyMap<string, ConditionSummary> | null | undefined,
  catalogue: readonly FeedCatalogueRow[],
  table: readonly FeedsEntry[] | undefined,
  /**
   * This file's share of the run's vacuum words (#419 decision 4). The facing file is the FIRST
   * program of a run that has one — it runs before any cutter touches the part — so the caller
   * passes `'first'`: the vacuum comes on here and stays on across the bit change, and the
   * engraving program that follows is posted `'last'` to switch it off.
   */
  span: VacuumSpan,
): {
  nc: string | null;
  verify: VerifyReport | null;
  toolKey: string | null;
  error: string | null;
  cam: FacingCamSummary | null;
} {
  // #474/#493 — the rule is the MATERIAL's, not the panel's. A legacy or hand-edited job that still
  // turns facing on for a plastic must not get a face file either: the worker refuses it by name,
  // so the R11 Facing row and the run sheet say why rather than walking the operator through a pass
  // the app will not produce.
  const refusal = facingRefusal(job.stock.material);
  if (refusal !== null) return { nc: null, verify: null, toolKey: null, error: refusal, cam: null };
  const pick = chooseFacingTool(
    tools,
    catalogue,
    job.stock.material,
    job.facing?.toolKey ?? null,
    conditions,
  );
  if (pick.entry === null) return { nc: null, verify: null, toolKey: null, error: pick.reason, cam: null };
  const tool = pick.entry.tool;
  const toolKey = pick.entry.key;
  // The facing pass resolves its OWN feeds: it is a different cutter in the same material, so the
  // engraving's numbers are not its numbers. `feedsFor` is the same resolver the program above uses,
  // against the same catalogue and the same shop table.
  //
  // NO `cutOverride` — deliberately. The job's override is the hand-entered speed and feed for the
  // job's ENGRAVING cutter (#205): a person who typed 12 000 rpm for a 1 mm flat has said nothing
  // about the 6 mm mill that skims the top, and handing those numbers over would run the big cutter
  // at a small cutter's feed rate. The facing file's S/F are the row's own for the facing cutter.
  const feeds = feedsFor(catalogue, job.stock.material, tool, machine, undefined, table);
  if (!feeds.ok) {
    return {
      nc: null,
      verify: null,
      toolKey,
      error: `the facing cutter "${tool.name}": ${feeds.reason}`,
      cam: null,
    };
  }
  // What the file was cut with, for the sheet (#432 slice 3). `zPasses` is the SAME answer the IR
  // uses for its Z levels, so the printed pass count cannot drift from the moves.
  const cam: FacingCamSummary = {
    toolName: tool.name,
    diameterMm: cuttingDiameter(tool) ?? 0,
    passes: zPasses(depth, feeds.params.stepDown).length,
    stepDown: feeds.params.stepDown,
    stepOver: feeds.params.stepOver,
    rpm: feeds.params.rpm,
    feed: feeds.params.feed,
    plungeFeed: feeds.params.plungeFeed,
    air: feeds.params.air,
  };
  try {
    const ir = generateFacing(
      { length: job.stock.length, width: job.stock.width },
      tool,
      feeds.params,
      machine.rapidEstimate,
      depth,
    );
    const posted = postZ1(ir, { ...ctx, toolKey }, machine, { vacuum: span });
    if (!posted.ok) {
      return { nc: null, verify: null, toolKey, error: posted.errors.join('; '), cam: null };
    }
    const verify = verifyProgram(posted.text, {
      setup,
      machine,
      tool,
      depthLimit: limit,
      minRapidZ: ir.hopZ,
      ...mountCtx(mount),
    });
    const refused = verify.findings.filter((f) => f.severity === 'error');
    if (refused.length > 0) {
      // #432 decision 5 — the whole top is the raster and the verifier is its guard, so a skim that
      // would run into the mount is refused and the refusal names the strips it could not face
      // rather than shrinking the pass behind the operator's back. `mount` is non-null here in
      // practice (a mount finding cannot exist without obstacles), but the guard keeps the type
      // honest.
      const atMount = refused.some((f) => f.code === 'clamp-in-path' || f.code === 'bracket-in-path');
      const bands =
        atMount && mount
          ? unfacedBands(mount.obstacles, { x: job.stock.length, y: job.stock.width }, {
              radius: (cuttingDiameter(tool) ?? 0) / 2,
              uncertainty: mount.uncertainty,
            })
          : [];
      return {
        nc: null,
        verify,
        toolKey,
        error:
          `the facing program has ${refused.length} verifier error(s)` +
          (bands.length > 0 ? `: the skim would run into the mount, and ${bands.join('; ')}` : ''),
        // No file, so there is nothing whose numbers the sheet could print.
        cam: null,
      };
    }
    return { nc: posted.text, verify, toolKey, error: null, cam };
  } catch (e) {
    return { nc: null, verify: null, toolKey, error: e instanceof Error ? e.message : String(e), cam: null };
  }
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
 *
 * `shop` is the engrave pipeline's shop defaults (#451), read by the caller for the same reason
 * `margins` is: `engrave.lostDetailWarnRatio` decides which items the findings warn about, and
 * `drill.peckClearanceMm` decides where each peck's re-entry rapid stops. Omitted, both modules keep
 * their labelled fallbacks, so a test or a headless script with no location still cuts the same
 * program the shipped default would.
 *
 * IT RETURNS A LIST (#419 J3). `programs` is the job's files in cut order, one per setup, each
 * posted, verified and FNV-keyed on its own; the older single-program fields (`nc`, `verify`,
 * `frameNc`, `cam`) describe the FIRST program, which is the file the panels upload and simulate
 * until #419 §3's multi-program upload lands. A job with no `setups[]` is exactly one program and
 * takes the pre-#419 path unchanged, so its bytes do not move.
 */
export function engraveGenerate(
  tl: ManifoldToplevel,
  job: EngraveJob,
  tool: Tool | null,
  catalogue: readonly FeedCatalogueRow[],
  calibration: MachineCalibration | null = null,
  margins: EngraveMargins = effectiveMargins(job, MARGIN_DEFAULTS),
  shop: EngraveShopOpts = {},
): EngraveGenerated {
  // #419 J3 — A JOB IS A LIST OF PROGRAMS.
  //
  // The job document says how many: one per setup (J2's `setups[]`), each cut with that setup's own
  // cutter, each posted and verified on its own — because one FILE has one tool, and the run is the
  // files played in order. `setupPrograms` is that reading; this function is the loop over it plus
  // the adapter back to the single-program shape every existing caller reads.
  //
  // A LEGACY DOCUMENT (no `setups[]`) takes exactly today's path, unfiltered: one program, the whole
  // job, `postZ1`'s default vacuum span. Deriving its single setup and re-filtering the lists would
  // drop disabled and construction items from the CAM's input, which is a behaviour change this
  // issue does not own.
  if (job.setups === undefined) {
    const one = generateOneProgram(tl, job, tool, catalogue, calibration, margins, shop, 'whole', true);
    const ref: JobProgramRef = {
      setupIndex: 1,
      setupId: jobSetups(job)[0]!.id,
      toolKey: job.toolKey,
      itemIds: [],
    };
    return { ...one, programs: one.ok && one.nc !== null && one.verify !== null ? [programOf(one, ref)] : [] };
  }

  // A setup that cannot become exactly one program is refused BEFORE anything is cut: the panel's
  // validation says the same sentence (#419 J3, `setupProgramFindings`).
  const setupProblems = setupProgramFindings(job);
  if (setupProblems.length > 0) {
    return {
      ok: false,
      stage: 'findings',
      findings: dedupeFindings([...setupProblems, ...validateJob(job)]),
      feeds: null,
      threads: null,
      threadMachining: null,
      cam: null,
      nc: null,
      verify: null,
      frameNc: null,
      frameVerify: null,
      facingNc: null,
      facingVerify: null,
      facingToolKey: null,
      facingError: null,
      facingCam: null,
      predicted: [],
      programs: [],
      errors: [],
    };
  }

  const refs = setupPrograms(job);
  const results = refs.map((ref, i) => {
    // Decision 4 — the vacuum words are spread across the RUN: on in the first program, off in the
    // last, neither in the ones between. One program is the whole run.
    const span: VacuumSpan = refs.length === 1 ? 'whole' : i === 0 ? 'first' : i === refs.length - 1 ? 'last' : 'middle';
    const subTool = toolForProgram(ref, job, tool, shop);
    const sub = jobForSetup(job, ref, subTool);
    return { ref, one: generateOneProgram(tl, sub, subTool, catalogue, calibration, margins, shop, span, i === 0) };
  });

  const first = results[0]!.one;
  const stopped = results.find((r) => !r.one.ok);
  return {
    // The adapter: the top-level fields describe the FIRST program, which is the file the panels
    // upload, simulate and save today. Multi-program upload is #419 §3's, not this slice's.
    ...first,
    ok: stopped === undefined,
    stage: stopped?.one.stage ?? 'done',
    findings: dedupeFindings(results.flatMap((r) => r.one.findings)),
    errors: results.flatMap((r) => r.one.errors),
    programs: results.flatMap((r) => (r.one.ok && r.one.nc !== null && r.one.verify !== null ? [programOf(r.one, r.ref)] : [])),
  };
}

/** One program as the result's list entry, keyed by the FNV of its posted text (decision 3). */
function programOf(one: Omit<EngraveGenerated, 'programs'>, ref: JobProgramRef): EngraveProgram {
  const nc = one.nc!;
  return {
    setupIndex: ref.setupIndex,
    setupId: ref.setupId,
    toolKey: ref.toolKey,
    nc,
    verify: one.verify!,
    frameNc: one.frameNc,
    frameVerify: one.frameVerify,
    programHash: programHash(nc),
    cam: one.cam,
  };
}

/**
 * The cutter a program runs: the caller's resolved `Tool` when the program is the job's own cutter,
 * otherwise the same key in the run's registry snapshot (`shop.tools`).
 *
 * The worker cannot see the tool registry (#305), which is why the job's cutter arrives as an
 * argument at all. A setup naming a cutter that is in neither place returns null and the program
 * stops at `feeds` with "the job has no usable cutter" — the same refusal a missing job cutter got.
 */
function toolForProgram(
  ref: JobProgramRef,
  job: EngraveJob,
  tool: Tool | null,
  shop: EngraveShopOpts,
): Tool | null {
  if (ref.toolKey === job.toolKey && tool !== null) return tool;
  const entry = (shop.tools ?? []).find((e) => e.key === ref.toolKey);
  return entry?.tool ?? (ref.toolKey === job.toolKey ? tool : null);
}

/**
 * The engraving program's share of the run's vacuum words when a FACING file was produced for it
 * (#432 review R3).
 *
 * The vacuum words belong to the RUN (#419 decision 4), and the facing file is its first program:
 * it is posted `'first'`, switching the vacuum on before the skim, and it stays on across the bit
 * change to the engraving cutter. So the engraving program is no longer first — `'whole'` becomes
 * `'last'` (it opens nothing and closes the run), and a multi-setup run's own first program becomes
 * `'middle'`. The other two are unchanged: neither opens the run.
 *
 * Only applied when the facing file EXISTS. A facing file the verifier withheld leaves the
 * engraving as the run's first program, and it carries both words itself.
 */
function spanAfterFacing(span: VacuumSpan): VacuumSpan {
  if (span === 'whole') return 'last';
  if (span === 'first') return 'middle';
  return span;
}

/**
 * ONE program: the pipeline as it shipped, for one setup and one cutter. Returns everything the
 * result carries EXCEPT `programs` — the list is assembled by the loop in `engraveGenerate`, which
 * is the only place that knows how many programs the job has.
 *
 * `span` is this file's share of the run's vacuum words (decision 4) and `withFacing` says whether
 * this program builds the job's facing file. The facing pass is a property of the BLANK, not of a
 * setup, so exactly one program in a run produces it — the first, so the operator faces before any
 * cut. That file is the run's FIRST program and takes the first word; this program's own span is
 * then moved along by `spanAfterFacing`.
 */
function generateOneProgram(
  tl: ManifoldToplevel,
  job: EngraveJob,
  tool: Tool | null,
  catalogue: readonly FeedCatalogueRow[],
  calibration: MachineCalibration | null,
  margins: EngraveMargins,
  shop: EngraveShopOpts,
  span: VacuumSpan,
  withFacing: boolean,
): Omit<EngraveGenerated, 'programs'> {
  // #347 — the JOB's machine, not the app's only one: the envelope, the spindle ceiling and the
  // frame below are read off the profile the document names. The POST is still `postZ1`'s dialect,
  // which is the only post this app has; a second mill is a second post, and this line is where a
  // job naming it would have to be refused until there is one.
  const mill = jobMachine(job, calibration);
  const { plan, regions, predicted, findings } = engraveRegions(tl, job, tool, margins, shop);
  const errors: EngraveFailure[] = [];

  const stop = (
    stage: EngraveStage,
    extra?: {
      feeds?: FeedsResult | null;
      message?: string;
      threads?: ThreadMillPlan[] | null;
      threadMachining?: ThreadSettingsResult | null;
      /**
       * The facing file, when the stop happens AFTER it was built (#432 review R3 — the facing
       * program is produced before the engraving is posted, so a post refusal can now come second).
       * Omitted everywhere else: a run that stops before the artefact exists reports no facing
       * file, no reason and no tool — `facingError` is "the program could not be produced", not
       * "the run stopped first".
       */
      facing?: {
        nc: string | null;
        verify: VerifyReport | null;
        toolKey: string | null;
        error: string | null;
        cam: FacingCamSummary | null;
      };
    },
  ): Omit<EngraveGenerated, 'programs'> => {
    if (extra?.message !== undefined) errors.push({ stage, message: extra.message });
    return {
      ok: false,
      stage,
      findings,
      feeds: extra?.feeds ?? null,
      threads: extra?.threads ?? null,
      threadMachining: extra?.threadMachining ?? null,
      cam: null,
      nc: null,
      verify: null,
      frameNc: null,
      frameVerify: null,
      facingNc: extra?.facing?.nc ?? null,
      facingVerify: extra?.facing?.verify ?? null,
      facingToolKey: extra?.facing?.toolKey ?? null,
      facingError: extra?.facing?.error ?? null,
      facingCam: extra?.facing?.cam ?? null,
      predicted,
      errors,
    };
  };

  // 1. findings (#200/#201/#203). Any error stops before feeds are even resolved.
  if (findings.some((f) => f.severity === 'error')) return stop('findings');

  // 2. feeds (#202) — OR, for a thread job, the thread settings (#445 D6). A tool the library
  // cannot resolve reads as `tool-missing` above; a tool with no row, or a step-over past the
  // radius (#191), refuses here. A V-BIT passes this gate since #405 — it is a cutter this CAM
  // can trace with, and `radius` being null only says it opens no region — so the refusal is the
  // trace path's own (`cuttingForTrace`), which names a ball nose, a bull nose, or a cone whose
  // header states no tip or angle.
  //
  // A THREAD MILL is refused by `cuttingForTrace` and by `feedsFor` at the same gate, correctly
  // for the region/trace CAM. The thread branch therefore goes BEFORE both and resolves
  // `threadSettings`, which asks the catalogue for a row itself (`catalogueCoverageFor`) and never
  // calls `feedsFor`. A thread-only job is the only job that reaches CAM with a thread mill:
  // `thread-mixed-tools` refuses a thread beside any other cut, because one program has one tool.
  if (tool === null) return stop('feeds', { message: 'the job has no usable cutter' });
  let feeds: FeedsResult | null = null;
  let threadPlans: ThreadMillPlan[] | null = null;
  let threadMachining: ThreadSettingsResult | null = null;
  let ir: ToolpathIR;
  // #432 — the facing depth the plan carries, or 0 when the job does not face. It decides whether
  // the facing artefact is built at all; it never touches the ENGRAVING program, which stays in the
  // document's frame (Z0 = the faced surface) because the re-touch re-zeros Z there between the two
  // programs. Slice 3 orders the two; slice 4 is the re-touch itself.
  const facingDepth = plan.facing?.depth ?? 0;
  if (plan.threads.length > 0) {
    const resolved = threadSettings(shop.defaults ?? null, catalogue, job.stock.material, tool, mill);
    // Carried from here on, refusals included: even a run that stops still knows which numbers it
    // would have cut with and where they came from (#445 phase B's run sheet).
    threadMachining = resolved;
    const refused = resolved.diagnostics.filter((d) => d.severity === 'error');
    if (refused.length > 0) {
      return stop('feeds', { message: refused.map((d) => d.message).join('; '), threadMachining });
    }
    try {
      const plans: ThreadMillPlan[] = [];
      const irs: ToolpathIR[] = [];
      for (const item of plan.threads) {
        const r = threadMillIR({
          tool,
          position: item.position,
          size: item.size,
          depth: item.depth,
          through: item.through,
          settings: resolved.settings,
          stock: { length: job.stock.length, width: job.stock.width },
          descriptor: item.name,
          labelId: item.id,
          // Every cut in this app runs with the vacuum on (#283); `cutOverride.air` is the job's
          // own say, and the feeds table never states anything else.
          air: job.cutOverride?.air ?? true,
          rapid: mill.rapidEstimate,
        });
        if (!r.ok) return stop('cam', { message: r.reason, threadMachining });
        plans.push(r.plan);
        irs.push(r.ir);
      }
      // `concatToolpathIR` renumbers the operations from 1, which is its contract (#287).
      ir = irs.slice(1).reduce((a, b) => concatToolpathIR(a, b), irs[0]!);
      threadPlans = plans;
    } catch (e) {
      return stop('cam', { message: e instanceof Error ? e.message : String(e), threadMachining });
    }
  } else {
    const usable = cuttingForTrace(tool);
    if (!usable.ok) return stop('feeds', { message: usable.reason });
    const resolved = feedsFor(catalogue, job.stock.material, tool, mill, job.cutOverride, shop.feeds ?? undefined);
    if (!resolved.ok) return stop('feeds', { feeds: resolved, message: resolved.reason });
    feeds = resolved;

    // 3. the CAM core (#172), on the SAME opened polygons stage 1 measured.
    try {
      // A job with no REGION item has nothing for the region CAM to open — and since #405 it must not
      // be handed an empty list either: a trace-only job can now reach this line with a CONE for a
      // tool, and `generateEngrave` refuses a V-bit by name (rightly: opening a region needs the
      // offset radius). The two CAMs return IRs describing the same machine state, so a job with no
      // regions simply IS the trace IR, and its `.nc` is unchanged.
      const regionIr = regions.length === 0 ? null : generateEngrave(tl, regions, tool, resolved.params, mill.rapidEstimate, 'nearest', shop.peckClearanceMm ?? null);
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
      const traceIr = generateTrace(plan.traces, tool, resolved.params, mill.rapidEstimate);
      if (regionIr === null) ir = traceIr;
      else ir = traceIr.operations.length > 0 ? concatToolpathIR(regionIr, traceIr) : regionIr;
    } catch (e) {
      return stop('cam', { feeds, message: e instanceof Error ? e.message : String(e) });
    }
  }

  // #432 — FACING IS ITS OWN PROGRAM, and this one is untouched by it.
  //
  // The skim is posted against the blank's PROBED top and posted as its own file (below, beside the
  // frame file), with its own cutter: a 0.5 mm skim wants the widest flat the shop can justify,
  // while the engraving's cutter is chosen for the detail its items need. The engraving program
  // stays in the DOCUMENT's frame, whose Z = 0 is the faced surface, and its verifier's rapid floor
  // is therefore its own `hopZ` — nothing here is shifted, because nothing here is post-shift. What
  // makes the two files meet physically is the re-touch (slice 4): the machine re-zeros Z on the
  // faced surface between the facing program and this one, so a label the document calls 2 mm deep
  // physically sits 2 mm below the faced top in BOTH frames. A shift here would double-lower the
  // cut by the full facing depth once that re-touch lands.
  const minRapidZ = ir.hopZ;
  const cam = summarize(ir);

  // 4. the depth limit and the setup. They are read by the facing file as well as by the verifier
  // below, and the facing file has to be built BEFORE the engraving is posted — see step 6 — so
  // both live up here. The depth limit is the one the JOB implies: the CNC-2 stock limit,
  // tightened where an under-surface void leaves a thinner membrane (#231 item 3). On a job that
  // states its print (#285) the whole limit comes from the layer stack instead, so the void
  // membrane is layer-aligned and the verifier's number is the one the printer will honour.
  const stack = stackDepthLimit(tl, plan, job, margins.boundaryMargin);
  const limit: DepthLimit = stack?.limit ?? jobDepthLimit(job, margins.boundaryMargin);
  const limitReasonAt = stack
    ? (x: number, y: number): string => depthLimitReason(stack, job, x, y)
    : undefined;
  const setup = toSetup(job, mill, shop.mount?.fixture ?? undefined);

  // 5. the post-processor (#173). Its `ctx` comes first because the facing file is posted from it
  // too (step 6), and the two files share one job name, stock and frame.
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

  // 6. the FACING file (#432 slice 2): the skim of the blank's top, as its own program, beside
  // the job. It shares nothing with the engraving program — its own cutter, its own feeds, its own
  // post and verify — and it can refind nothing either: a refusal is carried as `facingError` and
  // the run still succeeds, because an operator who cannot face in this app can face in their own
  // program and still cut what this run produced.
  //
  // BUILT BEFORE THE ENGRAVING IS POSTED (#432 review R3). The vacuum words belong to the RUN
  // (#419 decision 4): the facing file is its first program and switches the vacuum on, and the
  // engraving program that follows switches it off. So the engraving's own share depends on
  // whether this file exists at all — a withheld facing file (refused by the verifier) leaves the
  // engraving as the run's only program, and it has to carry BOTH words itself. The facing file's
  // own span is `'first'` for the same reason.
  const facing =
    withFacing && facingDepth > 0
      ? facingProgram(
          job,
          facingDepth,
          ctx,
          mill,
          setup,
          limit,
          shop.mount,
          shop.tools ?? [],
          shop.conditions ?? null,
          catalogue,
          shop.feeds ?? undefined,
          span === 'none' ? 'none' : 'first',
        )
      : { nc: null, verify: null, toolKey: null, error: null, cam: null };

  // 7. the post-processor's text, with this file's share of the vacuum words: `span` when the
  // engraving is the run's only program (or the facing file was withheld), `spanAfterFacing(span)`
  // when the facing file has already taken the first word.
  let nc: string;
  try {
    const posted = postZ1(ir, ctx, mill, { vacuum: facing.nc !== null ? spanAfterFacing(span) : span });
    if (!posted.ok) return stop('post', { feeds, message: posted.errors.join('; '), facing });
    nc = posted.text;
  } catch (e) {
    return stop('post', { feeds, message: e instanceof Error ? e.message : String(e), facing });
  }

  // 8. the verifier (#174) on the TEXT. The stack holds wasm cross-sections, so it is released
  // when this function returns — it is read again by the verifier calls below and by the frame's.
  try {
    const verify = verifyProgram(nc, { setup, machine: mill, tool, depthLimit: limit, minRapidZ, ...(limitReasonAt ? { limitReasonAt } : {}), ...mountCtx(shop.mount) });
    if (verify.findings.some((f) => f.severity === 'error')) {
      errors.push({ stage: 'verify', message: `${verify.findings.filter((f) => f.severity === 'error').length} verifier error(s)` });
      return { ok: false, stage: 'verify', findings, feeds, threads: threadPlans, threadMachining, cam, nc, verify, frameNc: null, frameVerify: null, facingNc: null, facingVerify: null, facingToolKey: null, facingError: null, facingCam: null, predicted, errors };
    }

    // 9. the frame file (#244): the job's XY extent traced in the air, beside the job. Produced by
    // THIS gated action from the same toolpath, and checked by the SAME verifier — a frame the
    // operator cannot run at the wrong Z, because the Z is in the file.
    const frame = frameProgram(ir, ctx, mill, setup, tool, limit, shop.mount);
    if ('error' in frame) {
      errors.push({ stage: 'verify', message: `the frame file could not be produced: ${frame.error}` });
      return { ok: false, stage: 'verify', findings, feeds, threads: threadPlans, threadMachining, cam, nc, verify, frameNc: null, frameVerify: null, facingNc: facing.nc, facingVerify: facing.verify, facingToolKey: facing.toolKey, facingError: facing.error, facingCam: facing.cam, predicted, errors };
    }
    const frameErrors = frame.verify.findings.filter((f) => f.severity === 'error');
    if (frameErrors.length > 0) {
      errors.push({ stage: 'verify', message: `the frame file has ${frameErrors.length} verifier error(s)` });
      return { ok: false, stage: 'verify', findings, feeds, threads: threadPlans, threadMachining, cam, nc, verify, frameNc: frame.nc, frameVerify: frame.verify, facingNc: facing.nc, facingVerify: facing.verify, facingToolKey: facing.toolKey, facingError: facing.error, facingCam: facing.cam, predicted, errors };
    }

    return {
      ok: true,
      stage: 'done',
      findings,
      feeds,
      threads: threadPlans,
      threadMachining,
      cam,
      nc,
      verify,
      frameNc: frame.nc,
      frameVerify: frame.verify,
      facingNc: facing.nc,
      facingVerify: facing.verify,
      facingToolKey: facing.toolKey,
      facingError: facing.error,
      facingCam: facing.cam,
      predicted,
      errors,
    };
  } finally {
    stack?.dispose();
  }
}
