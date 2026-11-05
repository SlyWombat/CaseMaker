/**
 * cam/model/plan.ts — the one entry point of the model-driven CAM engine (#956). §3.0/§3.0.1 of
 * `docs/design/cam-model-engine.md` is this file's source of truth; read that before changing
 * anything here.
 *
 * `planModelCam` replaces both `generateSurface3dForGoal` and `generateSurface3dIR` at their
 * `generateGoalPrograms`/`generateSurfacePrimitiveProgram` call sites — both already `async`, so
 * this is not a new calling convention for either caller. It is wired behind an opt-in flag
 * (`USE_MODEL_CAM_ENGINE`, set only by specs for now) so nothing changes for an operator until
 * #957/#959/#960 land for real; every stub below throws, so a run with the flag on fails loudly
 * instead of posting an empty program.
 *
 * The PUBLIC output types below (`OpOutcome`, `RegionAtZ`, `RegionRef`, `PassRef`, `PlannedOp`,
 * `Polygon`, `Box2`, and this file's OWN `CycleCost`) are distinct from `linking.ts`'s and
 * `sequence.ts`'s internal shapes: those two modules are C's real #961/#962 implementations, with
 * their own richer internal types (`SequenceStep`/`CandidateSequence`/a DIFFERENT, internal
 * `CycleCost` in `sequence.ts` that sums to a bare `estimateSeconds: number`; `LinkPoint`/
 * `MaterialField`/`PassLink` in `linking.ts`). `planModelCam` is the adapter between C's internal
 * shapes and this serialisable `SetupPlan` — the surface F's parity harness (`modelGolden.spec.ts`)
 * and D's panel read, and the one this file's own `CycleCost` is shaped to match exactly.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { Mount } from '@/engine/cnc/setups/types';
import type { FixtureEnvelope } from '@/engine/cnc/setup';
import type { ObstacleBox } from '@/engine/cnc/setup';
import { cuttingDiameter, flatEndMill, type Tool } from '@/engine/cnc/tool';
import { coneHeight, isVShape, vCone, type VCone } from '@/engine/cnc/vProfile';
import { vCarvePassPitch } from '@/engine/cnc/vCarveGeometry';
import { concatToolpathIR, estimateCycleTerms, HOP_Z, SAFE_Z, type CycleTerms, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { feedCatalogueSnapshot, feedsFor, feedsToolForSurface, resolvedFeedsTable, type CutParams } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { readDefault, liveShopDefaults } from '@/platform/defaultsClient';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { pointInPolygons } from '@/engine/cnc/engrave/throughMask';
import { getToplevel } from '@/workers/geometry/ManifoldRuntime';
import type { OffsetFn, Polygons } from '@/engine/cnc/cam/pocket';
import type { BooleanFn } from '@/engine/cnc/cam/engraveJob';
import type { FeatureSource, FeatureTree, PocketNode, RemainderRegion, SetupFrame } from './features';
import { recogniseFeatures, regionRefs } from './features';
import type { EdgeBreakSpec, GoalCellField, ModelPlanProgress, ModelTolerances, StockProbes } from './types';
import { batchSameCutterRuns, chooseSequence, cutterKeyOf, type CutterCandidates, type PlannedOpKind, type SequenceChoice, type SequenceFeature, type SequenceOptions, type SequenceStep, type SequenceStepFailure } from './sequence';
import { documentXY, mapIRToDocument, registerSetupOrigin, rotatedGeometryFor, type SetupRegistration } from './setups';
import { pocket } from './ops/pocket';
import { clSurface, creaseFits } from './clsurface';
import { dropCutterHeight, profileOf, type CutterProfile, type DropCutterMesh } from './dropcutter';
import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';

/**
 * #965/#898 part 2 — THE FRAME-FLIP ALGEBRA, isolated from feature recognition's own
 * uncertainties so it has its own direct, hand-checkable test (`contourFreeingCl965.spec.ts`).
 *
 * `toSetupFrame`'s own half-turn-about-X for `up = [0, 0, -1]` (`features.ts`) negates Y and Z of
 * every mesh position, with NO translation — so a non-first setup's own RAW local Z (the same
 * axis `ContourOpOptions.depthMm`/`zPasses` already cut on, before `planPocketsForTree`'s own
 * `-stockTop` rebase) is exactly the NEGATION of the one fixed frame `ModelPlanInput.geometry`
 * itself sits in (the opposite, `top`, setup's own frame — `up = [0, 0, 1]`, the identity
 * rotation — called "world" here only in that sense, not a machine coordinate). A local depth `d`
 * below THIS setup's own stock top is raw local Z `stockTop - d`, so `worldZ(d) = d - stockTop`.
 *
 * The opposite setup's solid sits at or below its own `dropCutterHeight` at the SAME document
 * (world) point (#957's drop-cutter, read off the design mesh itself — the same ground truth
 * `rough`/`rest`/`finish` already trust for "where the final surface is," not `SetupPlan.clGrid`,
 * which carries only `{toleranceMm, minSpacingMm, maxSpacingMm}` per cutter and no sampled height
 * at all). This setup's cut stays safe while it never reaches past that same world height, less a
 * numerical-noise margin (the SAME chord-tolerance bound `PROFILE_OFFSET_GUARD_MM`/
 * `ARC_CHORD_TOLERANCE_MM` already uses elsewhere, not a new tuned number):
 * `d <= surfaceWorldZ - margin + stockTop`.
 *
 * `frame` is THIS (non-first) setup's own — the ONLY supported case is its `up = [0, 0, -1]`
 * (#965's stated scope: a vise's bottom flip, the one `frameForFace`/`documentXY` actually map);
 * the caller (`planModelCam`) is what checks that before ever calling this, so this function
 * itself assumes it, not re-checks it. `profile`/`mesh` are the OPPOSITE setup's own tool profile
 * and ITS rotated mesh (`rotatedGeometryFor(input.geometry, opposite.features.frame)`).
 *
 * #965 REVIEW FINDING, fixed here: this function maps `(x, y)` through `documentXY` — the SAME
 * function `mapIRToDocument` uses to place this setup's own posted moves in the document frame.
 * It must therefore take the SAME registration `offset` `planModelCam` passes to that call, or it
 * checks a different point than the one the cut actually lands on the instant registration finds
 * a real (non-zero) correction — dormant until then, since every current fixture (including a
 * genuinely two-setup `planModelCam` run) only ever produces `[0, 0]` for this module's own pure
 * axis-through-origin flip (no caller has ever needed to exercise it before `registrationFreeingCl965.spec.ts`).
 */
export function oppositeSurfaceSafeDepthMm(
  frame: SetupFrame,
  profile: CutterProfile,
  mesh: DropCutterMesh,
  x: number,
  y: number,
  marginMm: number = ARC_CHORD_TOLERANCE_MM,
  // #965 review finding: this MUST be the same registration offset `mapIRToDocument` is given
  // for this setup's own posted program, and it MUST go through the same `documentXY` call — the
  // one mapping both share — or this function checks a different point than the one the cut
  // actually posts to. Absent → [0, 0], unchanged for every pre-existing caller (none of which
  // pass a non-zero offset today; see this function's own header for why that case has never
  // come up on a real job yet).
  offset: readonly [number, number] = [0, 0],
): number | null {
  const [wx, wy] = documentXY(frame, x, y, offset);
  const surfaceWorldZ = dropCutterHeight(profile, mesh, wx, wy);
  if (surfaceWorldZ === null) return null;
  return surfaceWorldZ + frame.stockTop - marginMm;
}
import { rough, skin } from './ops/rough';
import { maskCellsExact } from './finishMask';
import { FLAT_SURFACE_MAX_SLOPE_DEG, flatSurfaceMaxSlopeDeg, skinStepdownFactor } from './settings';
import { cellPolygons, rest } from './ops/rest';
import { DEFAULT_FINISH_SCALLOP_MM, finish, finishKindFor, type FinishKind } from './ops/finish';
import { hasValley, pencil } from './ops/pencil';
import { chamfer } from './ops/chamfer';
import { contour as contourOp, throughHole } from './ops/contour';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { parseGcode } from '@/engine/cnc/gcode';
import { setupFromHeader } from '@/engine/cnc/setupFromHeader';
import { stubSetup } from '@/engine/cnc/setup';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptFieldTooled } from '@/workers/sim/sweptPoint';
import { buildTriangleBins, binnedReachableTriangles, type TriangleBins } from './triangleBins';

/** One ring (outer boundary or a hole); `pocket.ts`'s `Polygons` is `Polygon[]`. NEW — no existing equivalent. */
export type Polygon = [number, number][];

/** NEW — no existing equivalent. */
export interface Box2 {
  min: [number, number];
  max: [number, number];
}

/** The material removed at one Z — outer boundary plus holes. */
export interface RegionAtZ {
  z: number;
  boundary: Polygon[];
}

/**
 * One pass within an op, in execution order (C's #956 comment 6619787259 point 4, restored on
 * C's objection: the reshaped `PlannedOp` dropped entry/exit, and `link()`/`linkPasses` (`linking.ts`)
 * cannot find where one pass ends and the next begins without them).
 */
export interface PassRef {
  z: number;
  boundary: Polygon[];
  cleared: RegionAtZ;
  entry: [number, number, number];
  exit: [number, number, number];
}

/**
 * Every op generator returns one of these. `cutter` is a ToolKey — no such type exists yet
 * (`roughToolKey?: string`, `types/engraveJob.ts:770`), so this is a bare `string`, not invented.
 */
export interface OpOutcome {
  ir: ToolpathIR;
  cutter: string;
  /** In execution order; what `linkPasses` (`linking.ts`) joins. */
  passes: PassRef[];
  /** What the op removed, per depth — the material state's input. Absent for an op that removes nothing new. */
  cleared?: RegionAtZ[];
  /** #960 — statements the op makes about its own method (a skipped wall band, a stated slope
   *  threshold), carried into the plan's notes so the operator sees them. */
  notes?: string[];
}

export type RegionKind = 'pocket' | 'island-top' | 'curved' | 'contour' | 'rim';

export interface RegionRef {
  id: string;
  kind: RegionKind;
  bounds: Box2;
  topZ: number;
  bottomZ: number;
  /**
   * The fixture's boxes that reach this region's bounds — already inflated by the fixture
   * envelope's own `uncertainty` (the same inflation `prepareFixtureBoxes`/the sweep applies,
   * `workers/geometry/sweep.ts:622`), not the whole fixture. This is the #949 jaw-clearance data.
   */
  obstacles: ObstacleBox[];
  /**
   * The lowest Z that clears every one of `obstacles`, mm — C's point 3 ruling: the per-region
   * clearance plane a stay-down link retracts to inside this region (`linking.ts`'s
   * `LinkOptions.clearanceZ` is this value). The OTHER clearance height C's note meant is
   * `ToolpathIR.safeZ` (existing field, ir.ts) — the program-wide retract between regions/ops.
   * Neither is named `stayDownClearanceMm`/`retractClearanceMm`; this note's first pass at the
   * names was wrong, per C's objection.
   */
  regionClearanceZ: number;
}

/**
 * One planned operation, in a `SetupPlan.ops[]` execution order.
 */
export interface PlannedOp {
  kind: PlannedOpKind;
  region: RegionRef;
  outcome: OpOutcome;
}

export interface SetupSpec {
  frame: SetupFrame;
  /** #898's three choices. */
  underside: 'flatOnStockBottom' | 'flippedTabs' | 'plinth';
}

export interface ModelPlanInput {
  geometry: FeatureSource;
  /** #959 ruling: `'on'` plans the facing stage; absent/`'off'` gives the skin to the `skin` pass. */
  facing?: 'off' | 'on';
  /**
   * #943's ruling — the probed stock top, handed in by the caller that holds the measurement
   * (the registration store lives on the main thread; this plan cannot read it). ABSENT is a job
   * with no measurement: the facing depth comes from the stated stock top and the plan says so.
   */
  stockProbes?: StockProbes;
  /** The shared flat/ball slope parameter (#959); absent → the provisional `FLAT_SURFACE_MAX_SLOPE_DEG`. */
  flatSurfaceMaxSlopeDeg?: number;
  /**
   * Length 1 for the tray/organizer today; #898/#914's flip plan (`held/914-flip-plan`: the
   * reach-aware face decision, the stock-floor anchor, the band-floor trigger) and #965 fill this
   * to more than one entry. Reserved now so #965 does not reopen this interface.
   */
  setups: SetupSpec[];
  stock: Pick<EngraveJob['stock'], 'length' | 'width' | 'thickness' | 'material'>;
  /**
   * The resolved fixture, by mount type — `viseEnvelope(job.stock, jobVise(job), job.sacrificial)`
   * for a vise (`engine/cnc/fixture.ts:371`, the same call `jobSetup.ts:1207`'s `defaultFixture`
   * makes), `bracketMount(...).fixture` for a bracket (already a `FixtureEnvelope`,
   * `mounts/bracket.ts:451`), `null` for tape. The SAME object the sweep checks the posted program
   * against — not rebuilt here, so this engine and the sweep cannot disagree about where the jaws
   * are (the #949 class).
   */
  fixture: { mount: Mount; envelope: FixtureEnvelope | null };
  cutters: CutterCandidates;
  tolerances: ModelTolerances;
  edgeBreak: EdgeBreakSpec;
  /**
   * #961 — THE GOAL, when the caller can supply it: the model's top surface on the stock frame
   * (Z 0 = stock top, the same 0.1 mm field the goal check samples). The picker's completeness
   * is then the SIMULATED OUTCOME — the goal cells a candidate's own sweep leaves above the
   * 0.1 mm band (the maintainer's 11-05 ruling), not the count of pockets left behind. Absent →
   * the old pocket-count completeness, unchanged.
   */
  goal?: GoalCellField;
  /**
   * #869/#966 — THE CURVED PIPELINE'S OWN ROUGH, independent of `primary` (the pockets' own
   * largest flat, which a goal with no pockets picks only because the house owns one at all).
   * Absent (every existing caller): unchanged — the curved pipeline ROUGHS with `primary`, exactly
   * as before this field existed. `null`: no rough at all, the ball alone takes each remainder
   * region's full depth (#869's stated default for a goal with no `roughToolKey`). A `Tool`: that
   * tool roughs instead of `primary` (#869's `roughToolKey`, once validated by the caller — this
   * field is not itself validated here, the same contract `cutters.house` already keeps).
   */
  curvedRoughTool?: Tool | null;
}

export interface ModelPlanOutput {
  perSetup: SetupPlan[];
}

/**
 * The PUBLIC cost wrapper `SetupPlan.sequence[].cost` carries — distinct from `sequence.ts`'s own
 * internal `CycleCost` (which sums to a bare `estimateSeconds: number`, not a `CycleTerms` object).
 * `terms` is #927's real type (`ir.ts`) on this cutter's posted, concatenated `ToolpathIR`;
 * `toolChangeSeconds`/`totalSeconds` wrap it per C's cost ruling; `toolChanges` is optional — the
 * ruling's wrapper does not require the count, though C's module states it.
 */
export interface CycleCost {
  terms: CycleTerms;
  toolChangeSeconds: number;
  totalSeconds: number;
  toolChanges?: number;
}

/**
 * One cutter's priced place in the sequence. `pinned`/`house` come from the chosen
 * `SequenceStep.cutter: CutterChoice` for that key (`sequence.ts`), not duplicated state.
 */
export interface SequencedCutter {
  cutterKey: string;
  cost: CycleCost;
  pinned: boolean;
  house: boolean;
}

export interface SetupPlan {
  setupIndex: number;
  features: FeatureTree;
  /** Grid resolution per cutter/op — renamed from `clSurface` to avoid colliding with `clsurface.ts`'s exported function of that name. */
  clGrid: { cutterKey: string; toleranceMm: number; minSpacingMm: number; maxSpacingMm: number }[];
  ops: PlannedOp[];
  sequence: SequencedCutter[];
  linking: { rapidsCount: number; hopsCount: number; airFractionPct: number };
  /**
   * One program per RUN, in execution order — #419's "one program per tool" still holds for a
   * job with no cutter revisit; a cutter #961 returns to for the freeing cut (cheaper than its
   * last cutter taking the profile) posts as a SECOND, separate entry here, never merged with
   * its first (advisor's review on ab6b2827 — merging them posts a file that frees the part
   * before the step in between it ever ran).
   */
  programs: ToolpathIR[];
  totalCostSeconds: number;
  /**
   * The plan's statements to the operator — every stage that found nothing to cut, a feeds
   * substitution, a limit this entry does not yet cover. Stated, never silent: the check suite's
   * own finding was that `planModelCam` computed these and dropped them.
   */
  notes: string[];
  /** Features no cutter in the chain covers, each a sentence naming the limiting number. */
  unreachable: string[];
  /**
   * #959 item 5 — every region/stage of THIS plan that threw or planned nothing, in `sequence.ts`'s
   * own `SequenceStepFailure` shape (kind, cutter, regions, the reason). The rest of the plan still
   * posts; only a primary failure refuses (`priceSequence`'s step-0 rule).
   */
  unplanned: SequenceStepFailure[];
  /**
   * #961 acceptance (the maintainer's 11-05 review) — the pocket chain's full picker result: the
   * chosen chain's cost and EVERY candidate it priced (`considered`), so a card or the run sheet
   * prints the candidates beside the choice instead of only the winner. The plan already computed
   * this; before this field it was dropped at the SetupPlan seam.
   */
  choice: SequenceChoice;
}

/**
 * Set only by specs and the breadth tool for now (see this file's header). The environment gate
 * exists so a Node tool (`tests/tools/goal-engine-breadth.ts`) can exercise the seam without a
 * bundler: `CASEMAKER_MODEL_CAM=1` turns the engine on for a process, and `VITE_MODEL_CAM=1` does
 * the same for an e2e build. Both default off, so the shipped app is unchanged.
 */
export let USE_MODEL_CAM_ENGINE: boolean =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.['CASEMAKER_MODEL_CAM'] === '1' ||
  (import.meta as { env?: Record<string, string | undefined> }).env?.['VITE_MODEL_CAM'] === '1';

/**
 * #966 — a Playwright spec (or any other runtime caller) flips the flag without `vi.doMock`'s
 * module-registry trick, which a browser-run e2e test does not have. Test/e2e-only purpose, same
 * as the env gate above — this does not change the shipped app's own default (still env-gated,
 * off unless `CASEMAKER_MODEL_CAM=1`/`VITE_MODEL_CAM=1`), it only lets a runtime override that
 * default for the lifetime of the process/page.
 */
export function setModelCamEnabled(on: boolean): void {
  USE_MODEL_CAM_ENGINE = on;
}

export interface PlanModelCamOptions {
  signal?: AbortSignal;
  onProgress?: (p: ModelPlanProgress) => void;
}

/**
 * The rough's stock-to-leave band, mm — the old engine's own `DEFAULT_STOCK_TO_LEAVE_MM`
 * (`cam/surface3d.ts:74`). That file is #966's to delete, so the number is stated here as the
 * entry's default until the band is an input field (§3.6 point 4's job fields, which #965 decides).
 * It is the ROUGH's band only; the ball's promised cusp is the job's finish tolerance
 * (`finishScallopMm`), because F's coverage line counts anything over 0.1 mm standing above the
 * goal as leftover — a finish leaving the rough's band as its own scallop reads as uncovered.
 */
const MODEL_STOCK_TO_LEAVE_MM = 0.3;

/** #962 — how close a rim's own first and last point must already be to count as closed; past
 * this is a genuine gap in `findRims`' own chain, not float noise from the mesh. */
const RIM_CLOSE_TOL_MM = 0.01;

/**
 * One cutter's resolved cut numbers, through the app's one feeds resolver (the labelled fallback
 * table when no catalogue row answers).
 *
 * THE CHECK SUITE FOUND THIS: the compiled starting table tops out at 3.2 mm, and the house's
 * primary ⌀6 has no row in a realm where no catalogue is installed (the specs, the hosted build) —
 * every plan was refused at the first cutter. Refusing would be right if the numbers were a guess;
 * they are not: the material's LARGEST covered row answers through a FLAT proxy at the row's own
 * diameter (the same substitution #669 makes for a chamfer without a V row), which is a shallower
 * step-down and a slower feed than this cutter could take — the conservative side. The
 * substitution is returned so the plan STATES it, never posts it silently.
 */
function resolvedCutParams(input: ModelPlanInput, tool: Tool): { params: CutParams; substitution: string | null } {
  const resolved = feedsFor(feedCatalogueSnapshot(), input.stock.material, feedsToolForSurface(tool), Z1);
  if (resolved.ok) return { params: resolved.params, substitution: null };
  const rows = resolvedFeedsTable()
    .table.filter((row) => row.material === input.stock.material && (row.edge ?? 'flat') === 'flat')
    .sort((a, b) => b.maxDiameter - a.maxDiameter);
  const largest = rows[0];
  if (largest !== undefined) {
    const proxy = flatEndMill(largest.maxDiameter, { number: tool.number, id: tool.id, name: tool.name });
    const viaProxy = feedsFor(feedCatalogueSnapshot(), input.stock.material, proxy, Z1);
    if (viaProxy.ok) {
      return {
        params: viaProxy.params,
        substitution:
          `${tool.name || tool.id || `${cuttingDiameter(tool)} mm cutter`}: no starting row covers its diameter — ` +
          `${input.stock.material}'s largest covered row (${largest.maxDiameter} mm) answered, its step-down and feed ` +
          'being the conservative side',
      };
    }
  }
  const label = tool.name || tool.id || `${tool.shape} cutter`;
  throw new Error(`cam/model/plan: no feeds for ${label} in ${input.stock.material} — ${resolved.reason}`);
}

