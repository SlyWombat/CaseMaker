/**
 * #1180 — ONE IMPORT-AND-PLAN LOADER FOR THE ACCEPTANCE PARTS.
 *
 * The licensed Makerables STEP files are expensive to read and recognise, and the acceptance specs
 * each imported the tray/organizer on their own — twice in a file when two tests touched the same
 * part. This module resolves the env-pinned part paths, builds the placed mesh + goal target once
 * per (file, stock, model top) — memoised per process — and recognises the feature tree on top.
 * Splitting the acceptance specs into parallel files then gives the wall clock the parallelism; the
 * loader removes the repeated imports inside each file.
 *
 * It also carries the acceptance catalogue install (the vendor's own rows) and the shared helpers
 * the split acceptance specs measure with, moved verbatim from opsAcceptance959.spec.ts.
 */

import { createHash } from 'node:crypto';

import { expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tl } from './manifoldExec';
import { stepToMesh } from '@/engine/import/stepMesh';
import { recogniseFeatures, type FeatureTree } from '@/engine/cnc/cam/model/features';
import type { ToolpathIR } from '@/engine/cnc/cam/ir';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { Z1 } from '@/engine/cnc/machine';
import { DEFAULT_VISE, seatedVise, viseEnvelope } from '@/engine/cnc/fixture';
import { cuttingDiameter, flatEndMill, type Tool } from '@/engine/cnc/tool';
import { measurePostedProgram, combinePostedFacts } from '../../tools/postedFacts';
import { scoreSevenLines, type CutIntoScore, type ProgramScore, type SequenceReceipt, type SevenLineCard } from '../../tools/sevenLines';
import { makerablesRoot, readMakerablesManifest, resolveMakerablesCard } from '../../tools/makerables';
import { clearMakeraCatalogue, installMakeraCatalogue } from '../../tools/makeraCatalogue';
import { getTools } from '@/engine/cnc/toolRegistry';
import { comparePlanOutcomes, type PlanTradeoff } from '../../tools/tradeoff';
import { feedRowsFor } from '../../tools/feedRows';
import { measureVendorCard } from '../../tools/cardMeasurement';
import { planModelCam, type ModelPlanInput, type PlanPocketsResult, type SetupPlan, type SetupSpec } from '@/engine/cnc/cam/model/plan';
import type { SequenceChoice } from '@/engine/cnc/cam/model/sequence';
import { TOOL_CHANGE_SECONDS } from '@/engine/cnc/engrave/smartPick';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptFieldTooled } from '@/workers/sim/sweptPoint';
import { parseGcode, setupFromHeader, stubSetup } from '@/engine/cnc';
import { sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { checkGoalCutInto, type GoalCutIntoOptions, type GoalCutIntoReport } from '@/engine/cnc/engrave/designCheck';
import type { ResultTop } from '@/engine/cnc/engrave/goalCoverage';
import { vToolAllowance } from '@/engine/cnc/engrave/edgeBreak';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseStl } from '@/engine/import/stlParser';
import { buildModelPlanInputForGoal, type EngraveShopOpts } from '@/workers/sim/engraveGenerate';

export const TRAY_STEP = process.env.CM_959_TRAY_STEP ?? process.env.CM_958_TRAY_STEP;
export const ORGANIZER_STEP = process.env.CM_959_ORGANIZER_STEP ?? process.env.CM_958_ORGANIZER_STEP;

/**
 * THE ACCEPTANCE CATALOGUE, per process. Only the specs that price on the vendor's own rows call
 * `installAcceptanceCatalogue`; the parts loader and the other specs never install it.
 */
let activeCatalogue: ReturnType<typeof installMakeraCatalogue> | null = null;

/** Install the FULL Makera catalogue (local data); the acceptance parts are priced on the vendor rows. */
export function installAcceptanceCatalogue(): ReturnType<typeof installMakeraCatalogue> {
  activeCatalogue = installMakeraCatalogue();
  return activeCatalogue;
}

/** Remove it again, in each acceptance spec's afterAll. */
export function clearAcceptanceCatalogue(): void {
  clearMakeraCatalogue();
  activeCatalogue = null;
}

function catalogue(): ReturnType<typeof installMakeraCatalogue> {
  return activeCatalogue ?? {
    installed: false,
    optedOut: false,
    rows: 0,
    path: null,
    note: 'the acceptance catalogue was not installed in this process',
  };
}

type StepRead = Awaited<ReturnType<typeof stepToMesh>>;
const stepCache = new Map<string, Promise<StepRead>>();

/** The STEP read once per process: the import is the recurring cost, not the placement. */
export function loadStepMesh(file: string): Promise<StepRead> {
  let hit = stepCache.get(file);
  if (hit === undefined) {
    hit = (async () => {
      const bytes = fs.readFileSync(file);
      return stepToMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'recognition');
    })();
    stepCache.set(file, hit);
  }
  return hit;
}

export interface PlacedPart {
  read: StepRead;
  /** The recognition mesh, shifted into the stock frame (centre in XY, top at `modelTop`). */
  mesh: StepRead['mesh'];
  /** The goal's own door: the RAW mesh as a binary STL, placed by `position` exactly as the
   *  recognition mesh was shifted — so `sampleGoalHeightfield` reads the same surface. */
  target: EngraveTargetObject;
}

const partCache = new Map<string, Promise<PlacedPart>>();

/** The part imported and placed ONCE per (file, stock, model top) per process. */
export function placedPart(file: string, stock: [number, number], modelTop: number): Promise<PlacedPart> {
  const key = `${file}|${stock[0]}|${stock[1]}|${modelTop}`;
  let hit = partCache.get(key);
  if (hit === undefined) {
    hit = (async () => {
      const read = await loadStepMesh(file);
      const { min, max } = read.mesh.bbox;
      const dx = stock[0] / 2 - (min[0] + max[0]) / 2;
      const dy = stock[1] / 2 - (min[1] + max[1]) / 2;
      const dz = modelTop - max[2];
      const positions = Float32Array.from(read.mesh.positions);
      for (let i = 0; i < positions.length; i += 3) {
        positions[i] = positions[i]! + dx;
        positions[i + 1] = positions[i + 1]! + dy;
        positions[i + 2] = positions[i + 2]! + dz;
      }
      const stl = buildBinaryStl([{ positions: read.mesh.positions, indices: read.mesh.indices }]);
      const sha256 = createHash('sha256').update(Buffer.from(stl)).digest('hex');
      const target: EngraveTargetObject = {
        id: sha256.slice(0, 16),
        name: path.basename(file),
        format: 'stl',
        sha256,
        data: Buffer.from(stl).toString('base64'),
        size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
        position: { x: stock[0] / 2, y: stock[1] / 2, z: modelTop },
        rotation: 0,
        enabled: true,
        role: 'goal',
      };
      return { read, mesh: { ...read.mesh, positions }, target };
    })();
    partCache.set(key, hit);
  }
  return hit;
}

