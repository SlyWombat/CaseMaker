/**
 * cam/model/setups.ts — #965: the figures' multi-setup on the new engine.
 *
 * `ModelPlanInput.setups: SetupSpec[]` is `cam/model/plan.ts`'s own reserved interface point
 * ("#898/#914's flip plan ... fill this to more than one entry"). This module is that fill:
 *
 *   - `buildSetupSpecs` — the REACH-AWARE top+bottom decision, ported from `held/914-flip-plan`.
 *     That branch's reach-aware fields landed on THIS branch by applying its diff straight onto
 *     the still-present (pre-#914) `goalFlipPlan.ts`/`goalFlipSetups.ts` (a previous commit on
 *     this branch) — those two modules are shared, mesh/`Face`-level geometry utilities that the
 *     #956 rebuild never touched, so #914's reach work did not need re-deriving, only re-wiring
 *     into the new engine's `SetupFrame` vocabulary, which is this file's job.
 *   - `documentXY`/`mapIRToDocument` — the setup→document (world) XY map a flipped setup's
 *     posted moves need before they can be read on the SAME goal grid as the top setup's (the
 *     #948-v2 whole-surface union, and the #965 acceptance spec's own simpler direct
 *     accumulation, both assume this).
 *   - `rotatedGeometryFor` — the per-setup mesh `clSurface`'s drop-cutter needs (see its own doc
 *     on why `ModelPlanInput.geometry` alone is not enough once a setup's `frame.up` is not
 *     `[0, 0, 1]`).
 *
 * STATED SCOPE (not guessed): the figures this issue judges (#965's elephant/panther "stick" jobs,
 * per the approved #945 design note) are held in a VISE with the two long faces excluded as
 * candidates — the only two faces this module ever offers are `top` (the job's own orientation)
 * and `bottom` (the flip). A side flip (left/right/front/back) would need its own entry in
 * `frameForFace`/`documentXY` — `setups/orient.ts`'s own `orient()` shows those are each a
 * DIFFERENT rotation, not a generalisation of the top/bottom one — and is not implemented here.
 */

import type { Face, MountSpec } from '@/engine/cnc/setups/types';
import { goalFlipPlan, type FlipPlan, type FlipPlanInput, type FlipPlanReachInput } from '@/engine/cnc/engrave/goalFlipPlan';
import type { CoverageMesh, CoverageOptions } from '@/engine/cnc/engrave/goalCoverage';
import type { ParsedMesh } from '@/engine/import/stlParser';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { CamMove, ToolpathIR } from '../ir';
import { toSetupFrame, type FeatureSource, type FeatureTree, type PocketNode, type SetupFrame } from './features';
import type { SetupSpec } from './plan';

/** The only two faces this build's `goalFlipPlan` call is ever offered (see this file's header). */
const FLIPPABLE_FACES: readonly Face[] = ['top', 'bottom'];

export interface BuildSetupsInput {
  geometry: FeatureSource;
  underside: SetupSpec['underside'];
  mount: MountSpec;
  /** The stock's size in ITS OWN frame, mm — `goalFlipPlan`'s own `stockSize` (the vise-opening rule). */
  stockSize: { x: number; y: number; z: number };
  /**
   * World Z of the stock's top face as the geometry is placed, mm — what every `SetupFrame` this
   * function builds is rebased from. `0` is the figures' own placement convention
   * (`targetPlace.ts`'s `placeTarget`, `sampleGoalHeightfield`'s `stockTopZ`) and this field's
   * default.
   */
  stockTopZ?: number;
  targetFraction?: number;
  pitchMm?: number;
  coverage?: CoverageOptions;
  /** #914's reach-aware scoring — omitted keeps the plan geometry-only (`goalFlipPlan`'s own rule). */
  reach?: FlipPlanReachInput;
}

export interface BuildSetupsResult {
  setups: SetupSpec[];
  /** The full `goalFlipPlan` result this was built from — `sides[].neededMm`/`creditedMaxDepthMm`,
   *  `reach`, `stopped`, `dropped` are the numbers a caller states to the operator. */
  plan: FlipPlan;
}

/**
 * The reach-aware top+bottom decision (#914), re-wired onto `SetupSpec`/`SetupFrame`. #898's own
 * rule — ported from `held/914-flip-plan`'s `stockBottomExclusion` fix ("anchors on the stock's
 * own floor, not the goal's lowest point") — is applied FIRST, before `goalFlipPlan` ever runs:
 * `underside === 'flatOnStockBottom'` means the underside is pressed against the stock's own
 * floor BY DESIGN, so `bottom` is not offered as a candidate at all, never merely scored and
 * dropped as unreached.
 */
