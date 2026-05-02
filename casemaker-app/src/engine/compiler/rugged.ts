import type {
  BoardProfile,
  CaseParameters,
  HatPlacement,
  HatProfile,
} from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cube, cylinder, difference, mesh, rotate, translate, union, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';
import {
  cornerSign,
  protectiveRibPositions,
  LATCH_RIB_W,
  LATCH_RIB_BODY_DEPTH,
  LATCH_RIB_KNUCKLE_DEPTH,
  LATCH_RIB_KNUCKLE_PAD,
  LATCH_PIVOT_BELOW_RIM,
  LATCH_KNUCKLE_OUTER_R,
  LATCH_KNUCKLE_OFFSET,
  LATCH_PIN_R,
  LATCH_PIN_HOLE_CLEAR,
} from './latchProtection';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;
type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

/** Issue #111 — rugged exterior options. Three independent treatments:
 *
 *  1. Corner bumpers: vertical-axis cylinders at each external corner,
 *     extending past the case envelope by `radius - cornerRadius`.
 *     `flexBumper: true` emits them as separate top-level nodes so the
 *     user prints them in TPU and slips them on; otherwise fused with
 *     the case body.
 *
 *  2. Wall ribbing: rectangular ribs running vertically (along Z) or
 *     horizontally (along the wall tangent) on each side wall. Whity-
 *     style refinement: ribs leave a smooth `clearBand` mm band at top
 *     AND bottom for cleaner aesthetics.
 *
 *  3. Integrated feet: cylindrical pads at the case bottom corners.
 */

export interface RuggedOps {
  /** Geometry fused with the case body (rigid). */
  caseAdditive: BuildOp[];
  /** Geometry fused with the lid (in LID-LOCAL coords — caller unions
   *  these into lidOp BEFORE the lid translates to its world Z). Used
   *  for the upper portion of bumpers + ribs when the lid is a Pelican-
   *  style shell (lidCavityHeight > 0); a flat-plate lid leaves this
   *  empty and everything fuses to the case as before. */
  lidAdditive: BuildOp[];
  /** Separate top-level nodes (printed in TPU) for slip-on flex bumpers. */
  bumperNodes: { id: string; op: BuildOp }[];
}

export function buildRuggedOps(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): RuggedOps {
  const empty: RuggedOps = { caseAdditive: [], lidAdditive: [], bumperNodes: [] };
  if (!params.rugged?.enabled) return empty;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const caseAdditive: BuildOp[] = [];
  const lidAdditive: BuildOp[] = [];
  const bumperNodes: { id: string; op: BuildOp }[] = [];
  // Pelican-style: lid is a hollow shell with its own walls. Top corner
  // caps + upper-half ribs belong on the LID (not on the case rim) so
  // the rugged exterior wraps the assembled case continuously.
  const lidCavityHeight = params.lidCavityHeight ?? 0;
  const lidShellMode = lidCavityHeight > 0 && !params.lidRecess;
  const lidTotalZ = params.lidThickness + lidCavityHeight;

  if (params.rugged.corners.enabled) {
    const c = buildCornerBumpers(dims, params, lidShellMode, lidTotalZ);
    const placeBumpers = (ops: BuildOp[], target: BuildOp[]) => {
      target.push(...ops);
    };
    if (params.rugged.corners.flexBumper) {
      // Each bumper becomes a separate top-level node (assembled coords).
      [...c.caseCaps, ...c.lidCaps].forEach((op, i) => {
        bumperNodes.push({ id: `bumper-${i}`, op });
      });
    } else {
      placeBumpers(c.caseCaps, caseAdditive);
      placeBumpers(c.lidCaps, lidAdditive);
    }
  }

  if (params.rugged.ribbing.enabled) {
    const ribs = buildWallRibs(dims, params, lidShellMode, lidTotalZ);
    caseAdditive.push(...ribs.caseRibs);
    lidAdditive.push(...ribs.lidRibs);
  }

  if (params.rugged.feet.enabled) {
    caseAdditive.push(...buildIntegratedFeet(dims, params));
  }

  return { caseAdditive, lidAdditive, bumperNodes };
}