/** Just the goal target — the shape the reach and shadow specs take. */
export async function placedTarget(file: string, stock: [number, number], modelTop: number): Promise<EngraveTargetObject> {
  return (await placedPart(file, stock, modelTop)).target;
}

const stlCache = new Map<string, Promise<{ bytes: Buffer; parsed: ReturnType<typeof parseStl> }>>();

/** An STL read and parsed once per process — the STL rows and the progress spec share it. */
export function loadStlMesh(file: string): Promise<{ bytes: Buffer; parsed: ReturnType<typeof parseStl> }> {
  let hit = stlCache.get(file);
  if (hit === undefined) {
    hit = (async () => {
      const bytes = fs.readFileSync(file);
      const parsed = parseStl(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      return { bytes, parsed };
    })();
    stlCache.set(file, hit);
  }
  return hit;
}

const treeCache = new Map<
  string,
  Promise<{ tree: FeatureTree; mesh: StepRead['mesh']; faceId: Uint32Array | undefined; target: EngraveTargetObject }>
>();

/** The part with its recognised feature tree — ONE recognition per (file, stock, model top). */
export function placedTree(
  file: string,
  stock: [number, number],
  modelTop: number,
): Promise<{ tree: FeatureTree; mesh: StepRead['mesh']; faceId: Uint32Array | undefined; target: EngraveTargetObject }> {
  const key = `${file}|${stock[0]}|${stock[1]}|${modelTop}`;
  let hit = treeCache.get(key);
  if (hit === undefined) {
    hit = (async () => {
      const part = await placedPart(file, stock, modelTop);
      const tree = recogniseFeatures({ triangles: part.mesh, faceId: part.read.faceId }, { up: [0, 0, 1], stockTop: 0 }, tl);
      return { tree, mesh: part.mesh, faceId: part.read.faceId, target: part.target };
    })();
    treeCache.set(key, hit);
  }
  return hit;
}

/** #991 — the Makerables .stl that ships beside the STEP: the file a user would have picked. */
export function shippedStlBeside(stepPath: string): string | null {
  const stl = path.join(path.dirname(stepPath), `${path.basename(stepPath, path.extname(stepPath))}.stl`);
  return fs.existsSync(stl) ? stl : null;
}

/** The card's own single setup (the #966 test seam), so the #991 rows measure the door, not the
 * setup decision. */
export const CARD_SETUPS: SetupSpec[] = [{ frame: { up: [0, 0, 1], stockTop: 0 }, underside: 'flatOnStockBottom' }];


/**
 * #991 — THE STL ROW: the Makerables .stl planned through `buildModelPlanInputForGoal`, the
 * user's own door (an STL carries no faceId), on the card's stock and single setup. The seven
 * lines are measured by the card's own `writeAcceptance`; the row prints beside the STEP row
 * and is pinned to today's numbers, so the filed mesh-path item's fix is visible here.
 */
export async function measureStlRow(name: string, stlPath: string, stockXy: [number, number], modelTop: number) {
  const { bytes, parsed } = await loadStlMesh(stlPath);
  const size = {
    x: parsed.bbox.max[0] - parsed.bbox.min[0],
    y: parsed.bbox.max[1] - parsed.bbox.min[1],
    z: parsed.bbox.max[2] - parsed.bbox.min[2],
  };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const goal: EngraveTargetObject = {
    id: sha256.slice(0, 16),
    name: path.basename(stlPath),
    format: 'stl',
    sha256,
    data: bytes.toString('base64'),
    size,
    position: { x: stockXy[0] / 2, y: stockXy[1] / 2, z: modelTop },
    rotation: 0,
    enabled: true,
    role: 'goal',
    chamfer: { widthMm: EDGE_BREAK_LEG_MM, toolKey: `inv:${CHAMFER3175.id}` },
  } as EngraveTargetObject;
  // The part's top sits at `modelTop` in the work frame (Z 0 = stock top), so the stock is as
  // thick as the part is tall plus that drop.
  const thickness = -modelTop + size.z;
  const base = defaultEngraveJob();
  const job: EngraveJob = {
    ...base,
    labels: [],
    shapes: [],
    targetObject: goal,
    toolKey: '',
    tool: BALL6,
    stock: { ...base.stock, length: stockXy[0], width: stockXy[1], thickness, material: 'hardwood' },
  };
  const input = await buildModelPlanInputForGoal(job, goal, BALL6, SHOP_991);
  input.setups = CARD_SETUPS;
  const output = await planModelCam(input);
  const setup = output.perSetup[0]!;
  const runs = setup.programs.map((ir) => ({ cutterKey: ir.tool.id ?? ir.tool.name, ir }));
  const measured = writeAcceptance(
    `${name}-stl`,
    setup.features,
    { ops: setup.ops, programs: runs, sequence: setup.sequence, unreachable: setup.unreachable, notes: setup.notes, choice: setup.choice },
    { target: goal, stock: { length: stockXy[0], width: stockXy[1] } },
  );
  const rims = setup.features.rims.length;
  const modelled = setup.features.rims.filter((r) => r.kind === 'modelledChamfer').length;
  const chamferOps = setup.ops.filter((op) => op.kind === 'chamfer').length;
  const skippedRims = setup.notes.filter((n) => n.includes('not broken')).length;
  console.log(
    `#991 ${name} STL row: ${setup.features.report.source} path, ${rims} rims (${modelled} modelledChamfer), ${chamferOps} chamfer ops (${skippedRims} rims not broken), ` +
      `coverage ${measured === null ? '—' : (measured.coverage * 100).toFixed(2)} %, cut-into ${measured === null ? '—' : ((measured.adjudicatedFraction ?? 0) * 100).toFixed(4)} %, ` +
      `cycle ${measured === null ? '—' : measured.ours.cycleSeconds.toFixed(1)} s, ` +
      // #995 — the row PRINTS its seven verdicts beside the STEP row's, never only the geometry.
      `seven lines (${measured === null ? 'unmeasured' : measured.scored.sentence}): ${measured === null ? '—' : sevenVerdicts(measured)}`,
  );
  return { setup, measured, rims, modelled, chamferOps };
}
// Makera's own pattern on these parts (plan v2 §1): the largest flat roughs, a smaller flat rests
// the corners it cannot enter, the ball finishes the curved remainder, the chamfer breaks the
// rims. A's R5 ruling: a simulation-only reference card prices on the VENDOR's own set. E's own
// tool-by-tool read of Makera's tray NC (2026-11-04): T1 6x32 flat, T2 3.175x25 flat, T3 6x32
// ball, T4 3.175 90° chamfer (tip 0.1) — the real four, not the two this spec carried before: with
// no ball or chamfer candidate, `chooseSequence` could never reproduce the 99.6 % of the scoop's
// own cells E found the vendor's ⌀6 ball cutting, which is the coverage gap in one line.
// The ids ARE Makera's catalogue ids (the vendor NC's T1-T4 records), so the installed catalogue
// answers each cutter by id — geometry alone would send the ball through the flat proxy.
export const FLAT6 = flatEndMill(6, { number: 1, id: '111031606032', name: 'flat-6', fluteLength: 32 });
export const FLAT3175 = flatEndMill(3.175, { number: 2, id: '111011313825', name: 'flat-3.175', fluteLength: 25 });
export const BALL6: Tool = { ...flatEndMill(6, { number: 3, id: '131032606032', name: 'ball-6', fluteLength: 32 }), typeText: 'Ball Nose', shape: 'ball' };
/** The vendor's 90° chamfer from the Makerables headers (⌀3.175, tip 0.1) — the bit the job's edge
 * break is cut with, and `edgeBreakAllowance` below's own source. */
export const CHAMFER3175: Tool = {
  ...flatEndMill(3.175, { number: 4, id: '122111013890', name: '3.175mm*90º Chamfer' }),
  typeText: 'V-Bit',
  shape: 'chamfer',
  tipDiameter: 0.1,
  diameter: 3.175,
  cornerRadius: 0,
  angle: 90,
  halfAngle: 45,
};
export const VENDOR_SET = [FLAT6, FLAT3175, BALL6, CHAMFER3175];

/** The shop the app's goal seam resolves a stated chamfer key through. */
export const SHOP_991: EngraveShopOpts = {
  tools: VENDOR_SET.map((t) => ({ key: `inv:${t.id}`, tool: t, provenance: 'test' })),
  feeds: null,
};
export const RAPID = Z1.rapidEstimate;

/**
 * #959 — THE REAL PARTS PLAN THROUGH THE ONE ENTRY (the manager's finding on E's run). The facts
 * level below used to plan through `planPocketsForTree`, so the curved half never ran on the tray
 * or the organizer: the ball finish E compared against the vendor's 99.5 % was never in our number,
 * and 90.44 % / 81.39 % stayed frozen from 9c1bcc41 for that reason. `planModelCam` is what the app
 * calls — the acceptance now measures what IT posts.
 */
export const EDGE_BREAK_LEG_MM = 0.5;

/**
 * A plan's runs in execution order — the plan's OWN posted programs (`SetupPlan.programs`), never a
 * re-derivation from `setup.ops`. `ops` stays in the reporting order (region by region); since
 * #964's `batchSameCutterRuns` the execution order groups the same cutter's ops, so deriving runs
 * from `ops` would resurrect the very alternation the batching removes (30 runs on the tray instead
 * of the 4 the plan posts).
 */
export function runsOf(setup: SetupPlan): { cutterKey: string; ir: ToolpathIR }[] {
  return setup.programs.map((ir) => ({ cutterKey: ir.tool.id ?? ir.tool.name, ir }));
}

export async function planCard(
  placed: Awaited<ReturnType<typeof placedTree>>,
  stock: { length: number; width: number },
  goal?: GoalHeightfield,
  // #975 — the plan's candidate set. The default is the card's own (the vendor's set); the
  // two-plan run passes the owned set and the owned ∪ catalogue set through the same entry.
  cutters: { house: Tool[]; catalogue: Tool[] } = { house: VENDOR_SET, catalogue: [] },
): Promise<{ setup: SetupPlan; runs: { cutterKey: string; ir: ToolpathIR }[] }> {
  const positions = placed.mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      min[c] = Math.min(min[c]!, positions[i + c]!);
      max[c] = Math.max(max[c]!, positions[i + c]!);
    }
  }
  // #943 (the maintainer's 11-05 ruling): the real acceptance parts are planned in the VISE with
  // jaw clearance, not on the bare bed. The envelope is the app's own call (`defaultFixture`'s
  // `viseEnvelope(job.stock, jobVise(job))`); the plan states in its notes that the region
  // obstacles do not consume it yet, and the gate's sweep still checks the posted program
  // against the SAME envelope — so the holding is a fact of this run, not a silent assumption.
  const thickness = placed.tree.frame.stockTop - placed.tree.frame.partBottom;
  const vise = seatedVise(DEFAULT_VISE, thickness);
  const input: ModelPlanInput = {
    geometry: {
      triangles: { positions, indices: placed.mesh.indices, triangleCount: placed.mesh.indices.length / 3, bbox: { min, max } },
      ...(placed.faceId === undefined ? {} : { faceId: placed.faceId }),
    },
    setups: [{ frame: { up: [0, 0, 1], stockTop: 0 }, underside: 'flatOnStockBottom' }],
    stock: { length: stock.length, width: stock.width, thickness, material: 'hardwood' },
    fixture: { mount: 'vise', envelope: viseEnvelope({ length: stock.length, width: stock.width, thickness }, vise) },
    cutters,
    // #965 (the review session's ruling, 2026-11-05) — these parts STATE NO FINISH TOLERANCE, so
    // the ball runs at the engine's default scallop (0.027 mm, the vendor's own). The empty object
    // is the point: a stated 0.01 would now be honoured, and the tray and organizer are not this
    // ruling's to change.
    tolerances: {},
    edgeBreak: { legMm: EDGE_BREAK_LEG_MM },
    // #961 — THE SIMULATED OUTCOME: the picker judges a candidate's completeness by what its own
    // sweep leaves above the 0.1 mm band, not by the pockets it declined. The goal is the same
    // heightfield the card measures against, sampled from the placed STEP.
    ...(goal === undefined ? {} : { goal }),
  };
  const output = await planModelCam(input);
  const setup = output.perSetup[0]!;
  expectOwnPocketDepths(setup, 'card');
  return { setup, runs: runsOf(setup) };
}