export function buildSetupSpecs(input: BuildSetupsInput): BuildSetupsResult {
  const stockTopZ = input.stockTopZ ?? 0;
  const mesh: CoverageMesh = { positions: input.geometry.triangles.positions, indices: input.geometry.triangles.indices };

  const candidateFaces =
    input.underside === 'flatOnStockBottom'
      ? {
          faces: [] as Face[],
          excludedReason:
            "the underside sits flat on the stock's own bottom (#898) — it is never cut, so it is not offered as a flip at all",
        }
      : {
          faces: FLIPPABLE_FACES,
          excludedReason: "the stick stock's vise-jaw and length-overhang faces are not cuttable surfaces here (#945 design note)",
        };

  const flipInput: FlipPlanInput = {
    mesh,
    firstUp: 'top',
    mount: input.mount,
    stockSize: input.stockSize,
    ...(input.pitchMm === undefined ? {} : { pitchMm: input.pitchMm }),
    ...(input.targetFraction === undefined ? {} : { targetFraction: input.targetFraction }),
    ...(input.coverage === undefined ? {} : { coverage: input.coverage }),
    ...(input.reach === undefined ? {} : { reach: input.reach }),
    candidateFaces,
  };
  const plan = goalFlipPlan(flipInput);

  const setups: SetupSpec[] = plan.sides.map((side) => ({
    frame: frameForFace(side.faceUp, input.mount, stockTopZ, input.stockSize.z),
    underside: input.underside,
  }));
  return { setups, plan };
}

/**
 * `Face` → `SetupFrame`, for exactly the two faces `buildSetupSpecs` ever offers. `toSetupFrame`'s
 * own degenerate case for `up = [0, 0, -1]` (`features.ts`) is a half turn about X — the SAME turn
 * `setups/orient.ts`'s `orient('bottom', mount, size)` returns for a VISE mount (`RX180`). A
 * bracket/tape mount's own bottom-flip is `RY180` (about Y) instead, which `documentXY` below does
 * NOT reproduce — stated here, not guessed, by refusing rather than posting a silently-wrong map.
 */
function frameForFace(face: Face, mount: MountSpec, stockTopZ: number, thicknessMm: number): SetupFrame {
  if (face === 'top') return { up: [0, 0, 1], stockTop: stockTopZ, stockBottom: stockTopZ - thicknessMm };
  if (face === 'bottom') {
    if (mount.kind !== 'vise') {
      throw new Error(
        `cam/model/setups: a 'bottom' setup is only wired for a vise mount (#965 stated scope) — a ${mount.kind} mount's own flip needs its own document-frame map`,
      );
    }
    return { up: [0, 0, -1], stockTop: thicknessMm - stockTopZ, stockBottom: -stockTopZ };
  }
  throw new Error(`cam/model/setups: '${face}' is not one of the two faces this build offers (#965 stated scope: top/bottom only)`);
}

/**
 * The setup-local XY → DOCUMENT (world) XY map, for exactly the two frames `frameForFace` builds.
 * `up = [0, 0, 1]` is the identity (the job's own orientation IS the document frame). `up =
 * [0, 0, -1]` is `toSetupFrame`'s own half turn about X — X unchanged, Y (and Z) negate — so a
 * flipped setup's local Y is the document's Y, mirrored; Z is never part of this map (a posted
 * program's Z is a MACHINE height, re-probed per setup — `SAFE_Z`/`HOP_Z`/the pocket chain's own
 * `z0` rebase — never a world coordinate, flipped setup or not).
 *
 * This is what lets a flipped setup's posted moves be read on the SAME goal grid the top setup's
 * already sit on — the #948-v2 whole-surface union's own precondition, and the #965 acceptance
 * spec's simpler direct accumulation (`exactSweptField` against one fixed `GoalHeightfield`) relies
 * on it just the same, silently, if this map is never applied.
 */
/**
 * `offset` (#965 registration, `registerSetupOrigin` below) is ADDED after the rotation-only map
 * — a pure translation, in document XY, mm. Defaulting to `[0, 0]` keeps every pre-#965
 * registration caller (every one today: no caller has ever passed a third argument) byte-for-byte
 * unchanged; `[0, 0]` is also what a registered setup gets back whenever its two setups' own
 * recognised features already agree with the rotation-only map (the common case for this module's
 * own axis-through-origin half-turn — see `registerSetupOrigin`'s header).
 */
export function documentXY(frame: SetupFrame, x: number, y: number, offset: readonly [number, number] = [0, 0]): [number, number] {
  const [ux, uy, uz] = frame.up;
  if (ux === 0 && uy === 0 && uz === 1) return [x + offset[0], y + offset[1]];
  if (ux === 0 && uy === 0 && uz === -1) return [x + offset[0], -y + offset[1]];
  throw new Error(`cam/model/setups: documentXY has no map for up = [${frame.up.join(', ')}] (#965 stated scope: axis-aligned top/bottom only)`);
}