function buildCornerBumpers(
  dims: { outerX: number; outerY: number; outerZ: number },
  params: CaseParameters,
  lidShellMode: boolean,
  lidTotalZ: number,
): { caseCaps: BuildOp[]; lidCaps: BuildOp[] } {
  const corners = params.rugged!.corners;
  const r = Math.max(0, corners.radius);
  if (r <= 0) return { caseCaps: [], lidCaps: [] };
  // Issue #121 — DISCRETE top + bottom caps at each vertical corner.
  // Caps are CHAMFERED cylinders (small frustum at top + bottom rim) so
  // the bumper reads as moulded with slightly rounded edges instead of
  // a printed-flat sharp disc.
  const capHeight = Math.max(2, corners.capHeight ?? 12);
  const corners2D: [number, number][] = [
    [0, 0],
    [dims.outerX, 0],
    [0, dims.outerY],
    [dims.outerX, dims.outerY],
  ];
  const caseCaps: BuildOp[] = [];
  const lidCaps: BuildOp[] = [];
  const safeCapCase = Math.min(capHeight, dims.outerZ / 2 - 2);
  if (safeCapCase <= 0) return { caseCaps: [], lidCaps: [] };
  for (const [x, y] of corners2D) {
    caseCaps.push(translate([x, y, 0], chamferedCylinder(safeCapCase, r)));
    if (!lidShellMode) {
      caseCaps.push(translate([x, y, dims.outerZ - safeCapCase], chamferedCylinder(safeCapCase, r)));
    }
  }
  if (lidShellMode) {
    const safeCapLid = Math.min(capHeight, lidTotalZ / 2 - 2);
    if (safeCapLid > 0) {
      for (const [x, y] of corners2D) {
        lidCaps.push(translate([x, y, lidTotalZ - safeCapLid], chamferedCylinder(safeCapLid, r)));
      }
    }
  }
  return { caseCaps, lidCaps };
}

/** Tiny frustum at the top + bottom rim of a vertical bumper cylinder so
 *  the edges read as gently rounded instead of printed-flat. The middle
 *  cylinder + the two frustums are extended by SECTION_EMBED to overlap
 *  volumetrically; otherwise their coplanar junction at z=CHAM_H and
 *  z=height-CHAM_H produces a tiny zero-area sliver during manifold's
 *  union, breaking the single-component invariant. */
function chamferedCylinder(height: number, r: number): BuildOp {
  const CHAM_H = Math.min(0.6, height * 0.15);
  const CHAM_R = Math.min(0.6, r * 0.2);
  if (height <= 2 * CHAM_H + 0.4 || r <= CHAM_R + 0.4) {
    return cylinder(height, r, 24);
  }
  const innerR = r - CHAM_R;
  const SECTION_EMBED = 0.05;
  const bottom: BuildOp = {
    kind: 'cylinder',
    height: CHAM_H + SECTION_EMBED,
    radiusLow: innerR,
    radiusHigh: r,
    segments: 24,
  };
  const middle = translate(
    [0, 0, CHAM_H - SECTION_EMBED],
    cylinder(height - 2 * CHAM_H + 2 * SECTION_EMBED, r, 24),
  );
  const top = translate(
    [0, 0, height - CHAM_H - SECTION_EMBED],
    { kind: 'cylinder', height: CHAM_H + SECTION_EMBED, radiusLow: r, radiusHigh: innerR, segments: 24 },
  );
  return union([bottom, middle, top]);
}