/**
 * THE REVIEW'S FINDING (item 8): the curved pipeline's ball and V were fed and spun at the
 * PRIMARY FLAT's own resolved numbers — `resolvedCutParams` exists per tool, but was only ever
 * called for the primary. Resolved the same way for a non-flat tool; if even the largest-covered-
 * row proxy cannot answer for it (`resolvedCutParams` throws), the primary's already-resolved
 * numbers stand in instead — stated in a note, never silently.
 */
function toolCutParams(input: ModelPlanInput, tool: Tool, primaryParams: CutParams): { params: CutParams; note: string | null } {
  try {
    const { params, substitution } = resolvedCutParams(input, tool);
    return { params, note: substitution };
  } catch (err) {
    const label = tool.name || tool.id || `${tool.shape} cutter`;
    const reason = err instanceof Error ? err.message : String(err);
    return {
      params: primaryParams,
      note: `${label}: ${reason} — the primary flat's own feeds/RPM answer instead, the conservative side`,
    };
  }
}

/** §5's three numbers, read off the posted moves: a hop retracts to `hopZ`, a rapid to `safeZ`. */
function linkingStats(programs: readonly ToolpathIR[]): SetupPlan['linking'] {
  let rapidsCount = 0;
  let hopsCount = 0;
  let feedXy = 0;
  let rapidXy = 0;
  for (const ir of programs) {
    let prev: { x: number; y: number } | null = null;
    for (const operation of ir.operations) {
      for (const move of operation.moves) {
        const d = prev === null ? 0 : Math.hypot(move.x - prev.x, move.y - prev.y);
        if (move.kind === 'rapid') {
          if (move.z <= ir.hopZ + 1e-9) hopsCount++;
          else rapidsCount++;
          rapidXy += d;
        } else {
          feedXy += d;
        }
        prev = { x: move.x, y: move.y };
      }
    }
  }
  const total = feedXy + rapidXy;
  return { rapidsCount, hopsCount, airFractionPct: total > 0 ? (rapidXy / total) * 100 : 0 };
}

/** `fmt3`: trims a computed mm figure to 3 decimals without carrying float noise into the note. */
const fmt3 = (n: number): string => String(Number(n.toFixed(3)));

/**
 * #965 registration's own stated sentence — names the datum `registerSetupOrigin` found and the
 * offset it computed, so the number in `SetupPlan.notes` is traceable to real recognised
 * geometry, never just "trust the vise".
 */
function describeRegistration(setupIndex: number, registration: SetupRegistration): string {
  const [dx, dy] = registration.offsetMm;
  const offset = `offset [${fmt3(dx)}, ${fmt3(dy)}] mm`;
  if (registration.datum.basis === 'two-holes') {
    const [h1, h2] = registration.datum.holes;
    return (
      `setup ${setupIndex}: registered against setup 0 via two through-holes — "${h1.id}" at ` +
      `(${fmt3(h1.x)}, ${fmt3(h1.y)}) and "${h2.id}" at (${fmt3(h2.x)}, ${fmt3(h2.y)}), ` +
      `${fmt3(registration.datum.separationMm)} mm apart — computed ${offset} (#965 registration)`
    );
  }
  const [a, b] = registration.datum.endpoints;
  return (
    `setup ${setupIndex}: registered against setup 0 via a single straight outline edge from ` +
    `(${fmt3(a[0])}, ${fmt3(a[1])}) to (${fmt3(b[0])}, ${fmt3(b[1])}), ${fmt3(registration.datum.lengthMm)} mm long ` +
    `— no through-hole pair qualified — computed ${offset} (#965 registration)`
  );
}

/**
 * THE ENTRY (#956 §3.0, filled in on F's check suite finding it still threw). One whole job — every
 * setup, every feature the tree recognises — planned through the model engine and returned as
 * #963's `SetupPlan`:
 *
 *   - the pocket chain by cost (`planPocketsForTree`), the curved remainder and the rims by the
 *     ruling's pipeline, and the freeing contour LAST (`planTreePrograms`);
 *   - programs ONE PER RUN, in execution order (a run starts when the cutter changes), each the
 *     concatenation of its ops' IRs;
 *   - cut numbers through the app's one feeds resolver (`feedsFor`), the shop's
 *     `toolChange.seconds` through the labelled default, both the same calls the rest of the app
 *     makes — this entry invents no numbers.
 *
 * STATED LIMITS, not silent ones: a fixture envelope is not yet wired into `RegionRef.obstacles`
 * (the plan says so in its notes; the sweep still checks the posted program against the SAME
 * envelope); `input.cutters.catalogue` is not in the pocket chain yet (`planPocketsForTree` takes
 * house flats only) — the plan says that too when a caller supplies one.
 */
export async function planModelCam(input: ModelPlanInput, opts: PlanModelCamOptions = {}): Promise<ModelPlanOutput> {
  const tl = await getToplevel();
  const offset = makeClipperOffset(tl);
  const boolean = { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) };
  const toolChangeSeconds = readDefault(liveShopDefaults(), 'toolChange.seconds').value;
  // #961 — THE SIMULATED OUTCOME'S STAMP. With a goal supplied, every candidate the picker prices
  // is posted and stamped exactly as the goal check does, and the cells its sweep leaves above the
  // 0.1 mm band are counted — the rank's first key. The goal is the caller's (the job's target),
  // not re-derived here.
  const coverageGoal = input.goal;
  const coverageCtx: PostContext = {
    jobName: 'model-coverage',
    stock: { length: input.stock.length, width: input.stock.width, thickness: input.stock.thickness },
    materialName: input.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'model-cam',
    toolKey: 'multi',
  };
  // #961 — each distinct IR is posted and stamped ONCE, however many candidates carry it (the
  // steps' IRs are memoized in `planStep`, so identity is stable); a candidate's fold is then a
  // walk over its own IRs' cached fields.
  const stampCache = new WeakMap<ToolpathIR, Float32Array | null>();
  const stampedField = (ir: ToolpathIR): Float32Array | null => {
    const cached = stampCache.get(ir);
    if (cached !== undefined) return cached;
    let field: Float32Array | null = null;
    const posted = postZ1(ir, coverageCtx, Z1);
    if (posted.ok) {
      const parsed = parseGcode(posted.text);
      const part = setupFromHeader(parsed.header).patch.part;
      if (part !== undefined && part.kind === 'prism' && part.outline.kind === 'p-rect') {
        const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
        const stamp = exactSweptFieldTooled(coverageGoal!, buildTimeline(parsed, setup, Z1), () => ir.tool);
        if (stamp !== null) field = stamp.field;
      }
    }
    stampCache.set(ir, field);
    return field;
  };
  // #961 follow-up — THE REST'S REGION FROM THE SIMULATED FIELD: the cells the chain so far
  // leaves more than the 0.1 mm band above the goal, inside the pocket's own footprint, as loops
  // (dilated by the ROUNDER in `planPocketsForTree`, which knows the cutter). A field that cannot
  // be stamped falls back to the whole footprint — the floor pass as it was.
  const restRegion = coverageGoal === undefined
    ? undefined
    : (prefixIrs: readonly ToolpathIR[], region: { id: string; footprint: Polygons; floorZ: number; bounds: { min: [number, number]; max: [number, number] } }): Polygons | null => {
        let acc: Float32Array | null = null;
        for (const ir of prefixIrs) {
          const field = stampedField(ir);
          if (field === null) continue;
          if (acc === null) acc = Float32Array.from(field);
          else for (let k = 0; k < acc.length; k++) if (field[k]! < acc[k]!) acc[k] = field[k]!;
        }
        if (acc === null) return region.footprint;
        const goal = coverageGoal;
        const pitch = goal.pitch;
        const i0 = Math.max(0, Math.floor((region.bounds.min[0] - goal.x0) / pitch));
        const i1 = Math.min(goal.nx - 1, Math.ceil((region.bounds.max[0] - goal.x0) / pitch));
        const j0 = Math.max(0, Math.floor((region.bounds.min[1] - goal.y0) / pitch));
        const j1 = Math.min(goal.ny - 1, Math.ceil((region.bounds.max[1] - goal.y0) / pitch));
        if (i1 < i0 || j1 < j0) return null;
        const cells = acc;
        const inside = (i: number, j: number): boolean => {
          const k = (j0 + j) * goal.nx + (i0 + i);
          if (goal.covered[k] !== 1) return false;
          if (!(cells[k]! - (goal.z[k] as number) > 0.1)) return false;
          const x = goal.x0 + (i0 + i) * pitch;
          const y = goal.y0 + (j0 + j) * pitch;
          return pointInPolygons(region.footprint, x, y);
        };
        return cellPolygons(inside, i1 - i0 + 1, j1 - j0 + 1, goal.x0 + i0 * pitch, goal.y0 + j0 * pitch, pitch);
      };
  const goalCoverage =
    coverageGoal === undefined
      ? undefined
      : (irs: readonly ToolpathIR[]): { leftoverCells: number; coveredCells: number; cellAreaMm2: number } | null => {
          let acc: Float32Array | null = null;
          for (const ir of irs) {
            const field = stampedField(ir);
            if (field === null) continue;
            if (acc === null) acc = Float32Array.from(field);
            else for (let k = 0; k < acc.length; k++) if (field[k]! < acc[k]!) acc[k] = field[k]!;
          }
          if (acc === null) return null;
          let covered = 0;
          let leftover = 0;
          for (let k = 0; k < acc.length; k++) {
            if (coverageGoal.covered[k] !== 1) continue;
            covered++;
            if (acc[k]! - (coverageGoal.z[k] as number) > 0.1) leftover++;
          }
          return { leftoverCells: leftover, coveredCells: covered, cellAreaMm2: coverageGoal.pitch * coverageGoal.pitch };
        };
  const perSetup: SetupPlan[] = [];
  // #965 registration — setup 0's own recognised tree is the document-frame ground truth every
  // later setup's locating features are read against (`registerSetupOrigin`'s own header on
  // `setups.ts`). Kept across loop iterations for exactly that comparison; `null` only before
  // setup 0 has run, which no setup ever observes (setup 0 never reads it).
  let setup0Tree: FeatureTree | null = null;

  for (let setupIndex = 0; setupIndex < input.setups.length; setupIndex++) {
    opts.signal?.throwIfAborted();
    const spec = input.setups[setupIndex]!;
    opts.onProgress?.({ setupIndex, op: 'features', fraction: 0 });
    const tree = recogniseFeatures(input.geometry, spec.frame, tl);
    if (setupIndex === 0) setup0Tree = tree;

    // #965 registration — computed, never assumed. `registerSetupOrigin` THROWS, by name, when
    // this part carries neither a reliable two-hole datum nor a long straight edge (see its own
    // header): that throw is left to propagate out of `planModelCam` rather than caught and
    // papered over with a nominal `[0, 0]`, per the issue's own ruling ("never falls back to a
    // guessed/nominal origin"). Only setup 0 is ever registration-free (it IS the reference).
    const registration: SetupRegistration | null = setupIndex === 0 ? null : registerSetupOrigin(setup0Tree!, tree);
    const registrationOffset: [number, number] = registration?.offsetMm ?? [0, 0];

    const flats = input.cutters.house
      .filter((t) => t.shape === 'flat' && (cuttingDiameter(t) ?? 0) > 0)
      .sort((a, b) => (cuttingDiameter(b) ?? 0) - (cuttingDiameter(a) ?? 0));
    const balls = input.cutters.house
      .filter((t) => t.shape === 'ball' && (cuttingDiameter(t) ?? 0) > 0)
      .sort((a, b) => (cuttingDiameter(b) ?? 0) - (cuttingDiameter(a) ?? 0));
    // #982 (the review session's ruling) — NO FLAT IN THE SET: the ball takes the primary's place.
    // It roughs with its own profile and the pocket floors are its scallop pass; the card states
    // the wall-foot fillet (the ball's radius) as the tradeoff. Only a set with NO round cutter at
    // all is refused, by name.
    const noFlatFallback = flats.length === 0;
    const primary = flats[0] ?? balls[0];
    if (primary === undefined) {
      throw new Error('cam/model/plan: the house states no flat end mill and no ball nose with a cutting diameter — no round cutter can plan this part');
    }
    const ball = balls[0];
    // #965 (the review session's ruling, item 3.1) — THE REST BALL: the next-smaller ball, admitted
    // only on a STATED reach that covers the deepest remainder. The vendor's long ⌀1
    // (6*1*30.5mm Ball Nose Engraving, 161032105031) states a 30.5 mm flute and reaches the
    // figures' 26 mm relief; the house's 0.5 ball states no flute length at all and failed on
    // reach in the review's own measurement, so it can never qualify. No new op: the rest runs the
    // finish's machinery over the ball's own leftover mask.
    const deepestRemainderMm = tree.remainder.reduce((m, r) => Math.max(m, r.zTop - r.zBottom), 0);
    const restBall = balls.find((t) => t !== ball && (t.fluteLength ?? 0) >= deepestRemainderMm - 1e-9);
    const vbit = input.cutters.house.find((t) => t.shape === 'chamfer') ?? input.cutters.house.find((t) => t.shape === 'engraving');
    // #982 — NO BALL IN THE SET: the flat finishes the curved remainder (a flat-raster over the
    // whole region, the flat's cusp rule), the creases via the rest with the smallest flat. The
    // throw the old code raised here was the refusal the ruling forbids.
    const finishFlat = flats.length > 0 ? flats[flats.length - 1] : undefined;

    const { params: pocketParams, substitution } = resolvedCutParams(input, primary);
    const feeds = { feedMmPerMin: pocketParams.feed, plungeFeedMmPerMin: pocketParams.plungeFeed };

    // THE REVIEW'S FINDING (item 8): the ball and the V each get their OWN catalogue row — not
    // the primary flat's, reused as every tool's numbers before this.
    const toolSubstitutions: string[] = substitution === null ? [] : [substitution];
    const ballParams = ball === undefined ? null : toolCutParams(input, ball, pocketParams);
    if (ballParams?.note !== null && ballParams?.note !== undefined) toolSubstitutions.push(ballParams.note);
    const vbitParams = vbit === undefined ? null : toolCutParams(input, vbit, pocketParams);
    if (vbitParams?.note !== null && vbitParams?.note !== undefined) toolSubstitutions.push(vbitParams.note);
    const restBallParams = restBall === undefined ? null : toolCutParams(input, restBall, pocketParams);
    if (restBallParams?.note !== null && restBallParams?.note !== undefined) toolSubstitutions.push(restBallParams.note);
    const cutParamsFor = (tool: Tool): CutParams => {
      if (ball !== undefined && tool === ball && ballParams !== null) return ballParams.params;
      if (restBall !== undefined && tool === restBall && restBallParams !== null) return restBallParams.params;
      if (vbit !== undefined && tool === vbit && vbitParams !== null) return vbitParams.params;
      return pocketParams;
    };

    opts.onProgress?.({ setupIndex, op: 'sequence', fraction: 0.4 });

    // #965 — MULTI-SETUP TABS: a job with more than one setup must stay ONE piece of stock
    // through the turn-over, so every setup but the LAST keeps the pocket chain's own default
    // tabs (`DEFAULT_RELEASE_TABS`) on its freeing contour, whatever `spec.underside` says — the
    // part is not released until it has nothing left to turn INTO. The LAST setup's freeing
    // contour is the one that actually frees the part (`{ count: 0 }`, the pocket chain's own
    // explicit-release case). A single-setup job (today's only real caller) is untouched: `tabs`
    // is left unset, so `planPocketsForTree` keeps its own `DEFAULT_RELEASE_TABS` default exactly
    // as before.
    //
    // STATED, NOT YET DONE (#965 open item — flagged in this issue's progress comment, not
    // guessed): the LAST setup's freeing contour is still a FLAT-Z pass to `tree.contour.zTo`,
    // the SAME op a single-setup job posts. #898 part 2's "tabbed freeing cut ... re-planned over
    // the CL surface" — tracking the OTHER setup's already-cut 3D surface instead of one flat Z,
    // so the final release cannot stand on (or cut into) whatever the earlier setup already
    // shaped on what is now the underside — is NOT implemented: `contourOp`/`ops/contour.ts` has
    // no CL-surface input today. A multi-setup job's last-setup release is therefore only as safe
    // as `tree.contour.zTo` being shallow enough not to reach the opposite setup's cut, which this
    // plan does not check.
    const tabs =
      input.setups.length <= 1
        ? undefined
        : setupIndex === input.setups.length - 1
          ? { count: 0, width: DEFAULT_RELEASE_TABS.width, height: DEFAULT_RELEASE_TABS.height }
          : DEFAULT_RELEASE_TABS;

    // #965 — the per-setup mesh the curved pipeline's `clSurface` must score against: `recogniseFeatures`
    // (above) already rotated `input.geometry` into THIS setup's frame to build `tree`; `clSurface`
    // is handed `ModelPlanInput.geometry` at every call site inside `planCurvedForTree` and must see
    // the SAME rotation, or a non-identity setup's drop-cutter reads the part's OLD orientation
    // against a tree built in the NEW one (`rotatedGeometryFor`'s own doc). Identity for `up = [0, 0, 1]`
    // (every job today), so this changes nothing for the existing single-setup caller.
    const curvedGeometry = rotatedGeometryFor(input.geometry, spec.frame);

    // #965/#898 part 2: the LAST setup's freeing contour must not cut past the OPPOSITE setup's
    // already-finished surface (this file's own #965 open-item note, below, used to be the whole
    // story). Only the LAST of exactly two setups has an opposite one already planned — a single-
    // setup job's `setupIndex` is never `> 0`, so `oppositeSafeDepthMm` stays `undefined` and
    // `contourOp` behaves exactly as before (#959/#960's regression safety); the FIRST setup's own
    // contour has no earlier setup to read either. `buildSetupSpecs`'s own stated scope (#965
    // header) offers only `top`/`bottom` — `perSetup[0]` IS "the opposite setup" whenever this
    // branch runs, never a guess at which earlier entry that is.
    //
    // The opposite setup's "finished surface" is read straight off the SAME design mesh
    // (`input.geometry`, rotated into ITS frame — `rotatedGeometryFor`, the same helper `curvedGeometry`
    // above uses) via a real drop-cutter height (`dropcutter.ts`, #957) — not `clGrid` (it carries
    // only `{toleranceMm, minSpacingMm, maxSpacingMm}` per cutter, a report of what was sampled,
    // never the sampled heights themselves, so it cannot answer "how deep is safe at (x, y)").
    // Re-querying the mesh directly is the SAME ground truth `rough`/`rest`/`finish` already trust
    // for "where the final surface is," not a second, divergent source.
    //
    // The cutter used to read it is THIS setup's own `primary` flat — not a guess: a LARGER radius
    // leaves MORE material standing in a tight corner than the mesh's own mathematical surface
    // (concave corners it cannot fully enter), so reading the opposite surface through the SAME
    // tool radius that actually cut it is the conservative direction — it never reports less
    // material remaining there than the real cut would leave.
    let oppositeSafeDepthMm: ((x: number, y: number) => number | null) | undefined;
    const freeingNotes: string[] = [];
    if (setupIndex > 0 && setupIndex === input.setups.length - 1) {
      const opposite = perSetup[0];
      if (opposite === undefined) {
        throw new Error('cam/model/plan: the last setup has no earlier setup planned yet to free against (#965) — the setup loop order is broken');
      }
      const [ux, uy, uz] = spec.frame.up;
      if (ux === 0 && uy === 0 && uz === -1) {
        const oppositeGeometry = rotatedGeometryFor(input.geometry, opposite.features.frame);
        const profile = profileOf(primary);
        if (profile === null) {
          freeingNotes.push(
            `setup ${setupIndex}: the freeing contour's depth could not be checked against setup 0's finished surface — ${primary.name || primary.shape} has no drop-cutter profile (#965) — it still cuts to this setup's own flat zTo`,
          );
        } else {
          const mesh: DropCutterMesh = oppositeGeometry.triangles;
          const frameForQuery = spec.frame;
          // #965 review finding: this setup's own `registrationOffset` — the SAME one
          // `mapIRToDocument` below places this setup's posted moves with — or the safety check
          // and the real cut disagree about where a point is the moment registration is ever
          // non-zero.
          oppositeSafeDepthMm = (x: number, y: number): number | null =>
            oppositeSurfaceSafeDepthMm(frameForQuery, profile, mesh, x, y, ARC_CHORD_TOLERANCE_MM, registrationOffset);
          freeingNotes.push(
            `setup ${setupIndex}: the freeing contour's depth is bounded, at every point its path samples, by setup 0's own finished surface (#965, #898 part 2) — it will not cut deeper than that surface, read through this setup's own ${primary.name || primary.shape}`,
          );
        }
      } else {
        freeingNotes.push(
          `setup ${setupIndex}: this setup's frame is not the stated bottom flip (#965 scope: up = [0, 0, -1]) — the freeing contour is NOT checked against setup 0's surface and still cuts to this setup's own flat zTo`,
        );
      }
    }

    const statedFinishCusp = ((): number | undefined => {
      if (input.tolerances.finishMm !== undefined) return input.tolerances.finishMm;
      const pitch = input.tolerances.finishStepOverMm;
      const radiusMm = ball === undefined ? undefined : (cuttingDiameter(ball) ?? 0) / 2;
      if (pitch === undefined || radiusMm === undefined || !(radiusMm > 0) || !(pitch > 0)) return undefined;
      const half = pitch / 2;
      return radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - half * half));
    })();

    // #982 — NO FLAT: each pocket node becomes a synthetic remainder-style region the curved
    // pipeline plans with the ball (its rough, then the ball's scallop finish). The floor is
    // CLAMPED at the real design top over the opening: a spurious pocket floor below the body
    // (the 11.37 mm gouge) yields no depth, so the ball can never cut through the part.
    const pocketFloorRegions: RemainderRegion[] = [];
    if (noFlatFallback) {
      const bins = buildTriangleBins(input.geometry.triangles);
      const walkPockets = (nodes: PocketNode[]): void => {
        for (const node of nodes) {
          let designMax = -Infinity;
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const ring of node.region) {
            for (const [x, y] of ring) {
              minX = Math.min(minX, x); maxX = Math.max(maxX, x);
              minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
          }
          for (let x = minX; x <= maxX + 1e-9; x += 0.5) {
            for (let y = minY; y <= maxY + 1e-9; y += 0.5) {
              const top = topSurfaceAt(bins, x, y);
              if (top !== null && top > designMax) designMax = top;
            }
          }
          const zBottom = Number.isFinite(designMax) ? Math.max(node.floorZ, designMax) : node.floorZ;
          // The ball's CENTRE space: the footprint is eroded by the ball's radius, exactly as the
          // pocket chain offsets its loops — otherwise the ball's centre reaches the wall and its
          // flank cuts a radius into it (a 0.95 mm gouge measured on the elephant). Eroded, the
          // flank is tangent at the wall foot: the stated fillet, never a gouge.
          const ballRadius = (cuttingDiameter(primary) ?? 0) / 2;
          const footprint = ballRadius > 0 ? offset(node.region, -ballRadius) : node.region;
          if (footprint.length === 0) {
            notes.push(`${node.id}: the ball cannot enter this pocket (narrower than its radius) — left uncut`);
            walkPockets(node.children);
            continue;
          }
          pocketFloorRegions.push({
            id: node.id,
            footprint,
            area: Math.abs(node.region.reduce((sum, ring) => sum + ringAreaOf(ring), 0)),
            zTop: node.mouthZ,
            zBottom,
            triangles: new Uint32Array(0),
            slopeDeg: [0, 0],
            slopeMedianDeg: 0,
            in: 'top',
          });
          walkPockets(node.children);
        }
      };
      walkPockets(tree.pockets);
    }

    const result = planTreePrograms(tree, {
      offset,
      pockets: noFlatFallback ? null : {
        houseFlats: flats,
        // #975 — the V bits are the pocket chain's last resort: a pocket no flat covers gets the
        // narrowest V whose tip fits the stroke and whose leg reaches the floor, floor-correct.
        houseVs: input.cutters.house.filter((t) => isVShape(t)),
        paramsFor: cutParamsFor,
        stepDownMm: pocketParams.stepDown,
        feeds,
        rapid: Z1.rapidEstimate,
        toolChangeSeconds,
        spindleRpm: pocketParams.rpm,
        air: true,
        boolean,
        // #966/#970 — the per-level shadow check (`PocketOpOptions.aboveMaterial`'s own doc): the
        // SAME rotated design mesh `curvedGeometry` below already reads for this setup's own frame,
        // so every pocket/facing/through-as-pocket op this setup plans is bounded by the real
        // ceiling, not just each node's own static `region` — #970's own finding (a ⌀6 flat planned
        // straight through ~22 mm of the elephant's body, because the belly closing the gap above a
        // recognised floor was never checked).
        //
        // CORRECTION (Session A, independent re-check): `curvedOpsProperty959.spec.ts`'s own
        // `sloped`/`filletedFloor` coverage drop, first reported here as "CSG-noise artefact of
        // `slopedPocketVoid`/`filletFloorVoid`'s own construction," was NOT that — both flagged
        // nodes are the ordinary open-shoulder-notch and blind-hole subtraction every
        // `randomParts.ts` kind shares, and a direct `dropCutterHeight` probe at each one's own
        // centroid read back EXACTLY its own `floorZ`, real material, not stock top. The actual
        // cause (confirmed by tracing and fixed in `ops/pocket.ts`'s own `ceilingMaskAt`): the
        // per-level predicate read a node's OWN floor — the only thing a probe ever finds along a
        // vertical line through a floor with nothing above it — as an obstruction AT that floor's
        // own depth, excluding the node's entire LAST pass. Fixed at the source; see
        // `ops/pocket.ts`'s own comment at the predicate and `pocketShadow966.spec.ts`'s "#970
        // over-clip" / `pocketShadowNestedFloor966.spec.ts` cases. `curvedOpsProperty959` is back
        // at its own 95% line, unchanged.
        shadowMesh: curvedGeometry.triangles,
        ...(tabs === undefined ? {} : { tabs }),
        ...(oppositeSafeDepthMm === undefined ? {} : { oppositeSafeDepthMm }),
        facing: input.facing ?? 'off',
        ...(goalCoverage === undefined ? {} : { goalCoverage }),
        ...(restRegion === undefined ? {} : { restRegion }),
        ...(input.stockProbes === undefined ? {} : { stockProbes: input.stockProbes }),
      },
      curved: {
        geometry: curvedGeometry,
        // #982 — NO FLAT ANYWHERE IN THE HOUSE: the ball stands in for the flat (ball-as-rough,
        // 0ca79e89's disc-aware proof against the region and the CL), and the pocket floors (no
        // pocket chain at all without a flat) become `extraRegions`. A goal's own `curvedRoughTool`
        // is moot here — with no flat anywhere it can only ever validate to `null` (see the other
        // branch's own doc), which this one already subsumes with the more capable mechanism.
        //
        // #869/#966 — otherwise: absent (every existing caller): `primary`, unchanged. `null` (a
        // goal with no `roughToolKey`): no rough, ball alone. A `Tool` (a goal's validated
        // `roughToolKey`): that tool roughs instead of `primary`, which this job's own pockets (if
        // it has any) still use — the two are independent on purpose, see
        // `ModelPlanInput.curvedRoughTool`'s own doc.
        ...(noFlatFallback
          ? { flat: primary, extraRegions: pocketFloorRegions }
          : input.curvedRoughTool === undefined
            ? { flat: primary }
            : input.curvedRoughTool === null
              ? {}
              : { flat: input.curvedRoughTool }),
        ...(ball === undefined ? {} : { ball }),
        ...(restBall === undefined ? {} : { restBall }),
        // #982 — NO BALL IN THE SET: the flat finishes the curved remainder (a flat-raster over
        // the whole region, the flat's cusp rule), the creases via the rest with the smallest flat.
        ...(ball === undefined ? { finishFlat: finishFlat ?? primary } : {}),
        ...(ball === undefined && finishFlat !== undefined && finishFlat !== primary ? { restFlat: finishFlat } : {}),
        ...(vbit === undefined ? {} : { vbit }),
        stepDownMm: pocketParams.stepDown,
        bandMm: MODEL_STOCK_TO_LEAVE_MM,
        // #965 (the review session's ruling, 2026-11-05) — THE JOB'S TOLERANCE IS THE SCALLOP.
        // No floor and no max(): a job that states 0.01 mm finishes at 0.01 mm, and the vendor's
        // 0.027 mm (its ⌀6 ball's own 0.8 mm step-over) is the default only for a job that states
        // no tolerance at all. (The 960 merge floored the tolerance at the default, so a finer
        // tolerance could not tighten the scallop — that reading is withdrawn.)
        //
        // #985 — AND A STATED PITCH IS A PITCH. `finishStepOverMm` is a WIDTH (the old engine's
        // finishing raster pitch); the cusp it leaves is `R − √(R² − (s/2)²)` on the finishing
        // ball, converted here where R is known, never fed into `finishMm`'s height seat. A
        // stated cusp wins over a pitch; absent both, the engine's default stands.
        finishScallopMm: statedFinishCusp ?? DEFAULT_FINISH_SCALLOP_MM,
        stepOverMm: pocketParams.stepOver,
        feeds,
        cutParamsFor,
        rapid: Z1.rapidEstimate,
        spindleRpm: pocketParams.rpm,
        air: true,
        edgeBreak: input.edgeBreak,
        toolNumberFor: (tool) => tool.number ?? 1,
        facing: input.facing ?? 'off',
        ...(input.flatSurfaceMaxSlopeDeg === undefined ? {} : { flatSurfaceMaxSlopeDeg: input.flatSurfaceMaxSlopeDeg }),
      },
    });
    opts.signal?.throwIfAborted();
    opts.onProgress?.({ setupIndex, op: 'linking', fraction: 0.9 });

    // AN EMPTY PROGRAM NEVER REACHES THE POST — the rule, applied at the one place every stage's
    // IR passes (the manager's finding on F's seeds: postZ1 refuses an IR with no moves — 'the
    // toolpath IR has no operation with any moves: nothing to post'). planCurvedForTree drops its
    // own empty stages; this guard covers the pocket/through-hole/contour chain too, so a step that
    // planned nothing can only ever be a STATED op, never a posted file. A contour that emitted
    // nothing is called out for what it is: the part is not freed.
    const ops: PlannedOp[] = [];
    const emptyStages: string[] = [];
    for (const op of result.ops) {
      if (op.outcome.ir.operations.some((operation) => operation.moves.length > 0)) {
        // #965 — every op's posted IR is mapped to the DOCUMENT (world) XY here, once, before it
        // becomes part of `SetupPlan.ops`/`programs`: identity for the top setup (`up = [0, 0, 1]`,
        // every job today), the setup→document map for a flip (`setups.ts`'s own doc on why this
        // is required before two setups' programs can be read on one goal grid).
        ops.push({ ...op, outcome: { ...op.outcome, ir: mapIRToDocument(op.outcome.ir, spec.frame, registrationOffset) } });
        continue;
      }
      emptyStages.push(
        `${op.kind} "${op.region.id}" emitted no moves — not posted` +
          (op.kind === 'contour' ? ' — THE PART IS NOT FREED BY THIS PLAN' : ''),
      );
    }

    // #964's own measurement: the curved pipeline's per-region loop alternates flat/ball once per
    // remainder region (rough, [rest], finish, pencil, next region's rough, ...) — region A's
    // rough has no dependency on region B's ball stage or vice versa, so nothing here demands
    // that alternation. `batchSameCutterRuns` groups same-cutter ops back together wherever nothing
    // depends on the gap between them (`sequence.ts`'s own header on the one real invariant: never
    // reorder two ops on the SAME region), with the freeing contour pinned exactly where it was.
    const batchedOps = batchSameCutterRuns(ops, (op) => op.outcome.cutter, (op) => op.kind === 'contour');

    // Programs ONE PER RUN, in execution order — the same rule `planPocketsForTree` states: a run
    // starts when the cutter key changes, so a cutter's two non-contiguous visits never merge.
    const programs: ToolpathIR[] = [];
    let run: { key: string; ir: ToolpathIR } | null = null;
    for (const op of batchedOps) {
      if (run !== null && run.key !== op.outcome.cutter) {
        programs.push(run.ir);
        run = null;
      }
      run = run === null ? { key: op.outcome.cutter, ir: op.outcome.ir } : { key: run.key, ir: concatToolpathIR(run.ir, op.outcome.ir) };
    }
    if (run !== null) programs.push(run.ir);

    let totalCostSeconds = 0;
    for (let p = 0; p < programs.length; p++) {
      totalCostSeconds += estimateCycleTerms(programs[p]!, Z1.rapidEstimate).totalSeconds;
      if (p > 0) totalCostSeconds += toolChangeSeconds;
    }

    const notes = [...result.notes, ...emptyStages, ...freeingNotes];
    notes.push(...toolSubstitutions);
    // #982 (the review session's ruling) — the two cutter fallbacks, stated on the card in
    // outcome terms (the measured coverage/cycle numbers are the acceptance card's; the plan
    // states the method and the tradeoff it implies).
    if (noFlatFallback) {
      const r = (cuttingDiameter(primary) ?? 0) / 2;
      notes.push(
        `the set holds no flat end mill — the pocket floors are cut by the ${primary.name || primary.shape} ball: ` +
          `wall feet carry a ${r.toFixed(3)} mm fillet and the floor a stepped scallop between passes (the tradeoff of cutting without a flat)`,
      );
    }
    if (ball === undefined && tree.remainder.length > 0) {
      const flatName = (finishFlat ?? primary).name || 'flat';
      notes.push(
        `the set holds no ball nose — the curved remainder is finished by the ${flatName} as a flat-raster over the whole region ` +
          `(cusp rule: step = cusp / tan of the steepest slope, clamped to the flat's radius/10 to radius); ` +
          (finishFlat !== undefined && finishFlat !== primary ? 'the creases go to the rest pass with the smallest flat' : 'no smaller flat is offered, so the creases are left as the raster finds them'),
      );
    }
    if (input.fixture.envelope !== null) {
      notes.push(
        `the ${input.fixture.mount} fixture envelope is not yet wired into the region obstacles — this plan carries none; the posted program is still checked against the same envelope by the sweep`,
      );
    }
    if (input.cutters.catalogue.length > 0) {
      notes.push(`${input.cutters.catalogue.length} catalogue cutter(s) are not in the pocket chain yet — the house set is what it chooses from`);
    }
    // #965 — registration against setup 0's own cut features is now COMPUTED
    // (`registerSetupOrigin`, `setups.ts`), not left to the operator's fixture/jig: the note
    // states WHICH datum was found and the offset it produced, so the number is auditable rather
    // than asserted. (The freeing-contour gap just below is a SEPARATE, still-open #965 item —
    // the flat-Z release pass, not the registration this function now answers.)
    if (setupIndex > 0) {
      notes.push(describeRegistration(setupIndex, registration!));
      // The freeing contour's own depth IS now bounded against the opposite setup's finished
      // surface (above, `freeingNotes`) — this is no longer a stated gap; see that note for the
      // actual outcome (or why it could not be checked) on THIS plan.
    }

    perSetup.push({
      setupIndex,
      features: tree,
      clGrid: result.clGrid,
      ops,
      sequence: result.sequence,
      linking: linkingStats(programs),
      programs,
      totalCostSeconds,
      notes,
      unreachable: result.unreachable,
      unplanned: result.unplanned,
      choice: result.choice,
    });
    opts.onProgress?.({ setupIndex, op: 'linking', fraction: 1 });
  }
  return { perSetup };
}

