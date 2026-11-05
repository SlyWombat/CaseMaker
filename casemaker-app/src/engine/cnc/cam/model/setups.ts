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
import type { CamMove, ToolpathIR } from '../ir';
import { toSetupFrame, type FeatureSource, type SetupFrame } from './features';
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
export function documentXY(frame: SetupFrame, x: number, y: number): [number, number] {
  const [ux, uy, uz] = frame.up;
  if (ux === 0 && uy === 0 && uz === 1) return [x, y];
  if (ux === 0 && uy === 0 && uz === -1) return [x, -y];
  throw new Error(`cam/model/setups: documentXY has no map for up = [${frame.up.join(', ')}] (#965 stated scope: axis-aligned top/bottom only)`);
}

function mapMove(m: CamMove, frame: SetupFrame): CamMove {
  const [x, y] = documentXY(frame, m.x, m.y);
  return { ...m, x, y };
}

/**
 * `documentXY`, applied to every move of a `ToolpathIR` that is about to become `SetupPlan.ops`/
 * `programs` — i.e. applied ONCE, after a setup's whole tree is planned, not inside any one op.
 * Identity (returns `ir` unchanged) for the top setup, so a single-setup job (today's only real
 * caller) sees byte-identical output.
 */
export function mapIRToDocument(ir: ToolpathIR, frame: SetupFrame): ToolpathIR {
  const [ux, uy, uz] = frame.up;
  if (ux === 0 && uy === 0 && uz === 1) return ir;
  return {
    ...ir,
    operations: ir.operations.map((op) => ({ ...op, moves: op.moves.map((m) => mapMove(m, frame)) })),
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