function buildWallRibs(
  dims: { outerX: number; outerY: number; outerZ: number },
  params: CaseParameters,
  lidShellMode: boolean,
  lidTotalZ: number,
): { caseRibs: BuildOp[]; lidRibs: BuildOp[] } {
  const ribbing = params.rugged!.ribbing;
  if (ribbing.ribCount <= 0) return { caseRibs: [], lidRibs: [] };
  const caseRibs: BuildOp[] = [];
  const lidRibs: BuildOp[] = [];
  const clear = Math.max(0, ribbing.clearBand);
  // Case ribs span the case body (z=[clear, outerZ-clear-jointGap] —
  // smooth band at top so the case-lid junction reads cleanly). With a
  // shell lid, the LID gets matching ribs covering its own outer wall;
  // the two rib stacks line up vertically when the lid is closed.
  const jointGap = lidShellMode ? 0 : 0;  // future: leave a tiny gap at the meeting plane
  const ribZTop = dims.outerZ - clear - jointGap;
  const ribZBottom = clear;
  const ribZSpan = ribZTop - ribZBottom;
  if (ribZSpan <= 1) return { caseRibs: [], lidRibs: [] };
  const ribDepth = ribbing.ribDepth;
  // Issue #119 — ribs MUST overlap the case wall volumetrically so manifold's
  // union fuses them. Coplanar contact (rib base on the outer wall plane) is
  // NOT enough. Embed the rib INTO the wall by EMBED mm; the visible
  // protrusion stays `ribDepth`.
  const EMBED = 0.5;
  const totalDepth = ribDepth + EMBED;

  const RIB_TAPER = 3.0;  // mm — vertical taper at top + bottom of each vertical rib

  // Inner helper: emit ribs for a given Z range (zBot, zSpan) into the
  // supplied output array. Same X/Y geometry; only Z anchors change so
  // case + lid ribs line up vertically when assembled.
  const emitRibs = (out: BuildOp[], zBot: number, zSpan: number): void => {
    if (zSpan <= 1) return;
    if (ribbing.direction === 'vertical') {
      const RIB_W = 2;
      for (const wall of ['+x', '-x', '+y', '-y'] as const) {
        const tangent = wall === '+x' || wall === '-x' ? dims.outerY : dims.outerX;
        const stride = tangent / (ribbing.ribCount + 1);
        for (let i = 1; i <= ribbing.ribCount; i++) {
          const tCenter = i * stride;
          out.push(buildTaperedVerticalRib(wall, tCenter, RIB_W, zBot, zBot + zSpan, ribDepth, EMBED, RIB_TAPER, dims));
        }
      }
    } else {
      const RIB_H = 2;
      const stride = zSpan / (ribbing.ribCount + 1);
      for (let i = 1; i <= ribbing.ribCount; i++) {
        const z = zBot + i * stride;
        out.push(translate([dims.outerX - EMBED, 0, z - RIB_H / 2], cube([totalDepth, dims.outerY, RIB_H], false)));
        out.push(translate([-ribDepth, 0, z - RIB_H / 2], cube([totalDepth, dims.outerY, RIB_H], false)));
        out.push(translate([0, dims.outerY - EMBED, z - RIB_H / 2], cube([dims.outerX, totalDepth, RIB_H], false)));
        out.push(translate([0, -ribDepth, z - RIB_H / 2], cube([dims.outerX, totalDepth, RIB_H], false)));
      }
    }
  };

  emitRibs(caseRibs, ribZBottom, ribZSpan);
  if (lidShellMode) {
    // Lid-local Z: ribs span the same `clear`-margined band on the LID
    // side wall so case ribs and lid ribs read as a continuous column.
    const lidRibBot = clear;
    const lidRibTop = lidTotalZ - clear;
    const lidRibSpan = lidRibTop - lidRibBot;
    emitRibs(lidRibs, lidRibBot, lidRibSpan);
  }

  // Protective vertical ribs flanking each latch — shield the latch arm
  // from impact. Each rib is a 3-segment contour that bumps OUT at the
  // hinge-knuckle Z so the knuckle (which sticks further out than the arm
  // body) is also covered. The CORNER-facing rib gets a horizontal pin
  // hole so the print-in-place hinge pin can be poked out with a
  // paperclip without disassembling the case.
  const latches = params.latches ?? [];
  const RAMP_LEN = 3;  // mm — slope length between body depth and knuckle bump
  const emitLatchRibs = (out: BuildOp[], zBot: number, zSpan: number, zIsLidLocal: boolean): void => {
    if (zSpan <= 1) return;
    const knuckleCenterZ = dims.outerZ - LATCH_PIVOT_BELOW_RIM;
    const knuckleZBot = knuckleCenterZ - LATCH_KNUCKLE_OUTER_R - LATCH_RIB_KNUCKLE_PAD;
    const knuckleZTop = knuckleCenterZ + LATCH_KNUCKLE_OUTER_R + LATCH_RIB_KNUCKLE_PAD;
    for (const latch of latches) {
      if (!latch.enabled) continue;
      void cornerSign;  // imported for completeness; positions does the heavy lifting
      const positions = protectiveRibPositions(latch, dims);
      const ribCenters: { center: number; isCorner: boolean }[] = [
        { center: positions.innerCenter,  isCorner: false },
        { center: positions.cornerCenter, isCorner: true  },
      ];
      // Build the rib as ONE smooth continuous mesh: a generalized prism
      // whose (z, depth) profile follows the latch contour with ramped
      // transitions instead of stepped boundaries. The case-side profile
      // includes the knuckle bump; the lid-side profile is just body
      // depth (no hinge there).
      for (const { center: tCenter, isCorner } of ribCenters) {
        const zTop = zBot + zSpan;
        const slices: { z: number; depth: number }[] = [];
        const push = (z: number, depth: number): void => {
          // De-dup consecutive identical-Z slices (keep the LATER depth).
          if (slices.length > 0 && Math.abs(slices[slices.length - 1]!.z - z) < 0.01) {
            slices[slices.length - 1]!.depth = depth;
            return;
          }
          slices.push({ z, depth });
        };
        push(zBot, 0);                              // bottom edge: zero outward
        push(Math.min(zBot + RIB_TAPER, zTop), LATCH_RIB_BODY_DEPTH);
        if (!zIsLidLocal && knuckleZBot < zTop && knuckleZTop > zBot) {
          // Insert the knuckle bump with sloped shoulders.
          const rampInZ  = Math.max(zBot + RIB_TAPER, knuckleZBot - RAMP_LEN);
          const bumpBotZ = Math.max(zBot + RIB_TAPER, knuckleZBot);
          const bumpTopZ = Math.min(zTop - RIB_TAPER, knuckleZTop);
          const rampOutZ = Math.min(zTop - RIB_TAPER, knuckleZTop + RAMP_LEN);
          if (rampInZ  > slices[slices.length - 1]!.z) push(rampInZ,  LATCH_RIB_BODY_DEPTH);
          if (bumpBotZ > rampInZ  - 0.01)              push(bumpBotZ, LATCH_RIB_KNUCKLE_DEPTH);
          if (bumpTopZ > bumpBotZ - 0.01)              push(bumpTopZ, LATCH_RIB_KNUCKLE_DEPTH);
          if (rampOutZ > bumpTopZ - 0.01)              push(rampOutZ, LATCH_RIB_BODY_DEPTH);
        }
        push(Math.max(zBot, zTop - RIB_TAPER), LATCH_RIB_BODY_DEPTH);
        push(zTop, 0);                              // top edge: zero outward
        let rib = buildSmoothLatchRib(latch.wall, tCenter, LATCH_RIB_W, slices, EMBED, dims);
        if (!zIsLidLocal && isCorner) {
          const holeR = LATCH_PIN_R + LATCH_PIN_HOLE_CLEAR;
          rib = difference([rib, buildPinHoleCutter(latch.wall, tCenter, holeR, knuckleCenterZ, dims)]);
        }
        out.push(rib);
      }
    }
  };
  emitLatchRibs(caseRibs, ribZBottom, ribZSpan, /*zIsLidLocal=*/false);
  if (lidShellMode) {
    emitLatchRibs(lidRibs, clear, lidTotalZ - 2 * clear, /*zIsLidLocal=*/true);
  }

  return { caseRibs, lidRibs };
}

