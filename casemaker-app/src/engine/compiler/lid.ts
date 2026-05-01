import type { CaseParameters, BoardProfile, HatPlacement, HatProfile } from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cube, cylinder, difference, roundedRectPrism, translate, union, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';
import { computeBossPlacements, getScrewClearanceDiameter } from './bosses';
import { computeHatBaseZ } from './hats';

// Issue #46 — local helper so the lid layer doesn't need every callsite to
// pass `() => undefined`; lid.ts can simply forward the project's resolver.
type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;
type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

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
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): { pocketX: number; pocketY: number; pocketZ: number; ledge: number; clearance: number } | null {
  if (!params.lidRecess) return null;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
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
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): LidDims {
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const recess = computeRecessDims(board, params, hats, resolveHat, display, resolveDisplay);
  if (recess) {
    return {
      x: recess.pocketX - 2 * recess.clearance,
      y: recess.pocketY - 2 * recess.clearance,
      z: params.lidThickness,
      zPosition: dims.outerZ - params.lidThickness,
      // Issue #79 — when the lid is recessed it sits IN a pocket flush with
      // the rim, so a 2 mm exploded gap is hard to read at default zoom.
      // Lift further (6 mm) so the user can see the rim, the shelf, and the
      // floating lid as three distinct surfaces.
      liftAboveShell: 6,
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
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): { posts: BuildOp[]; holes: BuildOp[]; postLength: number } {
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
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
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): BuildOp {
  const lid = computeLidDims(board, params, hats, resolveHat, display, resolveDisplay);
  // Issue #81 — non-recessed flat-lid plate matches the case envelope's
  // outer corner radius so the lid silhouette aligns with the rim.
  const plate = roundedRectPrism(lid.x, lid.y, lid.z, lidOuterCornerRadius(params));
  const { posts, holes } = buildLidPosts(board, params, hats, resolveHat, display, resolveDisplay);
  return attachPosts(plate, posts, holes);
}

/**
 * Issue #81 — vertical-corner radius applied to the lid plate. For a
 * recessed lid the pocket radius determines this; for a flat lid the case
 * envelope's outer radius matches the rim. cornerRadius=0 returns 0 and
 * roundedRectPrism falls back to a plain cube for byte-identical legacy.
 */
function lidOuterCornerRadius(params: CaseParameters): number {
  return Math.max(0, params.cornerRadius);
}

function lidRecessedCornerRadius(params: CaseParameters): number {
  // Recessed lid drops into the pocket. With the caseShell pocket now using
  // the OUTER cornerRadius (uniform-width rim), the lid corner radius
  // should also be the outer cornerRadius minus the lid clearance — which
  // is negligible (≤ 0.2 mm) so we pass the full cornerRadius and let
  // roundedRectPrism's clamp handle the tiny gap.
  return Math.max(0, params.cornerRadius);
}

export function buildSnapFitLid(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): BuildOp {
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const topPlate = roundedRectPrism(
    dims.outerX,
    dims.outerY,
    params.lidThickness,
    lidOuterCornerRadius(params),
  );
  const { posts, holes } = buildLidPosts(board, params, hats, resolveHat, display, resolveDisplay);

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
  const lipRing = buildFullLidFrictionLip(board, params, hats, resolveHat, display, resolveDisplay);
  if (!lipRing) return attachPosts(topPlate, posts, holes);

  const withPosts = posts.length > 0 ? union([topPlate, lipRing, ...posts]) : union([topPlate, lipRing]);
  return holes.length > 0 ? difference([withPosts, ...holes]) : withPosts;
}

/**
 * Continuous-perimeter friction lip for the Full-Lid snap variant. Returns a
 * hollow rectangular ring extruded DOWN by SNAP_LIP_DEPTH from the lid-plate
 * underside, sized to friction-fit between the cavity walls.
 *
 * Returns null when the cavity is too narrow to host a lip wide enough to
 * survive the print (issue #42 degenerate-cavity guard).
 *
 * Used by buildSnapFitLid AND by the lidRecess + full-lid combo path.
 */
function buildFullLidFrictionLip(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): BuildOp | null {
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
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
  if (lipOuterX <= minInnerDim || lipOuterY <= minInnerDim || lipWall < 0.4) return null;

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
  return difference([lipOuter, lipInner]);
}

export function buildScrewDownLid(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): BuildOp {
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const plate = roundedRectPrism(
    dims.outerX,
    dims.outerY,
    params.lidThickness,
    lidOuterCornerRadius(params),
  );
  const { posts, holes } = buildLidPosts(board, params, hats, resolveHat, display, resolveDisplay);
  return attachPosts(plate, posts, holes);
}

/**
 * Issue #122 — extension tab on a recessed lid that bridges the lid plate's
 * hinge-side edge out to the hinge knuckle bodies (which sit OUTSIDE the
 * case envelope). Without this the recessed lid plate doesn't reach the
 * knuckle XY positions and the lid splits into [plate, knuckle-1, …]
 * disconnected components.
 *
 * Returns null when no hinge is configured or the hinge isn't on a side
 * face (±x / ±y).
 */
function buildHingeLidExtension(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[],
  resolveHat: HatResolver,
  display: DisplayPlacement | null | undefined,
  resolveDisplay: DisplayResolver,
  plateOriginX: number,
  plateOriginY: number,
  lid: LidDims,
): BuildOp | null {
  const hinge = params.hinge;
  if (!hinge?.enabled) return null;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const knuckleR = hinge.knuckleOuterDiameter / 2;
  // Tab spans `hingeLength + 2 mm` along the hinge u-axis (the wall tangent),
  // covering the knuckle XY footprint plus a small overshoot at each end.
  const tabU = hinge.hingeLength + 2;
  // Tab depth along the wall normal: from the lid plate's hinge-side edge
  // OUT past the case envelope to the knuckle outer face. Plus an EMBED
  // overlap on each end so the union with both lid plate and knuckles is
  // volumetric, not coplanar.
  const EMBED_PLATE = 0.5;
  const EMBED_KNUCKLE = 0.5;
  // Plate edge (lid-local coord on the hinge axis), case envelope (world),
  // knuckle outer face (world): all derived per face below.
  const plateEdgeX = plateOriginX; // -x face
  const plateEdgeXMax = plateOriginX + lid.x; // +x face
  const plateEdgeY = plateOriginY; // -y face
  const plateEdgeYMax = plateOriginY + lid.y; // +y face

  // u position along the wall tangent (centered for now; honor positioning
  // via existing layout in a follow-up if needed).
  const isXFace = hinge.face === '+x' || hinge.face === '-x';
  const wallTangentLen = isXFace ? dims.outerY : dims.outerX;
  const uStart = (wallTangentLen - hinge.hingeLength) / 2 - 1;

  // Tab z range = full lid plate thickness (matches lid plate underside +
  // top exactly) so the tab fuses with the plate AND the knuckle body
  // (which extends from z=-knuckleR upward to z=0 in lid-local — see
  // hinges.ts buildKnuckleLidFairing).
  const tabZ = lid.z;
  switch (hinge.face) {
    case '+y': {
      // Tab covers from plate's +y edge (with EMBED overlap inward) to the
      // case +y envelope and beyond by knuckleR + EMBED_KNUCKLE.
      const yStart = plateEdgeYMax - EMBED_PLATE;
      const yEnd = dims.outerY + knuckleR + EMBED_KNUCKLE;
      const yLen = yEnd - yStart;
      if (yLen <= 0) return null;
      return translate([uStart, yStart, 0], cube([tabU, yLen, tabZ], false));
    }
    case '-y': {
      const yEnd = plateEdgeY + EMBED_PLATE;
      const yStart = -knuckleR - EMBED_KNUCKLE;
      const yLen = yEnd - yStart;
      if (yLen <= 0) return null;
      return translate([uStart, yStart, 0], cube([tabU, yLen, tabZ], false));
    }
    case '+x': {
      const xStart = plateEdgeXMax - EMBED_PLATE;
      const xEnd = dims.outerX + knuckleR + EMBED_KNUCKLE;
      const xLen = xEnd - xStart;
      if (xLen <= 0) return null;
      return translate([xStart, uStart, 0], cube([xLen, tabU, tabZ], false));
    }
    case '-x': {
      const xEnd = plateEdgeX + EMBED_PLATE;
      const xStart = -knuckleR - EMBED_KNUCKLE;
      const xLen = xEnd - xStart;
      if (xLen <= 0) return null;
      return translate([xStart, uStart, 0], cube([xLen, tabU, tabZ], false));
    }
  }
}

export function buildLid(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): BuildOp {
  // When recessed, the plate is sized to drop into the recess pocket; the
  // joint flavor adds posts / holes / snap arms ON TOP of that plate.
  //
  // Bug fix: previously the plate was emitted at lid-local (0, 0, 0) but
  // the pocket sits at world (wall - recessOffset + clearance, ...) — i.e.
  // ~0.7 mm inboard from the case envelope on every side. The lid was
  // then misaligned: hanging over the case on one side and short of the
  // pocket on the other, which the user correctly described as "the lid
  // doesn't fit the smaller shape inside." Translate the plate to its
  // proper pocket-centered XY origin so it nests cleanly. Posts /
  // holes / lip are already in world coords (computed via
  // cavityOriginXY) so they don't need offsetting.
  if (params.lidRecess) {
    const lid = computeLidDims(board, params, hats, resolveHat, display, resolveDisplay);
    const recess = computeRecessDims(board, params, hats, resolveHat, display, resolveDisplay)!;
    const recessOffset = Math.max(0.5, params.wallThickness - 0.5);
    const plateOriginX = params.wallThickness - recessOffset + recess.clearance;
    const plateOriginY = params.wallThickness - recessOffset + recess.clearance;
    let plate: BuildOp = translate(
      [plateOriginX, plateOriginY, 0],
      roundedRectPrism(lid.x, lid.y, lid.z, lidRecessedCornerRadius(params)),
    );
    // Issue #122 — recessed lid is INSET from the case envelope; hinge
    // knuckles sit OUTSIDE the case envelope. Without an extension, the
    // lid plate doesn't reach the knuckle XY positions and the lid splits
    // into [plate, knuckle-1, knuckle-2, …]. Emit a slab tab that bridges
    // the lid plate's hinge-side edge OUT to the case envelope (and a bit
    // beyond, to overlap the knuckle bodies).
    const ext = buildHingeLidExtension(board, params, hats, resolveHat, display, resolveDisplay, plateOriginX, plateOriginY, lid);
    if (ext) plate = union([plate, ext]);
    const { posts, holes } = buildLidPosts(board, params, hats, resolveHat, display, resolveDisplay);
    if (params.joint === 'snap-fit' && params.snapType === 'full-lid') {
      const lip = buildFullLidFrictionLip(board, params, hats, resolveHat, display, resolveDisplay);
      if (lip) {
        const withLip = union([plate, lip]);
        return attachPosts(withLip, posts, holes);
      }
    }
    return attachPosts(plate, posts, holes);
  }
  switch (params.joint) {
    case 'snap-fit':
      return buildSnapFitLid(board, params, hats, resolveHat, display, resolveDisplay);
    case 'screw-down':
      return buildScrewDownLid(board, params, hats, resolveHat, display, resolveDisplay);
    case 'flat-lid':
    default:
      return buildFlatLid(board, params, hats, resolveHat, display, resolveDisplay);
  }
}