/**
 * #1019 review (finding 1) — RED-FIRST: every pocket op's recorded depth is its OWN node's.
 * `pocket()` builds an operation's `depth` from its own mouth-to-floor span and its
 * `estimatedSeconds` from its own moves, so an op wearing another pocket's pair (a 2.9999998 on a
 * 22 mm pocket — thirteen of them, all pocket-15's) is a pairing bug even when every move is right.
 * The op's own posted passes are the oracle: they span `(depthPasses − 1) × stepDown`.
 */
export function expectOwnPocketDepths(setup: SetupPlan, where: string): void {
  for (const op of setup.ops) {
    if (op.kind !== 'pocket') continue;
    const irOp = op.outcome.ir.operations[0];
    if (irOp === undefined) continue;
    const ownDepth = ((irOp.depthPasses ?? 1) - 1) * (irOp.passStepMm ?? 0);
    expect(
      irOp.depth + 1e-3,
      `${where}: ${op.region.id}'s recorded depth ${irOp.depth} against its own ${irOp.depthPasses} passes at ${irOp.passStepMm} mm`,
    ).toBeGreaterThanOrEqual(ownDepth - 1e-3);
  }
}

export function postedTextFor(cutterKey: string, merged: ToolpathIR, ctx: PostContext): string {
  const posted = postZ1(merged, ctx, Z1);
  if (!posted.ok) throw new Error(`#959 ${cutterKey}: postZ1 refused — ${posted.errors.join('; ')}`);
  return posted.text;
}