/** Smooth latch protective rib: a generalized-prism mesh built from a
 *  sequence of (z, depth) slices. Each slice is a horizontal cross-section
 *  with the same wall-side at n=-embed and a varying outer face at
 *  n=depth. Adjacent slices connect with sloped quad faces — no segment
 *  boundaries / no hard angular shoulders — so the contour reads as one
 *  smooth continuous part as the user requested. */
function buildSmoothLatchRib(
  wall: '+x' | '-x' | '+y' | '-y',
  tCenter: number,
  ribW: number,
  slices: { z: number; depth: number }[],
  embed: number,
  dims: { outerX: number; outerY: number; outerZ: number },
): BuildOp {
  const axis: 'x' | 'y' = wall === '+x' || wall === '-x' ? 'x' : 'y';
  const sign: 1 | -1 = wall === '+x' || wall === '+y' ? +1 : -1;
  const wallOuter =
    wall === '-x' || wall === '-y' ? 0 :
    wall === '+x' ? dims.outerX : dims.outerY;
  const tStart = tCenter - ribW / 2;
  if (slices.length < 2) {
    return cube([0, 0, 0]);  // degenerate; should never happen
  }

  // Vertex layout: for each slice i, 4 vertices at (front-wall,
  // front-outer, back-wall, back-outer). Index = i*4 + k where:
  //   k=0: front-wall  (t=0,    n=-embed, z=slice.z)
  //   k=1: front-outer (t=0,    n=depth,  z=slice.z)
  //   k=2: back-wall   (t=ribW, n=-embed, z=slice.z)
  //   k=3: back-outer  (t=ribW, n=depth,  z=slice.z)
  const positions: number[] = [];
  function pushVert(t: number, n: number, z: number): void {
    if (axis === 'x') {
      positions.push(wallOuter + sign * n, tStart + t, z);
    } else {
      positions.push(tStart + t, wallOuter + sign * n, z);
    }
  }
  for (const s of slices) {
    pushVert(0,    -embed,   s.z);
    pushVert(0,    s.depth,  s.z);
    pushVert(ribW, -embed,   s.z);
    pushVert(ribW, s.depth,  s.z);
  }
  const N = slices.length;
  const idx = (i: number, k: 0 | 1 | 2 | 3): number => i * 4 + k;

  const tris: number[] = [];
  // End caps (rectangle at zBot and zTop in the t,n plane).
  // Bottom (z=slices[0].z, outward normal -z): quad (FW, BW, BO, FO) viewed
  // from -z = CCW when n→right, t→up... let's just trust the parity flip.
  tris.push(idx(0, 0), idx(0, 2), idx(0, 3));
  tris.push(idx(0, 0), idx(0, 3), idx(0, 1));
  // Top (z=slices[N-1].z, outward +z): quad (FW, FO, BO, BW)
  tris.push(idx(N - 1, 0), idx(N - 1, 1), idx(N - 1, 3));
  tris.push(idx(N - 1, 0), idx(N - 1, 3), idx(N - 1, 2));

  // Side faces between consecutive slices.
  for (let i = 0; i < N - 1; i++) {
    // Wall face (n=-embed, normal -n): quad (FW_i, FW_{i+1}, BW_{i+1}, BW_i)
    tris.push(idx(i, 0), idx(i + 1, 0), idx(i + 1, 2));
    tris.push(idx(i, 0), idx(i + 1, 2), idx(i, 2));
    // Outer face (n=depth, normal +n + Δz): quad (FO_i, BO_i, BO_{i+1}, FO_{i+1})
    tris.push(idx(i, 1), idx(i, 3), idx(i + 1, 3));
    tris.push(idx(i, 1), idx(i + 1, 3), idx(i + 1, 1));
    // Front face (t=0, normal -t): quad (FW_i, FO_i, FO_{i+1}, FW_{i+1})
    tris.push(idx(i, 0), idx(i, 1), idx(i + 1, 1));
    tris.push(idx(i, 0), idx(i + 1, 1), idx(i + 1, 0));
    // Back face (t=ribW, normal +t): quad (BW_i, BW_{i+1}, BO_{i+1}, BO_i)
    tris.push(idx(i, 2), idx(i + 1, 2), idx(i + 1, 3));
    tris.push(idx(i, 2), idx(i + 1, 3), idx(i, 3));
  }

  // Parity flip — my reference triangle list is wound for the "inverted"
  // (negative-determinant) case; the non-inverted case needs the swap.
  // Same logic as snapCatches.ts buildLipWedge.
  const inverted =
    (axis === 'x' && sign === -1) ||
    (axis === 'y' && sign === +1);
  if (inverted) {
    for (let i = 0; i < tris.length; i += 3) {
      const swap = tris[i + 1]!;
      tris[i + 1] = tris[i + 2]!;
      tris[i + 2] = swap;
    }
  }
  return mesh(new Float32Array(positions), new Uint32Array(tris));
}