const allPockets = (nodes: PocketNode[]): PocketNode[] => nodes.flatMap((n) => [n, ...allPockets(n.children)]);

/** The `facing` region's own `Box2` — there is no `PocketNode`/`regionRefs` entry for it (it is
 * not a recognised feature, it is this plan's own synthesis of `FeatureTree.top.floors`). */
/**
 * The topmost mesh surface at (x, y), or null where no triangle covers the point.
 *
 * PERF FINDING (#959 review): this used to scan EVERY triangle of the whole mesh, for every one
 * of `rims x segments x 5` samples — the same cost `triangleBins.ts`'s own header describes for
 * `dropcutter.ts`'s pre-bins query. `binnedReachableTriangles(bins, x, y, 0)` is the exact same
 * drop-in: a radius-0 query answers "triangle's own bbox contains (x, y)", a NECESSARY condition
 * for the barycentric test below to ever accept it, so the candidate set it returns is a superset
 * of the true containing triangle(s) — the barycentric filter here still does the real work, and
 * the retained (best) result is identical to the brute-force scan's, never just close to it.
 */
function topSurfaceAt(bins: TriangleBins, x: number, y: number): number | null {
  const p = bins.mesh.positions;
  const indices = bins.mesh.indices;
  let best: number | null = null;
  for (const t of binnedReachableTriangles(bins, x, y, 0)) {
    const i0 = indices[t * 3]! * 3;
    const i1 = indices[t * 3 + 1]! * 3;
    const i2 = indices[t * 3 + 2]! * 3;
    const x0 = p[i0]!, y0 = p[i0 + 1]!, z0 = p[i0 + 2]!;
    const x1 = p[i1]!, y1 = p[i1 + 1]!, z1 = p[i1 + 2]!;
    const x2 = p[i2]!, y2 = p[i2 + 1]!, z2 = p[i2 + 2]!;
    const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(d) < 1e-12) continue;
    const a = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d;
    const b = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d;
    const c = 1 - a - b;
    if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
    const z = a * z0 + b * z1 + c * z2;
    if (best === null || z > best) best = z;
  }
  return best;
}

/** The chamfer's own air-side sign: outward for the part's contour, into the pocket for a rim. */
function rimAirSign(rim: { of: string }): number {
  return rim.of === 'contour' ? 1 : -1;
}

/** A closed ring normalised to positive orientation (the same convention `chamfer()` uses). */
function rimRing(polyline: readonly [number, number][]): [number, number][] {
  const ring = polyline.map((q) => [q[0], q[1]] as [number, number]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  return area < 0 ? ring.reverse() : ring;
}

/**
 * IS THIS RIM EXPOSED FROM +Z? (the manager's ruling, from the tray's 0.5 mm cell). The tray's
 * chamfer ran a 130 mm feed along a real 90° mesh edge whose air side is COVERED: the goal's top
 * surface continues across the edge at the same height (the edge lies under the land — a cavity
 * mouth, not an open lip), so the break cut 0.5 mm into ground the goal never exposes. A rim is
 * breakable only where its AIR side actually drops — by the goal's own step threshold (0.2 mm,
 * `designEdgeCells`). Sampled at EVERY segment midpoint (not a stride across them — an 8-point
 * stride missed covered stretches on the tray), seven distances onto the air side (0.25/0.5/1.0/
 * 1.3/1.55/1.65/1.8 mm, the V's whole 1.6375 mm skirt reach plus margin); ANY covered sample means
 * the rim is not broken whole (conservative: never break under a lip).
 */
function rimExposedFromAbove(
  bins: TriangleBins,
  rim: { polyline: readonly [number, number][]; z: number; of: string },
  stepMm = 0.2,
): boolean {
  const ring = rimRing(rim.polyline);
  const segments = ring.length - 1;
  if (segments <= 0) return true;
  // EVERY segment midpoint, not a sample of them: an 8-point stride missed covered stretches on
  // the tray (adjudicated cut fell 0.00128 -> 0.00031, not to zero) because a long rim can pass
  // under a lip for a short run between the sampled points.
  const air = rimAirSign(rim);
  for (let s = 0; s < segments; s++) {
    const a = ring[s]!;
    const b = ring[(s + 1) % segments]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    // For a positively oriented closed ring the interior is on the left; outward is (dy, -dx).
    const nx = (dy / len) * air;
    const ny = (-dx / len) * air;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    // The samples must cover the V's WHOLE footprint, not just the edge's neighbourhood: the
    // cutter's skirt reaches its own outer radius from the path (offset 0.05 on the air side plus
    // 1.5875 of cone = 1.6375 from the rim), so covered ground that starts ~1.5 mm out is still
    // cut at 0.5 mm deep. The organizer's 45-degree rim cut one cell at 1.6 mm — past the old last
    // sample at 1.55 — which is why its 0.04 % survived the first filter.
    for (const d of [0.25, 0.5, 1.0, 1.3, 1.55, 1.65, 1.8]) {
      const top = topSurfaceAt(bins, mx + nx * d, my + ny * d);
      if (top !== null && top > rim.z - stepMm) return false;
    }
  }
  return true;
}

/** A ring's projected area (shoelace), mm² — absolute, so the ring's winding does not matter. */
function ringAreaOf(ring: readonly [number, number][]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return Math.abs(area / 2);
}

function boundsOfPolygons(polygons: Polygons): Box2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of polygons) for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