function mapMove(m: CamMove, frame: SetupFrame, offset: readonly [number, number]): CamMove {
  const [x, y] = documentXY(frame, m.x, m.y, offset);
  return { ...m, x, y };
}

/**
 * `documentXY`, applied to every move of a `ToolpathIR` that is about to become `SetupPlan.ops`/
 * `programs` — i.e. applied ONCE, after a setup's whole tree is planned, not inside any one op.
 * Identity (returns `ir` unchanged) for the top setup with no offset, so a single-setup job
 * (today's only real caller) sees byte-identical output.
 */
export function mapIRToDocument(ir: ToolpathIR, frame: SetupFrame, offset: readonly [number, number] = [0, 0]): ToolpathIR {
  const [ux, uy, uz] = frame.up;
  if (ux === 0 && uy === 0 && uz === 1 && offset[0] === 0 && offset[1] === 0) return ir;
  return {
    ...ir,
    operations: ir.operations.map((op) => ({ ...op, moves: op.moves.map((m) => mapMove(m, frame, offset)) })),
  };
}

/**
 * The per-setup mesh `clSurface` needs (its own doc: "the ONE mesh `RemainderRegion.triangles`
 * indexes into"). `recogniseFeatures(geometry, frame, tl)` rotates `geometry.triangles` INTERNALLY
 * to build the `FeatureTree` (`toSetupFrame`), so every `RemainderRegion`'s triangle INDICES are
 * into that rotated mesh's vertex order — but its `triangles: Uint32Array` field is only indices,
 * never the positions they resolve into, and `clSurface(geometry, ...)` is handed
 * `ModelPlanInput.geometry` (the CALLER's original, UNROTATED mesh) at every call site today.
 * That is harmless while every job has exactly one setup at `up = [0, 0, 1]` (rotating by the
 * identity changes nothing) and WRONG the moment a setup's `frame.up` differs — `dropCutterHeight`
 * would then evaluate the cutter against the PART'S OLD ORIENTATION while the tree it is scored
 * against is in the NEW one. This function rebuilds the SAME rotated mesh `recogniseFeatures`
 * used, as its own `FeatureSource`, so a caller can pass IT (not `ModelPlanInput.geometry`
 * directly) to the curved pipeline for any setup whose frame is not the identity.
 */
