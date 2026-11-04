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
import type { Tool } from '@/engine/cnc/tool';
import { concatToolpathIR, type CycleTerms, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import type { OffsetFn } from '@/engine/cnc/cam/pocket';
import type { FeatureSource, FeatureTree, PocketNode, SetupFrame } from './features';
import { regionRefs } from './features';
import type { EdgeBreakSpec, ModelPlanProgress, ModelTolerances } from './types';
import type { CutterCandidates, PlannedOpKind } from './sequence';
import { pocket } from './ops/pocket';

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
  /** One program per `cutterKey` in `sequence`, in sequence order — the #419 answer ("one program per tool"). */
  programs: ToolpathIR[];
  totalCostSeconds: number;
}

/** Set only by specs for now (see this file's header). */
export const USE_MODEL_CAM_ENGINE = false;

export interface PlanModelCamOptions {
  signal?: AbortSignal;
  onProgress?: (p: ModelPlanProgress) => void;
}

export async function planModelCam(_input: ModelPlanInput, _opts: PlanModelCamOptions = {}): Promise<ModelPlanOutput> {
  throw new Error('cam/model/plan: planModelCam() not implemented (#956 skeleton — #957/#959/#960 fill it in)');
}

const allPockets = (nodes: PocketNode[]): PocketNode[] => nodes.flatMap((n) => [n, ...allPockets(n.children)]);

export interface PlanPocketsOptions {
  /** The real Clipper2 offset, or a test fake — `pocketLoops`' own contract, carried through unchanged. */
  offset: OffsetFn;
  /** House cutters, largest first; this is NOT #961's real picker (see this function's own note). */
  houseFlats: readonly Tool[];
  stepDownMm: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  rapid: RapidEstimate;
  spindleRpm: number;
  air: boolean;
}

export interface PlanPocketsResult {
  ops: PlannedOp[];
  /** One program per cutter actually used, in `ops` order, concatenated. */
  programs: Map<string, ToolpathIR>;
  /** A node too narrow for every cutter in `houseFlats`, as a stated finding naming the limiting number. */
  skipped: string[];
}

/**
 * Every non-through floored `PocketNode` in a `FeatureTree`, cut with the largest `houseFlats`
 * entry that fits (by `node.narrowest`). **This is a placeholder for #961's real cutter sequence**
 * (`sequence.ts`'s `chooseSequence`), not a re-implementation of it: C's picker assigns ONE
 * primary (+ rest) cutter to every pocket feature in one `SequenceDemand`, which cannot serve a
 * part whose features span a range too wide for any single primary + rest pair (E's 6621584766 —
 * the tray's six ~1 mm features alongside its 6+ mm ones). Resolving that is #961's own call
 * (raised on #956/#961), not decided here by adding smaller cutters speculatively.
 *
 * Moved here from the acceptance spec (`opsAcceptance959.spec.ts`) so the product, not the test
 * harness, is what gets measured — the spec now calls this directly.
 */
export function planPocketsForTree(tree: FeatureTree, opts: PlanPocketsOptions): PlanPocketsResult {
  const refs = regionRefs(tree);
  const ops: PlannedOp[] = [];
  const programs = new Map<string, ToolpathIR>();
  const skipped: string[] = [];
  const sorted = [...opts.houseFlats].sort((a, b) => (b.diameter ?? 0) - (a.diameter ?? 0));

  for (const node of allPockets(tree.pockets)) {
    if (node.through || node.floors.length === 0) continue;
    const ref = refs.find((r) => r.id === node.id);
    if (ref === undefined) { skipped.push(`${node.id}: no RegionRef`); continue; }
    const cutter = sorted.find((t) => node.narrowest >= (t.diameter ?? 0));
    if (cutter === undefined) {
      skipped.push(`${node.id}: not cut — needs a cutter ≤ ${node.narrowest.toFixed(2)} mm (house offers ${sorted.map((t) => `⌀${t.diameter}`).join(', ')})`);
      continue;
    }
    const diameter = cutter.diameter ?? 1;
    const outcome = pocket({
      cutter,
      node,
      region: { ...ref, obstacles: [], regionClearanceZ: tree.frame.partTop + 5 },
      stepOverMm: Math.min(diameter / 4, diameter / 2),
      stepDownMm: opts.stepDownMm,
      feeds: opts.feeds,
      offset: opts.offset,
      safeZMm: tree.frame.partTop + 10,
      hopZMm: tree.frame.partTop + 3,
      toolNumber: cutter.number ?? 1,
      spindleRpm: opts.spindleRpm,
      air: opts.air,
      rapid: opts.rapid,
    });
    ops.push({ kind: 'pocket', region: { ...ref, obstacles: [], regionClearanceZ: tree.frame.partTop + 5 }, outcome });
    const key = outcome.cutter;
    const existing = programs.get(key);
    programs.set(key, existing === undefined ? outcome.ir : concatToolpathIR(existing, outcome.ir));
  }
  return { ops, programs, skipped };
}