export interface PlanPocketsOptions {
  /** The real Clipper2 offset, or a test fake — `pocketLoops`' own contract, carried through unchanged. */
  offset: OffsetFn;
  /** House cutters, largest first is NOT required — #961's `chooseSequence` ranks by cost, not list order. */
  houseFlats: readonly Tool[];
  /**
   * #975 — an optional per-cutter cut-parameter resolver, so a V floor run speaks the SAME feeds
   * and spindle speed as that cutter's other steps (the rim chamfer): the two runs merge into one
   * program, and `concatToolpathIR` refuses a header mismatch. Absent → `feeds`/`spindleRpm`.
   */
  paramsFor?: (tool: Tool) => CutParams;
  /**
   * #975 — the V bits in the house set (engraving/chamfer shapes), as the pocket chain's LAST
   * RESORT: a pocket no flat covers gets the narrowest V whose tip is no wider than the stroke
   * and whose leg reaches the floor, cut as a floor-correct pocket (the maintainer's 2026-11-05
   * ruling — "never a refusal where a tool in the set can do the job"). Absent = no V pocketing.
   */
  houseVs?: readonly Tool[];
  stepDownMm: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  rapid: RapidEstimate;
  /** The shop's `toolChange.seconds` (#858) — #961's own per-change allowance, not a default here. */
  toolChangeSeconds: number;
  spindleRpm: number;
  air: boolean;
  /** The card's "vendor + 1" cutter budget (`SequenceOptions.maxCutters`). Absent → no cap. */
  maxCutters?: number;
  /** Absent → {@link DEFAULT_RELEASE_TABS} (the part must stay held until the last cut touches it). */
  tabs?: { count: number; width: number; height: number };
  /** A real Clipper2 union/subtract, for an OPEN node's region extension (finding 3). Absent on an open node leaves it unextended, stated by the caller, not assumed silently. */
  boolean?: { union: BooleanFn; subtract: BooleanFn };
  /** `ContourOpOptions.oppositeSafeDepthMm`, carried straight through to the contour op when this
   * setup's freeing cut must stay off the opposite setup's already-finished surface (#965). Absent
   * for every single-setup job and the first of two — `contourOp` then behaves exactly as before. */
  oppositeSafeDepthMm?: (x: number, y: number) => number | null;
  /**
   * #966 — the real design mesh, ALREADY ROTATED into THIS setup's own frame (the SAME one
   * `recogniseFeatures` built `tree` from — `planModelCam`'s own `curvedGeometry`). Threaded into
   * every `pocket()` call (`PocketOpOptions.aboveMaterial`'s own doc) so a node's per-level cut is
   * bounded by the true ceiling read off the mesh, not just `node.region`'s own static "air at
   * floorZ" footprint — #966's elephant/table finding (a flat planned straight through an overhang
   * with no floor patch of its own to correct `mouthZ`). Absent → every pre-#966 call site/test
   * (every one of them) is unaffected: no shadow check runs, `pocket()` behaves exactly as before.
   */
  shadowMesh?: DropCutterMesh;
  /**
   * #959 (2026-11-05 ruling): FACING OFF by default. `'on'` plans the facing stage exactly as
   * before (the operator option); absent or `'off'` plans none, and the skin over the top land
   * belongs to the flat surface-following pass (`skin`).
   */
  facing?: 'off' | 'on';
  /**
   * #962 — the rest region's dilation about the leftover mask, mm. Default `2 x the cutter's
   * radius + 0.25` (the MEASURED value: `pocketLoops` erodes by r before ringing, so the grown
   * strip must be a cutter diameter wide for the ring to exist). Exposed so a spec can drive the
   * failure geometry a smaller dilation produces — and prove such a rest is STATED, never silent.
   */
  restDilationMm?: number;
  /**
   * #961 — the simulated outcome for a candidate's planned IRs: the goal cells left above the
   * band and the covered cells, stamped by the caller (which owns the goal). Absent → the
   * picker keeps its pocket-count completeness.
   */
  goalCoverage?: (irs: readonly ToolpathIR[]) => { leftoverCells: number; coveredCells: number; cellAreaMm2: number } | null;
  /**
   * #961 — a COVERAGE rest's region, from the caller's own simulated field: the cells the chain so
   * far leaves above the band, as polygons in the plan's XY (the caller owns the goal and the
   * stamp). Absent → the rest cuts its whole pocket floor (the pre-restriction behaviour).
   */
  restRegion?: (
    prefixIrs: readonly ToolpathIR[],
    region: { id: string; footprint: Polygons; floorZ: number; bounds: { min: [number, number]; max: [number, number] } },
  ) => Polygons | null;
  /**
   * #943's ruling — the probed stock top (see {@link ModelPlanInput.stockProbes}): the facing
   * cut starts at the highest probed point and its target clamps at the part top. Absent → the
   * stated stock top, stated on the plan.
   */
  stockProbes?: StockProbes;
}

/**
 * A's review 6622610124 raised a real sequencing question this default answers, stated here for
 * the Manager/C to confirm rather than decided silently: #961's chain may add a rest flat AFTER
 * this contour step runs (the tray's 3.6 mm channels need ⌀3.175, smaller than the primary that
 * carries the contour), and the part must stay captured until the LAST cutter touches it. Of the
 * three ways to guarantee that — run the contour last (an extra tool change #961 does not price),
 * cut it with the chain's last cutter, or tab it — tabs cost the least to wire here: the contour
 * keeps whatever position the chain gives it, and these four shallow bridges hold the part
 * through every cut that follows. `{count: 0}` is no longer the default; it still frees the part
 * outright when the caller states it explicitly.
 */
export const DEFAULT_RELEASE_TABS = { count: 4, width: 6, height: 1 };

export interface PlanPocketsResult {
  ops: PlannedOp[];
  /**
   * One program per RUN, in execution order — NOT one per cutter key (advisor's review on
   * ab6b2827): #961 may legitimately return to an earlier cutter for the freeing cut (cheaper
   * than the chain's last cutter taking the profile itself), and a `Map<cutterKey, …>` merges
   * that cutter's two non-contiguous visits into ONE file — which, read in that file's own
   * order, frees the part before the rest step in between ever ran. A run starts whenever a
   * step's cutter differs from the previous step's; the SAME cutter key can appear in more than
   * one run.
   */
  programs: { cutterKey: string; ir: ToolpathIR }[];
  /**
   * `SetupPlan.sequence`'s own shape — `terms` computed HERE, from each cutter's concatenated
   * posted `ToolpathIR` via #927's `estimateCycleTerms` (§3.0.1), not reused from `choice.cost`'s
   * per-step sum (`sequence.ts`'s own internal accounting is a different, bare `estimateSeconds`).
   */
  sequence: SequencedCutter[];
  /** A feature no cutter in the chosen chain's budget covers, as a stated finding naming the limiting number — `SequenceChoice.unreachable`, turned into a sentence. */
  unreachable: string[];
  /** Other stated findings — a skin above the part this plan does not fully face, and similar gaps that are not a refusal. */
  notes: string[];
  /** The full picker result (`considered`, `cost`) — for a caller that wants more than `ops`/`unreachable`. */
  choice: SequenceChoice;
  /** #959 item 5 — the chosen chain's failed steps, one entry per region that threw (with its own message). */
  unplanned: SequenceStepFailure[];
}

/**
 * Every non-through floored `PocketNode`, AND the outer contour, in a `FeatureTree`, planned
 * TOGETHER through #961's real `chooseSequence` rest chain (`sequence.ts`) — one `SequenceDemand`
 * covering both, so the chain's cutter choice is priced against the whole job, not pocket and
 * contour separately. The manager's rule after E's a46f0358 run: an op that is real enters this
 * function AND whatever acceptance spec plans through it in the same commit, so a real run
 * exercises what the engine would actually post.
 *
 * `planStep` (the seam `chooseSequence` prices candidates through) dispatches each region id in a
 * step to `pocket()` (a real `PocketNode`) or `contourOp()` (`id === 'contour'`, `regionRefs`' own
 * reserved id for the tree's outer contour) and caches the resulting `OpOutcome`s by step
 * signature — `chooseSequence` calls `planStep` once per candidate it prices, not just the winner.
 */
