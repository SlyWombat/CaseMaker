import type {
  BoardProfile,
  CaseParameters,
  HatPlacement,
  HatProfile,
} from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import {
  difference,
  roundedRectPrism,
  translate,
  type BuildOp,
} from './buildPlan';
import { computeShellDims } from './caseShell';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;
type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

/**
 * Issue #107 — waterproof gasket geometry.
 *
 * Case-side: a closed-loop rectangular channel cut into the rim top face.
 * Lid-side: a matching tongue protruding from the lid underside.
 *
 * Cross-section in the rim n-z plane (n = inboard-normal, z = vertical):
 *
 *   case rim:     ┌──┬──┬──┐   ← rim top face
 *                 │  │  │  │   ← channel of depth = channelDepth
 *                 │  └──┘  │
 *                 │ ░░░░░░ │   ← rest of rim wall material
 *
 *   lid (closed): ┌────────┐   ← lid plate underside
 *                 │   ▼▼   │   ← tongue protrudes by tongueHeight
 *
 *   When closed, the tongue presses the (gasketDepth-tall) gasket into
 *   the (channelDepth-deep) channel, compressing it by `compressionFactor`.
 *
 *   channelDepth + tongueHeight = gasketDepth × (1 + compressionFactor)
 *
 *   So if the gasket is 2 mm thick at 25% compression:
 *     • channelDepth = 1.0 mm
 *     • tongueHeight = 1.5 mm
 *     • Compressed gasket = 2.0 × (1 - 0.25) = 1.5 mm
 *     • Sum (channel + tongue) = 2.5 mm; gasket compressed to 1.5 mm fills
 *       channel (1.0) + leaves 0.5 mm pressing tongue ⇒ correct preload.
 */

export interface SealRingDims {
  /** World-coord X corner of the OUTER ring rectangle (rim top, lid plane). */
  outerCornerX: number;
  outerCornerY: number;
  /** Outer ring extents (case footprint minus some margin). */
  outerWidth: number;
  outerHeight: number;
  /** Cross-section width (= gasketWidth) of the ring. */
  ringWidth: number;
  /** Outer rim corner radius — matches the case shell. */
  cornerRadius: number;
}

/** Channel cross-section depth and lid-tongue height for a given seal config. */
export function computeChannelAndTongue(seal: NonNullable<CaseParameters['seal']>): {
  channelDepth: number;
  tongueHeight: number;
} {
  const compressedGasketDepth = seal.depth * (1 - seal.compressionFactor);
  // Split the available below-rim depth so the channel takes ~40% and the
  // tongue protrudes ~60% — keeps the gasket primarily seated in the
  // channel (not flopping around above it) while still giving the tongue
  // enough drive to compress reliably.
  const channelDepth = compressedGasketDepth * 0.4;
  const tongueHeight = compressedGasketDepth * 0.6 + seal.depth * seal.compressionFactor;
  return { channelDepth, tongueHeight };
}

/**
 * Compute the gasket ring geometry in world coords. The ring follows the
 * case rim, offset INWARD from the outer wall so it doesn't break the
 * outer envelope. Centerline sits at:
 *   uOffset = wallThickness/2  (i.e. centered in the wall material)
 *
 * For the lid tongue, offset by an additional `tongueClearance` so it
 * sits WITHIN the case ring without binding (the gasket fills the gap).
 */
export function computeSealRing(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): SealRingDims | null {
  if (!params.seal?.enabled) return null;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const { wallThickness: wall } = params;
  const ringWidth = params.seal.width;
  // Centerline of the gasket ring sits centered in the wall material:
  // outer ring outer edge = wall/2 - ringWidth/2 from the case outer face.
  const outerOffset = wall / 2 - ringWidth / 2;
  if (outerOffset < 0) {
    // Wall too thin for the gasket — caller surfaces this via the validator.
    return null;
  }
  return {
    outerCornerX: outerOffset,
    outerCornerY: outerOffset,
    outerWidth: dims.outerX - 2 * outerOffset,
    outerHeight: dims.outerY - 2 * outerOffset,
    ringWidth,
    cornerRadius: Math.max(0, params.cornerRadius - outerOffset),
  };
}