/** The gate's allowance is sized from the vendor's own chamfer Tool record (`CHAMFER3175`, above)
 * and the job's stated edge break, never from the CAM's plan (A's R3); `vToolAllowance` is the
 * app's own V reader. */
export function edgeBreakAllowance(): Pick<GoalCutIntoOptions, 'edgeBreak' | 'wallShadowRadiusMm'> {
  const allowance = vToolAllowance(CHAMFER3175);
  if (allowance === null) throw new Error('#959: the chamfer Tool record states no cone');
  // #948/v4 — THE V GATE: the card's allowance names the job's own chamfer tool number, so the
  // check excuses a band cell only where this V cut it deepest (`edgeBreak.toolNumber` + whoAt).
  // A tool record with no number cannot carry the gate, and the self-test below fails rather than
  // letting the card measure the geometry-only rule.
  const toolNumber = CHAMFER3175.number;
  return {
    edgeBreak: { ...allowance, ...(toolNumber === null || toolNumber === undefined ? {} : { toolNumber }) },
    wallShadowRadiusMm: cuttingDiameter(FLAT6)! / 2,
  };
}

/**
 * The gate's read of the posted programs: each program is loaded with its own Tool-record cutter
 * and stamped at every goal cell centre by the app's exact sweep (`sweptFieldExact`), and the
 * stamps are accumulated across programs by taking the lowest reach at each cell — the same fold
 * `goalCheckField` performs within one run, applied across the runs this spec posts separately.
 */
export function stampedTop(
  runs: readonly { cutterKey: string; text: string; ir: ToolpathIR }[],
  goal: GoalHeightfield,
): { top: ResultTop; whoAt: (x: number, y: number) => number | null; clAt: (x: number, y: number) => { x: number; y: number } | null } {
  let acc: Float32Array | null = null;
  let who: Uint8Array | null = null;
  // #1092 (0f's R-b parity ask) — the CL of the SAME stamp that set the depth folds with the field
  // and the identity (lowest reach wins, ties keep the earlier run), exactly the session's fold.
  // The silhouette branch reads it; the band fix already excuses the rim chamfer, so this changes
  // none of those cells — it makes the helper's inputs match production (`goalCheckField.ts`).
  let clXs: Float32Array | null = null;
  let clYs: Float32Array | null = null;
  for (const run of runs) {
    const parsed = parseGcode(run.text);
    const part = setupFromHeader(parsed.header).patch.part;
    if (part === undefined || part.kind !== 'prism' || part.outline.kind !== 'p-rect') {
      throw new Error(`#959 goal check: ${run.cutterKey}'s posted text carries no rectangular stock header`);
    }
    const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
    // `exactSweptFieldTooled` is the read the session's stamp makes: the posted program stamped at
    // every goal cell centre with the Tool-record cutter, carrying the per-cell identity of the
    // lowest reach. Called on the program's own timeline rather than through a session, because a
    // dense flat job routes to the exact engine and the session then has no column grid to read —
    // the stamp itself is route-independent.
    const timeline = buildTimeline(parsed, setup, Z1);
    const stamp = exactSweptFieldTooled(goal, timeline, () => run.ir.tool);
    if (stamp === null) throw new Error(`#959 goal check: ${run.cutterKey} produced no exact stamp`);
    if (acc === null || who === null || clXs === null || clYs === null) {
      acc = Float32Array.from(stamp.field);
      who = Uint8Array.from(stamp.who);
      clXs = Float32Array.from(stamp.clX);
      clYs = Float32Array.from(stamp.clY);
    } else {
      // #948/v4 — the per-run who maps fold with the field, lowest reach wins (the session's own
      // fold): the cell's cutter is the one whose stamp took it deepest, which is what the V gate
      // reads. A tie keeps the earlier run's identity, as `session.ts`'s fold does. #1092 — the
      // CL point folds with them, from the same winning stamp.
      for (let k = 0; k < acc.length; k++) {
        if (stamp.field[k]! < acc[k]!) {
          acc[k] = stamp.field[k]!;
          who[k] = stamp.who[k]!;
          clXs[k] = stamp.clX[k]!;
          clYs[k] = stamp.clY[k]!;
        }
      }
    }
  }
  if (acc === null || who === null || clXs === null || clYs === null) throw new Error('#959 goal check: no programs to stamp');
  const field: Float32Array = acc;
  const identity: Uint8Array = who;
  const clX: Float32Array = clXs;
  const clY: Float32Array = clYs;
  const cell = (x: number, y: number): number | null => {
    const i = Math.round((x - goal.x0) / goal.pitch);
    const j = Math.round((y - goal.y0) / goal.pitch);
    if (i < 0 || j < 0 || i >= goal.nx || j >= goal.ny) return null;
    return j * goal.nx + i;
  };
  return {
    top: (x: number, y: number) => {
      const k = cell(x, y);
      return k === null ? null : field[k]!;
    },
    whoAt: (x: number, y: number) => {
      const k = cell(x, y);
      return k === null ? null : identity[k]!;
    },
    // The same stamp's CL, absent where no cut stamped the cell (field 0) — the session's own
    // `sweptClExact` contract.
    clAt: (x: number, y: number) => {
      const k = cell(x, y);
      if (k === null || field[k] === 0) return null;
      return { x: clX[k]!, y: clY[k]! };
    },
  };
}