export function rotatedGeometryFor(geometry: FeatureSource, frame: SetupFrame): FeatureSource {
  const [ux, uy, uz] = frame.up;
  if (ux === 0 && uy === 0 && uz === 1) return geometry;
  const rotated = toSetupFrame(geometry.triangles, frame.up);
  const positions = Float32Array.from(rotated.positions);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const triangles: ParsedMesh = {
    positions,
    indices: rotated.indices,
    triangleCount: geometry.triangles.triangleCount,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
  return { triangles, ...(geometry.faceId === undefined ? {} : { faceId: geometry.faceId }) };
}

/*
 * #965 REGISTRATION — the vise-flip setup's origin, computed from locating features, not
 * assumed from the vise alone.
 *
 * `plan.ts`'s own #965 open-item note stated the gap exactly: "registration against setup N-1's
 * own cut features... is left to the operator's fixture/jig, not computed here." `frameForFace`
 * above gets the physical turn-over's ROTATION right (the vise flip is a half turn about the
 * X axis, the SAME one `toSetupFrame`/`documentXY` apply), but a rotation alone says nothing
 * about where that turn's AXIS actually sits relative to the stock. `toSetupFrame` rotates about
 * the mesh's own coordinate origin (Y = 0, Z = 0) — i.e. it is only the real flip when the
 * physical turn-over happens to pivot exactly there. A dowel-pinned flip (two holes reseated on
 * two pins) or an edge-against-a-stop flip pivots wherever THOSE features put it, which may not
 * be the mesh's coordinate origin at all. `registerSetupOrigin` below answers this the only way
 * that is not a guess: recognise the SAME physical locating feature (a hole, an edge) in BOTH
 * setups' own `FeatureTree`s, read where setup 0 says it is (document XY, ground truth — setup 0
 * IS the document frame) and where setup N's naive `documentXY` map says it is, and report the
 * DIFFERENCE as `offsetMm`. That offset is computed from real recognised geometry every time,
 * never assumed to be `[0, 0]` — it comes out as `[0, 0]` whenever the two setups' own recognised
 * positions already agree (which is always, for THIS module's own axis-through-origin half-turn,
 * since `documentXY`'s formula is exactly `toSetupFrame`'s own inverse rotation — see the proof in
 * this function's own tests), and would come out non-zero the moment that stops being true (a
 * different pivot, a side flip with its own rotation, anything this module does not yet model).
 *
 * WHERE THE COMPUTED ORIGIN LIVES (the Manager's #965 ask): a SEPARATE return value
 * (`SetupRegistration`), not a new field on `SetupFrame`. `SetupFrame` is built by
 * `buildSetupSpecs`/`frameForFace` BEFORE any feature is recognised — it is a pure rotation/Z-datum
 * description that `recogniseFeatures`, `clSurface` (via `rotatedGeometryFor`) and `documentXY`
 * all consume as-is, and every one of those call sites would have to decide whether to honour a
 * new `SetupFrame.originOffset` field or silently ignore it. The registration offset, by
 * contrast, can only be computed once BOTH setups' trees exist (it compares setup 0's recognised
 * features against setup N's), so it is a function of two `FeatureTree`s, returned on its own and
 * applied by the one caller that already owns the setup→document map: `documentXY`/
 * `mapIRToDocument`'s new optional `offset` parameter, above.
 */

/** One through-hole's centre, document XY, mm. */
export interface LocatingHole {
  id: string;
  x: number;
  y: number;
}

export interface HolePairDatum {
  basis: 'two-holes';
  holes: [LocatingHole, LocatingHole];
  separationMm: number;
}

export interface EdgeDatum {
  basis: 'edge';
  /** The chosen straight outline run's two endpoints, setup 0's own document XY, mm. */
  endpoints: [[number, number], [number, number]];
  lengthMm: number;
}

export type LocatingDatum = HolePairDatum | EdgeDatum;

export interface SetupRegistration {
  datum: LocatingDatum;
  /**
   * Setup N's origin relative to setup 0, document XY, mm — ADD this to `documentXY`'s own
   * rotation-only map (its new `offset` parameter) so the chosen datum reads at the SAME document
   * position under both setups. `[0, 0]` is a COMPUTED agreement, never an unchecked default — see
   * this file's registration header.
   */
  offsetMm: [number, number];
}

/**
 * CHOSEN THRESHOLDS, stated here because no rule in the issue or the design note fixes them
 * (per the issue's own ask: state the rule explicitly rather than pick one silently).
 *
 *  - `MIN_HOLE_SEPARATION_MM = 10`: two dowel holes closer than this cannot anchor a reliable
 *    orientation — a small angular/placement error at the pins turns into a large swing at the
 *    far end of the part when the pins themselves are close together. 10 mm is a dowel-pin-scale
 *    number (typical locating dowels are 3-6 mm, so this asks the pair to be at least a couple of
 *    pin-diameters apart), not a measured bench figure.
 *  - `MIN_EDGE_LENGTH_MM = 15`: an edge datum has no "two points far apart" baseline of its own —
 *    its own length IS the baseline — so it is asked to clear a somewhat higher bar than the hole
 *    pair's separation.
 *  - `COLLINEAR_TOL_RAD ≈ 0.057°`: merges a polygon's own subdivided straight edges (Clipper's
 *    output chops a long straight run into several collinear segments) back into one run, without
 *    merging a genuine shallow corner.
 *  - `OFFSET_CONSISTENCY_TOL_MM = 1e-3`: the two ends of one chosen datum (the pair's two holes,
 *    or one edge's two endpoints) must agree with each other about the offset to within this —
 *    for THIS module's pure rotation-about-origin model that agreement is exact up to floating
 *    point, so a real disagreement past this band means the candidate is not a trustworthy datum
 *    (the wrong hole/edge was matched, or the part's geometry does not actually support a simple
 *    top/bottom flip), and that candidate is discarded rather than averaged over. Reused, same
 *    value, as the #966 WHOLE-DATASET validation tolerance below.
 *
 * #966 MIRROR-TWIN FIX: a chosen datum's own two ends agreeing with each other (the check above)
 * only proves the pairing is SOME rigid translation — it says nothing about whether it is the
 * RIGHT one. A part with a mirror-twin feature (two parallel edges of identical length that map
 * onto each other under the flip's own half-turn — the "lying cylinder" case; the hole-pair
 * analogue is a periodic/evenly-spaced hole row) can have TWO candidate pairings that each pass
 * that check while disagreeing about the real offset — the lying-cylinder case silently returned
 * `[0, -20]` instead of the true `[0, 0]` before this fix (`registrationAmbiguity966.spec.ts`).
 * `outlineMatches`
 * (edge datum) and the all-matched-holes check inside `tryHolePair` (hole datum) are the
 * SECOND, independent test this fix adds: does the candidate offset, cast over EVERY OTHER
 * recognised point of the SAME datum — not just the two that produced it — still agree? A finite
 * point set translated by a non-zero vector moves its own centroid, so at most one offset can
 * make a translated point set equal another SET-FOR-SET (not just two points of it); the "rest of
 * the outline"/"the rest of the holes" is therefore a genuine second datum whenever it has more
 * than the two points the candidate was built from, and it is what lets `tryEdge`/`tryHolePair`
 * RESOLVE the lying-cylinder case to `[0, 0]` outright rather than merely refusing it. Only when
 * more than one candidate survives even that whole-dataset check (the datum truly has no feature,
 * anywhere in its own recognised geometry, left to tell the mirror twins apart) do they throw the
 * new named "ambiguous" error below, instead of guessing.
 */
const MIN_HOLE_SEPARATION_MM = 10;
const MIN_EDGE_LENGTH_MM = 15;
const COLLINEAR_TOL_RAD = 1e-3;
const OFFSET_CONSISTENCY_TOL_MM = 1e-3;

const dist = (a: readonly [number, number], b: readonly [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Groups offsets that agree with each other (within `OFFSET_CONSISTENCY_TOL_MM`) — #966's own
 * "is there more than one surviving answer" check, shared by `tryEdge` and `tryHolePair`. More
 * than one group back is the ambiguous case: two (or more) candidates that each individually
 * passed their own validation but disagree with EACH OTHER about the real offset.
 */
function groupByOffset(offsets: readonly (readonly [number, number])[]): [number, number][][] {
  const groups: [number, number][][] = [];
  for (const o of offsets) {
    const g = groups.find((candidate) => dist(candidate[0]!, o) <= OFFSET_CONSISTENCY_TOL_MM);
    if (g) g.push([o[0], o[1]]);
    else groups.push([[o[0], o[1]]]);
  }
  return groups;
}

const AMBIGUOUS_MESSAGE_PREFIX = 'cam/model/setups: the vise-flip registration is ambiguous (#966 registration) — ';

/** Area-weighted polygon centroid (shoelace form); the vertex average for a near-zero-area ring. */
function ringCentroid(ring: readonly (readonly [number, number])[]): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[(i + 1) % ring.length]!;
    const cross = x0 * y1 - x1 * y0;
    a += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of ring) {
      sx += x;
      sy += y;
    }
    return [sx / ring.length, sy / ring.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

function regionCentroid(region: Polygons, id: string): [number, number] {
  const outer = region[0];
  if (outer === undefined || outer.length < 3) {
    throw new Error(`cam/model/setups: through-hole "${id}" has no outer ring to centre a registration datum on (#965 registration)`);
  }
  return ringCentroid(outer);
}

function allThroughHoles(nodes: PocketNode[]): PocketNode[] {
  const out: PocketNode[] = [];
  for (const n of nodes) {
    if (n.through) out.push(n);
    out.push(...allThroughHoles(n.children));
  }
  return out;
}

/** Every through-hole's centre, in DOCUMENT xy (this tree's own `documentXY`, no offset yet). */
function documentHoles(tree: FeatureTree): LocatingHole[] {
  return allThroughHoles(tree.pockets).map((n) => {
    const [x, y] = regionCentroid(n.region, n.id);
    const [dx, dy] = documentXY(tree.frame, x, y);
    return { id: n.id, x: dx, y: dy };
  });
}

/**
 * Greedy nearest-neighbour correspondence between setup 0's holes and setup N's own
 * naive-document-mapped holes — correct as long as the real offset is small next to the holes'
 * OWN spacing, which `MIN_HOLE_SEPARATION_MM` exists to make true. Not a global min-cost
 * assignment: with the small hole counts this module ever sees (a part's own dowel/locating
 * holes, not every hole in it), greedy is enough, and a wrong greedy pick is caught by the
 * separation/consistency checks the caller applies to the result.
 */
function matchHoles(holes0: readonly LocatingHole[], holesN: readonly LocatingHole[]): { h0: LocatingHole; hN: LocatingHole }[] | null {
  if (holes0.length < 2 || holesN.length < 2) return null;
  const used = new Set<number>();
  const matches: { h0: LocatingHole; hN: LocatingHole }[] = [];
  for (const h0 of holes0) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let j = 0; j < holesN.length; j++) {
      if (used.has(j)) continue;
      const d = dist([h0.x, h0.y], [holesN[j]!.x, holesN[j]!.y]);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }
    if (bestIdx === -1) return null;
    used.add(bestIdx);
    matches.push({ h0, hN: holesN[bestIdx]! });
  }
  return matches;
}

/** `a.h0 - a.hN`, document XY — one matched hole's own implied offset. */
function holeDelta(m: { h0: LocatingHole; hN: LocatingHole }): [number, number] {
  return [m.h0.x - m.hN.x, m.h0.y - m.hN.y];
}

/**
 * The two-through-hole datum (strategy (a)). Tries every matched pair, widest separation first:
 * a pair survives only if its own two holes AGREE with each other about the offset (within
 * `OFFSET_CONSISTENCY_TOL_MM`, the ORIGINAL #965 check — see this file's threshold note for why
 * disagreement discards a candidate instead of averaging over it), AND — #966's own addition —
 * that SAME offset also agrees with EVERY OTHER matched hole, not only the two the pair was built
 * from. Two holes agreeing with each other only proves their pairing is SOME rigid translation; a
 * periodic/evenly-spaced row of holes (three or more, evenly spaced) can have a "shift by one
 * hole" mismatch that is internally self-consistent for the pair chosen yet wrong — the OTHER
 * holes' own deltas, mismatched the same wrong way, give it away (`registrationAmbiguity966.spec.ts`).
 * For exactly two holes this added check is a no-op (there is nothing else to check against) — a
 * provable, not merely observed, fact: two DISTINCT points related by one assumed global
 * translation admit at most one self-consistent correspondence (swapping which hole maps to which
 * would need the two tree-0 holes to coincide, which `MIN_HOLE_SEPARATION_MM` already rules out) —
 * so this file's own `registration965.spec.ts` two-hole cases are unaffected by this change.
 *
 * `null` when no matched pair clears `MIN_HOLE_SEPARATION_MM` at all, or no pair that does also
 * survives both consistency checks (a genuinely mismatched hole set — #966 prefers this safe
 * `null`, falling through to the edge strategy or the final named refusal, over naming a
 * wrong-but-plausible pair "ambiguous" when the real defect is that the correspondence itself
 * never resolved at all).
 */
function tryHolePair(tree0: FeatureTree, treeN: FeatureTree): SetupRegistration | null {
  const matches = matchHoles(documentHoles(tree0), documentHoles(treeN));
  if (matches === null || matches.length < 2) return null;

  const pairs: { i: number; j: number; separationMm: number }[] = [];
  for (let i = 0; i < matches.length; i++) {
    for (let j = i + 1; j < matches.length; j++) {
      pairs.push({ i, j, separationMm: dist([matches[i]!.h0.x, matches[i]!.h0.y], [matches[j]!.h0.x, matches[j]!.h0.y]) });
    }
  }
  pairs.sort((a, b) => b.separationMm - a.separationMm);

  const validated: { offset: [number, number]; holes: [LocatingHole, LocatingHole]; separationMm: number }[] = [];
  for (const { i, j, separationMm } of pairs) {
    if (separationMm < MIN_HOLE_SEPARATION_MM) break; // sorted descending — no later pair clears it either.
    const a = matches[i]!;
    const b = matches[j]!;
    const deltaA = holeDelta(a);
    const deltaB = holeDelta(b);
    if (dist(deltaA, deltaB) > OFFSET_CONSISTENCY_TOL_MM) continue; // this pair does not agree with itself — discard, try the next.
    const offset: [number, number] = [(deltaA[0] + deltaB[0]) / 2, (deltaA[1] + deltaB[1]) / 2];
    // #966: self-consistent for THIS pair — does it also agree with every OTHER matched hole?
    if (!matches.every((m) => dist(holeDelta(m), offset) <= OFFSET_CONSISTENCY_TOL_MM)) continue;
    validated.push({ offset, holes: [a.h0, b.h0], separationMm });
  }
  if (validated.length === 0) return null;

  const groups = groupByOffset(validated.map((v) => v.offset));
  if (groups.length > 1) {
    throw new Error(
      AMBIGUOUS_MESSAGE_PREFIX +
        'more than one matched through-hole pair is self-consistent (and agrees with every other recognised ' +
        `hole) on its own, but the pairs disagree with EACH OTHER about the real offset (found ${groups
          .map((g) => `[${g[0]![0]}, ${g[0]![1]}]`)
          .join(' vs ')} mm); refusing rather than guessing which pair is the real vise-flip correspondence`,
    );
  }
  const best = validated.reduce((b, v) => (v.separationMm > b.separationMm ? v : b));
  return { datum: { basis: 'two-holes', holes: best.holes, separationMm: best.separationMm }, offsetMm: best.offset };
}

interface StraightRun {
  a: [number, number];
  b: [number, number];
  lengthMm: number;
}

/**
 * Consecutive collinear edges of a closed ring, merged into runs (Clipper's own output subdivides
 * a long straight outline edge into several collinear segments). Starts from a genuine corner
 * (an edge not collinear with the one before it) so no run is split across the array's own
 * wraparound point; returns `[]` for a degenerate ring where every edge is collinear with the
 * last (not a real closed polygon).
 */
function straightRuns(ring: readonly (readonly [number, number])[]): StraightRun[] {
  const n = ring.length;
  if (n < 3) return [];
  const dirOf = (i: number): [number, number] => {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const len = Math.hypot(dx, dy);
    return len > 1e-9 ? [dx / len, dy / len] : [0, 0];
  };
  const dirs = Array.from({ length: n }, (_, i) => dirOf(i));
  const collinear = (i: number, j: number): boolean => {
    const [ax, ay] = dirs[i]!;
    const [bx, by] = dirs[j]!;
    const cos = Math.min(1, Math.max(-1, ax * bx + ay * by));
    return Math.acos(cos) <= COLLINEAR_TOL_RAD;
  };
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (!collinear((i - 1 + n) % n, i)) {
      start = i;
      break;
    }
  }
  if (start === -1) return [];

  const runs: StraightRun[] = [];
  let runStart = start;
  let i = start;
  for (let steps = 0; steps < n; steps++) {
    const next = (i + 1) % n;
    if (steps === n - 1 || !collinear(i, next)) {
      const a: [number, number] = [ring[runStart]![0], ring[runStart]![1]];
      const b: [number, number] = [ring[next]![0], ring[next]![1]];
      runs.push({ a, b, lengthMm: dist(a, b) });
      runStart = next;
    }
    i = next;
  }
  return runs;
}