export function planPocketsForTree(tree: FeatureTree, opts: PlanPocketsOptions): PlanPocketsResult {
  // ADVISOR'S REVIEW, most severe: there is no single Z datum without this. `zPasses`, SAFE_Z/
  // HOP_Z (ir.ts) and the post's own `probed-top-face` convention all assume IR Z 0 is the STOCK
  // top; `pocket()` instead used `node.floorZ`/`mouthZ` as literal move Z, on whatever absolute
  // axis `recogniseFeatures` happened to place the mesh on (A's own red-first fixtures place it
  // at `stockTop = 10`, not near 0 — "every real caller keeps stockTop near 0" was simply wrong).
  // Every Z this function hands an op is rebased by `-stockTop` here, ONCE, so every op downstream
  // shares the SAME Z 0 = stock top — not fixed by a per-caller convention, not assumed.
  const z0 = tree.frame.stockTop;
  const rebase = (z: number): number => z - z0;

  const refs = regionRefs(tree);
  // `regionRefs` reads `topZ`/`bottomZ` straight off the tree (mesh-absolute) — rebased here too,
  // so a `RegionRef` never mixes the mesh's own axis with the stock-relative one every op uses.
  const refById = new Map(refs.map((r) => [r.id, {
    ...r,
    topZ: rebase(r.topZ),
    bottomZ: rebase(r.bottomZ),
    obstacles: [],
    // The skin above an OPEN node (a shoulder) is cut by this plan; above anything else (an
    // island's own cap, say) it is not, and stays at the stock's own top (rebased, 0) — never
    // below it, or a clearance plane under 5 mm above a thick, uncut skin would not clear it.
    regionClearanceZ: Math.max(0, rebase(tree.frame.partTop)) + 5,
  }]));

  // A's review 6622610124, finding 2: a ROOT node's mouth is the STOCK's own top, not the
  // recognised part top — the tray's top land sits 1.2 mm below the stock surface, and without
  // this the first pass engages 1.2 mm + one step-down with nothing faced first. A nested node's
  // mouth is correctly its parent's own floor, so only roots get the override (below).
  const rootIds = new Set(tree.pockets.map((n) => n.id));
  const allNodes = allPockets(tree.pockets);
  const pocketNodes = allNodes.filter((n) => !n.through && n.floors.length > 0);
  const pocketsById = new Map(pocketNodes.map((n) => [n.id, n] as const));
  // A's review 6622610124, finding 4: a through node used to be skipped with nothing in
  // `unreachable` — it is cut by the SAME contour-op machinery as the outer release (a hole, cut
  // INSIDE its own outline), as its own `SequenceFeature` so the chain can size it a cutter that
  // fits its own narrowest opening, independent of whatever covers the outer contour.
  const throughNodes = allNodes.filter((n) => n.through);
  const throughById = new Map(throughNodes.map((n) => [n.id, n] as const));

  // A's review 6622610124, most severe: `zPasses` counts down from Z 0, the STOCK top, not the
  // recognised part top — a `partTop - zTo` depth stopped the contour short by exactly the skin
  // between the stock and the part (1.2 mm on the tray, 0.8 mm on the organizer), so the part was
  // never actually freed. These are magnitudes, already stock-top-relative — no `rebase` needed.
  const contourDepthMm = z0 - tree.contour.zTo;

  // The manager's #959 ruling: the top land OUTSIDE every pocket's footprint, faced through the
  // SAME `pocket()` op and `link()` safety every other region uses — not a new op. `tree.top.floors`
  // is NOT the right region for it (advisor's review on 9a5cc607): features/tree.ts's own "top
  // land" step deliberately EXCLUDES an island's own top (so it is not faced either, there is
  // nowhere else a skin over one gets cut) and, being a recognised shape, erodes away under a
  // real cutter's own radius wherever the land is a wall or a rim narrower than that — exactly
  // where this plan most needs it to still reach. Facing the WHOLE outline instead (the SAME
  // open-edge overhang the open-shoulder fix already uses, `offset(outline, +2r)`) has neither
  // problem. Computed per cutter (below, not here) since the margin is `r`-sized.
  //
  // Ordering now DOES matter (advisor's review on this revert): a root pocket's/wide through
  // hole's own mouth is `tree.top.z`, not the stock top (below) — it assumes facing already took
  // the skin everywhere, so facing posting AFTER one would hand it a first stepdown pass deeper
  // than `stepDownMm` expects. This is pushed FIRST into `features`, below, which is enough: a
  // flat tool covers facing unconditionally (no opening/corner/flute-depth constraint it can
  // fail), so `chainFrom`'s own `addLink(primary)` always claims it on the first cutter's first
  // link — and `regionIds`' own order-preserving filter over `pocketFeatures` then puts it ahead
  // of every pocket/through-hole sharing that same step. See the regression test proving this by
  // POSTED ORDER, not by trusting this push order alone, in `opsAcceptance959.spec.ts`.
  const facingSkinMm = z0 - tree.top.z;
  // #959 (2026-11-05 ruling): facing is an OPERATOR OPTION, off by default.
  const hasFacing = (opts.facing ?? 'off') === 'on' && facingSkinMm > 1e-6;
  // #943 (2026-11-05 ruling): FACING LEVELS THE TOP, it does not skin it. The top is the HIGHEST
  // probed point; the TARGET is one step-down below the LOWEST probed point — "it may require many
  // passes as the high point may be a large variance" — so a stock standing well proud of the part
  // finishes one step below its low point and the remaining skin is the rough's/skin's to take.
  // The target clamps at the PART TOP (one step deeper would cut the design's own top face), and
  // the clamp is STATED when it binds (a skin thinner than one row step). In this datum the
  // registration writes Z0 at the LOWEST touch (#475's `Z0_REFERENCE`), so the highest reading is
  // `+spreadMm` above the zero and the target sits at `−stepDown`. No probes → the stated stock
  // top is the cut's start, stated on the plan.
  const facingSpreadMm = Math.max(0, opts.stockProbes?.spreadMm ?? 0);
  const facingTopZ = rebase(z0) + facingSpreadMm;
  const facingDepthMm = Math.min(opts.stepDownMm, facingSkinMm);
  if (hasFacing) {
    refById.set('facing', {
      id: 'facing', kind: 'pocket', bounds: boundsOfPolygons(tree.contour.outline),
      topZ: facingTopZ, bottomZ: rebase(z0) - facingDepthMm, obstacles: [],
      regionClearanceZ: Math.max(0, rebase(tree.frame.partTop)) + 5,
    });
  }

  const features: SequenceFeature[] = [];
  if (hasFacing) features.push({ id: 'facing', kind: 'pocket', depthMm: facingDepthMm });
  for (const node of pocketNodes) {
    features.push({
      id: node.id,
      kind: 'pocket',
      // An OPEN node's OWN narrowest is measured against its unextended boundary, which is not
      // the real constraint at an open edge (finding 3) — the extension this op applies (below)
      // is what decides whether a cutter fits there, not this number; stating it here would
      // exclude a cutter the extended region can serve.
      minOpeningMm: node.open ? null : node.narrowest,
      cornerRadiusMm: node.open ? null : node.narrowest / 2,
      // Measured below the STOCK top (`SequenceFeature.depthMm`'s own doc), not the node's own
      // mouth — a nested node's flute reach is under-reported by `mouthZ - floorZ` alone.
      depthMm: z0 - node.floorZ,
    });
  }
  for (const node of throughNodes) {
    features.push({
      id: node.id,
      kind: 'pocket',
      minOpeningMm: node.narrowest,
      cornerRadiusMm: node.narrowest / 2,
      depthMm: z0 - node.floorZ,
    });
  }
  // #987 — a skirt-closed relief's outline is synthetic: the kernel's own requirement for a
  // solid, not a design edge, so no contour op is demanded against it. `tree.contour.frees`
  // stays what it always was (whether a REAL contour reaches the stock bottom, which decides
  // tabs below) — a different question from whether a contour exists at all.
  if (!tree.contour.synthetic) {
    features.push({ id: 'contour', kind: 'contour', depthMm: contourDepthMm });
  }
  const demand = { features };

  const cutters: CutterCandidates = { house: [...opts.houseFlats], catalogue: [] };

  const cutParamsFor = (cutter: Tool): CutParams => ({
    rpm: opts.spindleRpm,
    feed: opts.feeds.feedMmPerMin,
    plungeFeed: opts.feeds.plungeFeedMmPerMin,
    stepDown: opts.stepDownMm,
    stepOver: (cuttingDiameter(cutter) ?? 1) / 4,
    peck: 0,
    air: opts.air,
  });

  /**
   * #961 — A REST'S OWN REGION (the manager's 11-05 finding, measured): the tray's ⌀3.175 rest was
   * planned as a full pocket pass — every op the ⌀6 already cut, re-cut at all three levels, 4,306 s
   * (90.2 % of its 60,266 mm of feed travelled over floor the primary had already cleared and
   * removed nothing). The material a pocket primary leaves standing is AT THE FLOOR: the 0.58 mm
   * lands between the tray's scoops, which the ⌀6's disc cannot span but the ⌀3.175's can. The
   * rest is therefore ONE pass at the node's floor over the pocket's own region — not the mouth,
   * not every level, not the facing the primary already finished.
   *
   * The manager's suggested criterion (`cut only where prevCl − restCl > band`) was tried first and
   * blocked by the rest op's own rule (`ops/rest.ts`): its mask is `nextCL + stockToLeave + margin
   * < levelZ`, so it always stops a band ABOVE its own CL — in the curved pipeline the ball finish
   * takes that band. As a POCKET rest it cannot cut to the floor at all (at the floor level its
   * mask is empty by construction), and the tray's lands stand at the floor. The floor-level pass
   * is the shape that cuts what actually stands, and it keeps the coverage bit-identical.
   *
   * #961 follow-up — THE REGION IS THE SIMULATED LEFTOVER: when the caller supplies `restRegion`
   * (it owns the goal), the pass is confined to the cells the CHAIN SO FAR leaves above the band,
   * dilated by the rest's radius plus its step-over so its centre can reach them. The material
   * map showed the untrimmed floor pass still crossing cleared floor at 83 % of its feed; the
   * spine strips and slot-wall corners are all there is to cut.
   */
  const planRestRegion = (id: string, step: SequenceStep, prefix: readonly SequenceStep[] | undefined): OpOutcome | null => {
    // The primary faced the land and cleared the through holes; nothing rests there (the primary's
    // own pass already reached the design surface). Only a pocket's floor can hold a land.
    if (id === 'facing') return null;
    const node = pocketsById.get(id);
    if (node === undefined) return null;
    const ref = refById.get(id);
    if (ref === undefined) return null;
    const cutter = step.cutter.tool;
    const floorZ = rebase(node.floorZ);
    const stepOverMm = (cuttingDiameter(cutter) ?? 1) / 4;
    const radius = (cuttingDiameter(cutter) ?? 0) / 2;
    // The chain so far, as IRs (each prefix step planned with its own prefix; all memoized).
    const prefixIrs: ToolpathIR[] = [];
    if (prefix !== undefined) {
      for (let i = 0; i < prefix.length; i++) {
        let ir: ToolpathIR | null;
        try {
          ir = planStep(prefix[i]!, prefix.slice(0, i));
        } catch {
          ir = null;
        }
        if (ir !== null) prefixIrs.push(ir);
      }
    }
    let regionPolys = node.region;
    if (opts.restRegion !== undefined) {
      if (prefixIrs.length === 0) return null; // nothing planned before it: no leftover to cut
      const mask = opts.restRegion(prefixIrs, { id, footprint: node.region, floorZ, bounds: ref.bounds });
      if (mask === null || mask.length === 0) return null;
      // #962 — THE DILATION: 2r + 0.25, MEASURED. `2r + stepOver + 0.25` grew the leftover mask
      // ~4.2 mm on a ⌀3.175 and the rings swept that grown area: the integration tip's tray rest
      // spent 601 s of feed over cells the prefix already held within the band. But `r + 0.25`
      // is WORSE, not tighter: `pocketLoops` erodes the region by r before it rings it, so a
      // strip grown only to r leaves a region narrower than the cutter's diameter and the rest
      // emits NO toolpath at all for that pocket — six of the tray's seven lost their pass
      // outright and coverage fell 99.34 → 99.03 %. The tray sweep brackets the threshold at
      // exactly 2r (3.15 mm: 99.30 %; 3.20 mm: 99.34 %; 2r = 3.175): the grown strip needs to be
      // a cutter diameter wide for the eroded ring to exist. So the dilation is 2r — the ring's
      // own inset plus the reach the cell needs — plus 0.25 mm of margin; the grown region is
      // still clipped back to the pocket's own mouth (A ∩ B = A \ (A \ B)). Tray at this value:
      // coverage 99.344 % (identical to the over-grown tip), rapid 660.6 s vs its 732.3 s.
      regionPolys = opts.offset(mask, opts.restDilationMm ?? 2 * radius + 0.25);
      if (regionPolys.length === 0) return null;
      if (opts.boolean !== undefined) {
        const clipped = opts.boolean.subtract(regionPolys, opts.boolean.subtract(regionPolys, node.region));
        // #962 — the mask holds standing cells but nothing of it survives at this pocket's own
        // mouth: a planned pass that would cut nothing, STATED rather than silently dropped
        // (the same silence the r-only dilation produced when `pocketLoops` could not ring).
        if (clipped.length === 0) {
          throw new Error(
            `the rest's leftover mask has standing cells but none of it survives inside this pocket at the ` +
              `cutter's radius (${radius} mm) — standing material outside the mask's reach is left uncut`,
          );
        }
        regionPolys = clipped;
      }
    }
    const restNode: PocketNode = {
      ...node,
      open: false,
      through: false,
      region: regionPolys,
      floors: [{ polygons: regionPolys, area: 0 }],
      mouthZ: floorZ,
      floorZ,
    };
    const restOutcome = pocket({
      cutter,
      node: restNode,
      region: ref,
      stepOverMm,
      stepDownMm: opts.stepDownMm,
      feeds: opts.feeds,
      offset: opts.offset,
      safeZMm: SAFE_Z,
      hopZMm: HOP_Z,
      toolNumber: cutter.number ?? 1,
      spindleRpm: cutParamsFor(cutter).rpm,
      air: opts.air,
      rapid: opts.rapid,
      boolean: opts.boolean,
    });
    // #962 — A REST THAT CUTS NOTHING OVER LIVE STANDING MATERIAL IS STATED, NEVER SILENT: the
    // mask said cells stand here, and the op produced no toolpath (the region eroded to nothing
    // at the cutter's radius — the failure a too-small dilation produced on six of the tray's
    // seven rest passes, where those plans simply had no rest op and said nothing). Throwing
    // takes the region into `unplanned` with this reason, in the plan's own outcome words.
    if (restOutcome.ir.operations.every((operation) => operation.moves.length === 0)) {
      throw new Error(
        `the rest's leftover mask eroded to nothing at the cutter's radius (${radius} mm) — ` +
          'standing material under this mask is left uncut',
      );
    }
    return restOutcome;
  };

  const planRegion = (id: string, step: SequenceStep, prefix?: readonly SequenceStep[]): OpOutcome | null => {
    const ref = refById.get(id);
    if (ref === undefined) return null;
    const cutter = step.cutter.tool;
    // #961 — Only a COVERAGE rest is a floor-level pass: the primary already cleared the pocket
    // above its floor. A GEOMETRIC rest (a pocket the primary cannot enter at all) still needs the
    // full depth pass — its material stands from the mouth down, not just at the floor.
    if (step.kind === 'rest' && step.coverageRest === true) {
      return planRestRegion(id, step, prefix);
    }
    if (id === 'contour') {
      return contourOp({
        cutter,
        contour: tree.contour,
        region: ref,
        depthMm: contourDepthMm,
        tabs: opts.tabs ?? DEFAULT_RELEASE_TABS,
        offset: opts.offset,
        params: cutParamsFor(cutter),
        rapid: opts.rapid,
        ...(opts.oppositeSafeDepthMm === undefined ? {} : { oppositeSafeDepthMm: opts.oppositeSafeDepthMm }),
      });
    }
    if (id === 'facing') {
      const toolRadius = (cuttingDiameter(cutter) ?? 0) / 2;
      // `offset(outline, +2r)`: the same open-edge overhang the open-shoulder fix uses, so the
      // facing cut reaches all the way to the true outer edge, past every island top and every
      // wall/rim too narrow to survive `tree.top.floors`' own erosion. The overshoot past the
      // true edge is air once the contour frees the part, same reasoning as the shoulder case.
      //
      // E's measurement on faf7ad78: excluding each pocket's own interior made BOTH reference
      // parts SLOWER (tray +165 s, organizer +155 s) — the holed raster this cut into the
      // facing region, going around every pocket's own boundary, is many SHORT feed segments
      // (+58 %/+27 % feed moves), and that cost more than the area it skipped saved. Reverted:
      // facing covers the WHOLE grown outline again, no exclusion. The real lever E found in
      // the posted program was the STEP-OVER: facing ran at 25 % of the cutter's own diameter
      // (the same fraction a tight pocket needs for wall engagement), where an OPEN, single-pass
      // facing cut can use far more of it. The manager's stated band was 50-60 %; `pocketLoops`
      // itself refuses anything over 50 % by default (`maxStepOver = toolRadius`, #191 — past
      // that, contour-parallel rings leave an uncut spine) and `pocket()` does not expose a
      // higher one to ask for, so 50 % (= toolRadius, exactly the ceiling) is what this can
      // actually post, not a choice within the band. Not a lookup of the real feeds row's own
      // stepOverFraction (feeds.ts) either — wiring that in needs a material/tool lookup this
      // function does not have today, named as the next integration point.
      const facingRegion = opts.offset(tree.contour.outline, 2 * toolRadius);
      return pocket({
        cutter,
        node: {
          id: 'facing', floorZ: rebase(z0) - facingDepthMm, mouthZ: facingTopZ, open: false, through: false,
          region: facingRegion, floors: [], islands: [], children: [], remainder: [], narrowest: Infinity,
        },
        region: ref,
        stepOverMm: toolRadius,
        stepDownMm: opts.stepDownMm,
        feeds: opts.feeds,
        offset: opts.offset,
        safeZMm: SAFE_Z,
        hopZMm: HOP_Z,
        toolNumber: cutter.number ?? 1,
        spindleRpm: opts.spindleRpm,
        air: opts.air,
        rapid: opts.rapid,
        boolean: opts.boolean,
        ...(opts.shadowMesh === undefined ? {} : { aboveMaterial: { mesh: opts.shadowMesh, zOffsetMm: z0 } }),
      });
    }
    const throughNode = throughById.get(id);
    if (throughNode !== undefined) {
      const diameter = cuttingDiameter(cutter) ?? 1;
      // The manager's #959 ruling 2: a through hole is CLEARED, not just profiled — a profile cut
      // alone leaves an uncut slug in the middle of anything wider than about two cutter
      // diameters (through-the-material, nothing holds it, nowhere for the chips of it to go).
      // Narrower than that, the slug a profile cut would leave is negligible next to the kerf
      // itself, and the real pocket op's own Z-level stepping/linking would be wasted on it.
      if (throughNode.narrowest >= 2 * diameter) {
        return pocket({
          cutter,
          // `tree.top.z`, not the stock top — facing already clears the skin above it everywhere,
          // this hole's own footprint included (same reasoning as the root-pocket mouth, below).
          node: { ...throughNode, mouthZ: rebase(tree.top.z), floorZ: rebase(throughNode.floorZ) },
          region: ref,
          stepOverMm: diameter / 4,
          stepDownMm: opts.stepDownMm,
          feeds: opts.feeds,
          offset: opts.offset,
          safeZMm: SAFE_Z,
          hopZMm: HOP_Z,
          toolNumber: cutter.number ?? 1,
          spindleRpm: opts.spindleRpm,
          air: opts.air,
          rapid: opts.rapid,
          boolean: opts.boolean,
          ...(opts.shadowMesh === undefined ? {} : { aboveMaterial: { mesh: opts.shadowMesh, zOffsetMm: z0 } }),
        });
      }
      return throughHole({
        cutter,
        id,
        outline: throughNode.region,
        region: ref,
        depthMm: z0 - throughNode.floorZ,
        offset: opts.offset,
        params: cutParamsFor(cutter),
        rapid: opts.rapid,
      });
    }
    const node = pocketsById.get(id);
    if (node === undefined) return null;
    const diameter = cuttingDiameter(cutter) ?? 1;
    // Rebased onto the SAME Z 0 = stock top every op shares (see this function's header note); a
    // root's own mouth is `tree.top.z`, not the stock top directly — facing (above) already
    // clears the skin from the stock top down to the top land everywhere, including over every
    // root pocket's own footprint, so a root pocket starting at the stock top too would re-face
    // that same skin layer a second time (the manager's "pocket passes that overlap the faced
    // land start below it"). `tree.top.z` equals the stock top when there is no skin, so this is
    // the stock top again in that case — not a separate branch. A nested node's mouth is
    // unaffected, its parent's own floor, as before.
    const mouthZAbs = rootIds.has(node.id) ? tree.top.z : node.mouthZ;
    return pocket({
      cutter,
      node: { ...node, mouthZ: rebase(mouthZAbs), floorZ: rebase(node.floorZ) },
      region: ref,
      stepOverMm: diameter / 4,
      stepDownMm: opts.stepDownMm,
      feeds: opts.feeds,
      offset: opts.offset,
      // The SAME constants `contourOp` gets from `generateProfile` (ir.ts) — a pocket and the
      // contour in one cutter's program must agree on `safeZ`/`hopZ` (`concatToolpathIR` refuses
      // otherwise); both are only meaningful heights ABOVE the stock because every Z passed to
      // either op is now on that SAME stock-top-relative axis.
      safeZMm: SAFE_Z,
      hopZMm: HOP_Z,
      toolNumber: cutter.number ?? 1,
      spindleRpm: opts.spindleRpm,
      air: opts.air,
      rapid: opts.rapid,
      openOutline: node.open ? tree.contour.outline : undefined,
      boolean: opts.boolean,
      ...(opts.shadowMesh === undefined ? {} : { aboveMaterial: { mesh: opts.shadowMesh, zOffsetMm: z0 } }),
    });
  };

  // `chooseSequence` calls `planStep` once per candidate it prices (not just the chosen one); a
  // step's own signature (kind + cutter + regionIds) is stable across those calls, so the SAME
  // step, priced more than once, is only ever planned once.
  const outcomeCache = new Map<string, { id: string; outcome: OpOutcome }[] | null>();
  const stepSignature = (step: SequenceStep): string => `${step.kind}:${step.cutter.key}:${step.regionIds.join(',')}`;

  // The manager's ruling on #959: a throwing region must not crash the whole plan. `sequence.ts`
  // prunes candidates on GEOMETRY alone (an opening, a corner, a flute length) — it has no notion
  // of a region that passes that pruning but fails when actually planned (a Clipper failure on an
  // extended open shoulder, a degenerate through hole), so this is the one place that can catch
  // it. Caught per region, not per step: the OTHER regions in the same step still plan and post.
  const regionFailures = new Map<string, SequenceStepFailure>();
  // The same failures by step signature, so the plan states the CHOSEN chain's own (not another
  // candidate's) in `unplanned`, each with the message its region threw.
  const stepFailures = new Map<string, { id: string; reason: string }[]>();

  // #961 — THE SAME STEP, PRICED BY MANY CANDIDATES, IS ONE IR: the picker stamps every priced
  // candidate's steps, so the merge (and, in `planModelCam`, the stamp) must be done once per
  // step, not once per candidate. Keyed by the same signature the outcome cache uses.
  // #961 — a COVERAGE rest's IR depends on the chain so far (its region is that chain's stamped
  // leftover), so the caches key on the prefix for a rest step; every other step is prefix-free.
  const stepKey = (step: SequenceStep, prefix: readonly SequenceStep[] | undefined): string =>
    step.kind === 'rest' && prefix !== undefined && prefix.length > 0
      ? `${stepSignature(step)}|after:${prefix.map((s) => stepSignature(s)).join('>')}`
      : stepSignature(step);
  const irCache = new Map<string, ToolpathIR | null>();
  const planStep: SequenceOptions['planStep'] = (step, prefix) => {
    const signature = stepKey(step, prefix);
    if (irCache.has(signature)) return irCache.get(signature)!;
    // The outcome cache uses the SAME key as the IR cache (a rest's regions depend on its prefix),
    // and the chosen chain's ops build reads it back by `stepKey` — the two must agree or a rest's
    // ops silently drop out of the posted program.
    let outcomes = outcomeCache.get(signature);
    if (outcomes === undefined) {
      outcomes = [];
      for (const id of step.regionIds) {
        let outcome: OpOutcome | null;
        try {
          outcome = planRegion(id, step, prefix);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (!regionFailures.has(id)) regionFailures.set(id, { kind: step.kind, cutterKey: step.cutter.key, regionIds: [id], reason });
          const signature = stepSignature(step);
          stepFailures.set(signature, [...(stepFailures.get(signature) ?? []), { id, reason }]);
          continue;
        }
        if (outcome === null) continue;
        outcomes.push({ id, outcome });
      }
      outcomeCache.set(signature, outcomes);
    }
    const merged = outcomes === null || outcomes.length === 0
      ? null
      : outcomes.map((o) => o.outcome.ir).reduce((a, b) => concatToolpathIR(a, b));
    irCache.set(signature, merged);
    return merged;
  };

  // #987 — a demand with NOTHING in it (every pocket/through-hole is a `curved` region planned
  // by `planCurvedForTree` instead, and the contour is synthetic or absent) is trivially
  // satisfied: no pocket-chain cutter is needed, so none is required to exist. Without this,
  // `candidateSequences` finds no candidate to build (every built step list is empty and `add`
  // drops it) and `chooseSequence` threw "no cutter sequence can be planned" against a relief
  // that in fact needs no pocket-chain cutter at all (#869's ball-alone relief, #966's open-mesh
  // relief). Guarded here, not in `sequence.ts`, so the general-purpose chooser stays untouched.
  const choice: SequenceChoice = demand.features.length === 0
    ? { steps: [], cost: { entries: [], estimateSeconds: 0, toolChanges: 0, toolChangeSeconds: 0, totalSeconds: 0 }, considered: [], unreachable: [], freeing: null, unplanned: [] }
    : chooseSequence(demand, cutters, {
    rapid: opts.rapid,
    toolChangeSeconds: opts.toolChangeSeconds,
    planStep,
    maxCutters: opts.maxCutters,
    ...(opts.goalCoverage === undefined
      ? {}
      : {
          coverage: (steps: readonly SequenceStep[]) => {
            // The candidate's PLANNED steps' IRs (cached by planStep) — what would post. A step
            // that throws cuts nothing (`priceSequence` already caught it and stated the failure),
            // so it contributes no IR here either: a candidate is never crashed by a simulation.
            const irs: ToolpathIR[] = [];
            const already: SequenceStep[] = [];
            for (const step of steps) {
              let ir: ToolpathIR | null;
              try {
                ir = planStep(step, already);
              } catch {
                ir = null;
              }
              if (ir !== null) irs.push(ir);
              already.push(step);
            }
            return irs.length === 0 ? null : opts.goalCoverage!(irs);
          },
        }),
  });

  // #975 — THE V FLOOR (the maintainer's 2026-11-05 ruling). A pocket the chosen chain leaves
  // UNREACHABLE is not refused while a V bit in the set can do the job: the NARROWEST V whose tip
  // is no wider than the pocket's narrowest stroke and whose leg reaches the floor cuts it as a
  // FLOOR-CORRECT pocket — the model's floor at the model's depth, the floor plane exact (rings
  // from the region offset by the tip's own radius, at the V-carve pass pitch, one level), the
  // walls opening at the V's half-angle, and the land the flanks take per side (`depth·tan(half)`)
  // STATED, never counted as a failure (the gate's edge-break class carries it: the IR's tool is
  // the V, so `whoAt` answers it there). Planned OUTSIDE the chain's cost ranking on purpose —
  // the V is the last resort for features nothing else covers, and a 0.05 mm floor pitch would
  // never earn its place against a covering flat by cost. Its run posts BEFORE the freeing
  // contour: the part must stay captured while it is cut.
  const vCovered = new Set<string>();
  const vOps: PlannedOp[] = [];
  const vRuns: { cutterKey: string; ir: ToolpathIR }[] = [];
  const vNotes: string[] = [];
  if (opts.houseVs !== undefined && opts.houseVs.length > 0 && choice.unreachable.length > 0) {
    const featureOf = new Map(demand.features.map((f) => [f.id, f] as const));
    const byV = new Map<string, { tool: Tool; cone: VCone; ids: string[] }>();
    for (const id of choice.unreachable) {
      const node = pocketsById.get(id);
      const feature = featureOf.get(id);
      if (node === undefined || feature === undefined || feature.kind !== 'pocket' || throughById.has(id)) continue;
      let pick: { tool: Tool; cone: VCone } | null = null;
      // The V's reach is measured from the node's MOUTH, not the stock top: the cone only has to
      // span mouth-to-floor (`SequenceFeature.depthMm` is stock-top-relative for a FLAT's flute,
      // which would refuse the tray's digits by 0.26 mm — their mouth is the −1.2 land, their
      // floor −1.8), and above the mouth the shank rides in air the facing already cleared.
      const mouthZAbsV = rootIds.has(node.id) ? tree.top.z : node.mouthZ;
      const nodeDepthMm = mouthZAbsV - node.floorZ;
      for (const tool of opts.houseVs) {
        const cone = vCone(tool);
        if (cone === null) continue;
        const tip = cone.tipRadius * 2;
        if (feature.minOpeningMm !== null && feature.minOpeningMm !== undefined && tip > feature.minOpeningMm + 1e-9) continue;
        const leg = coneHeight(cone);
        if (leg === null || leg + 1e-9 < nodeDepthMm) continue;
        if (pick === null || tip < pick.cone.tipRadius * 2) pick = { tool, cone };
      }
      if (pick === null) continue;
      const key = cutterKeyOf(pick.tool);
      const entry = byV.get(key) ?? { tool: pick.tool, cone: pick.cone, ids: [] };
      entry.ids.push(id);
      byV.set(key, entry);
    }
    for (const [key, group] of byV) {
      const pitch = vCarvePassPitch(group.cone.tipRadius, group.cone);
      const irs: ToolpathIR[] = [];
      for (const id of group.ids) {
        const node = pocketsById.get(id)!;
        const ref = refById.get(id)!;
        const mouthZAbs = rootIds.has(node.id) ? tree.top.z : node.mouthZ;
        const mouthZ = rebase(mouthZAbs);
        const floorZ = rebase(node.floorZ);
        // The V's OWN row where the caller resolves one (its rpm/feed must match that cutter's
        // other runs so the two merge into one program) — the plan's flat numbers otherwise.
        const vParams = opts.paramsFor?.(group.tool);
        const outcome = pocket({
          cutter: group.tool,
          node: { ...node, mouthZ, floorZ },
          region: ref,
          // The floor-correct pass: the tip's own radius as the boundary offset (the floor plane
          // lands on the model's outline), the V-carve pass pitch between rings (clamped to the
          // tip radius, so the tip's flat covers every gap and the floor is flat, not a knife
          // line), and ONE level at the floor (`stepDown = the whole depth`).
          stepOverMm: pitch,
          stepDownMm: mouthZ - floorZ,
          feeds: vParams === undefined ? opts.feeds : { feedMmPerMin: vParams.feed, plungeFeedMmPerMin: vParams.plungeFeed },
          offset: opts.offset,
          safeZMm: SAFE_Z,
          hopZMm: HOP_Z,
          toolNumber: group.tool.number ?? 1,
          spindleRpm: vParams?.rpm ?? opts.spindleRpm,
          air: opts.air,
          rapid: opts.rapid,
          boolean: opts.boolean,
          ...(opts.shadowMesh === undefined ? {} : { aboveMaterial: { mesh: opts.shadowMesh, zOffsetMm: z0 } }),
        });
        vOps.push({ kind: 'pocket', region: ref, outcome });
        irs.push(outcome.ir);
        vCovered.add(id);
        const depth = mouthZ - floorZ;
        const land = depth * group.cone.tanHalf;
        const r3 = (n: number): string => String(Math.round(n * 1000) / 1000);
        vNotes.push(
          `${id}: cut by the ${group.tool.name || group.tool.shape} V as a floor-correct pocket — floor at the model's ` +
            `−${r3(depth)} mm, walls at ${r3(group.cone.halfAngleDeg)}°, land ${r3(land)} mm per side (the V's own geometry: ` +
            `depth × tan(half)); the land at the surface is the edge-break class, not cut-into`,
        );
      }
      if (irs.length > 0) vRuns.push({ cutterKey: key, ir: irs.reduce((a, b) => concatToolpathIR(a, b)) });
    }
  }

  const ops: PlannedOp[] = [];
  // Advisor's review on ab6b2827: grouped by cutter KEY (a Map), a return visit merges into the
  // SAME file as that cutter's first visit — which, read in that file's own order, frees the
  // part (the contour, appended at the end) before whatever ran in between on the OTHER cutter
  // ever did. Grouped by RUN instead: a new entry starts the moment the step's cutter changes,
  // so the SAME cutter key can appear more than once, in the right place each time.
  const programs: { cutterKey: string; ir: ToolpathIR }[] = [];
  let currentRun: { cutterKey: string; ir: ToolpathIR } | null = null;
  // The manager's #959 ruling: the part's freeing cut (the outer contour) is posted LAST, after
  // every rest/finish/chamfer step that still touches the part. #961 now owns this directly: the
  // contour is its own step, always last in `choice.steps`, and its cutter is priced like any
  // other choice (a RETURN to an earlier cutter is charged a tool change in `choice.cost`, same
  // as the chain's last cutter taking the profile itself when that is cheaper) — nothing to defer
  // or re-plan here, every step (contour included) goes through the SAME loop.
  for (let stepIndex = 0; stepIndex < choice.steps.length; stepIndex++) {
    const step = choice.steps[stepIndex]!;
    // #975 — the V-floor run posts BEFORE the freeing contour (the part must stay captured while
    // its narrow pockets are cut); it is flushed exactly once, at the contour step or at the end
    // when the chain has no contour step.
    if (step.kind === 'contour' && vRuns.length > 0) {
      if (currentRun !== null) programs.push(currentRun);
      currentRun = null;
      ops.push(...vOps);
      programs.push(...vRuns);
      vRuns.length = 0;
    }
    // The SAME key the picker priced it under — a coverage rest's IR depends on its prefix.
    const outcomes = outcomeCache.get(stepKey(step, choice.steps.slice(0, stepIndex)));
    if (outcomes === undefined || outcomes === null) continue; // chooseSequence only chose postable steps
    if (currentRun === null || currentRun.cutterKey !== step.cutter.key) {
      if (currentRun !== null) programs.push(currentRun);
      currentRun = null;
    }
    for (const { id, outcome } of outcomes) {
      const ref = refById.get(id)!;
      // A through hole is cleared like a pocket now (ruling 2), profile-only only when it is too
      // narrow for that to mean anything — 'pocket' either way describes what it does.
      ops.push({ kind: id === 'contour' ? 'contour' : 'pocket', region: ref, outcome });
      currentRun = currentRun === null
        ? { cutterKey: step.cutter.key, ir: outcome.ir }
        : { cutterKey: currentRun.cutterKey, ir: concatToolpathIR(currentRun.ir, outcome.ir) };
    }
  }
  if (currentRun !== null) programs.push(currentRun);
  if (vRuns.length > 0) {
    // No contour step in the chain (a caller that states none): the V run still posts.
    ops.push(...vOps);
    programs.push(...vRuns);
    vRuns.length = 0;
  }

  const offered = [...opts.houseFlats].map((t) => `⌀${cuttingDiameter(t)}`).join(', ');
  // A's review 6622610124, finding 4: a through node's own limiting number was lost (the lookup
  // only checked `pocketsById`) — the SAME sentence either kind of node gets.
  const unreachable = choice.unreachable.filter((id) => !vCovered.has(id)).map((id) => {
    const node = pocketsById.get(id) ?? throughById.get(id);
    const failed = regionFailures.get(id);
    // #959 item 5: a region the chosen chain left out because its planning THREW (the chain that
    // would have cut it ranked lower for that failure) is not a cutter-size limit — say why.
    if (failed !== undefined) return `${id}: not cut — planning failed (${failed.reason})`;
    return node === undefined
      ? `${id}: not cut`
      : `${id}: not cut — needs a cutter ≤ ${node.narrowest.toFixed(2)} mm (house offers ${offered})`;
  });

  // A step that posted with some regions thrown, and a step that failed whole (`choice.unplanned`):
  // either way one entry per thrown region, with its own message; a step that failed without a
  // throw (it planned nothing) keeps the sequence's own entry.
  const unplanned: SequenceStepFailure[] = [];
  for (const step of [...choice.steps, ...choice.unplanned]) {
    const kind = step.kind;
    const cutterKey = 'cutter' in step ? step.cutter.key : step.cutterKey;
    const thrown = stepFailures.get(`${kind}:${cutterKey}:${step.regionIds.join(',')}`) ?? [];
    for (const { id, reason } of thrown) unplanned.push({ kind, cutterKey, regionIds: [id], reason });
    if (thrown.length === 0 && 'reason' in step) unplanned.push(step);
  }
  // A region the chosen chain does not cut at all because every chain that tried it threw (the
  // chain without it then ranks first): its first failure, so its own message is stated too.
  for (const id of choice.unreachable) {
    const failed = regionFailures.get(id);
    if (failed !== undefined && !unplanned.some((f) => f.regionIds.includes(id))) unplanned.push(failed);
  }
  // #962 — AND A THROWN REGION IS STATED when the chosen plan leaves its material standing, even
  // when its candidate lost the ranking. WARNINGS MUST DISCRIMINATE: a REGION the chosen chain
  // covers, which threw only in a candidate that lost, has its material cut — not stated. A REST
  // is different in kind: its mask was computed as leftover standing above the band, so a rest
  // that could not cut is standing-material evidence whatever the chain chose.
  const chosenCovers = new Set(choice.steps.flatMap((step) => step.regionIds));
  for (const [id, failure] of regionFailures) {
    if (failure.kind !== 'rest' && chosenCovers.has(id)) continue;
    if (!unplanned.some((f) => f.regionIds.includes(id))) unplanned.push(failure);
  }

  const notes: string[] = [];
  // #943 (2026-11-05 ruling): the facing stage states where its cut starts, how many passes the
  // probed spread takes, and the clamp when the part top binds. The count mirrors `depthPasses`'
  // own rule (`ceil(total / stepDown)`, the last pass on the floor). `facingDepthMm` is the
  // TARGET depth — one row step below the low point, clamped at the part top — and the skin left
  // above the part top is stated with it.
  if (hasFacing) {
    const mm = (n: number): string => String(Math.round(n * 1000) / 1000);
    const passes = Math.max(1, Math.ceil((facingSpreadMm + facingDepthMm) / opts.stepDownMm - 1e-9));
    const plural = passes === 1 ? 'pass' : 'passes';
    const above = Math.max(0, facingSkinMm - facingDepthMm);
    const clamp = facingSkinMm < opts.stepDownMm - 1e-9;
    const floorWords = clamp
      ? `the part top ${mm(facingDepthMm)} mm below the zero`
      : `${mm(facingDepthMm)} mm below the zero, the lowest point less one row step (${mm(above)} mm above the part top)`;
    notes.push(
      opts.stockProbes === undefined
        ? `facing: no surface measurement — the stated stock top is the cut's start, ${passes} ${plural} of at most ${mm(opts.stepDownMm)} mm to ${floorWords}`
        : `facing: ${opts.stockProbes.count} surface touches, spread ${mm(opts.stockProbes.spreadMm)} mm from the highest point — ${passes} ${plural} of at most ${mm(opts.stepDownMm)} mm to ${floorWords}`,
    );
    if (clamp) {
      notes.push(
        `facing stops at the part top ${mm(facingDepthMm)} mm below the zero — less than one ${mm(opts.stepDownMm)} mm row step; the low side gets a ${mm(facingDepthMm)} mm bite, because one step deeper would cut the design`,
      );
    }
  }
  // #975 — the V floor's own lines: floor, wall angle, and the land per side the flanks take
  // (the V's own geometry, stated; the gate's edge-break class carries the land).
  notes.push(...vNotes);
  // #987 — a synthetic outline (the skirt `closeOpenSheet` added to close an open relief) is not
  // a design edge, so this plan demands no contour op against it at all: an open-surface relief —
  // its edge is the stock beside it; nothing is freed.
  if (tree.contour.synthetic) {
    notes.push('an open-surface relief: its edge is the stock beside it; nothing is freed');
  }
  // #962 — ONE STATEMENT PER CAUSE, NOT A LINE PER REGION: failed regions are grouped by their
  // kind and reason with a count; the per-region detail lives in `unplanned` (machine-readable),
  // never as a wall of operator lines.
  {
    const byCause = new Map<string, { kind: string; reason: string; count: number }>();
    for (const [, failure] of regionFailures) {
      const key = `${failure.kind}: ${failure.reason}`;
      const entry = byCause.get(key) ?? { kind: failure.kind, reason: failure.reason, count: 0 };
      entry.count++;
      byCause.set(key, entry);
    }
    for (const entry of byCause.values()) {
      const plural = entry.count === 1 ? 'region' : 'regions';
      notes.push(`${entry.kind}: ${entry.count} ${plural} could not be cut — ${entry.reason}`);
    }
  }
  // A root pocket's/wide through hole's own mouth assumes facing already cleared the skin
  // (above) — if facing itself is the region that failed, that assumption is now FALSE for
  // every pocket this plan still posted, and nothing re-plans them at the stock top instead.
  // Named here rather than silently trusted, per the advisor's review on this revert.
  if (regionFailures.has('facing')) {
    notes.push(
      'facing failed to plan but the skin is real (see above) — every pocket/through-hole posted still ' +
        'assumes it is gone; their own first pass is deeper than it looks.',
    );
  }
  // #961's own pick between the two freeing-cut options (a return to the covering cutter, or the
  // chain's last cutter taking the profile itself) is priced in `choice.cost` either way; stated
  // here only when it actually cost something — a plain "no extra change" pick is not a finding.
  if (choice.freeing !== null && choice.freeing.extraToolChange) {
    const lastChainCutter = [...choice.steps].reverse().find((s) => s.kind !== 'contour')?.cutter.key ?? 'the last step';
    notes.push(
      choice.freeing.lastCutterEligible
        ? `the freeing cut (contour) is posted LAST on ${choice.freeing.cutterKey} — a RETURN tool change back to it after ${lastChainCutter}, priced in the cycle (taking the profile with ${lastChainCutter} was dearer)`
        : `the freeing cut (contour) is posted LAST on ${choice.freeing.cutterKey} — a RETURN tool change back to it after ${lastChainCutter}, priced in the cycle; ${lastChainCutter} cannot take the profile (flute or stated shape)`,
    );
  }

  const sequence: SequencedCutter[] = choice.cost.entries.map((entry) => {
    // #927's terms summed over every RUN this cutter appears in (almost always one; a return
    // visit for the freeing cut is two) — concatenating them for `estimateCycleTerms` is only
    // for this one estimate, not a claim they post as a single file (`programs` above is that).
    const cutterRuns = programs.filter((p) => p.cutterKey === entry.cutterKey).map((p) => p.ir);
    const ir = cutterRuns.length === 0 ? undefined : cutterRuns.reduce((a, b) => concatToolpathIR(a, b));
    const terms: CycleTerms = ir === undefined
      ? { movesSeconds: 0, entrySeconds: 0, spinUpSeconds: 0, totalSeconds: 0 }
      : estimateCycleTerms(ir, opts.rapid);
    const stepCutter = choice.steps.find((s) => s.cutter.key === entry.cutterKey)?.cutter;
    return {
      cutterKey: entry.cutterKey,
      cost: {
        terms,
        toolChangeSeconds: entry.toolChangeSeconds,
        totalSeconds: terms.totalSeconds + entry.toolChanges * entry.toolChangeSeconds,
        toolChanges: entry.toolChanges,
      },
      pinned: stepCutter?.pinned ?? false,
      house: stepCutter?.house ?? false,
    };
  });

  // #975 — a V that only the floor run uses is not in `choice.cost.entries`; its run still prices
  // into the cycle, so it gets its own sequence entry (one tool change in). A V already in the
  // chain — the tray's chamfer, which also breaks the rims — needs nothing here: its entry's own
  // terms already sum over every run of its key, the floor run included.
  const sequenced = new Set(sequence.map((s) => s.cutterKey));
  for (const run of programs) {
    if (sequenced.has(run.cutterKey)) continue;
    if (choice.steps.some((s) => s.cutter.key === run.cutterKey)) continue;
    sequenced.add(run.cutterKey);
    const terms = estimateCycleTerms(run.ir, opts.rapid);
    sequence.push({
      cutterKey: run.cutterKey,
      cost: {
        terms,
        toolChangeSeconds: opts.toolChangeSeconds,
        totalSeconds: terms.totalSeconds + opts.toolChangeSeconds,
        toolChanges: 1,
      },
      pinned: false,
      house: true,
    });
  }

  return { ops, programs, sequence, unreachable, notes, choice, unplanned };
}