/** The vendor card beside ours, from the local Makerables references (the page's own measurement
 * path). Absent on a machine without them: the card is then unreferenced, never guessed. */
export function vendorScoreFor(name: string): ProgramScore | null {
  // The two-plan runs post under `tray-ideal` / `organizer-ideal`: the SAME reference card, so
  // both plans are scored against the same vendor program (the ruling compares like with like).
  const cardId = name.startsWith('tray') ? 'tray70-top' : name.startsWith('organizer') ? 'organizer-top' : null;
  if (cardId === null) return null;
  const manifest = readMakerablesManifest();
  const entry = manifest.cards.find((c) => c.card === cardId);
  if (entry === undefined) return null;
  const resolved = resolveMakerablesCard(entry, makerablesRoot());
  if (!resolved.ok) return null;
  return measureVendorCard({
    card: cardId,
    goalcheckPath: resolved.resolved.goalcheckPath,
    ncFiles: resolved.resolved.ncFiles,
    // The reference page's own words: the vendor cut on its bare bed (#943 prints both holdings).
    holding: entry.holding,
  });
}

interface AcceptanceGoal {
  /** The goal's own door: the STEP mesh as a placed target (see `placedTree`). */
  target: EngraveTargetObject;
  /** The stock the reference card is cut from, for the post's header (the stamp reads the same). */
  stock: { length: number; width: number };
}

/**
 * THE HOLDING THE CARD PRINTS (#943). The real acceptance parts are planned in the vise (see
 * `planCard`), so their card states the vise, the stock's proud height over the jaw tops and that
 * the pitch was not changed. The synthetic and figure cards are tapes: they say `tape` and state
 * the line is NOT claimed — never 'as filed'. Every card carries this string into `sevenLines`
 * (`holding.ours`), and the vendor's own stated holding is printed beside it.
 */
export function holdingFacts(
  tree: FeatureTree,
  goal: AcceptanceGoal | undefined,
): { ok: boolean; holding: string; pitchMm: number; note?: string } {
  if (goal === undefined) {
    return {
      ok: false,
      holding: 'tape',
      pitchMm: 0.1,
      note: "'posts as filed' means the vise with jaw clearance (#943); this card is a tape-down plan and cannot claim the line",
    };
  }
  const thickness = tree.frame.stockTop - tree.frame.partBottom;
  const vise = seatedVise(DEFAULT_VISE, thickness);
  return {
    ok: true,
    holding:
      `vise — Z1 low-profile, stock ${goal.stock.length} × ${goal.stock.width} × ${thickness.toFixed(1)} mm, ` +
      `${vise.stockProud.toFixed(1)} mm proud of the jaw tops (jaws at x = 0 / ${goal.stock.length} mm)`,
    pitchMm: 0.1,
  };
}

/** What `writeAcceptance` reads from a plan — the pocket result and the one entry's SetupPlan both answer it. */
type AcceptancePlan = Pick<PlanPocketsResult, 'ops' | 'programs' | 'sequence' | 'unreachable' | 'notes' | 'choice'>;

/**
 * #961 acceptance (the maintainer's 11-05 review) — THE CARD'S PRICED CANDIDATE SEQUENCES.
 *
 * The pocket chain's picker already priced every candidate (`SequenceChoice.considered`, ranked by
 * completeness then failures then house/rowed then #927's total). This turns that into the card's
 * receipt: each candidate's cutters, its #927 estimate (moves + spin-up + inter-op, without the
 * changes), its total (with the shop's tool-change seconds), its completeness rank
 * (`leftBehind`/`unreachable`/`unplanned`), and which one won. The chosen WHOLE-JOB set comes from
 * the posted runs — the curved stage's ball and the rim chamfer are chosen outside the picker, by
 * geometry, and the card says so rather than pretending the picker priced them.
 */