/**
 * EVERY outer-ring straight run at least `MIN_EDGE_LENGTH_MM` long, document XY (this tree's own
 * `documentXY`, no offset) — #966's own change from the original "the single longest run only".
 * A tied-length pair (the lying-cylinder case: two parallel edges of identical length, each the
 * flip's mirror twin of the other) must be seen as TWO candidates, not silently collapsed to
 * whichever one a `reduce`'s own tie-break (first-encountered wins) happened to prefer — that
 * silent collapse is exactly how the original bug returned a wrong offset without ever tripping
 * its own consistency check (see this file's #966 header note).
 */
function candidateOutlineRuns(tree: FeatureTree): StraightRun[] {
  const outer = tree.contour.outline[0];
  if (outer === undefined) return [];
  const mapped = outer.map(([x, y]) => documentXY(tree.frame, x, y));
  return straightRuns(mapped).filter((r) => r.lengthMm >= MIN_EDGE_LENGTH_MM);
}

/**
 * #966's own SECOND, independent check (this file's header note): does `offset`, applied to
 * EVERY point of `treeN`'s own recognised outline — not just the two endpoints of one candidate
 * edge — reproduce `tree0`'s own outline, point for point, as a SET (the two rings may start at a
 * different vertex, or wind the opposite way, once setup N's mirror-Y map is applied, so this is
 * a set match, not a sequence match)? A bijective nearest-match: every mapped point of `treeN`
 * claims a DIFFERENT, close point of `tree0`'s, with none left over on either side (`undefined`/
 * length-mismatched outlines fail closed, never silently "mostly" match).
 */
