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
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { concatToolpathIR, estimateCycleTerms, HOP_Z, SAFE_Z, type CycleTerms, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import type { CutParams } from '@/engine/cnc/feeds';
import type { OffsetFn, Polygons } from '@/engine/cnc/cam/pocket';
import type { BooleanFn } from '@/engine/cnc/cam/engraveJob';
import type { FeatureSource, FeatureTree, PocketNode, SetupFrame } from './features';
import { regionRefs } from './features';
import type { EdgeBreakSpec, ModelPlanProgress, ModelTolerances } from './types';
import { chooseSequence, type CutterCandidates, type PlannedOpKind, type SequenceChoice, type SequenceFeature, type SequenceOptions, type SequenceStep } from './sequence';
import { pocket } from './ops/pocket';
import { clSurface } from './clsurface';
import { rough } from './ops/rough';
import { rest } from './ops/rest';
import { finish } from './ops/finish';
import { pencil } from './ops/pencil';
import { chamfer } from './ops/chamfer';
import { contour as contourOp, throughHole } from './ops/contour';

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
  /**
   * One program per RUN, in execution order — #419's "one program per tool" still holds for a
   * job with no cutter revisit; a cutter #961 returns to for the freeing cut (cheaper than its
   * last cutter taking the profile) posts as a SECOND, separate entry here, never merged with
   * its first (advisor's review on ab6b2827 — merging them posts a file that frees the part
   * before the step in between it ever ran).
   */
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

/** The `facing` region's own `Box2` — there is no `PocketNode`/`regionRefs` entry for it (it is
 * not a recognised feature, it is this plan's own synthesis of `FeatureTree.top.floors`). */
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
  const hasFacing = facingDepthMm > 1e-6;
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
  const regionFailures = new Map<string, string>();

  const planStep: SequenceOptions['planStep'] = (step) => {
    let outcomes = outcomeCache.get(stepSignature(step));
    if (outcomes === undefined) {
      outcomes = [];
      for (const id of step.regionIds) {
        let outcome: OpOutcome | null;
        try {
          outcome = planRegion(id, step.cutter.tool);
        } catch (err) {
          if (!regionFailures.has(id)) regionFailures.set(id, err instanceof Error ? err.message : String(err));
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
    return node === undefined
      ? `${id}: not cut`
      : `${id}: not cut — needs a cutter ≤ ${node.narrowest.toFixed(2)} mm (house offers ${offered})`;
  });

  const notes: string[] = [];
  for (const [id, message] of regionFailures) {
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

  return { ops, programs, sequence, unreachable, notes, choice };
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
  ball: Tool;
  vbit: Tool;
  /** An optional smaller flat for the rest pass by CL difference. */
  restFlat?: Tool;
  stepDownMm: number;
  /** The band the finish promises, mm — the rough's stock-to-leave and the ball's scallop. */
  bandMm: number;
  /** The rings' spacing; absent → the flat's own radius. */
  stepOverMm?: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  rapid: RapidEstimate;
  spindleRpm: number;
  air: boolean;
  safeZMm: number;
  hopZMm: number;
  /** The job's own edge break — the chamfer's depth (A's R3). */
  edgeBreak: EdgeBreakSpec;
  toolNumberFor: (tool: Tool) => number;
  startFrom?: readonly [number, number];
}

export interface PlanCurvedResult {
  ops: PlannedOp[];
  /** Statements the plan owes the operator: nothing here is silent. */
  notes: string[];
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
  const cuts: CutParams = {
    rpm: opts.spindleRpm,
    feed: opts.feeds.feedMmPerMin,
    plungeFeed: opts.feeds.plungeFeedMmPerMin,
    stepDown: opts.stepDownMm,
    stepOver: opts.stepOverMm ?? (cuttingDiameter(opts.flat) ?? 1) / 2,
    peck: 0,
    air: opts.air,
  };

  for (const region of tree.remainder) {
    const ref = regionRefOf(region.id, 'curved', region.footprint, region.zTop, region.zBottom);
    const clFlat = clSurface(opts.geometry, region, opts.flat, cuts.stepOver);
    // 1. The FLAT Z-steps the region to its own CL, leaving the band.
    const roughOut = rough({
      cutter: opts.flat,
      region,
      regionRef: ref,
      clSurface: clFlat,
      stepDownMm: opts.stepDownMm,
      stockToLeaveMm: opts.bandMm,
      stepOverMm: opts.stepOverMm,
      feeds: opts.feeds,
      offset: opts.offset,
      safeZMm: opts.safeZMm,
      hopZMm: opts.hopZMm,
      toolNumber: opts.toolNumberFor(opts.flat),
      spindleRpm: opts.spindleRpm,
      air: opts.air,
      rapid: opts.rapid,
      ...(opts.startFrom === undefined ? {} : { startFrom: opts.startFrom }),
    });
    ops.push({ kind: 'rough', region: ref, outcome: roughOut });

    // 2. REST BY CL DIFFERENCE, when the caller offers a smaller flat: the band the previous
    //    cutter left standing, where the smaller one can reach.
    let finishCl = clFlat;
    if (opts.restFlat !== undefined) {
      const restCl = clSurface(opts.geometry, region, opts.restFlat, cuts.stepOver);
      const restOut = rest({
        cutter: opts.restFlat,
        region,
        regionRef: ref,
        prevClSurface: clFlat,
        clSurface: restCl,
        stepDownMm: opts.stepDownMm,
        stockToLeaveMm: opts.bandMm,
        stepOverMm: opts.stepOverMm,
        feeds: opts.feeds,
        offset: opts.offset,
        safeZMm: opts.safeZMm,
        hopZMm: opts.hopZMm,
        toolNumber: opts.toolNumberFor(opts.restFlat),
        spindleRpm: opts.spindleRpm,
        air: opts.air,
        rapid: opts.rapid,
        ...(opts.startFrom === undefined ? {} : { startFrom: opts.startFrom }),
      });
      ops.push({ kind: 'rest', region: ref, outcome: restOut });
      finishCl = restCl;
    }

    // 3. THE BALL'S ONE FINAL LEVEL: a single pass at the region's depth takes the band.
    const depth = Math.max(opts.stepDownMm, region.zTop - region.zBottom);
    const finishOut = finish({
      cutter: opts.ball,
      region,
      regionRef: ref,
      clSurface: finishCl,
      kind: 'ball-scallop',
      scallopMm: opts.bandMm,
      stepDownMm: depth,
      feeds: opts.feeds,
      safeZMm: opts.safeZMm,
      hopZMm: opts.hopZMm,
      toolNumber: opts.toolNumberFor(opts.ball),
      spindleRpm: opts.spindleRpm,
      air: opts.air,
      rapid: opts.rapid,
    });
    ops.push({ kind: 'finish', region: ref, outcome: finishOut });

    // 4. PENCIL along the creases the ball's own CL surface leaves.
    const pencilOut = pencil({
      cutter: opts.ball,
      region,
      regionRef: ref,
      clSurface: finishCl,
      feeds: opts.feeds,
      safeZMm: opts.safeZMm,
      hopZMm: opts.hopZMm,
      toolNumber: opts.toolNumberFor(opts.ball),
      spindleRpm: opts.spindleRpm,
      air: opts.air,
      rapid: opts.rapid,
    });
    ops.push({ kind: 'pencil', region: ref, outcome: pencilOut });
  }

  // 5. EVERY RIM the tree found, broken by the V at the job's stated edge break.
  for (const rim of tree.rims) {
    const ref = regionRefOf(rim.id, 'rim', [[...rim.polyline]], rim.z, rim.z);
    const out = chamfer({
      cutter: opts.vbit,
      rim,
      region: ref,
      edgeBreak: opts.edgeBreak,
      offset: opts.offset,
      params: cuts,
      rapid: opts.rapid,
    });
    ops.push({ kind: 'chamfer', region: ref, outcome: out });
  }

  if (tree.remainder.length === 0) notes.push('no curved remainder regions — the rough/rest/finish/pencil stages have nothing to plan');
  if (tree.rims.length === 0) notes.push('no rims — the chamfer stage has nothing to plan');
  notes.push(
    `the curved pipeline follows the ruling: the flat Z-steps each remainder region to its CL less ${opts.bandMm} mm, ` +
      `the ball runs ONE final level, the pencil follows the creases${opts.restFlat === undefined ? ', and no rest flat was offered' : ', and a rest flat clears the CL difference first'}`,
  );
  return { ops, notes };
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
  unreachable: string[];
  notes: string[];
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
    unreachable: pocketResult.unreachable,
    notes: [...pocketResult.notes, ...curvedResult.notes],
  };
}