/**
 * #959's curved half — THE RULING'S PIPELINE, one op per stage, per `RemainderRegion` and rim.
 *
 * The manager's ruling on the curved regions: the FLAT Z-steps every curved region to its own CL
 * surface, leaving one BAND above it (`bandMm` — the finish's promised scallop/stock-to-leave);
 * where that band is all the finish needs (the shallow ground), the flat's own band step-over is
 * the whole story, and where the surface is steep the flat roughs to the CL instead of trying to
 * follow it. The BALL then runs ONE final level over the region (a single pass at the region's
 * depth, not another Z-staircase) to take the band; a PENCIL pass follows each crease the ball's
 * CL surface leaves; and where a smaller flat is offered (`restFlat`), a REST pass clears by CL
 * difference between the two flats before the ball. Every rim the tree found is broken by the V
 * at the job's stated edge break. The FIGS' goal path uses this same pipeline (`rough` first).
 *
 * These ops are entered into the acceptance spec in the same commit (the manager's rule after
 * E's a46f0358 run): an op that is real is planned through the product path and measured there.
 */
export interface PlanCurvedOptions {
  /** The mesh the tree's regions index into (`ModelPlanInput.geometry`). */
  geometry: FeatureSource;
  /** #982 — extra remainder-style regions the curved pipeline also plans (the no-flat path's
   *  synthetic pocket floors). Absent → the tree's own remainder only. */
  extraRegions?: RemainderRegion[];
  /** The real Clipper2 offset, or a test fake — the pocket op's own contract. */
  offset: OffsetFn;
  /**
   * The three tools the curved pipeline uses: the flat roughs, the ball finishes, the V breaks
   * rims. Absent (#869/#966): no rough at all — the ball alone takes each remainder region's
   * whole depth in one pass, and the skin stage (which only a flat can surface-follow) is not
   * planned either. Every existing caller passes a flat; this keeps that path byte-identical.
   */
  flat?: Tool;
  /** The ball. Absent is allowed when the tree has no remainder to finish — the region loop refuses by name the moment one needs it. */
  ball?: Tool;
  /**
   * #965 (the review session's ruling, item 3.1) — THE REST BALL: a smaller ball whose stated reach
   * covers the remainder's depth (the vendor's long ⌀1). It runs the finish's machinery a second
   * time over the cells where the main ball's OWN CL still stands above the design by more than the
   * band, at its own radius' footprint — the sequence's rest rule, no new op.
   */
  restBall?: Tool;
  /** The V. Absent is allowed when the job states no edge break — the rim stage is then not planned at
   * all (the property specs' house holds no V and asks for none). */
  vbit?: Tool;
  /** An optional smaller flat for the rest pass by CL difference. */
  restFlat?: Tool;
  /** #982 — the finish cutter when the set holds no ball: the smallest flat that reaches.
   *  Absent with `ball` absent → the primary flat. */
  finishFlat?: Tool;
  stepDownMm: number;
  /** The ROUGH's stock-to-leave band, mm — what the flat leaves standing for the ball. */
  bandMm: number;
  /**
   * The BALL's promised cusp, mm (#964 finding). Defaults to `bandMm` — the old conflation — but
   * F's coverage line counts anything standing more than 0.1 mm above the goal as leftover, so a
   * finish leaving the rough's 0.3 mm band as its own scallop reads as an uncovered surface even
   * where every cell was swept. `planModelCam` passes the job's finish tolerance here; the rough's
   * band stays its own number.
   */
  finishScallopMm?: number;
  /**
   * #960 — THE FLAT/BALL THRESHOLD, degrees. A parameter while the picture decides the value
   * (equal-cusp 1.9° vs vendor-like 7.1°); the constant is shared with C's #959 skin pass.
   */
  flatFinishMaxSlopeDeg?: number;
  /** The rings' spacing; absent → the flat's own radius. */
  stepOverMm?: number;
  /** `flat`'s own feed/plunge — kept as the fallback every tool used before the review's finding
   * below named it: the ball and the V each cut at a DIFFERENT diameter and want their own
   * catalogue row, not the flat's. */
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  rapid: RapidEstimate;
  /** `flat`'s own spindle RPM — see {@link feeds}. */
  spindleRpm: number;
  /**
   * THE REVIEW'S FINDING (item 8): every cutter in the curved pipeline — rough's flat, rest's
   * smaller flat, the ball, the V — was fed and spun at `feeds`/`spindleRpm` ABOVE, which
   * `planModelCam` resolves for the PRIMARY FLAT ONLY. A ball nose and a V cut at their own
   * diameters, and the house catalogue has their own rows; absent, the resolver falls back to
   * `feeds`/`spindleRpm` here, so every existing caller that never passes it keeps the old
   * (flat-wide) numbers unchanged.
   */
  cutParamsFor?: (tool: Tool) => CutParams;
  air: boolean;
  safeZMm: number;
  hopZMm: number;
  /** The job's own edge break — the chamfer's depth (A's R3). */
  edgeBreak: EdgeBreakSpec;
  toolNumberFor: (tool: Tool) => number;
  startFrom?: readonly [number, number];
  /** #959 ruling: `'on'` puts the skin back on the facing stage; absent/`'off'` gives it to `skin`. */
  facing?: 'off' | 'on';
  /** The shared flat/ball slope parameter (#959); absent → `FLAT_SURFACE_MAX_SLOPE_DEG`'s provisional value. */
  flatSurfaceMaxSlopeDeg?: number;
}

export interface PlanCurvedResult {
  ops: PlannedOp[];
  /** Statements the plan owes the operator: nothing here is silent. */
  notes: string[];
  /** `SetupPlan.clGrid`'s entries — every CL surface this pipeline sampled, one per cutter that built one. */
  clGrid: { cutterKey: string; toleranceMm: number; minSpacingMm: number; maxSpacingMm: number }[];
  /** #959 item 5 — every stage that threw, per region/rim, and the stages a failed rough skipped. */
  unplanned: SequenceStepFailure[];
}

function regionRefOf(id: string, kind: RegionKind, footprint: Polygons, topZ: number, bottomZ: number): RegionRef {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of footprint) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    id,
    kind,
    bounds: { min: [minX, minY], max: [maxX, maxY] },
    topZ,
    bottomZ,
    obstacles: [],
    regionClearanceZ: Math.max(0, topZ) + 5,
  };
}