function outlineMatches(tree0: FeatureTree, treeN: FeatureTree, offset: readonly [number, number]): boolean {
  const outer0 = tree0.contour.outline[0];
  const outerN = treeN.contour.outline[0];
  if (outer0 === undefined || outerN === undefined || outer0.length !== outerN.length || outer0.length === 0) return false;
  const mapped0 = outer0.map(([x, y]) => documentXY(tree0.frame, x, y));
  const mappedN = outerN.map(([x, y]) => documentXY(treeN.frame, x, y, offset));
  const claimed = new Set<number>();
  for (const p of mappedN) {
    let found = -1;
    for (let i = 0; i < mapped0.length; i++) {
      if (claimed.has(i)) continue;
      if (dist(p, mapped0[i]!) <= OFFSET_CONSISTENCY_TOL_MM) {
        found = i;
        break;
      }
    }
    if (found === -1) return false;
    claimed.add(found);
  }
  return true;
}

/**
 * The single-straight-edge datum (strategy (b)). Every candidate run in `tree0` is matched
 * against every length-matching candidate in `treeN`, pairing endpoints the way that minimises
 * their total distance (the two rings wind OPPOSITE ways once setup N's mirror-Y map is applied,
 * so the "first" endpoint of one is the "second" of the other) — a pairing that disagrees with
 * ITSELF (the original #965 per-edge check) is dropped immediately; one that agrees with itself
 * must then also pass `outlineMatches` (#966) before it is trusted. A mirror-twin pairing (the
 * lying-cylinder case) passes the per-edge check in both directions but only the one true to the
 * WHOLE outline survives `outlineMatches` — see this file's #966 header note for why that is not
 * merely "one more heuristic" but provably decisive (a translated finite point set can equal
 * another, set for set, for at most one translation). `null` when no candidate survives either
 * check at all (falls through to the final named refusal); throws the new named "ambiguous" error
 * when more than one SURVIVING candidate disagrees with the others about the offset — a shape
 * whose own recognised outline genuinely carries no feature anywhere capable of telling its
 * mirror twins apart.
 */
