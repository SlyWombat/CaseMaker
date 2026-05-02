import type { BoardProfile, CaseParameters, HatPlacement, HatProfile } from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cube, difference, roundedRectPrism, translate, union, type BuildOp } from './buildPlan';
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

// Brim thickness bumped from 2 mm → 4 mm so the flange survives a drop
// (real Pelican brims are 4-6 mm, reinforced with corner gussets). 2 mm
// snapped off too easily under impact at the corners.
const BRIM_T = 4.0;             // mm — thickness of each brim half
const TONGUE_HEIGHT = 1.5;      // mm — tongue protrudes ABOVE meeting plane (scales with the thicker brim)
const TONGUE_WIDTH = 2.0;       // mm — wall-normal width of the tongue ring
const GROOVE_CLEAR = 0.3;       // mm — total slop (groove WIDER than tongue)
const GROOVE_EXTRA_DEPTH = 0.3; // mm — groove deeper than tongue so the lid seats
const FLANGE_MIN_DEPTH = 3.0;   // mm — flange always extends out at least this much (impact protection)
const FLANGE_FALLBACK_DEPTH = 3.0; // mm — used when ribbing is disabled
// Corner gussets — small triangular braces under the brim at each of
// the 4 outside corners so the brim doesn't snap off when the case is
// dropped on a corner. Each gusset is a vertical triangle in the corner-
// diagonal plane, height = GUSSET_H, leg lengths = GUSSET_LEG.
const GUSSET_H = 6;             // mm — vertical extent down the wall
const GUSSET_LEG = 4;           // mm — leg length out from the wall corner

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
  // continuous outline. Clamped UP to FLANGE_MIN_DEPTH so a thin-rib
  // project still gets a brim with enough material to survive a drop.
  const flangeDepth = Math.max(
    FLANGE_MIN_DEPTH,
    params.rugged?.ribbing?.enabled && params.rugged.ribbing.ribDepth > 0
      ? params.rugged.ribbing.ribDepth
      : FLANGE_FALLBACK_DEPTH,
  );

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

  // ---- Corner gussets ----
  //
  // Small triangular braces under the brim at each of the 4 outside
  // corners. Each gusset reinforces the brim ↔ wall junction at the
  // corner where impact loads are highest. Implemented as a cube fused
  // into the wall corner; the brim's underside provides the top face
  // and the wall's outside provides the back face, so the gusset reads
  // visually as a triangular brace even though the geometry is a small
  // box (cheaper than a triangular prism + good enough for impact
  // protection). Each gusset spans GUSSET_LEG mm out from the wall
  // corner along each axis and GUSSET_H mm DOWN from the brim's
  // underside.
  const gussets: BuildOp[] = [];
  if (GUSSET_H > 0 && GUSSET_LEG > 0 && flangeDepth >= GUSSET_LEG - 0.5) {
    const gussetTopZ = caseBrimZ0;
    const gussetBotZ = gussetTopZ - GUSSET_H;
    if (gussetBotZ < dims.outerZ - 0.5) {
      // Sized so the gusset's outer corner is FLUSH with the brim's outer
      // corner (visually integrated). Inner corner is INSIDE the wall by
      // EMBED so the gusset fuses with the case shell.
      const gusset = (xCorner: -1 | 1, yCorner: -1 | 1): BuildOp => {
        const xOrigin = xCorner === -1 ? -GUSSET_LEG : dims.outerX;
        const yOrigin = yCorner === -1 ? -GUSSET_LEG : dims.outerY;
        // Embed slightly INTO wall material on the inboard side.
        const xEmbed = xCorner === -1 ? -EMBED : 0;
        const yEmbed = yCorner === -1 ? -EMBED : 0;
        const xExtra = xCorner === -1 ? EMBED : EMBED;
        const yExtra = yCorner === -1 ? EMBED : EMBED;
        return translate(
          [xOrigin + (xCorner === -1 ? 0 : xEmbed), yOrigin + (yCorner === -1 ? 0 : yEmbed), gussetBotZ],
          cube([GUSSET_LEG + xExtra, GUSSET_LEG + yExtra, GUSSET_H + EMBED]),
        );
      };
      gussets.push(gusset(-1, -1));
      gussets.push(gusset(+1, -1));
      gussets.push(gusset(-1, +1));
      gussets.push(gusset(+1, +1));
    }
  }

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
  if (gussets.length > 0) {
    caseAdditive = union([caseAdditive, ...gussets]);
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
