import type {
  BoardProfile,
  CaseParameters,
  HatPlacement,
  HatProfile,
} from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cube, cylinder, translate, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

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
  // Issue #121 — DISCRETE top + bottom caps at each vertical corner. The
  // previous design emitted full-height cylindrical pillars (cylinder of
  // height = outerZ) which produced four giant rods at the corners — not
  // matching any real protective-case design. Caps are short cylinders
  // of `capHeight` mm at the top and bottom of each vertical corner,
  // leaving the middle of the wall smooth.
  const capHeight = Math.max(2, corners.capHeight ?? 12);
  const corners2D: [number, number][] = [
    [0, 0],
    [dims.outerX, 0],
    [0, dims.outerY],
    [dims.outerX, dims.outerY],
  ];
  const caseCaps: BuildOp[] = [];
  const lidCaps: BuildOp[] = [];
  // Bottom caps live on the case (z=[0, safeCap]). With a Pelican shell
  // lid the TOP cap moves to the LID (lid-local z=[lidTotalZ - safeCap,
  // lidTotalZ]). Without shell mode, both caps stay on the case — same
  // as pre-Pelican behavior.
  const safeCapCase = Math.min(capHeight, dims.outerZ / 2 - 2);
  if (safeCapCase <= 0) return { caseCaps: [], lidCaps: [] };
  for (const [x, y] of corners2D) {
    caseCaps.push(translate([x, y, 0], cylinder(safeCapCase, r, 24)));
    if (!lidShellMode) {
      caseCaps.push(translate([x, y, dims.outerZ - safeCapCase], cylinder(safeCapCase, r, 24)));
    }
  }
  if (lidShellMode) {
    const safeCapLid = Math.min(capHeight, lidTotalZ / 2 - 2);
    if (safeCapLid > 0) {
      for (const [x, y] of corners2D) {
        // Lid-local Z: cap sits at the TOP of the lid.
        lidCaps.push(translate([x, y, lidTotalZ - safeCapLid], cylinder(safeCapLid, r, 24)));
      }
    }
  }
  return { caseCaps, lidCaps };
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

  // Inner helper: emit ribs for a given Z range (zBot, zSpan) into the
  // supplied output array. Same X/Y geometry; only Z anchors change so
  // case + lid ribs line up vertically when assembled.
  const emitRibs = (out: BuildOp[], zBot: number, zSpan: number, ribFilter?: (wall: '+x' | '-x' | '+y' | '-y', tPos: number) => boolean): void => {
    if (zSpan <= 1) return;
    if (ribbing.direction === 'vertical') {
      const RIB_W = 2;
      for (const wall of ['+x', '-x', '+y', '-y'] as const) {
        const tangent = wall === '+x' || wall === '-x' ? dims.outerY : dims.outerX;
        const stride = tangent / (ribbing.ribCount + 1);
        for (let i = 1; i <= ribbing.ribCount; i++) {
          const t = i * stride;
          if (ribFilter && !ribFilter(wall, t)) continue;
          let placed: BuildOp;
          if (wall === '+x') {
            placed = translate([dims.outerX - EMBED, t - RIB_W / 2, zBot], cube([totalDepth, RIB_W, zSpan], false));
          } else if (wall === '-x') {
            placed = translate([-ribDepth, t - RIB_W / 2, zBot], cube([totalDepth, RIB_W, zSpan], false));
          } else if (wall === '+y') {
            placed = translate([t - RIB_W / 2, dims.outerY - EMBED, zBot], cube([RIB_W, totalDepth, zSpan], false));
          } else {
            placed = translate([t - RIB_W / 2, -ribDepth, zBot], cube([RIB_W, totalDepth, zSpan], false));
          }
          out.push(placed);
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

  // Issue (per-user followup) — protective vertical ribs flanking each
  // latch, so the latch arm is shielded from impact. Two ribs per latch
  // (one on each side of the latch's u-position). These are emitted on
  // BOTH case + lid (when shell mode) so the protection wraps the
  // assembled exterior.
  const latches = params.latches ?? [];
  const LATCH_RIB_GAP = 6;       // mm — how far outboard of the latch the protective rib sits
  const LATCH_RIB_W = 3;         // mm — wider than regular ribs for impact protection
  const LATCH_RIB_DEPTH = ribDepth + 1;  // protect a touch proud of the regular rib line
  const latchRibTotalDepth = LATCH_RIB_DEPTH + EMBED;
  const emitLatchRibs = (out: BuildOp[], zBot: number, zSpan: number): void => {
    if (zSpan <= 1) return;
    for (const latch of latches) {
      if (!latch.enabled) continue;
      const halfW = latch.width / 2;
      const offsets = [-(halfW + LATCH_RIB_GAP), halfW + LATCH_RIB_GAP];
      for (const off of offsets) {
        const tPos = latch.uPosition + off;
        let placed: BuildOp;
        if (latch.wall === '+x') {
          placed = translate([dims.outerX - EMBED, tPos - LATCH_RIB_W / 2, zBot], cube([latchRibTotalDepth, LATCH_RIB_W, zSpan], false));
        } else if (latch.wall === '-x') {
          placed = translate([-LATCH_RIB_DEPTH, tPos - LATCH_RIB_W / 2, zBot], cube([latchRibTotalDepth, LATCH_RIB_W, zSpan], false));
        } else if (latch.wall === '+y') {
          placed = translate([tPos - LATCH_RIB_W / 2, dims.outerY - EMBED, zBot], cube([LATCH_RIB_W, latchRibTotalDepth, zSpan], false));
        } else {
          placed = translate([tPos - LATCH_RIB_W / 2, -LATCH_RIB_DEPTH, zBot], cube([LATCH_RIB_W, latchRibTotalDepth, zSpan], false));
        }
        out.push(placed);
      }
    }
  };
  emitLatchRibs(caseRibs, ribZBottom, ribZSpan);
  if (lidShellMode) {
    emitLatchRibs(lidRibs, clear, lidTotalZ - 2 * clear);
  }

  return { caseRibs, lidRibs };
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