/** A horizontal cylinder along the wall tangent at the latch pin axis,
 *  long enough to pierce a single protective rib. Used as a subtractor
 *  on the corner-facing rib so the print-in-place pin can pass through. */
function buildPinHoleCutter(
  wall: '+x' | '-x' | '+y' | '-y',
  ribTCenter: number,
  holeR: number,
  pinZ: number,
  dims: { outerX: number; outerY: number; outerZ: number },
): BuildOp {
  const axis: 'x' | 'y' = wall === '+x' || wall === '-x' ? 'x' : 'y';
  const sign: 1 | -1 = wall === '+x' || wall === '+y' ? +1 : -1;
  const wallOuter =
    wall === '-x' || wall === '-y' ? 0 :
    wall === '+x' ? dims.outerX : dims.outerY;
  const pinAxisN = wallOuter + sign * LATCH_KNUCKLE_OFFSET;
  // Cutter long enough to pierce the rib's full tangent extent (LATCH_RIB_W
  // = 3 mm) plus a safety margin on each side.
  const cutLen = LATCH_RIB_W + 2;
  const cyl = cylinder(cutLen, holeR, 24);
  const oriented = axis === 'x'
    ? rotate([-90, 0, 0], cyl)
    : rotate([0, 90, 0], cyl);
  if (axis === 'x') {
    return translate([pinAxisN, ribTCenter - cutLen / 2, pinZ], oriented);
  }
  return translate([ribTCenter - cutLen / 2, pinAxisN, pinZ], oriented);
}