export function sequenceReceipt(
  choice: SequenceChoice,
  runs: readonly { cutterKey: string; ir: ToolpathIR; text: string }[],
): SequenceReceipt {
  const flats = [...new Set(runs.filter((r) => r.ir.tool.shape === 'flat').map((r) => r.ir.tool))]
    .sort((a, b) => (cuttingDiameter(b) ?? 0) - (cuttingDiameter(a) ?? 0));
  const roleOf = (tool: Tool): string => {
    if (tool.shape === 'flat') return tool === flats[0] ? 'flat' : 'rest';
    if (tool.shape === 'ball' || tool.shape === 'tapered-ball') return 'ball';
    if (tool.shape === 'chamfer' || tool.shape === 'engraving') return 'chamfer';
    return tool.shape;
  };
  // Per cutter, in execution order, #927 on every run it posts (a return merges its runs).
  const chosenMap = new Map<string, { cutterKey: string; role: string; estimateSeconds: number; runs: number }>();
  for (const run of runs) {
    const entry = chosenMap.get(run.cutterKey) ?? {
      cutterKey: run.cutterKey,
      role: roleOf(run.ir.tool),
      estimateSeconds: 0,
      runs: 0,
    };
    entry.estimateSeconds += measurePostedProgram(run.text).cycleSeconds;
    entry.runs += 1;
    chosenMap.set(run.cutterKey, entry);
  }
  const chosen = [...chosenMap.values()];
  const chosenSignature = choice.steps.map((step) => `${step.kind}:${step.cutter.key}`);
  const candidates = [...choice.considered]
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || (a.cost === null ? 1 : 0) - (b.cost === null ? 1 : 0))
    .map((candidate) => ({
      rank: candidate.rank ?? 0, // 0 = could not be priced; printed after every ranked candidate
      steps: candidate.steps.map((step) => ({ kind: step.kind, cutterKey: step.cutterKey })),
      cutters: [...new Set(candidate.steps.map((step) => step.cutterKey))],
      estimateSeconds: candidate.estimateSeconds,
      toolChanges: candidate.toolChanges,
      totalSeconds: candidate.cost,
      leftoverCells: candidate.leftoverCells,
      coveredCells: candidate.coveredCells,
      restPrice: candidate.restPrice,
      leftBehind: candidate.leftBehind,
      unreachable: candidate.unreachable,
      unplanned: candidate.unplanned,
      chosen:
        candidate.steps.length === choice.steps.length &&
        candidate.steps.every((step, i) => `${step.kind}:${step.cutterKey}` === chosenSignature[i]),
      reason: candidate.reason,
    }));
  // The vendor's own set, in its run order, and the closest picker candidate: the chain of the
  // vendor's FLATS (the picker prices flat chains; the ball and chamfer are the curved/rim stages').
  const vendorKeys = VENDOR_SET.map((tool) => tool.id ?? tool.name);
  const vendorFlats = VENDOR_SET.filter((tool) => tool.shape === 'flat').map((tool) => tool.id ?? tool.name);
  const chosenKeys = chosen.map((entry) => entry.cutterKey);
  const bestFlatChain = candidates.find((candidate) => {
    const cutters = candidate.cutters;
    return cutters.length === vendorFlats.length && cutters.every((key, i) => key === vendorFlats[i]);
  });
  const sameAsVendor = chosenKeys.length === vendorKeys.length && chosenKeys.every((key, i) => key === vendorKeys[i]);
  const vendor = sameAsVendor
    ? `chosen set = Makera's own four, in its run order (${vendorKeys.join(' → ')})`
    : `chosen set ${chosenKeys.join(' → ')} vs Makera's four ${vendorKeys.join(' → ')}` +
      (bestFlatChain === undefined
        ? '; no priced candidate uses the vendor’s flat chain (T1 → T2) — the picker adds a rest flat only for a pocket the primary cannot enter, and this part has none'
        : `; the vendor’s flat chain (T1 → T2) prices at ${bestFlatChain.totalSeconds === null ? '—' : `${bestFlatChain.totalSeconds.toFixed(1)} s`} (rank ${bestFlatChain.rank || 'unpriced'}), the chosen chain at ${choice.cost.totalSeconds.toFixed(1)} s`) +
      '; the ball and the chamfer are chosen by the curved/rim stages, not priced as picker candidates';
  return {
    rule:
      'rank: completeness first — the SIMULATED OUTCOME, the goal cells the candidate’s own sweep leaves above the 0.1 mm band (fewer wins), then pockets a cutter could cover and the chain left (leftBehind), then unplanned steps, house before catalogue, rowed before fallback, then the #927 total; rank 1 is the choice. A coverage rest must also clear 0.01 mm²/s of coverage bought against the chain without it, on the picker’s own simulated field — which includes cells the ball finish may cover later, so the price judges what the REST can reach, not a promise of final coverage (the card’s measured gain is stated separately). Candidate estimates are #927 on the picker’s planned steps; the chosen cutters’ estimates are #927 on the posted runs (the card’s cycle basis).',
    chosen,
    candidates,
    vendor,
  };
}

/**
 * #991 — THE REVIEW SESSION'S CLARIFIED RULING: BOTH ROWS, ALL SEVEN LINES. A reference card's
 * STEP row AND its STL row each pass every line — coverage, cut-into, cycle, air, rapids,
 * cutters, posts-as-filed — against the same vendor score the card already resolves. A stated
 * line is not a pass (`scoreSevenLines`' own rule); `failing` names every line that is not.
 */
export function expectSevenLinesPass(measured: { scored: SevenLineCard }, row: string): void {
  expect(measured.scored.referenced, `${row}: unreferenced — no vendor score beside it`).toBe(true);
  expect(measured.scored.failing, `${row} seven lines — ${measured.scored.sentence}`).toEqual([]);
}

/** #995 — one row's seven verdicts, in the ruling's order, for the card to print. */
export function sevenVerdicts(measured: { scored: SevenLineCard }): string {
  return measured.scored.lines.map((line) => `${line.key}:${line.state}`).join(' ');
}

