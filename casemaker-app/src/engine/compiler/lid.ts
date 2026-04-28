import type { CaseParameters, BoardProfile, HatPlacement, HatProfile } from '@/types';
import { cube, cylinder, difference, translate, union, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';
import { computeBossPlacements, getScrewClearanceDiameter } from './bosses';
import { computeHatBaseZ } from './hats';

// Issue #46 — local helper so the lid layer doesn't need every callsite to
// pass `() => undefined`; lid.ts can simply forward the project's resolver.
type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;

const LID_POST_BOARD_CLEARANCE = 0.3;
const RECESS_LEDGE = 1; // shelf the lid sits on
const RECESS_CLEARANCE = 0.2; // gap on each side between lid edge and pocket wall

// Friction-fit clearance (mm) and depth (mm) for the Full-Lid snap variant
// (issue #78). Barb snap variant doesn't use these.
const SNAP_FRICTION = 0.2;
const SNAP_LIP_DEPTH = 4;

export interface LidDims {
  x: number;
  y: number;
  z: number;
  zPosition: number;
  liftAboveShell: number;
}

/**
 * Recessed-lid pocket dimensions (issue #30). The lid drops into the top of
 * the case, sitting on a 1mm horizontal ledge with a small clearance around
 * the perimeter. Returns null when lidRecess is disabled.
 */
export function computeRecessDims(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): { pocketX: number; pocketY: number; pocketZ: number; ledge: number; clearance: number } | null {
  if (!params.lidRecess) return null;
  const dims = computeShellDims(board, params, hats, resolveHat);
  const offset = Math.max(0.5, params.wallThickness - 0.5);
  return {
    pocketX: dims.cavityX + 2 * offset,
    pocketY: dims.cavityY + 2 * offset,
    pocketZ: params.lidThickness,
    ledge: RECESS_LEDGE,
    clearance: RECESS_CLEARANCE,
  };
}

export function computeLidDims(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): LidDims {
  const dims = computeShellDims(board, params, hats, resolveHat);
  const recess = computeRecessDims(board, params, hats, resolveHat);
  if (recess) {
    return {
      x: recess.pocketX - 2 * recess.clearance,
      y: recess.pocketY - 2 * recess.clearance,
      z: params.lidThickness,
      zPosition: dims.outerZ - params.lidThickness,
      liftAboveShell: 2,
    };
  }
  return {
    x: dims.outerX,
    y: dims.outerY,
    z: params.lidThickness,
    zPosition: dims.outerZ,
    liftAboveShell: 2,
  };
}

/**
 * Build the lid posts that clamp the board from above. Used by every joint type
 * (issue #27): a flat-lid case still needs the posts to retain the board, the
 * only difference is whether the post carries a screw clearance hole.
 */
function buildLidPosts(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): { posts: BuildOp[]; holes: BuildOp[]; postLength: number } {
  const dims = computeShellDims(board, params, hats, resolveHat);
  const placements = computeBossPlacements(board, params);
  const standoff = board.defaultStandoffHeight;
  // The post anchor is normally the top of the host PCB. With HATs present
  // the post would otherwise pierce through every HAT board on its way down,
  // so anchor at the top of the topmost HAT (PCB top + tallest +z component
  // on that HAT) instead. The HAT itself is clamped to the host by its
  // header pins; the lid post just bears down on the HAT's top surface.
  let anchorTopWorld = params.floorThickness + standoff + board.pcb.size.z;
  const enabledHats = (hats ?? []).filter((h) => h.enabled);
  if (enabledHats.length > 0) {
    const baseZ = computeHatBaseZ(board, params, enabledHats, resolveHat);
    for (const placement of enabledHats) {
      const profile = resolveHat(placement.hatId);
      const z0 = baseZ.get(placement.id);
      if (!profile || z0 === undefined) continue;
      const tallestPlus = profile.components.reduce(
        (m, c) => Math.max(m, c.position.z + c.size.z),
        profile.pcb.size.z,
      );
      const top = z0 + tallestPlus;
      if (top > anchorTopWorld) anchorTopWorld = top;
    }
  }
  const lidBottomWorld = dims.outerZ;
  const postLength = Math.max(0, lidBottomWorld - anchorTopWorld - LID_POST_BOARD_CLEARANCE);
  if (postLength <= 0 || placements.length === 0) {
    return { posts: [], holes: [], postLength };
  }
  const screwDia =
    params.joint === 'screw-down'
      ? getScrewClearanceDiameter(params.bosses.insertType)
      : 0;
  const posts: BuildOp[] = placements.map((b) =>
    translate([b.x, b.y, -postLength], cylinder(postLength, b.outerDiameter / 2, 32)),
  );
  const holes: BuildOp[] =
    screwDia > 0
      ? placements.map((b) => {
          const totalH = params.lidThickness + postLength + 1;
          return translate(
            [b.x, b.y, -postLength - 0.5],
            cylinder(totalH, screwDia / 2, 24),
          );
        })
      : [];
  return { posts, holes, postLength };
}

function attachPosts(plate: BuildOp, posts: BuildOp[], holes: BuildOp[]): BuildOp {
  if (posts.length === 0) return plate;
  const solid = union([plate, ...posts]);
  return holes.length > 0 ? difference([solid, ...holes]) : solid;
}

export function buildFlatLid(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): BuildOp {
  const lid = computeLidDims(board, params, hats, resolveHat);
  const plate = cube([lid.x, lid.y, lid.z], false);
  const { posts, holes } = buildLidPosts(board, params, hats, resolveHat);
  return attachPosts(plate, posts, holes);
}

export function buildSnapFitLid(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): BuildOp {
  const dims = computeShellDims(board, params, hats, resolveHat);
  const topPlate = cube([dims.outerX, dims.outerY, params.lidThickness], false);
  const { posts, holes } = buildLidPosts(board, params, hats, resolveHat);

  // Issue #78 — snapType selects the lid style:
  //  - 'barb' (default): flat plate, retention via discrete arms in
  //    snapOps.lidAdd. The case-side inside-wall lips engage the arms.
  //  - 'full-lid': continuous perimeter lip ring providing friction fit
  //    against the cavity walls. Snap arms are still added on top if
  //    present.
  if (params.snapType !== 'full-lid') {
    return attachPosts(topPlate, posts, holes);
  }

  // Full-Lid variant — restored from the pre-#73 implementation.
  const wall = params.wallThickness;
  const lipOuterX = dims.cavityX - 2 * SNAP_FRICTION;
  const lipOuterY = dims.cavityY - 2 * SNAP_FRICTION;
  const lipOriginX = wall + SNAP_FRICTION;
  const lipOriginY = wall + SNAP_FRICTION;

  // Degenerate-cavity guard from issue #42.
  const lipWallNominal = Math.max(0.8, wall - 0.6);
  const minInnerDim = 1.0;
  const maxLipWallX = (lipOuterX - minInnerDim) / 2;
  const maxLipWallY = (lipOuterY - minInnerDim) / 2;
  const lipWall = Math.min(lipWallNominal, maxLipWallX, maxLipWallY);
  const canBuildLip = lipOuterX > minInnerDim && lipOuterY > minInnerDim && lipWall >= 0.4;
  if (!canBuildLip) return attachPosts(topPlate, posts, holes);

  const lipInnerX = lipOuterX - 2 * lipWall;
  const lipInnerY = lipOuterY - 2 * lipWall;

  const lipOuter = translate(
    [lipOriginX, lipOriginY, -SNAP_LIP_DEPTH],
    cube([lipOuterX, lipOuterY, SNAP_LIP_DEPTH], false),
  );
  const lipInner = translate(
    [lipOriginX + lipWall, lipOriginY + lipWall, -SNAP_LIP_DEPTH - 0.5],
    cube([lipInnerX, lipInnerY, SNAP_LIP_DEPTH + 1], false),
  );
  const lipRing = difference([lipOuter, lipInner]);
  const withPosts = posts.length > 0 ? union([topPlate, lipRing, ...posts]) : union([topPlate, lipRing]);
  return holes.length > 0 ? difference([withPosts, ...holes]) : withPosts;
}

export function buildScrewDownLid(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): BuildOp {
  const dims = computeShellDims(board, params, hats, resolveHat);
  const plate = cube([dims.outerX, dims.outerY, params.lidThickness], false);
  const { posts, holes } = buildLidPosts(board, params, hats, resolveHat);
  return attachPosts(plate, posts, holes);
}

export function buildLid(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
): BuildOp {
  // When recessed, every joint variant produces a flat plate sized to the
  // recess pocket; the joint flavor only adds posts / holes / snap arms.
  if (params.lidRecess) {
    const lid = computeLidDims(board, params, hats, resolveHat);
    const plate = cube([lid.x, lid.y, lid.z], false);
    const { posts, holes } = buildLidPosts(board, params, hats, resolveHat);
    return attachPosts(plate, posts, holes);
  }
  switch (params.joint) {
    case 'snap-fit':
      return buildSnapFitLid(board, params, hats, resolveHat);
    case 'screw-down':
      return buildScrewDownLid(board, params, hats, resolveHat);
    case 'flat-lid':
    default:
      return buildFlatLid(board, params, hats, resolveHat);
  }
}
