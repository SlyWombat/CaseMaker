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
import { concatToolpathIR, estimateCycleTerms, HOP_Z, SAFE_Z, type CycleTerms, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { feedCatalogueSnapshot, feedsFor, feedsToolForSurface, resolvedFeedsTable, type CutParams } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { readDefault, liveShopDefaults } from '@/platform/defaultsClient';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { getToplevel } from '@/workers/geometry/ManifoldRuntime';
import type { OffsetFn, Polygons } from '@/engine/cnc/cam/pocket';
import type { BooleanFn } from '@/engine/cnc/cam/engraveJob';
import type { FeatureSource, FeatureTree, PocketNode, RemainderRegion, SetupFrame } from './features';
import { recogniseFeatures, regionRefs } from './features';
import type { EdgeBreakSpec, ModelPlanProgress, ModelTolerances } from './types';
import { batchSameCutterRuns, chooseSequence, cutterKeyOf, type CutterCandidates, type PlannedOpKind, type SequenceChoice, type SequenceFeature, type SequenceOptions, type SequenceStep, type SequenceStepFailure } from './sequence';
import { pocket } from './ops/pocket';
import { clSurface } from './clsurface';
import { rough, skin } from './ops/rough';
import { flatSurfaceMaxSlopeDeg, skinStepdownFactor } from './settings';
import { rest } from './ops/rest';
import { finish } from './ops/finish';
import { pencil } from './ops/pencil';
import { chamfer } from './ops/chamfer';
import { contour as contourOp, throughHole } from './ops/contour';
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
}