export function planCurvedForTree(tree: FeatureTree, opts: PlanCurvedOptions): PlanCurvedResult {
  const ops: PlannedOp[] = [];
  const notes: string[] = [];
  // THE CURVED PROPERTY SEEDS FOUND THIS: some stages legitimately have nothing to cut (the pencil
  // on a surface with no creases, a rough whose mask is empty), and an op that emitted no moves was
  // still pushed — then posted as a program `postZ1` refuses ("no operation with any moves").
  // An op with no moves is not a program: it is dropped here WITH A NOTE, so the plan stays honest
  // rather than posting an empty file. A stage that SHOULD have cut and did not still shows up as
  // a coverage failure at the goal check — the drop does not hide it.
  // #962 — THE OPERATOR SEES ONE STATEMENT PER CAUSE, NOT A LINE PER REGION (the standing rule
  // that warnings must discriminate): an empty stage and a finish's own slope wording are
  // accumulated per kind and stated once, with a count and the deepest ground among the regions.
  const emptyStages = new Map<PlannedOp['kind'], { count: number; deepestMm: number }>();
  const finishKinds = new Map<string, { count: number; minSlope: number; maxSlope: number }>();
  const pushStage = (kind: PlannedOp['kind'], ref: RegionRef, outcome: OpOutcome): void => {
    if (outcome.ir.operations.some((operation) => operation.moves.length > 0)) {
      ops.push({ kind, region: ref, outcome });
      return;
    }
    const entry = emptyStages.get(kind) ?? { count: 0, deepestMm: 0 };
    entry.count++;
    entry.deepestMm = Math.max(entry.deepestMm, Math.abs(ref.topZ - ref.bottomZ));
    emptyStages.set(kind, entry);
  };
  // #959 item 5 — A THROWING STAGE DOES NOT SINK THE PLAN: each stage (its CL surface included) is
  // caught per region/rim and stated in `unplanned` in `sequence.ts`'s step-failure shape; the
  // other stages and regions still plan. Returns whether the stage planned.
  const unplanned: SequenceStepFailure[] = [];
  const attempt = (kind: PlannedOp['kind'], cutter: Tool, ref: RegionRef, plan: () => OpOutcome): boolean => {
    try {
      pushStage(kind, ref, plan());
      return true;
    } catch (err) {
      unplanned.push({ kind, cutterKey: cutterKeyOf(cutter), regionIds: [ref.id], reason: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };
  // #962 — ONE bins build for the whole plan's top-surface queries (the rim filter, the 4a mask
  // and every op's material field share it), and THE DESIGN'S TOP at (x, y) in this plan's datum:
  // the answer the material fields need past their own sampled reach, where a wall or land beside
  // a region can stand HIGHER than the region's own top. The mesh's top where it answers; null
  // where it is silent (the ops then fall back to the stock top, 0 in this datum).
  let surfaceBins: TriangleBins | null = null;
  const binsForMask = (): TriangleBins => (surfaceBins ??= buildTriangleBins(opts.geometry.triangles));
  const designTopAt = (x: number, y: number): number | null => {
    const top = topSurfaceAt(binsForMask(), x, y);
    return top === null ? null : top - z0;
  };
  const clGrid: PlanCurvedResult['clGrid'] = [];
  const noteGrid = (cutter: Tool, surface: ReturnType<typeof clSurface>): void => {
    const key = cutterKeyOf(cutter);
    if (clGrid.some((entry) => entry.cutterKey === key)) return;
    clGrid.push({
      cutterKey: key,
      toleranceMm: surface.toleranceMm,
      minSpacingMm: surface.minSpacingMm,
      maxSpacingMm: surface.maxSpacingMm,
    });
  };
  // THE REVIEW'S FINDING (plan.ts:1033, rough.ts:241, finish.ts:164, chamfer.ts:86): the curved
  // half took the tree's MESH-ABSOLUTE Z values straight through, while `planPocketsForTree`
  // rebases every Z it hands an op by -stockTop. On a part recognised at a non-zero stockTop every
  // curved and rim move posted that far off the stock — silently, because the IR was internally
  // consistent (the red-first spec at stockTop 10 measured feeds at z = 15). ONE datum here too:
  // IR Z 0 is the STOCK top, which the post's `probed-top-face` convention and safeZ/hopZ assume.
  const z0 = tree.frame.stockTop;
  const rebaseZ = (z: number): number => z - z0;
  // The CL heights come from the MESH, so they are mesh-absolute too — the drop ANSWER is shifted
  // here, at the plan's own datum, rather than teaching every op a stockTop it would each have to
  // apply the same way. (The red-first spec's first fix moved feeds to z = 10.66: the region's Z
  // was rebased but the surface the ball followed was not.)
  const shiftSurface = (surface: ReturnType<typeof clSurface>): ReturnType<typeof clSurface> => ({
    ...surface,
    dropCutter: (x: number, y: number) => {
      const z = surface.dropCutter(x, y);
      return z === null ? null : z - z0;
    },
  });
  // #869/#966 — NO ROUGH AT ALL is a real state (ball alone): the sampling pitch that would have
  // come from the flat's own radius falls back to the ball's, so `clSurface`'s own sampling still
  // has a sensible step when there is no flat to size it against.
  const stepOverSizer = opts.flat ?? opts.ball;
  const cuts: CutParams = {
    rpm: opts.spindleRpm,
    feed: opts.feeds.feedMmPerMin,
    plungeFeed: opts.feeds.plungeFeedMmPerMin,
    stepDown: opts.stepDownMm,
    stepOver: opts.stepOverMm ?? (stepOverSizer === undefined ? 1 : cuttingDiameter(stepOverSizer) ?? 1) / 2,
    peck: 0,
    air: opts.air,
  };
  // THE REVIEW'S FINDING (item 8): every one of these calls used `cuts` — the FLAT's own resolved
  // numbers — for the ball and the V too. `cutParamsFor`, when the caller supplies it, resolves
  // each tool's OWN catalogue row; absent, this falls back to exactly `cuts`'s own shape (the flat
  // feeding every tool, unchanged for every existing caller that never passes it).
  const paramsFor = (tool: Tool): CutParams =>
    opts.cutParamsFor?.(tool) ?? {
      rpm: opts.spindleRpm,
      feed: opts.feeds.feedMmPerMin,
      plungeFeed: opts.feeds.plungeFeedMmPerMin,
      stepDown: opts.stepDownMm,
      stepOver: opts.stepOverMm ?? (cuttingDiameter(tool) ?? 1) / 2,
      peck: 0,
      air: opts.air,
    };
  const feedsOf = (p: CutParams): { feedMmPerMin: number; plungeFeedMmPerMin: number } => ({
    feedMmPerMin: p.feed,
    plungeFeedMmPerMin: p.plungeFeed,
  });

  for (const region of [...tree.remainder, ...(opts.extraRegions ?? [])]) {
    const ball = opts.ball;
    // #982 (the review session's ruling) — NO BALL IN THE SET: the flat finishes the whole curved
    // remainder as a flat-raster, the creases via the rest with the smallest flat. Never a throw.
    const finishCutter = ball ?? opts.finishFlat ?? opts.flat;
    if (finishCutter === undefined) {
      throw new Error(
        `cam/model/plan: the remainder region "${region.id}" needs a cutter to finish and the call states no ball, no finish flat and no flat`,
      );
    }
    const base = { ...region, zTop: rebaseZ(region.zTop), zBottom: rebaseZ(region.zBottom) };
    const ref = regionRefOf(region.id, 'curved', base.footprint, base.zTop, base.zBottom);
    // THE REVIEW'S SAFETY FINDING: the finish's outer footprint is grown by the ball's radius, and
    // nothing roughed that ring — the ball would take a full-width, full-depth bite of stock that
    // no rough had touched. The flat roughs the SAME grown region first (its own drop-cutter rests
    // against the part's flank over exactly that ring), leaving the band the ball is allowed to
    // take; both stages then see one region.
    //
    // The outer-surface test is the footprint's LARGEST ring against the contour's own: the
    // figure's remainder is an ANNULUS (two rings, outer ring = the silhouette), a summed area or a
    // single-ring count both rejected it and its coverage fell back to 87.77 %.
    const finishRadius0 = (cuttingDiameter(finishCutter) ?? 0) / 2;
    const outerMost = (polys: Polygons): number => Math.max(0, ...polys.map(ringAreaOf));
    const contourRing = outerMost(tree.contour.outline);
    const isOuterSurface =
      finishRadius0 > 0 && contourRing > 0 && Math.abs(outerMost(region.footprint) - contourRing) <= 0.01 * contourRing;
    const grownFootprint = isOuterSurface ? opts.offset(region.footprint, finishRadius0) : [];
    const roughRegion = grownFootprint.length > 0 ? { ...base, footprint: grownFootprint } : base;
    const roughRef = roughRegion === base
      ? ref
      : regionRefOf(region.id, 'curved', roughRegion.footprint, base.zTop, base.zBottom);
    // 1. THE FLAT Z-steps the region to its own CL, leaving the band — #869/#966: absent (ball
    // alone, no rough tool chosen for this goal), there is nothing to pre-clear and no band to
    // leave; the ball takes the region's own full depth in one pass below (step 3's `depth`
    // already computes that when there is no rough to leave a thinner one).
    //
    // #959 item 5: the rough is this region's PRIMARY — a rest, finish or pencil on stock it never
    // cleared would take a full-depth bite — so when it throws, the region's later stages are
    // stated as skipped, not planned.
    const flat = opts.flat;
    let prevCl: ReturnType<typeof clSurface> | undefined;
    const restClSink: { surface?: ReturnType<typeof clSurface> } = {};
    if (flat !== undefined) {
      const flatCl: { surface?: ReturnType<typeof clSurface> } = {};
      const roughed = attempt('rough', flat, ref, () => {
        const clFlat = shiftSurface(clSurface(opts.geometry, roughRegion, flat, cuts.stepOver));
        flatCl.surface = clFlat;
        noteGrid(flat, clFlat);
        return rough({
          cutter: flat,
          region: roughRegion,
          regionRef: roughRef,
          clSurface: clFlat,
          stepDownMm: opts.stepDownMm,
          stockToLeaveMm: opts.bandMm,
          // #869/#966 — `opts.stepOverMm` is sized for `primary` (the pockets' own flat, the plan-
          // level default); `flat` (this goal's own `curvedRoughTool`) can be a SMALLER tool, and
          // handing it a step-over bigger than its own radius is exactly the defect the rest
          // stage's own `Math.min` guard (below, the "rest flat is SMALLER than the primary" note)
          // already exists to prevent — `pocketLoops` refuses it by name ('step-over exceeds the
          // tool radius'). Same guard, same reason, here.
          stepOverMm: opts.stepOverMm === undefined
            ? undefined
            : Math.min(opts.stepOverMm, (cuttingDiameter(flat) ?? 0) / 2),
          feeds: feedsOf(paramsFor(flat)),
          offset: opts.offset,
          // #982 — the ball-as-rough fallback (no flat in the set): every cut point must lie
          // inside the region's own footprint, and the skim's standing field must say so too.
          ...(opts.ball !== undefined && opts.ball === opts.flat ? { cutPointInRegion: true } : {}),
          safeZMm: opts.safeZMm,
          hopZMm: opts.hopZMm,
          toolNumber: opts.toolNumberFor(flat),
          spindleRpm: paramsFor(flat).rpm,
          air: opts.air,
          rapid: opts.rapid,
          materialTopAt: designTopAt,
          stockTopZMm: 0,
          ...(opts.startFrom === undefined ? {} : { startFrom: opts.startFrom }),
        });
      });
      prevCl = flatCl.surface;
      if (!roughed || prevCl === undefined) {
        const skipped: [PlannedOp['kind'], Tool][] = [
          ...(opts.restFlat === undefined ? [] : [['rest', opts.restFlat] as [PlannedOp['kind'], Tool]]),
          ['finish', finishCutter] as [PlannedOp['kind'], Tool],
          ...(ball === undefined ? [] : [['pencil', ball] as [PlannedOp['kind'], Tool]]),
        ];
        for (const [kind, cutter] of skipped) {
          unplanned.push({ kind, cutterKey: cutterKeyOf(cutter), regionIds: [region.id], reason: `not planned: the rough of "${region.id}" failed` });
        }
        continue;
      }
    }

    // 2. REST BY CL DIFFERENCE, when the caller offers a smaller flat: the band the previous
    //    cutter left standing, where the smaller one can reach. Never offered without a rough —
    //    there is nothing for a rest to clean up.
    const restFlat = flat === undefined ? undefined : opts.restFlat;
    if (restFlat !== undefined && prevCl !== undefined) {
      // B's review of `0461df01`: the rest stage was left on the MESH-ABSOLUTE region and an
      // unshifted surface — `depthPasses` reads `opts.region.zTop/zBottom`, so at stockTop != 0 the
      // rebased levels sat above every mesh-absolute CL value and the mask came out EMPTY (a rest
      // pass silently missing, not merely off-datum). Both go through the plan's one datum here:
      // the region is `base`, the surface is shifted like the flat's.
      attempt('rest', restFlat, ref, () => {
        const restCl = shiftSurface(clSurface(opts.geometry, base, restFlat, cuts.stepOver));
        restClSink.surface = restCl;
        noteGrid(restFlat, restCl);
        return rest({
          cutter: restFlat,
          region: base,
          regionRef: ref,
          prevClSurface: prevCl,
          clSurface: restCl,
          stepDownMm: opts.stepDownMm,
          stockToLeaveMm: opts.bandMm,
          // The rest flat is SMALLER than the primary: the plan-level step-over is the primary's
          // (half a ⌀6 is 3 mm), and handing that to a ⌀3.175 rest is more than its own radius —
          // `pocketLoops` refuses it by name ('step-over 3 mm exceeds the 1.5875 mm tool radius').
          // The rest takes the smaller of the stated step-over and its own radius.
          stepOverMm: opts.stepOverMm === undefined
            ? undefined
            : Math.min(opts.stepOverMm, (cuttingDiameter(restFlat) ?? 0) / 2),
          feeds: feedsOf(paramsFor(restFlat)),
          offset: opts.offset,
          safeZMm: opts.safeZMm,
          hopZMm: opts.hopZMm,
          toolNumber: opts.toolNumberFor(restFlat),
          spindleRpm: paramsFor(restFlat).rpm,
          air: opts.air,
          rapid: opts.rapid,
          ...(opts.startFrom === undefined ? {} : { startFrom: opts.startFrom }),
        });
      });
    }

    // ITEM 4a — THE FINISH'S MASK: leftover = the flat's CL − the design > band, dilated by the
    // ball's footprint (its centre just outside the leftover still cuts into it, and just outside
    // the part still finishes the skirt its flank holds).
    //
    // #970 (the manager's ruling, #965's bisect) — THE EXACT PER-POINT RULE IS THE MASK'S RULE.
    // cd5ec056 replaced these queries with a leftover grid read by `Math.round`, which drops the
    // leftover between its samples: on the panther's 74–89° flanks the finish stopped running
    // (coverage 73.17 → 49.09 %), and MASK-EQUIV showed the grid cannot be made conservative at
    // its pitch (9,483 of 23,058 points dropped at 0.5 mm, 0 over-included; a 0.1 mm grid is still
    // 2.5 points short). Correct cuts before speed: the mask asks the exact CL at the point and at
    // its eight footprint neighbours, as it did before cd5ec056. The skimming grid that change
    // also made for `skin()` is untouched — that one carries its own read (#970's 6b35d6e9).
    const finishBand = opts.finishScallopMm ?? opts.bandMm;
    const flatAbs = (x: number, y: number): number | null => {
      if (prevCl === undefined) return null;
      const v = prevCl.dropCutter(x, y);
      return v === null ? null : v + z0;
    };
    const restAbs = (x: number, y: number): number | null => {
      const surface = restClSink.surface;
      if (surface === undefined) return null;
      const v = surface.dropCutter(x, y);
      return v === null ? null : v + z0;
    };
    const leftoverAbove = (x: number, y: number): boolean => {
      const f = flatAbs(x, y);
      const r = restAbs(x, y);
      const flatZ = f === null ? r : r === null ? f : Math.min(f, r);
      if (flatZ === null) return false;
      const design = topSurfaceAt(binsForMask(), x, y);
      if (design === null) return false;
      return flatZ - design > finishBand;
    };
    const ballRadiusForMask = (cuttingDiameter(finishCutter) ?? 0) / 2;
    const maskRing: [number, number][] = [];
    for (let d = 0; d < 8; d++) {
      const a = (d * Math.PI) / 4;
      maskRing.push([Math.cos(a) * ballRadiusForMask, Math.sin(a) * ballRadiusForMask]);
    }
    // #869/#966 — NO ROUGH, NO MASK: with no flat ahead of it the ball has nothing to compare
    // against, and nothing to mask against either — it takes the whole region, as `finish()`'s own
    // `maskCells === undefined` case already means ("the plan admits every point of every row").
    const maskCells = flat === undefined ? undefined : (x: number, y: number): boolean => maskCellsExact(leftoverAbove, maskRing, x, y);

    // 3. THE BALL'S ONE FINAL LEVEL: a single pass at the region's depth takes the band.
    //
    // THE CURVED PROPERTY SEEDS FOUND THIS: the ball was dropped onto `finishCl` — the FLAT's CL
    // surface (or the rest flat's) — so it rode the rough's own clearance instead of the design.
    // On the sloped seed a flat ⌀6 held tangent to an 11° ramp stands tan(11°)·3 ≈ 0.58 mm above
    // the surface at its downhill edge, and the ball followed that: 0.58 mm of material left over
    // the whole pocket. The finish and the pencil follow the BALL'S OWN CL surface; the flat's
    // stays the rough's (and the rest pass's) reference, which is what that CL difference is.
    // THE FIGURE SEEDS FOUND THIS: the raster confined the ball's CENTRE to the region's own
    // footprint, so a convex flank — the figure's bell, whose widest point is at its base — stood
    // in its own shadow: any ball centred inside the part had to rest on the higher shoulder
    // within its radius, and the skirt below read as 12.2 % left standing. A ball cuts a shoulder
    // from OUTSIDE it, so the finish runs on the same region the rough just cleared (grown, when
    // the region is the part's own outer surface). The CL surface is sampled on it too — dropping
    // a row against a surface that does not reach its own endpoints is what `dropRow` refuses.
    // The ball's CL surface is shared by the finish and the pencil; built inside whichever stage
    // reaches it first, so its own failure is that stage's.
    let clBallCache: ReturnType<typeof clSurface> | undefined;
    const clBall = (): ReturnType<typeof clSurface> => {
      if (clBallCache === undefined) {
        clBallCache = shiftSurface(clSurface(opts.geometry, roughRegion, finishCutter, cuts.stepOver));
        noteGrid(finishCutter, clBallCache);
      }
      return clBallCache;
    };
    // #869/#966, SAFETY (the review's finding, item 1): "the ball alone" never meant one pass at
    // the region's own full depth into untouched stock — that is the exact full-depth bite this
    // file's own #959 item 5 and "THE REVIEW'S SAFETY FINDING" (above) exist to prevent. WITH a
    // rough ahead, one level is enough (it already stepped down to within the band). With NONE,
    // the ball must step down on its OWN row, same as a rough would, over as many levels as the
    // region's depth needs.
    const depth = flat === undefined ? paramsFor(ball ?? finishCutter).stepDown : Math.max(opts.stepDownMm, base.zTop - base.zBottom);
    // #960 — FLAT OR BALL BY THE REGION'S OWN SLOPE, with the threshold stated on the plan; the
    // constant is a parameter (shared with C's #959 skin pass) while the picture decides 1.9° vs 7.1°.
    // #982 — with no ball the slope limit is lifted: the flat raster covers the WHOLE remainder.
    const finishKind: FinishKind = ball === undefined
      ? 'flat-raster'
      : finishKindFor(roughRegion, opts.geometry.triangles, opts.flatFinishMaxSlopeDeg ?? FLAT_SURFACE_MAX_SLOPE_DEG);
    {
      const entry = finishKinds.get(finishKind) ?? { count: 0, minSlope: Infinity, maxSlope: -Infinity };
      entry.count++;
      entry.minSlope = Math.min(entry.minSlope, roughRegion.slopeDeg[0]);
      entry.maxSlope = Math.max(entry.maxSlope, roughRegion.slopeDeg[1]);
      finishKinds.set(finishKind, entry);
    }
    attempt('finish', finishCutter, ref, () => finish({
      cutter: finishCutter,
      region: roughRegion,
      regionRef: roughRef,
      clSurface: clBall(),
      kind: finishKind,
      mesh: opts.geometry.triangles,
      scallopMm: opts.finishScallopMm ?? DEFAULT_FINISH_SCALLOP_MM,
      ...(ball === undefined ? { flatFallback: true } : {}),
      maskCells,
      // #962 — the material field's answers past the region's own reach (the linker's disc and the
      // down-leg floor reach up to a cutter radius outside it): the goal/mesh top there, which is
      // the honest bound a wall or land beside a low region demands, and the stock top where the
      // mesh is silent. The region's own zTop is NOT that bound — a neighbouring wall can out-top
      // it, and a rapid floored at zTop would run into the wall. In this datum (every Z rebased by
      // −stockTop) the stock top is 0.
      materialTopAt: designTopAt,
      stockTopZMm: 0,
      stepDownMm: depth,
      feeds: feedsOf(paramsFor(finishCutter)),
      safeZMm: opts.safeZMm,
      hopZMm: opts.hopZMm,
      toolNumber: opts.toolNumberFor(finishCutter),
      spindleRpm: paramsFor(finishCutter).rpm,
      air: opts.air,
      rapid: opts.rapid,
    }));

    let restBallCl: ReturnType<typeof clSurface> | undefined;
    // 3b. THE REST BALL (#965, the review session's ruling item 3.1): where the ball's OWN CL still
    // stands above the design by more than the band — its fillet at a wall foot, the slots its
    // radius cannot enter — a smaller ball whose stated reach covers this region runs the same
    // finish machinery at its own CL, restricted to that mask and to its own radius' footprint.
    // The sequence's rest rule, no new op; the reach is the one that qualified it.
    if (opts.restBall !== undefined) {
      const restBallTool = opts.restBall;
      const ballMaskRadiusMm = (cuttingDiameter(restBallTool) ?? 0) / 2;
      const restRing: [number, number][] = [];
      for (let d = 0; d < 8; d++) {
        const a = (d * Math.PI) / 4;
        restRing.push([Math.cos(a) * ballMaskRadiusMm, Math.sin(a) * ballMaskRadiusMm]);
      }
      // The ball's own CL is this op's datum; the design's top is the mesh's absolute Z — the
      // same +z0 conversion the flat's own leftover rule makes above.
      const afterBallLeftover = (x: number, y: number): boolean => {
        const b = clBall().dropCutter(x, y);
        if (b === null) return false;
        const design = topSurfaceAt(binsForMask(), x, y);
        if (design === null) return false;
        return b + z0 - design > finishBand;
      };
      attempt('rest', restBallTool, ref, () => finish({
        cutter: restBallTool,
        region: roughRegion,
        regionRef: roughRef,
        clSurface: (restBallCl = shiftSurface(clSurface(opts.geometry, roughRegion, restBallTool, cuts.stepOver))),
        kind: finishKind,
        mesh: opts.geometry.triangles,
        scallopMm: opts.finishScallopMm ?? DEFAULT_FINISH_SCALLOP_MM,
        maskCells: (x, y) => maskCellsExact(afterBallLeftover, restRing, x, y),
        materialTopAt: designTopAt,
        stockTopZMm: 0,
        stepDownMm: depth,
        feeds: feedsOf(paramsFor(restBallTool)),
        safeZMm: opts.safeZMm,
        hopZMm: opts.hopZMm,
        toolNumber: opts.toolNumberFor(restBallTool),
        spindleRpm: paramsFor(restBallTool).rpm,
        air: opts.air,
        rapid: opts.rapid,
      }));
    }

    // 3c. THE CREASE PASS (#965, the review session's step 2; the vendor's own figure method): a
    // conical engraver riding the creases with its OWN CL, after the rest ball. Admitted only
    // where `reach()`'s own rule allows — the V's flank angle against the region's steepest slope
    // (clsurface.ts `reach()`); a region the V cannot descend is STATED by name in `unplanned`,
    // never silently skipped.
    if (opts.vbit !== undefined && (opts.vbit.shape === 'chamfer' || opts.vbit.shape === 'engraving')) {
      const vTool = opts.vbit;
      // C's review of the crease pass (2026-11-05): PRE-GATE on a cheap valley test over the
      // PREVIOUS cutter's own CL — a region with no crease cell gets no pencil grid and no line at
      // all. The gate samples at 0.5 mm, 25x coarser than the pencil: it exists to skip regions,
      // not to judge cells.
      // shortcut: the gate is a PROXY — it reads the PREVIOUS cutter's CL (the ball, or the rest
      // ball), so a crease too narrow for that cutter to register, or finer than the 0.5 mm gate
      // grid, is not pre-detected and its region is skipped (the #983 wall-foot class); upgrade
      // the gate pitch if a job's creases need it.
      const vPitchGate = Math.max(0.5, (cuttingDiameter(vTool) ?? 0) / 4);
      const prevClGate = restBallCl ?? clBall();
      if (hasValley(prevClGate, { min: roughRef.bounds.min, max: roughRef.bounds.max }, vPitchGate)) {
      // The V's own CL and the previous (rest ball's) CL: the leftover depth at a crease is the
      // material between them — the number the crease rule's width test is stated at.
      const vCl = shiftSurface(clSurface(opts.geometry, roughRegion, vTool, cuts.stepOver));
      const prevCl = restBallCl ?? clBall();
      const vPitch = Math.min(0.5, Math.max(0.1, (cuttingDiameter(vTool) ?? 0) / 4));
      let creaseAdmitted = 0;
      let creaseRefused = 0;
      attempt('pencil', vTool, ref, () => {
        const out = pencil({
          cutter: vTool,
          region: roughRegion,
          regionRef: roughRef,
          clSurface: vCl,
          gridPitchMm: vPitch,
          admitCrease: (i, j, z, leftSlopeDeg, rightSlopeDeg) => {
            const x = roughRef.bounds.min[0] + i * vPitch;
            const y = roughRef.bounds.min[1] + j * vPitch;
            const prev = prevCl.dropCutter(x, y);
            const depth = prev === null ? 0 : Math.max(0, prev - z);
            const fits = creaseFits(vTool, { leftSlopeDeg, rightSlopeDeg, depthMm: depth });
            if (fits.reachable) creaseAdmitted++;
            else creaseRefused++;
            return fits.reachable;
          },
          feeds: feedsOf(paramsFor(vTool)),
          safeZMm: opts.safeZMm,
          hopZMm: opts.hopZMm,
          toolNumber: opts.toolNumberFor(vTool),
          spindleRpm: paramsFor(vTool).rpm,
          air: opts.air,
          rapid: opts.rapid,
        });
        const emitted = out.ir.operations.some((operation) => operation.moves.length > 0);
        if (!emitted) {
          // Stated, never a silent skip: no crease on this region passed the admission.
          unplanned.push({
            kind: 'pencil',
            cutterKey: cutterKeyOf(vTool),
            regionIds: [ref.id],
            reason: `the crease pass was admitted at no crease this region (${creaseAdmitted} admitted, ${creaseRefused} refused by the crease rule) — nothing emitted`,
          });
        }
        return out;
      });
      }
    }

    // 4. PENCIL along the creases the ball's own CL surface leaves — no ball, no pencil: the
    // creases are the rest rule's job (the smallest flat, above).
    if (ball !== undefined) attempt('pencil', ball, ref, () => pencil({
      cutter: ball,
      region,
      regionRef: ref,
      clSurface: clBall(),
      feeds: feedsOf(paramsFor(ball)),
      safeZMm: opts.safeZMm,
      hopZMm: opts.hopZMm,
      toolNumber: opts.toolNumberFor(ball),
      spindleRpm: paramsFor(ball).rpm,
      air: opts.air,
      rapid: opts.rapid,
    }));
  }

  // THE SKIN PASS (#959, 2026-11-05 ruling): the stock stands above the part top and the job asks
  // for no facing — the FLAT takes the skin, surface-following (C6's Makera T1 shape), capped at
  // its own step-down and gated by the shared slope parameter. Facing `'on'` keeps that stage
  // instead (the operator option).
  const skinMm = z0 - tree.top.z;
  if (skinMm > 1e-6 && (opts.facing ?? 'off') !== 'on' && opts.flat === undefined) {
    // #869/#966 — NO FLAT, NO SKIN: the skin is a flat's own surface-following pass (`skin()`
    // only a flat runs); a ball-alone goal states the skin standing rather than removing it with
    // the wrong tool. `facing: 'on'` is the operator's other route to the same stock.
    notes.push(
      `${String(Math.round(skinMm * 1000) / 1000)} mm of skin stands above the part top — no rough tool is chosen for ` +
        'this goal, so it is left standing rather than cleared with the ball; set a rough tool, or turn facing on, to remove it',
    );
  } else if (skinMm > 1e-6 && (opts.facing ?? 'off') !== 'on' && opts.flat !== undefined) {
    const flat = opts.flat;
    const flatRadius = (cuttingDiameter(flat) ?? 0) / 2;
    const grownSkin = flatRadius > 0 ? opts.offset(tree.contour.outline, 2 * flatRadius) : [];
    const skinFootprint = grownSkin.length > 0 ? grownSkin : tree.contour.outline;
    const skinRegion: RemainderRegion = {
      id: 'skin', footprint: skinFootprint, area: tree.contour.area, zTop: z0, zBottom: tree.top.z,
      triangles: new Uint32Array(), slopeDeg: [0, 0], slopeMedianDeg: 0, in: 'top',
    };
    const skinRef = regionRefOf('skin', 'curved', skinFootprint, 0, -skinMm);
    // THE SKIN'S DEPTH IS ITS LEVELS, not an exclusion: they stop at the part top, so a pocket's
    // own ground is never touched — but the skin ABOVE every pocket's mouth (which the pocket op,
    // starting at that mouth, never removes) is taken here. The first attempt excluded the pocket
    // footprints and left that skin standing: the tray's coverage fell 0.77 %.
    attempt('skin', flat, skinRef, () => {
      const skinCl = shiftSurface(clSurface(opts.geometry, skinRegion, flat, cuts.stepOver));
      return skin({
        cutter: flat,
        regionRef: skinRef,
        outline: tree.contour.outline,
        clSurface: skinCl,
        skinMm,
        // THE CAP IS THE ROW'S OWN STEP-DOWN x THE FACTOR (#959): a parameter, provisional at
        // 1.0 — two passes on the tray's 1.2 mm skin, one on the organizer's 0.8.
        stepDownMm: paramsFor(flat).stepDown * skinStepdownFactor(),
        maxSlopeDeg: opts.flatSurfaceMaxSlopeDeg ?? flatSurfaceMaxSlopeDeg(),
        stepOverMm: opts.stepOverMm,
        feeds: feedsOf(paramsFor(flat)),
        offset: opts.offset,
        safeZMm: opts.safeZMm,
        hopZMm: opts.hopZMm,
        toolNumber: opts.toolNumberFor(flat),
        spindleRpm: paramsFor(flat).rpm,
        air: opts.air,
        rapid: opts.rapid,
        materialTopAt: designTopAt,
        stockTopZMm: 0,
        ...(opts.startFrom === undefined ? {} : { startFrom: opts.startFrom }),
      });
    });
  }

  // 5. EVERY RIM the tree found, broken by the V at the job's stated edge break.
  //
  // THE PROPERTY SPECS FOUND THIS: an edge break of ZERO — every rectilinear card, and the curved
  // seeds that state none — is not a refusal, it is a job that asks for no bevel. `chamfer()`
  // rightly refuses a zero-depth cut (a scratch is not a bevel), so reaching the stage at all
  // threw a refusal at a job the tree said was fine. The stage is skipped WHOLE, and the note says
  // the rims stay sharp rather than leaving the reader to infer it.
  if (opts.edgeBreak.legMm > 0) {
    if (opts.vbit === undefined) {
      throw new Error(
        `cam/model/plan: the job states a ${opts.edgeBreak.legMm} mm edge break but the call states no V cutter for the rim stage`,
      );
    }
    const vbit = opts.vbit;
    // Built ONCE, reused by every rim's query below (#960's own bins, not a fresh brute-force
    // scan per rim — see `topSurfaceAt`'s own header for the perf finding this replaces).
    const rimBins = tree.rims.length > 0 ? buildTriangleBins(opts.geometry.triangles) : null;
    for (const rim of tree.rims) {
      try {
        // THE MANAGER'S RULING from the tray's 0.5 mm cell: a rim whose air side is COVERED is not
        // broken — see `rimExposedFromAbove` for the measurement that put this here. The test reads
        // the mesh, so it uses the rim's MESH-ABSOLUTE z, before the rebase below.
        if (!rimExposedFromAbove(rimBins!, rim)) {
          notes.push(
            `rim "${rim.id}" not broken: covered from above (its air side does not drop by 0.2 mm — the edge lies under the land)`,
          );
          continue;
        }
        // #962 — THE ORGANIZER'S 77 mm GROOVE FOUND THIS: `findRims`' edge-chaining can leave a
        // POCKET rim's own loop OPEN (a branch point in the sharp floor|wall graph took the wrong
        // one of several unused edges, per `features/rims.ts`'s `chain()`), and `chamfer()`'s own
        // `closedRing()` does not know the difference — it closes ANY polyline whose ends don't
        // already coincide with one more straight point, a phantom edge across whatever lies
        // between them. That phantom edge is real material to `generateChamfer`: it feeds along
        // it like any other edge of the ring, which is the posted gouge (E's render set, #962) —
        // not a `link()` defect, since `link()` never emits a lateral feed; this is the RING'S
        // OWN trace. A POCKET encloses a cavity, so its rim's own first and last point must be
        // the SAME vertex `chain()` started and ended on — not approximately, exactly, give or
        // take float noise from the mesh itself — so a gap past that noise floor there means the
        // chain never closed, and bridging it is refused. A CONTOUR rim is exempt: the outer
        // silhouette can legitimately run open to the stock's own edge (a shoulder cut to +X,
        // `buildRandomPart`'s own fixture finds this on every synthetic kind, rim-6, 8 mm open,
        // (20, -4)→(20, 4)) — closing that one just retraces its own two points, never a bridge
        // across unrelated ground.
        const first = rim.polyline[0];
        const last = rim.polyline[rim.polyline.length - 1];
        if (rim.of !== 'contour' && first !== undefined && last !== undefined && Math.hypot(first[0] - last[0], first[1] - last[1]) > RIM_CLOSE_TOL_MM) {
          notes.push(
            `rim "${rim.id}" not broken: its own loop is not closed (ends ${Math.hypot(first[0] - last[0], first[1] - last[1]).toFixed(2)} mm apart) — ` +
              `a straight bridge there is not real geometry, so no chamfer is cut rather than gouging across it`,
          );
          continue;
        }
        // The rim's own Z is mesh-absolute too — rebased before the op sizes its bevel from it.
        const rebasedRim = { ...rim, z: rebaseZ(rim.z) };
        const ref = regionRefOf(rim.id, 'rim', [[...rim.polyline]], rebasedRim.z, rebasedRim.z);
        const out = chamfer({
          cutter: vbit,
          rim: rebasedRim,
          region: ref,
          edgeBreak: opts.edgeBreak,
          offset: opts.offset,
          params: paramsFor(vbit),
          rapid: opts.rapid,
        });
        pushStage('chamfer', ref, out);
      } catch (err) {
        // #959 item 5: one rim that cannot be broken (its exposure test included) is stated, not fatal.
        unplanned.push({ kind: 'chamfer', cutterKey: cutterKeyOf(vbit), regionIds: [rim.id], reason: err instanceof Error ? err.message : String(err) });
      }
    }
  } else if (tree.rims.length > 0) {
    notes.push(`the job states no edge break — ${tree.rims.length} rim(s) stay sharp`);
  }

  if (tree.remainder.length === 0) notes.push('no curved remainder regions — the rough/rest/finish/pencil stages have nothing to plan');
  if (tree.rims.length === 0) notes.push('no rims — the chamfer stage has nothing to plan');
  notes.push(
    `the curved pipeline follows the ruling: the flat Z-steps each remainder region to its CL less ${opts.bandMm} mm, ` +
      `the ball runs ONE final level, the pencil follows the creases${opts.restFlat === undefined ? ', and no rest flat was offered' : ', and a rest flat clears the CL difference first'}`,
  );
  // #962 — the grouped statements, one per cause (see the accumulators above).
  for (const [kind, entry] of emptyStages) {
    const plural = entry.count === 1 ? 'region' : 'regions';
    notes.push(
      `${kind}: ${entry.count} ${plural} emitted no moves — nothing for it to cut` +
        (entry.deepestMm > 0 ? `; the deepest ground among them is ${entry.deepestMm.toFixed(1)} mm below the part top` : ''),
    );
  }
  for (const [finishKind, entry] of finishKinds) {
    // #965 — the card states the scallop it used, never just "constant": the job's own tolerance
    // when it states one, the vendor's 0.027 mm default when it does not.
    // #982 — with no ball the slope limit is lifted and the flat's own cusp rule sets the step;
    // the card states both, so the tradeoff is in outcome terms on the plan.
    const scallopMm = opts.finishScallopMm ?? DEFAULT_FINISH_SCALLOP_MM;
    const words = finishKind === 'flat-raster'
      ? (opts.ball === undefined
          ? `flat's fallback raster (no ball in the set; step ${scallopMm.toFixed(3)} mm cusp / tan of the steepest slope, clamped to the flat's radius/10 to radius)`
          : 'flat-following raster')
      : `ball at a constant ${scallopMm.toFixed(3)} mm scallop`;
    const plural = entry.count === 1 ? 'region' : 'regions';
    notes.push(
      `finish: ${entry.count} ${plural} run as a ${words} (slopes ${entry.minSlope.toFixed(1)}–${entry.maxSlope.toFixed(1)}°, flat threshold ${(opts.flatFinishMaxSlopeDeg ?? FLAT_SURFACE_MAX_SLOPE_DEG).toFixed(2)}°)`,
    );
  }
  return { ops, notes, clGrid, unplanned };
}

/**
 * #959/#966's ONE INTERFACE — a whole `FeatureTree` planned and posted through this engine:
 * pockets and through-holes by the costed chain, the curved remainder by the ruling's pipeline,
 * the rims by the V. The programs come back per cutter, concatenated in EXECUTION order.
 *
 * THE FREEING CUT STAYS LAST. `planPocketsForTree` already posts the contour after its own
 * pockets; the curved stages must therefore run BEFORE it, not after — a rest or finish cutting a
 * part the contour has just freed is the defect #959's ruling 1 names. So the pocket result's ops
 * are split around the contour and the tree's order is: pockets, curved, rims, freeing contour.
 */
export interface PlanTreeOptions {
  /** #982 — NULL skips the pocket chain entirely (the no-flat path plans the pocket floors as
   *  the ball's scallop pass through the curved pipeline and states the contour as not planned). */
  pockets: Omit<PlanPocketsOptions, 'offset'> | null;
  /**
   * The curved stages' options MINUS the retract heights. THE REAL TRAY FOUND THIS: the pocket
   * ops and `generateProfile`'s contour both retract at `SAFE_Z`/`HOP_Z` (`ir.ts`) and
   * `concatToolpathIR` refuses two programs that disagree — the whole-tree run threw 5 vs 12 the
   * moment the curved stages took their own. A tree posts ONE program per cutter, so it has ONE
   * program-wide retract; the type says so instead of letting a caller choose a height that
   * cannot concatenate.
   */
  curved: Omit<PlanCurvedOptions, 'offset' | 'safeZMm' | 'hopZMm'>;
  offset: OffsetFn;
}

export interface PlanTreeResult {
  ops: PlannedOp[];
  /** One program per cutter, in the order the cutters are first posted. */
  programs: Map<string, ToolpathIR>;
  /** `SetupPlan.sequence` — the pocket chain's priced cutters, unchanged from `planPocketsForTree`. */
  sequence: SequencedCutter[];
  /** `SetupPlan.clGrid` — the CL surfaces the curved stages sampled. */
  clGrid: { cutterKey: string; toleranceMm: number; minSpacingMm: number; maxSpacingMm: number }[];
  unreachable: string[];
  notes: string[];
  /** #959 item 5 — the pocket chain's failed steps, then the curved/rim stages'. */
  unplanned: SequenceStepFailure[];
  /** #961 — the pocket chain's picker result, carried through for `SetupPlan.choice`. */
  choice: SequenceChoice;
}

/**
 * #962 — THE REGION TOUR: within each cutter's run, order the regions so each one's exit joins the
 * nearest other region's entry (nearest neighbour + 2-opt — the finish's strip tour one level up).
 * E's rapid-class picture: the ⌀6 flat's region-to-region moves criss-crossed the tray (404 against
 * the vendor's 96) and were most of its rapids.
 *
 * THE UNIT IS A REGION: all of that cutter's ops on it, in their planned order — a same-region
 * pair must never be reversed (`sequence.ts`'s own invariant). The ops' paths themselves are
 * fixed, so a 2-opt move swaps the ORDER of regions and never a region's direction; only the two
 * boundary edges change.
 *
 * THE FREEING CUT NEVER MOVES: the contour op stays pinned at the end, exactly where the plan put
 * it — pulling it earlier would un-free the part before the last stage ran.
 */
export function orderOpsForPrograms(ops: readonly PlannedOp[]): PlannedOp[] {
  const sentinels = ops.filter((op) => op.kind === 'contour');
  const movable = ops.filter((op) => op.kind !== 'contour');
  const groups: PlannedOp[][] = [];
  const atByKey = new Map<string, number>();
  for (const op of movable) {
    let at = atByKey.get(op.outcome.cutter);
    if (at === undefined) {
      at = groups.length;
      atByKey.set(op.outcome.cutter, at);
      groups.push([]);
    }
    groups[at]!.push(op);
  }
  const out: PlannedOp[] = [];
  for (const group of groups) {
    const units: { ops: PlannedOp[]; entry: [number, number, number] | null; exit: [number, number, number] | null }[] = [];
    const unitByRegion = new Map<string, number>();
    for (const op of group) {
      let at = unitByRegion.get(op.region.id);
      if (at === undefined) {
        at = units.length;
        unitByRegion.set(op.region.id, at);
        units.push({ ops: [], entry: null, exit: null });
      }
      const unit = units[at]!;
      unit.ops.push(op);
      if (unit.entry === null && op.outcome.passes[0] !== undefined) unit.entry = op.outcome.passes[0]!.entry;
      if (op.outcome.passes[op.outcome.passes.length - 1] !== undefined) unit.exit = op.outcome.passes[op.outcome.passes.length - 1]!.exit;
    }
    if (units.some((u) => u.entry === null || u.exit === null)) {
      // An op that recorded no passes: the tour cannot price it, so this run keeps its order.
      out.push(...group);
      continue;
    }
    const entryOf = (at: number): [number, number, number] => units[at]!.entry!;
    const exitOf = (at: number): [number, number, number] => units[at]!.exit!;
    const d = (a: [number, number, number], b: [number, number, number]): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const remaining = units.map((_, k) => k);
    const order: number[] = [];
    let px = 0;
    let py = 0;
    while (remaining.length > 0) {
      let bestPos = 0;
      let best = Infinity;
      for (let k = 0; k < remaining.length; k++) {
        const e = entryOf(remaining[k]!);
        const dist = Math.hypot(e[0] - px, e[1] - py);
        if (dist < best - 1e-12) {
          best = dist;
          bestPos = k;
        }
      }
      const idx = remaining.splice(bestPos, 1)[0]!;
      order.push(idx);
      const e = exitOf(idx);
      px = e[0];
      py = e[1];
    }
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 64) {
      improved = false;
      for (let i = 1; i + 1 < order.length; i++) {
        for (let k = i; k < order.length; k++) {
          const before = d(exitOf(order[i - 1]!), entryOf(order[i]!))
            + (k + 1 < order.length ? d(exitOf(order[k]!), entryOf(order[k + 1]!)) : 0);
          const after = d(exitOf(order[i - 1]!), entryOf(order[k]!))
            + (k + 1 < order.length ? d(exitOf(order[i]!), entryOf(order[k + 1]!)) : 0);
          if (after < before - 1e-9) {
            order.splice(i, k - i + 1, ...order.slice(i, k + 1).reverse());
            improved = true;
          }
        }
      }
    }
    for (const at of order) out.push(...units[at]!.ops);
  }
  return [...out, ...sentinels];
}

export function planTreePrograms(tree: FeatureTree, opts: PlanTreeOptions): PlanTreeResult {
  const pocketResult: PlanPocketsResult = opts.pockets === null
    ? {
        ops: [],
        programs: [],
        sequence: [],
        unreachable: [],
        notes: [
          'the set holds no flat end mill — the pocket chain is not planned: its freeing contour is not planned with a ball either, so this plan does not free the part',
        ],
        unplanned: [],
        choice: {
          steps: [],
          cost: { entries: [], estimateSeconds: 0, toolChanges: 0, toolChangeSeconds: 0, totalSeconds: 0 },
          considered: [],
          unreachable: [],
          freeing: null,
          unplanned: [],
        },
      }
    : planPocketsForTree(tree, { ...opts.pockets, offset: opts.offset });
  const curvedResult = planCurvedForTree(tree, {
    ...opts.curved,
    offset: opts.offset,
    safeZMm: SAFE_Z,
    hopZMm: HOP_Z,
  });
  const freeing = pocketResult.ops.filter((op) => op.kind === 'contour');
  // #962 — THE REGION TOUR: each cutter's run visits its regions in nearest-neighbour order
  // rather than the planning order; the freeing contour stays pinned last (see the helper).
  const ops: PlannedOp[] = orderOpsForPrograms([
    ...pocketResult.ops.filter((op) => op.kind !== 'contour'),
    ...curvedResult.ops,
    ...freeing,
  ]);
  const programs = new Map<string, ToolpathIR>();
  for (const op of ops) {
    const key = op.outcome.cutter;
    const existing = programs.get(key);
    programs.set(key, existing === undefined ? op.outcome.ir : concatToolpathIR(existing, op.outcome.ir));
  }
  return {
    ops,
    programs,
    sequence: pocketResult.sequence,
    clGrid: curvedResult.clGrid,
    unreachable: pocketResult.unreachable,
    notes: [...pocketResult.notes, ...curvedResult.notes],
    unplanned: [...pocketResult.unplanned, ...curvedResult.unplanned],
    choice: pocketResult.choice,
  };
}
