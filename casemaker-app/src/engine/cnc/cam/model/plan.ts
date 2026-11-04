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

/** Shoelace signed area — positive for a CCW ring, negative for CW. `pocket.ts`'s own winding
 * convention: an outer boundary is CCW, a hole (an island) is CW. */
function signedArea(ring: readonly [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
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
  // problem and needs no ordering against the pockets: whichever runs first, the other cuts only
  // air where they overlap. Computed per cutter (below, not here) since the margin is `r`-sized.
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
      const diameter = cuttingDiameter(cutter) ?? 1;
      // `offset(outline, +2r)`: the same open-edge overhang the open-shoulder fix uses, so the
      // facing cut reaches all the way to the true outer edge, past every island top and every
      // wall/rim too narrow to survive `tree.top.floors`' own erosion. The overshoot past the
      // true edge is air once the contour frees the part, same reasoning as the shoulder case.
      const grown = opts.offset(tree.contour.outline, 2 * toolRadius);
      // The manager's #959 ruling: exclude every root pocket's (and through hole's) own DEEP
      // interior — its first pass already engages from the stock top (finding 2's own fix), so
      // facing it again is pure waste. `erode(⋃ roots, 2r)` keeps a 2r margin around each one
      // (the overhang a thin wall or rim still needs), only the interior past that is dropped.
      const rootPocketNodes = pocketNodes.filter((n) => rootIds.has(n.id));
      let facingRegion = grown;
      if (opts.boolean !== undefined) {
        // EACH pocket judged on its own, not the union eroded as one: a part with 47 small
        // pockets and a couple of large ones (the organizer) would otherwise erode the WHOLE
        // union to nothing the moment ANY one pocket is smaller than 4r, excluding none of them
        // — the Manager's own "stop at each land's own Z" read literally, one pocket at a time.
        // Eroding by 2r (not subtracting the raw region) reaches exactly to the true wall, the
        // same erode-then-dilate-adjacent math the open-shoulder fix uses in reverse: a flat
        // offset by -2r shrinks a hole's boundary by 2r, and a tool of radius r standing r off
        // THAT boundary lands exactly r in from the true wall — minus the r the tool's own disc
        // reaches beyond its centre, zero overshoot, zero gap. A pocket smaller than 4r erodes to
        // nothing; its own first pass already covers its WHOLE footprint regardless of size, so
        // exclude the raw region there instead of excluding nothing.
        const excludeRegions: Polygons[] = [];
        for (const node of [...rootPocketNodes, ...throughNodes]) {
          // Eroding `node.region` AS GIVEN risks a degenerate result once an island is big
          // enough relative to the gap around it: eroding the solid by 2r also DILATES the
          // island hole by 2r, and an island whose own footprint plus 2r reaches the outer
          // boundary collapses the whole erosion (Clipper read it as consuming the island's own
          // top, which must stay land — the fixture's own island, 4x4 inside a 16x16 pocket,
          // hits exactly this). Eroding the OUTER ring(s) alone avoids it; each island is then
          // carved back OUT of the result explicitly, so it is never excluded regardless of how
          // that erosion behaves near it.
          const outer = node.region.filter((ring) => signedArea(ring) > 0);
          if (outer.length === 0) continue;
          let eroded = opts.offset(outer, -2 * toolRadius);
          if (eroded.length === 0) eroded = outer;
          for (const island of node.islands) {
            if (island.outline.length === 0) continue;
            // `subtract(a, b)` needs `b` wound POSITIVE on its own (a standalone filled shape,
            // not a hole nested inside another ring) — `features/tree.ts` does not populate
            // `islands` yet, so there is no established convention to match; this reverses a
            // CW ring rather than assume the caller already states it the way a standalone
            // subtract operand needs. A CW `island.outline` otherwise reads as zero/negative
            // area on its own, and `subtract` removes nothing — exactly the gap the island-top
            // coverage test caught.
            const standalone = island.outline.map((ring) => (signedArea(ring) < 0 ? [...ring].reverse() : ring));
            eroded = opts.boolean.subtract(eroded, standalone);
          }
          excludeRegions.push(eroded);
        }
        if (excludeRegions.length > 0) {
          let union = excludeRegions[0]!;
          for (const region of excludeRegions.slice(1)) union = opts.boolean.union(union, region);
          facingRegion = opts.boolean.subtract(grown, union);
        }
      }
      return pocket({
        cutter,
        node: {
          id: 'facing', floorZ: rebase(tree.top.z), mouthZ: rebase(z0), open: false, through: false,
          region: facingRegion, floors: [], islands: [], children: [], remainder: [], narrowest: Infinity,
        },
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
          node: { ...throughNode, mouthZ: rebase(z0), floorZ: rebase(throughNode.floorZ) },
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
    // root's own mouth is the stock top itself (finding 2), a nested node's is its parent's floor,
    // unaffected by the override — both still need the SAME `-z0` shift as `floorZ`.
    const mouthZAbs = rootIds.has(node.id) ? z0 : node.mouthZ;
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
  for (const [id, message] of regionFailures) notes.push(`${id}: not cut — planning failed (${message})`);
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