/**
 * Build the gasket channel as a subtractive op cut into the rim top face.
 * Uses a ring-shape primitive (outer rectangle minus inner rectangle, both
 * with rounded corners matching the case envelope). Returns null if the
 * seal isn't enabled or the wall is too thin.
 */
export function buildSealChannel(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): BuildOp | null {
  const ring = computeSealRing(board, params, hats, resolveHat, display, resolveDisplay);
  if (!ring) return null;
  const { channelDepth } = computeChannelAndTongue(params.seal!);
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const overshoot = 0.1;
  const totalDepth = channelDepth + 2 * overshoot;
  // Outer ring solid (rounded prism)
  const outerSolid = roundedRectPrism(
    ring.outerWidth,
    ring.outerHeight,
    totalDepth,
    ring.cornerRadius,
  );
  // Inner ring solid (rounded prism, narrower by 2 × ringWidth)
  const innerWidth = ring.outerWidth - 2 * ring.ringWidth;
  const innerHeight = ring.outerHeight - 2 * ring.ringWidth;
  if (innerWidth <= 0 || innerHeight <= 0) return null;
  const innerR = Math.max(0, ring.cornerRadius - ring.ringWidth);
  const innerSolid = translate(
    [ring.ringWidth, ring.ringWidth, 0],
    roundedRectPrism(innerWidth, innerHeight, totalDepth, innerR),
  );
  const ringOp = difference([outerSolid, innerSolid]);
  // Place the channel opening flush with the rim TOP face (z = outerZ for
  // a non-recessed lid; z = outerZ - lidThickness for a recessed lid). The
  // channel extends DOWN into the rim by `channelDepth`. Add `overshoot`
  // both above and below so the boolean cut is clean.
  const rimTopZ = params.lidRecess ? dims.outerZ - params.lidThickness : dims.outerZ;
  const channelTopZ = rimTopZ + overshoot;
  const channelBottomZ = channelTopZ - totalDepth;
  return translate(
    [ring.outerCornerX, ring.outerCornerY, channelBottomZ],
    ringOp,
  );
}

/**
 * Build the lid tongue as an additive op fused with the lid mesh. The
 * tongue is the SAME ring shape as the channel (slightly narrower so it
 * fits with installation slop) extruded DOWN from the lid underside.
 *
 * Returned op is in WORLD coords. The caller (ProjectCompiler) translates
 * it into lid-local before unioning, since the lid op gets translated up
 * by `lidDims.zPosition` afterward.
 */
export function buildSealTongue(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): BuildOp | null {
  const ring = computeSealRing(board, params, hats, resolveHat, display, resolveDisplay);
  if (!ring) return null;
  const { tongueHeight } = computeChannelAndTongue(params.seal!);
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  // Tongue is INSET by tongueClearance from the channel walls so it slides
  // in cleanly. Also INSET inward from the gasket-ring outer edge by half
  // the clearance so it sits centered in the channel cross-section.
  const tongueClearance = 0.2;
  const tongueRingWidth = ring.ringWidth - 2 * tongueClearance;
  if (tongueRingWidth <= 0.5) return null; // gasket too narrow for a tongue
  const outerInset = tongueClearance;
  const outerWidth = ring.outerWidth - 2 * outerInset;
  const outerHeight = ring.outerHeight - 2 * outerInset;
  const cornerR = Math.max(0, ring.cornerRadius - outerInset);
  // Issue #121 — extend tongue UP by EMBED so it overlaps the lid plate
  // volumetrically. Without this the tongue's TOP face = lid plate's
  // BOTTOM face — coplanar contact only, manifold doesn't reliably fuse
  // them, lid splits into [plate, tongue] components.
  const TONGUE_EMBED = 0.5;
  const tongueTotalHeight = tongueHeight + TONGUE_EMBED;
  const outerSolid = roundedRectPrism(outerWidth, outerHeight, tongueTotalHeight, cornerR);
  const innerWidth = outerWidth - 2 * tongueRingWidth;
  const innerHeight = outerHeight - 2 * tongueRingWidth;
  if (innerWidth <= 0 || innerHeight <= 0) return null;
  const innerR = Math.max(0, cornerR - tongueRingWidth);
  const innerSolid = translate(
    [tongueRingWidth, tongueRingWidth, -0.1],
    roundedRectPrism(innerWidth, innerHeight, tongueTotalHeight + 0.2, innerR),
  );
  const tongueOp = difference([outerSolid, innerSolid]);
  // Tongue spans z = [tongueBottomZ, tongueBottomZ + tongueTotalHeight].
  // Top extends EMBED past lidUndersideZ INTO the lid plate so they share
  // volume. Visible protrusion below the lid plate = tongueHeight (unchanged).
  const lidUndersideZ = params.lidRecess
    ? dims.outerZ - params.lidThickness
    : dims.outerZ;
  const tongueBottomZ = lidUndersideZ - tongueHeight;
  return translate(
    [ring.outerCornerX + outerInset, ring.outerCornerY + outerInset, tongueBottomZ],
    tongueOp,
  );
}

