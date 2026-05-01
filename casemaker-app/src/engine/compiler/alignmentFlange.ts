import type { BoardProfile, CaseParameters, HatPlacement, HatProfile } from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { difference, roundedRectPrism, translate, union, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;
type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

/**
 * Pelican-standard ALIGNMENT FLANGE.
 *
 * Both the case rim and the lid bottom carry a horizontal BRIM that
 * extends OUTWARD past the case envelope by the same distance as the
 * wall ribbing. The two brims meet face-to-face when the lid is
 * closed and have a matching tongue+groove for alignment — so the
 * lid centers on the case during closing regardless of any o-ring
 * seal in the rim middle.
 *
 *           [ Lid wall ]
 *           [ Lid brim ──────────[ groove ]──────] ← lid-local z=[0, BRIM_T]
 *                                  ↕              ← meeting plane (world z=outerZ)
 *                                [ tongue ]
 *           [ Case brim ────────────────────────] ← world z=[outerZ-BRIM_T, outerZ]
 *           [ Case wall ]
 *
 * Brims sit OUTSIDE the case envelope (perimeter ring around the
 * envelope footprint), so they never conflict with the seal channel
 * (which lives in the middle of the rim wall material).
 *
 * Auto-emitted whenever the lid is in shell mode (lidCavityHeight > 0)
 * and not recessed.
 */

const BRIM_T = 2.0;             // mm — thickness of each brim half
const TONGUE_HEIGHT = 1.0;      // mm — tongue protrudes ABOVE meeting plane
const TONGUE_WIDTH = 1.5;       // mm — wall-normal width of the tongue ring
const GROOVE_CLEAR = 0.3;       // mm — total slop (groove WIDER than tongue)
const GROOVE_EXTRA_DEPTH = 0.3; // mm — groove deeper than tongue so the lid seats
const FLANGE_FALLBACK_DEPTH = 2.5; // mm — used when ribbing is disabled

export interface AlignmentFlangeOps {
  /** Case brim + tongue, in WORLD coords. */
  caseAdditive: BuildOp | null;
  /** Lid brim, in LID-LOCAL coords. */
  lidAdditive: BuildOp | null;
  /** Groove ring cut into the lid brim's underside, in LID-LOCAL coords. */
  lidSubtract: BuildOp | null;
}

const EMPTY: AlignmentFlangeOps = { caseAdditive: null, lidAdditive: null, lidSubtract: null };

export function buildAlignmentFlange(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): AlignmentFlangeOps {
  // Only meaningful for non-recessed shell lids — recessed lids align via
  // the recess pocket; flat plate lids have nowhere to host a groove.
  if (params.lidRecess) return EMPTY;
  if ((params.lidCavityHeight ?? 0) <= 0) return EMPTY;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);

  // Flange depth matches the wall-rib depth so the brim outline is flush
  // with the rib outer face — the assembled exterior reads as one
  // continuous outline. Falls back to a sensible default when ribbing is
  // off so the flange still works for non-rugged cases.
  const flangeDepth =
    params.rugged?.ribbing?.enabled && params.rugged.ribbing.ribDepth > 0
      ? params.rugged.ribbing.ribDepth
      : FLANGE_FALLBACK_DEPTH;

  // ---- Case brim (world coords) ----
  //
  // Outer rounded prism: extends from -flangeDepth to outerX+flangeDepth
  // (and same for Y). Subtract the case ENVELOPE so the brim is just the
  // outboard ring (we don't want to add a slab over the cavity opening
  // where the lid will sit).
  const brimOuterW = dims.outerX + 2 * flangeDepth;
  const brimOuterH = dims.outerY + 2 * flangeDepth;
  const brimOuterR = Math.max(0, params.cornerRadius + flangeDepth);
  // Subtract: case envelope, slightly oversized in Z so the boolean is clean.
  const overshoot = 0.1;
  const envelopeR = Math.max(0, params.cornerRadius);
  // Case brim Z range: [outerZ - BRIM_T, outerZ]. EMBED downward into wall
  // material so the brim+wall fuse volumetrically.
  const EMBED = 0.5;
  const caseBrimZSpan = BRIM_T + EMBED;
  const caseBrimZ0 = dims.outerZ - BRIM_T;
  const caseBrimSlab = roundedRectPrism(brimOuterW, brimOuterH, caseBrimZSpan, brimOuterR);
  // Subtract the case envelope footprint at the brim Z range so the brim
  // is ONLY the ring outside the envelope.
  const envelopeSubtract = translate(
    [flangeDepth, flangeDepth, -overshoot],
    roundedRectPrism(dims.outerX, dims.outerY, caseBrimZSpan + 2 * overshoot, envelopeR),
  );
  const caseBrimRing = difference([caseBrimSlab, envelopeSubtract]);
  const caseBrim = translate([-flangeDepth, -flangeDepth, caseBrimZ0 - EMBED], caseBrimRing);

  // ---- Tongue on top of case brim (world coords) ----
  //
  // Tongue ring sits ON TOP of the brim, centered between the case envelope
  // and the brim's outer edge. Tongue centerline at distance flangeDepth/2
  // outside the wall outer face.
  const tongueCenterFromEnv = flangeDepth / 2;
  const tongueOuterDist = tongueCenterFromEnv + TONGUE_WIDTH / 2;  // distance from envelope to tongue outer edge
  const tongueInnerDist = tongueCenterFromEnv - TONGUE_WIDTH / 2;  // distance from envelope to tongue inner edge
  let caseAdditive: BuildOp = caseBrim;
  if (tongueInnerDist > 0 && TONGUE_WIDTH > 0.1) {
    const tongueOuterW = dims.outerX + 2 * tongueOuterDist;
    const tongueOuterH = dims.outerY + 2 * tongueOuterDist;
    const tongueInnerW = dims.outerX + 2 * tongueInnerDist;
    const tongueInnerH = dims.outerY + 2 * tongueInnerDist;
    const tongueOuterR = Math.max(0, params.cornerRadius + tongueOuterDist);
    const tongueInnerR = Math.max(0, params.cornerRadius + tongueInnerDist);
    // Tongue Z range: [outerZ - EMBED, outerZ + TONGUE_HEIGHT]. EMBED into
    // brim top for fusion.
    const tongueZSpan = TONGUE_HEIGHT + EMBED;
    const tongueOuterSlab = roundedRectPrism(tongueOuterW, tongueOuterH, tongueZSpan, tongueOuterR);
    const tongueInnerSlab = translate(
      [TONGUE_WIDTH, TONGUE_WIDTH, -overshoot],
      roundedRectPrism(tongueInnerW, tongueInnerH, tongueZSpan + 2 * overshoot, tongueInnerR),
    );
    const tongueRing = difference([tongueOuterSlab, tongueInnerSlab]);
    const tongue = translate(
      [-tongueOuterDist, -tongueOuterDist, dims.outerZ - EMBED],
      tongueRing,
    );
    caseAdditive = union([caseBrim, tongue]);
  }

  // ---- Lid brim (lid-local coords) ----
  //
  // Mirror of the case brim: same outer/inner profile, sits at lid-local
  // z=[0, BRIM_T] (lid bottom). Embed UPWARD into the lid wall by EMBED.
  const lidBrimZSpan = BRIM_T + EMBED;
  const lidBrimSlab = roundedRectPrism(brimOuterW, brimOuterH, lidBrimZSpan, brimOuterR);
  const lidEnvelopeSubtract = translate(
    [flangeDepth, flangeDepth, -overshoot],
    roundedRectPrism(dims.outerX, dims.outerY, lidBrimZSpan + 2 * overshoot, envelopeR),
  );
  const lidBrimRing = difference([lidBrimSlab, lidEnvelopeSubtract]);
  const lidAdditive = translate([-flangeDepth, -flangeDepth, 0], lidBrimRing);

  // ---- Groove ring cut into lid brim bottom (lid-local coords) ----
  //
  // Slightly wider than the tongue (GROOVE_CLEAR slop) and a bit deeper
  // (GROOVE_EXTRA_DEPTH) so the lid seats fully on the case brim with the
  // tongue captured inside.
  let lidSubtract: BuildOp | null = null;
  const grooveCenterFromEnv = flangeDepth / 2;
  const grooveWidth = TONGUE_WIDTH + GROOVE_CLEAR;
  const grooveOuterDist = grooveCenterFromEnv + grooveWidth / 2;
  const grooveInnerDist = grooveCenterFromEnv - grooveWidth / 2;
  if (grooveInnerDist > 0 && grooveWidth > 0.1) {
    const grooveOuterW = dims.outerX + 2 * grooveOuterDist;
    const grooveOuterH = dims.outerY + 2 * grooveOuterDist;
    const grooveInnerW = dims.outerX + 2 * grooveInnerDist;
    const grooveInnerH = dims.outerY + 2 * grooveInnerDist;
    const grooveOuterR = Math.max(0, params.cornerRadius + grooveOuterDist);
    const grooveInnerR = Math.max(0, params.cornerRadius + grooveInnerDist);
    const grooveDepth = TONGUE_HEIGHT + GROOVE_EXTRA_DEPTH;
    const grooveZSpan = grooveDepth + 2 * overshoot;
    const grooveOuterSlab = roundedRectPrism(grooveOuterW, grooveOuterH, grooveZSpan, grooveOuterR);
    const grooveInnerSlab = translate(
      [grooveWidth, grooveWidth, -overshoot],
      roundedRectPrism(grooveInnerW, grooveInnerH, grooveZSpan + 2 * overshoot, grooveInnerR),
    );
    const grooveRing = difference([grooveOuterSlab, grooveInnerSlab]);
    // Lid-local: lid brim bottom at z=0, groove cut DOWN from there.
    lidSubtract = translate(
      [-grooveOuterDist, -grooveOuterDist, -overshoot],
      grooveRing,
    );
  }

  return { caseAdditive, lidAdditive, lidSubtract };
}