/** Tapered vertical rib: hexagonal cross-section in the (wall-normal,
 *  Z) plane extruded along the wall tangent for `ribW`. The hexagon has
 *  a flat outer face spanning the middle Z range and a slope at top +
 *  bottom that ramps from no outward protrusion (at the very edge) up
 *  to full ribDepth at z=zBot+taper / z=zTop-taper. The wall-side face
 *  is fully embedded into the wall material throughout. */
function buildTaperedVerticalRib(
  wall: '+x' | '-x' | '+y' | '-y',
  tCenter: number,
  ribW: number,
  zBot: number,
  zTop: number,
  ribDepth: number,
  embed: number,
  taper: number,
  dims: { outerX: number; outerY: number; outerZ: number },
): BuildOp {
  return buildTaperedVerticalRibAsymmetric(wall, tCenter, ribW, zBot, zTop, ribDepth, embed, taper, taper, dims);
}

/** Same as buildTaperedVerticalRib but with independent top + bottom
 *  taper lengths. Used by the protective-latch-rib stack so segments
 *  meet at full depth (small `0.6` mm taper at shared boundaries) while
 *  the outer ends keep the full `RIB_TAPER` for the smooth wall fade. */
function buildTaperedVerticalRibAsymmetric(
  wall: '+x' | '-x' | '+y' | '-y',
  tCenter: number,
  ribW: number,
  zBot: number,
  zTop: number,
  ribDepth: number,
  embed: number,
  taperBot: number,
  taperTop: number,
  dims: { outerX: number; outerY: number; outerZ: number },
): BuildOp {
  const axis: 'x' | 'y' = wall === '+x' || wall === '-x' ? 'x' : 'y';
  const sign: 1 | -1 = wall === '+x' || wall === '+y' ? +1 : -1;
  const wallOuter =
    wall === '-x' || wall === '-y' ? 0 :
    wall === '+x' ? dims.outerX : dims.outerY;
  const tStart = tCenter - ribW / 2;
  const span = zTop - zBot;
  // Clamp each per-end taper independently — the two together must leave
  // at least 10% of straight outer face in the middle so the hexagon
  // doesn't degenerate.
  const maxCombined = Math.max(0, span * 0.9);
  let effTaperBot = Math.max(0, taperBot);
  let effTaperTop = Math.max(0, taperTop);
  if (effTaperBot + effTaperTop > maxCombined) {
    const scale = maxCombined / (effTaperBot + effTaperTop);
    effTaperBot *= scale;
    effTaperTop *= scale;
  }
  if (effTaperBot < 0.1 && effTaperTop < 0.1) {
    // Fall back to a plain cube when there's no useful taper at either end.
    if (axis === 'x') {
      const x0 = sign === -1 ? wallOuter - ribDepth : wallOuter - embed;
      return translate([x0, tStart, zBot], cube([embed + ribDepth, ribW, span], false));
    }
    const y0 = sign === -1 ? wallOuter - ribDepth : wallOuter - embed;
    return translate([tStart, y0, zBot], cube([ribW, embed + ribDepth, span], false));
  }

  // Hexagon cross-section vertices in local (n, z) — n positive = OUTWARD,
  // negative = INTO wall. Trace A→B→C→D→E→F is CCW viewed from the +t
  // side of the rib.
  //   A = (-embed,    zBot)              wall-side, bottom
  //   B = (0,         zBot)              outer-bottom corner (no protrusion)
  //   C = (+ribDepth, zBot+effTaper)     outer-bottom-of-flat (full protrusion)
  //   D = (+ribDepth, zTop-effTaper)     outer-top-of-flat
  //   E = (0,         zTop)              outer-top corner (back to no protrusion)
  //   F = (-embed,    zTop)              wall-side, top
  const positions: number[] = [];
  function pushVert(t: number, n: number, z: number): void {
    if (axis === 'x') {
      positions.push(wallOuter + sign * n, tStart + t, z);
    } else {
      positions.push(tStart + t, wallOuter + sign * n, z);
    }
  }
  // Front cap (t=0): A,B,C,D,E,F → indices 0..5
  // Hexagon: B at outer-bottom corner sits at zBot only when taperBot > 0;
  // when taperBot == 0 the rib starts at full ribDepth at zBot (no slope
  // at this end), which is what we want at SHARED boundaries between
  // contour segments.
  const bMidY = effTaperBot > 0.05 ? 0 : ribDepth;
  const eMidY = effTaperTop > 0.05 ? 0 : ribDepth;
  pushVert(0,    -embed,  zBot);
  pushVert(0,    bMidY,   zBot);
  pushVert(0,    ribDepth, zBot + effTaperBot);
  pushVert(0,    ribDepth, zTop - effTaperTop);
  pushVert(0,    eMidY,   zTop);
  pushVert(0,    -embed,  zTop);
  // Back cap (t=ribW): indices 6..11
  pushVert(ribW, -embed,  zBot);
  pushVert(ribW, bMidY,   zBot);
  pushVert(ribW, ribDepth, zBot + effTaperBot);
  pushVert(ribW, ribDepth, zTop - effTaperTop);
  pushVert(ribW, eMidY,   zTop);
  pushVert(ribW, -embed,  zTop);

  // Reference winding (matches positive-determinant local→world basis).
  // Local basis (t, n, z) maps to world differently per axis:
  //   axis='x': (t, n, z) → (Y, sign·X, Z)  ⇒ det = -sign
  //   axis='y': (t, n, z) → (X, sign·Y, Z)  ⇒ det = +sign
  // Flip every triangle's winding when det < 0 so outward normals stay
  // consistent — same parity-flip pattern as buildLipWedge in snapCatches.ts.
  const inverted =
    (axis === 'x' && sign === +1) ||
    (axis === 'y' && sign === -1);
  const tris: number[] = [
    // Front cap (CCW viewed from -t; fan from A=0)
    0, 5, 4,  0, 4, 3,  0, 3, 2,  0, 2, 1,
    // Back cap (CCW viewed from +t; fan from A_b=6)
    6, 7, 8,  6, 8, 9,  6, 9, 10,  6, 10, 11,
    // Side faces (each edge of hexagon → quad → 2 tris)
    0, 1, 7,  0, 7, 6,    // A→B: bottom face (z=zBot, normal -z)
    1, 2, 8,  1, 8, 7,    // B→C: bottom slope (normal +n,-z)
    2, 3, 9,  2, 9, 8,    // C→D: outer face (n=ribDepth, normal +n)
    3, 4, 10, 3, 10, 9,   // D→E: top slope (normal +n,+z)
    4, 5, 11, 4, 11, 10,  // E→F: top face (z=zTop, normal +z)
    5, 0, 6,  5, 6, 11,   // F→A: wall face (n=-embed, normal -n)
  ];
  if (inverted) {
    for (let i = 0; i < tris.length; i += 3) {
      const swap = tris[i + 1]!;
      tris[i + 1] = tris[i + 2]!;
      tris[i + 2] = swap;
    }
  }
  return mesh(new Float32Array(positions), new Uint32Array(tris));
}