function tryEdge(tree0: FeatureTree, treeN: FeatureTree): SetupRegistration | null {
  const candidates0 = candidateOutlineRuns(tree0);
  const candidatesN = candidateOutlineRuns(treeN);
  if (candidates0.length === 0 || candidatesN.length === 0) return null;

  const validated: { offset: [number, number]; run0: StraightRun }[] = [];
  for (const run0 of candidates0) {
    for (const runN of candidatesN) {
      if (Math.abs(run0.lengthMm - runN.lengthMm) > OFFSET_CONSISTENCY_TOL_MM) continue; // not the same physical edge length.

      const straight = dist(run0.a, runN.a) + dist(run0.b, runN.b);
      const swapped = dist(run0.a, runN.b) + dist(run0.b, runN.a);
      const [pa, pb] = straight <= swapped ? [runN.a, runN.b] : [runN.b, runN.a];

      const deltaA: [number, number] = [run0.a[0] - pa[0], run0.a[1] - pa[1]];
      const deltaB: [number, number] = [run0.b[0] - pb[0], run0.b[1] - pb[1]];
      if (dist(deltaA, deltaB) > OFFSET_CONSISTENCY_TOL_MM) continue; // disagrees with itself — discard.

      const offset: [number, number] = [(deltaA[0] + deltaB[0]) / 2, (deltaA[1] + deltaB[1]) / 2];
      if (!outlineMatches(tree0, treeN, offset)) continue; // #966: self-consistent for this ONE edge, but not the whole outline.
      validated.push({ offset, run0 });
    }
  }
  if (validated.length === 0) return null;

  const groups = groupByOffset(validated.map((v) => v.offset));
  if (groups.length > 1) {
    throw new Error(
      AMBIGUOUS_MESSAGE_PREFIX +
        'this part\'s own recognised outline admits more than one equally self-consistent edge-datum offset, ' +
        `each reproducing a DIFFERENT pair of edges of the SAME outline (found ${groups
          .map((g) => `[${g[0]![0]}, ${g[0]![1]}]`)
          .join(' vs ')} mm); refusing rather than guessing which one is the real vise-flip correspondence`,
    );
  }
  const best = validated.reduce((b, v) => (v.run0.lengthMm > b.run0.lengthMm ? v : b));
  return { datum: { basis: 'edge', endpoints: [best.run0.a, best.run0.b], lengthMm: best.run0.lengthMm }, offsetMm: best.offset };
}

