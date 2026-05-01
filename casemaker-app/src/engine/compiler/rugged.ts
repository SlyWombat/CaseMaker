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
  const empty: RuggedOps = { caseAdditive: [], bumperNodes: [] };
  if (!params.rugged?.enabled) return empty;
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  const caseAdditive: BuildOp[] = [];
  const bumperNodes: { id: string; op: BuildOp }[] = [];

  if (params.rugged.corners.enabled) {
    const c = buildCornerBumpers(dims, params);
    if (params.rugged.corners.flexBumper) {
      // Each bumper becomes a separate top-level node.
      c.forEach((op, i) => {
        bumperNodes.push({ id: `bumper-${i}`, op });
      });
    } else {
      caseAdditive.push(...c);
    }
  }

  if (params.rugged.ribbing.enabled) {
    caseAdditive.push(...buildWallRibs(dims, params));
  }

  if (params.rugged.feet.enabled) {
    caseAdditive.push(...buildIntegratedFeet(dims, params));
  }

  return { caseAdditive, bumperNodes };
}

function buildCornerBumpers(
  dims: { outerX: number; outerY: number; outerZ: number },
  params: CaseParameters,
): BuildOp[] {
  const corners = params.rugged!.corners;
  const r = Math.max(0, corners.radius);
  if (r <= 0) return [];
  // Issue #121 — DISCRETE top + bottom caps at each vertical corner. The
  // previous design emitted full-height cylindrical pillars (cylinder of
  // height = outerZ) which produced four giant rods at the corners — not
  // matching any real protective-case design. Caps are short cylinders
  // of `capHeight` mm at the top and bottom of each vertical corner,
  // leaving the middle of the wall smooth.
  const capHeight = Math.max(2, corners.capHeight ?? 12);
  // Cap height clamped to half the case so top + bottom don't overlap.
  const safeCap = Math.min(capHeight, dims.outerZ / 2 - 2);
  if (safeCap <= 0) return [];
  const corners2D: [number, number][] = [
    [0, 0],
    [dims.outerX, 0],
    [0, dims.outerY],
    [dims.outerX, dims.outerY],
  ];
  const ops: BuildOp[] = [];
  for (const [x, y] of corners2D) {
    // Bottom cap: z = [0, safeCap].
    ops.push(translate([x, y, 0], cylinder(safeCap, r, 24)));
    // Top cap: z = [outerZ - safeCap, outerZ].
    ops.push(translate([x, y, dims.outerZ - safeCap], cylinder(safeCap, r, 24)));
  }
  return ops;
}

function buildWallRibs(
  dims: { outerX: number; outerY: number; outerZ: number },
  params: CaseParameters,
): BuildOp[] {
  const ribbing = params.rugged!.ribbing;
  if (ribbing.ribCount <= 0) return [];
  const out: BuildOp[] = [];
  const clear = Math.max(0, ribbing.clearBand);
  const ribZTop = dims.outerZ - clear;
  const ribZBottom = clear;
  const ribZSpan = ribZTop - ribZBottom;
  if (ribZSpan <= 1) return [];
  const ribDepth = ribbing.ribDepth;
  // Issue #119 — ribs MUST overlap the case wall volumetrically so manifold's
  // union fuses them. Coplanar contact (rib base on the outer wall plane) is
  // NOT enough. Embed the rib INTO the wall by EMBED mm; the visible
  // protrusion stays `ribDepth`.
  const EMBED = 0.5;
  const totalDepth = ribDepth + EMBED;

  if (ribbing.direction === 'vertical') {
    // Vertical ribs on each side wall (±x and ±y). Distributed along the
    // wall's tangent axis; each rib is a thin cube extending OUTWARD from
    // the wall by ribDepth and embedded INWARD by EMBED.
    const RIB_W = 2;
    for (const wall of ['+x', '-x', '+y', '-y'] as const) {
      const tangent = wall === '+x' || wall === '-x' ? dims.outerY : dims.outerX;
      const stride = tangent / (ribbing.ribCount + 1);
      for (let i = 1; i <= ribbing.ribCount; i++) {
        const t = i * stride;
        let placed: BuildOp;
        if (wall === '+x') {
          // Cube dims [depth-along-x, width-along-y, span-along-z].
          placed = translate(
            [dims.outerX - EMBED, t - RIB_W / 2, ribZBottom],
            cube([totalDepth, RIB_W, ribZSpan], false),
          );
        } else if (wall === '-x') {
          placed = translate(
            [-ribDepth, t - RIB_W / 2, ribZBottom],
            cube([totalDepth, RIB_W, ribZSpan], false),
          );
        } else if (wall === '+y') {
          // Cube dims [width-along-x, depth-along-y, span-along-z].
          placed = translate(
            [t - RIB_W / 2, dims.outerY - EMBED, ribZBottom],
            cube([RIB_W, totalDepth, ribZSpan], false),
          );
        } else {
          placed = translate(
            [t - RIB_W / 2, -ribDepth, ribZBottom],
            cube([RIB_W, totalDepth, ribZSpan], false),
          );
        }
        out.push(placed);
      }
    }
  } else {
    // Horizontal ribs — run along each wall's tangent. ribCount horizontal
    // bands distributed along Z within [ribZBottom, ribZTop]. Each rib
    // wraps the perimeter (4 cube segments). Same embed rule as vertical.
    const RIB_H = 2;
    const stride = ribZSpan / (ribbing.ribCount + 1);
    for (let i = 1; i <= ribbing.ribCount; i++) {
      const z = ribZBottom + i * stride;
      // +x wall
      out.push(
        translate(
          [dims.outerX - EMBED, 0, z - RIB_H / 2],
          cube([totalDepth, dims.outerY, RIB_H], false),
        ),
      );
      // -x wall
      out.push(
        translate(
          [-ribDepth, 0, z - RIB_H / 2],
          cube([totalDepth, dims.outerY, RIB_H], false),
        ),
      );
      // +y wall
      out.push(
        translate(
          [0, dims.outerY - EMBED, z - RIB_H / 2],
          cube([dims.outerX, totalDepth, RIB_H], false),
        ),
      );
      // -y wall
      out.push(
        translate(
          [0, -ribDepth, z - RIB_H / 2],
          cube([dims.outerX, totalDepth, RIB_H], false),
        ),
      );
    }
  }
  return out;
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