export function writeAcceptance(
  name: string,
  tree: FeatureTree,
  result: AcceptancePlan,
  goal?: AcceptanceGoal,
): { coverage: number; adjudicatedFraction: number; ours: ProgramScore; scored: SevenLineCard } | null {
  const { ops, programs, sequence, unreachable, notes } = result;

  const ctx: PostContext = {
    jobName: `${name}-959`,
    // The TRUE stock thickness — `partTop - partBottom` undercounts by any skin between the
    // stock's own top and the recognised part top (advisor's review on 108e120c): the contour now
    // correctly cuts to `stockTop - zTo`, deeper than a `partTop`-based thickness would state.
    // Length/width are the reference card's stock when a goal is measured (the setup stub reads
    // them from this header); the synthetic cases carry none and measure no goal.
    stock: {
      length: goal?.stock.length ?? 0,
      width: goal?.stock.width ?? 0,
      thickness: tree.frame.stockTop - tree.frame.partBottom,
    },
    materialName: 'hardwood',
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'test-959',
    toolKey: 'multi',
  };

  // One posted text per RUN (not per cutter key — advisor's review on ab6b2827: a cutter #961
  // returns to for the freeing cut posts as its OWN run, never merged into its first one).
  const factsByRun = programs.map((run) => ({
    cutterKey: run.cutterKey,
    ir: run.ir,
    text: postedTextFor(run.cutterKey, run.ir, ctx),
  }));
  const facts = combinePostedFacts(factsByRun.map((f) => measurePostedProgram(f.text)));
  const sequenceFacts = sequenceReceipt(result.choice, factsByRun);

  // THE TWO GEOMETRY LINES (plan v2 §3, red-first): the goal heightfield from the same STEP, the
  // posted programs stamped with their Tool-record cutters and accumulated, judged by the app's
  // own goal check with the V2-2 edge-break allowance, then scored through the seven-line scorer
  // against the Makerables vendor card. The tray's coverage is expected to be well below
  // Makera's 99.5 % until #960's ball finish lands — the number is the point, not a pass gate.
  let measured:
    | { coverage: number; cutInto: CutIntoScore; report: GoalCutIntoReport; ours: ProgramScore; scored: SevenLineCard }
    | null = null;
  if (goal !== undefined) {
    const field = sampleGoalHeightfield(goal.target, { pitchMm: 0.1, stockTopZ: 0 });
    const stamped = stampedTop(factsByRun, field);
    const report = checkGoalCutInto(field, stamped.top, {
      passCoverage: 0.95,
      ...edgeBreakAllowance(),
      whoAt: stamped.whoAt,
      // #1092 (0f's R-b parity ask) — production supplies the CL whenever the job states a wall
      // shadow radius (`goalCheckField.ts`); the helper now matches it.
      clAt: stamped.clAt,
    });
    const coverage = 1 - (report.leftoverFractions[0] ?? 0);
    const cutInto: CutIntoScore = {
      adjudicatedFraction: report.adjudicatedFraction,
      edgeBreakFraction: report.edgeBreakFraction,
      wallNotScoredFraction: report.wallNotScoredFraction,
      shadowNotScoredFraction: report.shadowNotScoredFraction,
      rawFraction: report.cutIntoFraction,
      maxMm: report.maxCutIntoMm,
      // The manager's own ask on E's run: a depth alone does not say whether a residue is a real
      // gouge or an artefact the rule should name — the coordinate is what lets a reader check it
      // against the part's own feature layout.
      maxAt: report.maxCutIntoAt,
      // #1092 (0f's ruling) — the deepest-cut tradeoff row is judged on the ADJUDICATED maximum;
      // the raw pair above stays printed beside it, with the class the raw cell was excused as.
      adjudicatedMaxMm: report.adjudicatedMaxMm,
      rawMaxExclusion: report.rawMaxExclusion ?? null,
    };
    const ours: ProgramScore = {
      label: name,
      coverage,
      cutInto,
      cycleSeconds: facts.cycleSeconds,
      // One manual bit change between consecutive posted runs; each run here is one cutter.
      toolChanges: Math.max(0, programs.length - 1),
      headerTimeSeconds: null,
      // C2 — which row fed each cutter, and the door's own state (installed, or opted out).
      feedRows: feedRowsFor(VENDOR_SET, 'hardwood'),
      catalogueStatus: { used: catalogue().installed, note: catalogue().note },
      sequence: sequenceFacts,
      airFraction: facts.airFraction,
      rapidSeconds: facts.rapidSeconds,
      rapidMoves: facts.rapidMoves,
      rapidsPer1000FeedLines: facts.rapidsPer1000FeedLines,
      cutters: facts.cutters.length,
      cuttersOwned: null, // a simulation-only reference card prices on the vendor's own set (R5)
      postsAsFiled: holdingFacts(tree, goal),
    };
    measured = { coverage, cutInto, report, ours, scored: scoreSevenLines({ card: name, ours, vendor: vendorScoreFor(name) }) };
    // BOTH CYCLE BASES, printed together (the manager's #959 acceptance): our estimate on the
    // posted text PLUS the shop's 91.4 s per tool change, against the vendor's own card value.
    const changes = Math.max(0, programs.length - 1);
    const oursTotal = facts.cycleSeconds + changes * TOOL_CHANGE_SECONDS;
    const cycleLine = measured.scored.lines.find((l) => l.key === 'cycle');
    // F's #964 harness (origin/964-acceptance-defaults) measured the vendor cards on OUR
    // estimator plus bit changes; the card scorer does not carry those numbers yet, so they are
    // stated here with their source rather than invented or printed as '—'.
    const VENDOR_CYCLE_SECONDS: Record<string, number> = { tray: 4816.7, organizer: 14991.5 };
    const vendorSeconds = typeof cycleLine?.vendorValue === 'number'
      ? cycleLine.vendorValue
      : (VENDOR_CYCLE_SECONDS[name] ?? null);
    console.log(
      `#959 ${name} CYCLE BASES — ours: ${facts.cycleSeconds.toFixed(0)} s moves + ${changes} tool change(s) x ${TOOL_CHANGE_SECONDS} s = ${oursTotal.toFixed(0)} s ` +
        `(${(oursTotal / 60).toFixed(1)} min); vendor: ${vendorSeconds === null ? '—' : `${(vendorSeconds / 60).toFixed(1)} min`}; ` +
        `ratio ${vendorSeconds === null ? '—' : `${(oursTotal / vendorSeconds).toFixed(2)}x`}`,
    );
  }

  const pocketOps = ops.filter((op) => op.kind === 'pocket').length;
  const contourOps = ops.filter((op) => op.kind === 'contour').length;
  const geometry =
    measured === null
      ? 'Coverage/cut-into: not measured (this case carries no STEP goal).'
      : `Coverage ${(measured.coverage * 100).toFixed(2)} % (vendor ${measured.scored.lines.find((l) => l.key === 'coverage')?.vendor ?? '—'}), ` +
        `cut-into adjudicated ${((measured.cutInto.adjudicatedFraction ?? 0) * 100).toFixed(2)} % ` +
        // #996 — the straddling excuse's count and tallest step, beside the other exclusions.
        `(straddling ${measured.report.straddlingNotScoredCells} cell(s) on up to ${measured.report.straddlingMaxStepMm.toFixed(3)} mm) ` +
        `(edge break ${((measured.cutInto.edgeBreakFraction ?? 0) * 100).toFixed(2)} %, wall cells ${((measured.cutInto.wallNotScoredFraction ?? 0) * 100).toFixed(2)} %, ` +
        `wall shadow ${((measured.cutInto.shadowNotScoredFraction ?? 0) * 100).toFixed(2)} % not counted; max ${measured.cutInto.maxMm.toFixed(3)} mm` +
        `${measured.cutInto.maxAt ? ` at ${measured.cutInto.maxAt.x.toFixed(1)}, ${measured.cutInto.maxAt.y.toFixed(1)}` : ''}). ` +
        `Seven lines: ${measured.scored.sentence}. ` +
        `Holding — ours: ${measured.scored.holding.ours ?? 'not stated'}; vendor: ${measured.scored.holding.vendor ?? 'not stated'}.`;
  console.log(
    `#959 ${name}: ${pocketOps} pocket + ${contourOps} contour op(s) planned (${unreachable.length} ` +
      `unreachable: ${unreachable.join('; ') || 'none'}), ${programs.length} run(s) on ${new Set(programs.map((p) => p.cutterKey)).size} cutter(s). Posted-text facts ` +
      `(the WHOLE plan through planModelCam — pockets, curved stages and rims): cycle ` +
      `${facts.cycleSeconds.toFixed(1)} s, air ${(facts.airFraction * 100).toFixed(1)} %, ` +
      `rapids/1000 ${facts.rapidsPer1000FeedLines.toFixed(0)}, cutters ${facts.cutters.length}. ${geometry}` +
      (notes.length > 0 ? ` Notes: ${notes.join('; ')}` : ''),
  );

  const measuredResult =
    measured === null
      ? null
      : { coverage: measured.coverage, adjudicatedFraction: measured.cutInto.adjudicatedFraction ?? 0, ours: measured.ours, scored: measured.scored };
  const out = process.env.CM_959_OUT;
  if (out === undefined) return measuredResult;
  fs.mkdirSync(out, { recursive: true });

  const plan: { perSetup: Partial<SetupPlan>[] } = {
    perSetup: [
      {
        setupIndex: 0,
        features: tree,
        clGrid: [],
        ops,
        sequence,
        linking: { rapidsCount: 0, hopsCount: 0, airFractionPct: facts.airFraction * 100 },
        programs: factsByRun.map((f) => f.ir),
        totalCostSeconds: facts.cycleSeconds,
      },
    ],
  };
  fs.writeFileSync(path.join(out, `${name}-plan.json`), JSON.stringify(plan));
  if (goal !== undefined) {
    // #964 — the standing picture set's input: the same goal target, stock/frame and gate options
    // this run measured, so `tests/tools/acceptancePics.ts` draws what this check saw.
    fs.writeFileSync(
      path.join(out, `${name}-pics.json`),
      JSON.stringify({
        card: name,
        target: goal.target,
        stock: { length: goal.stock.length, width: goal.stock.width, thickness: tree.frame.stockTop - tree.frame.partBottom },
        frame: { stockTop: tree.frame.stockTop, partBottom: tree.frame.partBottom },
        cutIntoOptions: { passCoverage: 0.95, ...edgeBreakAllowance() },
        post: ctx,
      }, null, 1),
    );
  }
  fs.writeFileSync(
    path.join(out, `${name}-posted-facts.json`),
    JSON.stringify({
      unreachable,
      notes,
      cutterKeys: programs.map((p) => p.cutterKey),
      pocketOps,
      contourOps,
      ...facts,
      ...(measured === null
        ? { coverage: null, cutInto: null, sevenLines: null, ours: null }
        : {
            coverage: measured.coverage,
            cutInto: measured.cutInto,
            sevenLines: measured.scored,
            ours: measured.ours,
          }),
    }),
  );
  return measuredResult;
}