/** Closed-loop centerline path in world coords — used by #108 (gasket export)
 *  and the placement validator (hinge knuckles must sit OUTSIDE this loop). */
export interface SealLoopPath {
  /** Outer ring rectangle (rounded). */
  outerCornerX: number;
  outerCornerY: number;
  outerWidth: number;
  outerHeight: number;
  /** Centerline ring width (gasket cross-section width). */
  ringWidth: number;
  /** Z of the gasket centerline (mid-height of the channel). */
  centerlineZ: number;
  /** Outer corner radius. */
  cornerRadius: number;
}

/**
 * Issue #108 — gasket body as a separate top-level part. The gasket is
 * the closed-loop centerline extruded as a uncompressed-thickness ring.
 * Lives as its own BuildNode so the export pipeline emits it as a
 * separate STL (printed in TPU 95A).
 *
 * For 'flat' profile: rectangular cross-section, dims = ringWidth × depth.
 * For 'o-ring' profile: not yet supported in v1 (would need a sweep-along-
 *   path operation; falls back to rectangular).
 */
export function buildGasketBody(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): BuildOp | null {
  const ring = computeSealRing(board, params, hats, resolveHat, display, resolveDisplay);
  if (!ring) return null;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const seal = params.seal!;
  // Gasket sits at the centerline Z, extends ±depth/2 in z. Print orientation
  // is the user's job; we emit the assembled position so the user can verify
  // fit visually before laying it flat for printing.
  const rimTopZ = params.lidRecess ? dims.outerZ - params.lidThickness : dims.outerZ;
  const { channelDepth } = computeChannelAndTongue(seal);
  const gasketBottomZ = rimTopZ - channelDepth - seal.depth + channelDepth;
  // bottomZ = rimTopZ - depth (gasket sits ON the rim with its bottom
  // edge at the channel base would equal rimTopZ - channelDepth; for the
  // assembled view, gasket center sits in the channel + standing proud
  // by (depth - channelDepth)).
  const baseZ = rimTopZ - channelDepth; // gasket sits with bottom inside channel
  void gasketBottomZ;
  // Outer ring solid at full gasket depth
  const outerSolid = roundedRectPrism(
    ring.outerWidth,
    ring.outerHeight,
    seal.depth,
    ring.cornerRadius,
  );
  const innerWidth = ring.outerWidth - 2 * ring.ringWidth;
  const innerHeight = ring.outerHeight - 2 * ring.ringWidth;
  if (innerWidth <= 0 || innerHeight <= 0) return null;
  const innerR = Math.max(0, ring.cornerRadius - ring.ringWidth);
  const innerSolid = translate(
    [ring.ringWidth, ring.ringWidth, -0.1],
    roundedRectPrism(innerWidth, innerHeight, seal.depth + 0.2, innerR),
  );
  const ringOp = difference([outerSolid, innerSolid]);
  return translate([ring.outerCornerX, ring.outerCornerY, baseZ], ringOp);
}

export function computeSealLoopPath(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): SealLoopPath | null {
  const ring = computeSealRing(board, params, hats, resolveHat, display, resolveDisplay);
  if (!ring) return null;
  const { channelDepth } = computeChannelAndTongue(params.seal!);
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const rimTopZ = params.lidRecess ? dims.outerZ - params.lidThickness : dims.outerZ;
  return {
    outerCornerX: ring.outerCornerX,
    outerCornerY: ring.outerCornerY,
    outerWidth: ring.outerWidth,
    outerHeight: ring.outerHeight,
    ringWidth: ring.ringWidth,
    centerlineZ: rimTopZ - channelDepth / 2,
    cornerRadius: ring.cornerRadius,
  };
}