function buildIntegratedFeet(
  dims: { outerX: number; outerY: number; outerZ: number },
  params: CaseParameters,
): BuildOp[] {
  const feet = params.rugged!.feet;
  const r = feet.padDiameter / 2;
  // Issue #119 — feet must OVERLAP the floor volumetrically. Original code
  // had the foot cylinder spanning z = [-padHeight, 0] which is coplanar
  // with the floor (which starts at z = 0) — manifold's union doesn't fuse
  // coplanar solids reliably. Extend the cylinder UP into the floor by
  // EMBED mm so there's real volume sharing.
  const EMBED = 1;
  const cylHeight = feet.padHeight + EMBED;
  // Pads sit at the case bottom: cylinder z = [-padHeight, +EMBED]. Visible
  // protrusion below the floor remains feet.padHeight; the EMBED slice is
  // hidden inside the floor.
  const pads4: [number, number][] = [
    [r + 1, r + 1],
    [dims.outerX - r - 1, r + 1],
    [r + 1, dims.outerY - r - 1],
    [dims.outerX - r - 1, dims.outerY - r - 1],
  ];
  const pads6: [number, number][] = [
    ...pads4,
    [dims.outerX / 2, r + 1],
    [dims.outerX / 2, dims.outerY - r - 1],
  ];
  const positions = feet.pads === 6 ? pads6 : pads4;
  return positions.map(([x, y]) =>
    translate([x, y, -feet.padHeight], cylinder(cylHeight, r, 24)),
  );
}