/**
 * #975 — EVERY BIT THE APP KNOWS, as the ideal plan's candidate set: the owned set plus every
 * cutter the tool library carries that the owned set does not (the same key/tool identity the
 * planner's own de-duplication uses). In this environment the library is the builtin tier, so the
 * extra is real but small — the ⌀1 flat is the one that matters on the tray (its pockets ask for
 * ≤ 0.96 mm cutters the owned set does not have).
 */
export function catalogueCutters(): Tool[] {
  const identity = (t: Tool): string => `${t.id ?? ''}|${t.number ?? ''}|${t.name}|${t.tipDiameter ?? ''}|${t.shape}`;
  const owned = new Set(VENDOR_SET.map(identity));
  return getTools()
    .map((entry) => entry.tool)
    .filter((tool) => !owned.has(identity(tool)));
}

/** Write the two-plan comparison beside the card's own receipt. */
export function writeTwoPlans(outName: string, owned: { ours: ProgramScore; scored: SevenLineCard }, ideal: { ours: ProgramScore; scored: SevenLineCard } | null): PlanTradeoff | null {
  const tradeoff = ideal === null ? null : comparePlanOutcomes({ score: owned.ours, card: owned.scored }, { score: ideal.ours, card: ideal.scored });
  const out = process.env.CM_959_OUT;
  if (out !== undefined) {
    fs.writeFileSync(
      path.join(out, `${outName}-two-plans.json`),
      JSON.stringify(
        {
          owned: { coverage: owned.ours.coverage, cutInto: owned.ours.cutInto, cycleSeconds: owned.ours.cycleSeconds, sevenLines: owned.scored },
          ideal: ideal === null ? null : { coverage: ideal.ours.coverage, cutInto: ideal.ours.cutInto, cycleSeconds: ideal.ours.cycleSeconds, sevenLines: ideal.scored },
          tradeoff,
        },
        null,
        1,
      ),
    );
  }
  return tradeoff;
}