/**
 * THE ENTRY — #965 registration. `tree0` is setup 0's own recognised `FeatureTree` (the
 * document-frame ground truth: setup 0's `frame.up` is always `[0, 0, 1]`, the identity, per this
 * module's stated scope); `treeN` is setup N's (`N > 0`, the flip). Tries the two-hole datum
 * first (the more rigid, two-point anchor — an edge alone cannot detect an offset ALONG its own
 * length), then the single-edge datum, and THROWS, naming the issue, when the part carries
 * neither — never falls back to a guessed/nominal `[0, 0]` offset. Either strategy can ALSO throw
 * its own #966 "ambiguous" error directly (propagated unmodified, never caught here) when its own
 * candidate survives every per-candidate check but still disagrees with another, equally-valid
 * one — a mirror-twin feature with nothing else in the part's own recognised geometry to tell the
 * twins apart. Never returns an offset indistinguishable from its own mirror image.
 */
export function registerSetupOrigin(tree0: FeatureTree, treeN: FeatureTree): SetupRegistration {
  const holeDatum = tryHolePair(tree0, treeN);
  if (holeDatum !== null) return holeDatum;
  const edgeDatum = tryEdge(tree0, treeN);
  if (edgeDatum !== null) return edgeDatum;
  throw new Error(
    'cam/model/setups: no locating features found for the vise flip (#965 registration) — ' +
      `neither two through-holes at least ${MIN_HOLE_SEPARATION_MM} mm apart nor a single straight outline edge at least ` +
      `${MIN_EDGE_LENGTH_MM} mm long survive, consistently, in both setup 0's and this setup's own recognised geometry; ` +
      'this part cannot carry a computed vise-flip registration and must not be silently assumed aligned',
  );
}