/** Set only by specs for now (see this file's header). */
export const USE_MODEL_CAM_ENGINE = false;

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
  const perSetup: SetupPlan[] = [];

  for (let setupIndex = 0; setupIndex < input.setups.length; setupIndex++) {
    opts.signal?.throwIfAborted();
    const spec = input.setups[setupIndex]!;
    opts.onProgress?.({ setupIndex, op: 'features', fraction: 0 });
    const tree = recogniseFeatures(input.geometry, spec.frame, tl);

    const flats = input.cutters.house
      .filter((t) => t.shape === 'flat' && (cuttingDiameter(t) ?? 0) > 0)
      .sort((a, b) => (cuttingDiameter(b) ?? 0) - (cuttingDiameter(a) ?? 0));
    const primary = flats[0];
    if (primary === undefined) {
      throw new Error('cam/model/plan: the house states no flat end mill with a cutting diameter — a pocket cannot be planned without one');
    }
    const ball = input.cutters.house
      .filter((t) => t.shape === 'ball' && (cuttingDiameter(t) ?? 0) > 0)
      .sort((a, b) => (cuttingDiameter(b) ?? 0) - (cuttingDiameter(a) ?? 0))[0];
    const vbit = input.cutters.house.find((t) => t.shape === 'chamfer') ?? input.cutters.house.find((t) => t.shape === 'engraving');
    if (tree.remainder.length > 0 && ball === undefined) {
      throw new Error('cam/model/plan: the part has curved remainder regions but the house states no ball nose — the finish stage cannot be planned');
    }

    const { params: pocketParams, substitution } = resolvedCutParams(input, primary);
    const feeds = { feedMmPerMin: pocketParams.feed, plungeFeedMmPerMin: pocketParams.plungeFeed };

    // THE REVIEW'S FINDING (item 8): the ball and the V each get their OWN catalogue row — not
    // the primary flat's, reused as every tool's numbers before this.
    const toolSubstitutions: string[] = substitution === null ? [] : [substitution];
    const ballParams = ball === undefined ? null : toolCutParams(input, ball, pocketParams);
    if (ballParams?.note !== null && ballParams?.note !== undefined) toolSubstitutions.push(ballParams.note);
    const vbitParams = vbit === undefined ? null : toolCutParams(input, vbit, pocketParams);
    if (vbitParams?.note !== null && vbitParams?.note !== undefined) toolSubstitutions.push(vbitParams.note);
    const cutParamsFor = (tool: Tool): CutParams => {
      if (ball !== undefined && tool === ball && ballParams !== null) return ballParams.params;
      if (vbit !== undefined && tool === vbit && vbitParams !== null) return vbitParams.params;
      return pocketParams;
    };

    opts.onProgress?.({ setupIndex, op: 'sequence', fraction: 0.4 });
    const result = planTreePrograms(tree, {
      offset,
      pockets: {
        houseFlats: flats,
        stepDownMm: pocketParams.stepDown,
        feeds,
        rapid: Z1.rapidEstimate,
        toolChangeSeconds,
        spindleRpm: pocketParams.rpm,
        air: true,
        boolean,
        facing: input.facing ?? 'off',
      },
      curved: {
        geometry: input.geometry,
        flat: primary,
        ...(ball === undefined ? {} : { ball }),
        ...(vbit === undefined ? {} : { vbit }),
        stepDownMm: pocketParams.stepDown,
        bandMm: MODEL_STOCK_TO_LEAVE_MM,
        finishScallopMm: input.tolerances.finishMm,
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
        ops.push(op);
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

    const notes = [...result.notes, ...emptyStages];
    notes.push(...toolSubstitutions);
    if (input.fixture.envelope !== null) {
      notes.push(
        `the ${input.fixture.mount} fixture envelope is not yet wired into the region obstacles — this plan carries none; the posted program is still checked against the same envelope by the sweep`,
      );
    }
    if (input.cutters.catalogue.length > 0) {
      notes.push(`${input.cutters.catalogue.length} catalogue cutter(s) are not in the pocket chain yet — the house set is what it chooses from`);
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
  /**
   * #959 (2026-11-05 ruling): FACING OFF by default. `'on'` plans the facing stage exactly as
   * before (the operator option); absent or `'off'` plans none, and the skin over the top land
   * belongs to the flat surface-following pass (`skin`).
   */
  facing?: 'off' | 'on';
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
  const facingDepthMm = z0 - tree.top.z;
  // #959 (2026-11-05 ruling): facing is an OPERATOR OPTION, off by default.
  const hasFacing = (opts.facing ?? 'off') === 'on' && facingDepthMm > 1e-6;
  if (hasFacing) {
    refById.set('facing', {
      id: 'facing', kind: 'pocket', bounds: boundsOfPolygons(tree.contour.outline),
      topZ: rebase(z0), bottomZ: rebase(tree.top.z), obstacles: [],
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
  features.push({ id: 'contour', kind: 'contour', depthMm: contourDepthMm });
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

  const planRegion = (id: string, cutter: Tool): OpOutcome | null => {
    const ref = refById.get(id);
    if (ref === undefined) return null;
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
          id: 'facing', floorZ: rebase(tree.top.z), mouthZ: rebase(z0), open: false, through: false,
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

  const planStep: SequenceOptions['planStep'] = (step) => {
    let outcomes = outcomeCache.get(stepSignature(step));
    if (outcomes === undefined) {
      outcomes = [];
      for (const id of step.regionIds) {
        let outcome: OpOutcome | null;
        try {
          outcome = planRegion(id, step.cutter.tool);
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
      outcomeCache.set(stepSignature(step), outcomes);
    }
    if (outcomes === null || outcomes.length === 0) return null;
    return outcomes.map((o) => o.outcome.ir).reduce((a, b) => concatToolpathIR(a, b));
  };

  const choice = chooseSequence(demand, cutters, {
    rapid: opts.rapid,
    toolChangeSeconds: opts.toolChangeSeconds,
    planStep,
    maxCutters: opts.maxCutters,
  });

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
  for (const step of choice.steps) {
    const outcomes = outcomeCache.get(stepSignature(step));
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

  const offered = [...opts.houseFlats].map((t) => `⌀${cuttingDiameter(t)}`).join(', ');
  // A's review 6622610124, finding 4: a through node's own limiting number was lost (the lookup
  // only checked `pocketsById`) — the SAME sentence either kind of node gets.
  const unreachable = choice.unreachable.map((id) => {
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

  const notes: string[] = [];
  for (const [id, { reason: message }] of regionFailures) {
    notes.push(`${id}: not cut — planning failed (${message})`);
    // A root pocket's/wide through hole's own mouth assumes facing already cleared the skin
    // (above) — if facing itself is the region that failed, that assumption is now FALSE for
    // every pocket this plan still posted, and nothing re-plans them at the stock top instead.
    // Named here rather than silently trusted, per the advisor's review on this revert.
    if (id === 'facing') {
      notes.push(
        'facing failed to plan but the skin is real (see above) — every pocket/through-hole posted still ' +
          'assumes it is gone; their own first pass is deeper than it looks.',
      );
    }
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
  /** The real Clipper2 offset, or a test fake — the pocket op's own contract. */
  offset: OffsetFn;
  /** The three tools the curved pipeline uses: the flat roughs, the ball finishes, the V breaks rims. */
  flat: Tool;
  /** The ball. Absent is allowed when the tree has no remainder to finish — the region loop refuses by name the moment one needs it. */
  ball?: Tool;
  /** The V. Absent is allowed when the job states no edge break — the rim stage is then not planned at
   * all (the property specs' house holds no V and asks for none). */
  vbit?: Tool;
  /** An optional smaller flat for the rest pass by CL difference. */
  restFlat?: Tool;
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
  const pushStage = (kind: PlannedOp['kind'], ref: RegionRef, outcome: OpOutcome): void => {
    if (outcome.ir.operations.some((operation) => operation.moves.length > 0)) {
      ops.push({ kind, region: ref, outcome });
      return;
    }
    notes.push(`${kind} "${ref.id}" emitted no moves — nothing for it to cut`);
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
  const cuts: CutParams = {
    rpm: opts.spindleRpm,
    feed: opts.feeds.feedMmPerMin,
    plungeFeed: opts.feeds.plungeFeedMmPerMin,
    stepDown: opts.stepDownMm,
    stepOver: opts.stepOverMm ?? (cuttingDiameter(opts.flat) ?? 1) / 2,
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

  for (const region of tree.remainder) {
    const ball = opts.ball;
    if (ball === undefined) {
      throw new Error(
        `cam/model/plan: the remainder region "${region.id}" needs a ball nose to finish and the call states none`,
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
    const ball0 = opts.ball;
    const ballRadius0 = ball0 === undefined ? 0 : (cuttingDiameter(ball0) ?? 0) / 2;
    const outerMost = (polys: Polygons): number => Math.max(0, ...polys.map(ringAreaOf));
    const contourRing = outerMost(tree.contour.outline);
    const isOuterSurface =
      ballRadius0 > 0 && contourRing > 0 && Math.abs(outerMost(region.footprint) - contourRing) <= 0.01 * contourRing;
    const grownFootprint = isOuterSurface ? opts.offset(region.footprint, ballRadius0) : [];
    const roughRegion = grownFootprint.length > 0 ? { ...base, footprint: grownFootprint } : base;
    const roughRef = roughRegion === base
      ? ref
      : regionRefOf(region.id, 'curved', roughRegion.footprint, base.zTop, base.zBottom);
    // 1. The FLAT Z-steps the region to its own CL, leaving the band.
    //
    // #959 item 5: the rough is this region's PRIMARY — a rest, finish or pencil on stock it never
    // cleared would take a full-depth bite — so when it throws, the region's later stages are
    // stated as skipped, not planned.
    const flatCl: { surface?: ReturnType<typeof clSurface> } = {};
    const roughed = attempt('rough', opts.flat, ref, () => {
      const clFlat = shiftSurface(clSurface(opts.geometry, roughRegion, opts.flat, cuts.stepOver));
      flatCl.surface = clFlat;
      noteGrid(opts.flat, clFlat);
      return rough({
        cutter: opts.flat,
        region: roughRegion,
        regionRef: roughRef,
        clSurface: clFlat,
        stepDownMm: opts.stepDownMm,
        stockToLeaveMm: opts.bandMm,
        stepOverMm: opts.stepOverMm,
        feeds: feedsOf(paramsFor(opts.flat)),
        offset: opts.offset,
        safeZMm: opts.safeZMm,
        hopZMm: opts.hopZMm,
        toolNumber: opts.toolNumberFor(opts.flat),
        spindleRpm: paramsFor(opts.flat).rpm,
        air: opts.air,
        rapid: opts.rapid,
        ...(opts.startFrom === undefined ? {} : { startFrom: opts.startFrom }),
      });
    });
    const prevCl = flatCl.surface;
    if (!roughed || prevCl === undefined) {
      const skipped: [PlannedOp['kind'], Tool][] = [
        ...(opts.restFlat === undefined ? [] : [['rest', opts.restFlat] as [PlannedOp['kind'], Tool]]),
        ['finish', ball],
        ['pencil', ball],
      ];
      for (const [kind, cutter] of skipped) {
        unplanned.push({ kind, cutterKey: cutterKeyOf(cutter), regionIds: [region.id], reason: `not planned: the rough of "${region.id}" failed` });
      }
      continue;
    }

    // 2. REST BY CL DIFFERENCE, when the caller offers a smaller flat: the band the previous
    //    cutter left standing, where the smaller one can reach.
    const restFlat = opts.restFlat;
    const restClSink: { surface?: ReturnType<typeof clSurface> } = {};
    if (restFlat !== undefined) {
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

    // ITEM 4a — THE FINISH'S MASK: leftover = flatSwept − design > band, dilated by the ball's
    // footprint. `flatSwept` is the LOWEST flat CL that actually ran over the region — the skim's
    // exact-contact pass, else the Z-levels' cl + band; a rest flat's CL when one ran — read back
    // to the MESH datum (the shifted surfaces + z0), because `design` is the mesh's own top at the
    // cell (`topSurfaceAt`). The band is the finish's tolerance (the ruling), not the rough's
    // stock-to-leave.
    const finishBand = opts.finishScallopMm ?? opts.bandMm;
    // One bins build for the whole plan's top-surface queries (the same structure the rim
    // filter uses), not one per region.
    let surfaceBins: TriangleBins | null = null;
    const binsForMask = (): TriangleBins => (surfaceBins ??= buildTriangleBins(opts.geometry.triangles));
    const flatAbs = (x: number, y: number): number | null => {
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
    const ballRadiusForMask = (cuttingDiameter(ball) ?? 0) / 2;
    const maskCells = (x: number, y: number): boolean => {
      // Dilated by the ball's footprint: a centre just outside the leftover still cuts into it,
      // and a centre just OUTSIDE the part still finishes the skirt its flank holds — the same
      // margin the grown outer ring needs.
      if (leftoverAbove(x, y)) return true;
      for (let d = 0; d < 8; d++) {
        const a = (d * Math.PI) / 4;
        if (leftoverAbove(x + Math.cos(a) * ballRadiusForMask, y + Math.sin(a) * ballRadiusForMask)) return true;
      }
      return false;
    };

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
        clBallCache = shiftSurface(clSurface(opts.geometry, roughRegion, ball, cuts.stepOver));
        noteGrid(ball, clBallCache);
      }
      return clBallCache;
    };
    const depth = Math.max(opts.stepDownMm, base.zTop - base.zBottom);
    attempt('finish', ball, ref, () => finish({
      cutter: ball,
      region: roughRegion,
      regionRef: roughRef,
      clSurface: clBall(),
      kind: 'ball-scallop',
      scallopMm: opts.finishScallopMm ?? opts.bandMm,
      maskCells,
      // #962 — the material field's answers past the region's own reach (the linker's disc and the
      // down-leg floor reach up to a cutter radius outside it): the goal/mesh top there, which is
      // the honest bound a wall or land beside a low region demands, and the stock top where the
      // mesh is silent. The region's own zTop is NOT that bound — a neighbouring wall can out-top
      // it, and a rapid floored at zTop would run into the wall. In this datum (every Z rebased by
      // −stockTop) the stock top is 0.
      materialTopAt: (x: number, y: number) => {
        const top = topSurfaceAt(binsForMask(), x, y);
        return top === null ? null : top - z0;
      },
      stockTopZMm: 0,
      stepDownMm: depth,
      feeds: feedsOf(paramsFor(ball)),
      safeZMm: opts.safeZMm,
      hopZMm: opts.hopZMm,
      toolNumber: opts.toolNumberFor(ball),
      spindleRpm: paramsFor(ball).rpm,
      air: opts.air,
      rapid: opts.rapid,
    }));

    // 4. PENCIL along the creases the ball's own CL surface leaves.
    attempt('pencil', ball, ref, () => pencil({
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
  if (skinMm > 1e-6 && (opts.facing ?? 'off') !== 'on') {
    const flatRadius = (cuttingDiameter(opts.flat) ?? 0) / 2;
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
    attempt('skin', opts.flat, skinRef, () => {
      const skinCl = shiftSurface(clSurface(opts.geometry, skinRegion, opts.flat, cuts.stepOver));
      return skin({
        cutter: opts.flat,
        regionRef: skinRef,
        outline: tree.contour.outline,
        clSurface: skinCl,
        skinMm,
        // THE CAP IS THE ROW'S OWN STEP-DOWN x THE FACTOR (#959): a parameter, provisional at
        // 1.0 — two passes on the tray's 1.2 mm skin, one on the organizer's 0.8.
        stepDownMm: paramsFor(opts.flat).stepDown * skinStepdownFactor(),
        maxSlopeDeg: opts.flatSurfaceMaxSlopeDeg ?? flatSurfaceMaxSlopeDeg(),
        stepOverMm: opts.stepOverMm,
        feeds: feedsOf(paramsFor(opts.flat)),
        offset: opts.offset,
        safeZMm: opts.safeZMm,
        hopZMm: opts.hopZMm,
        toolNumber: opts.toolNumberFor(opts.flat),
        spindleRpm: paramsFor(opts.flat).rpm,
        air: opts.air,
        rapid: opts.rapid,
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
  pockets: Omit<PlanPocketsOptions, 'offset'>;
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
}

export function planTreePrograms(tree: FeatureTree, opts: PlanTreeOptions): PlanTreeResult {
  const pocketResult = planPocketsForTree(tree, { ...opts.pockets, offset: opts.offset });
  const curvedResult = planCurvedForTree(tree, {
    ...opts.curved,
    offset: opts.offset,
    safeZMm: SAFE_Z,
    hopZMm: HOP_Z,
  });
  const freeing = pocketResult.ops.filter((op) => op.kind === 'contour');
  const ops: PlannedOp[] = [
    ...pocketResult.ops.filter((op) => op.kind !== 'contour'),
    ...curvedResult.ops,
    ...freeing,
  ];
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
  };
}
