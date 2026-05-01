import type {
  BoardProfile,
  CaseParameters,
  HatPlacement,
  HatProfile,
} from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cube, cylinder, mesh, translate, union, type BuildOp } from './buildPlan';
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
  // from impact. Two ribs per latch (one on each side of the latch's
  // u-position), wider than regular ribs and extending OUT past the
  // latch arm's outermost face. Same tapered ends + on case AND lid.
  const latches = params.latches ?? [];
  const LATCH_RIB_GAP = 6;
  const LATCH_RIB_W = 3;
  // Latch arm body's outer face is at HOOK_WALL_OFFSET (1.0) + tolerance
  // (0.2 default) + ARM_PLATE_THICKNESS (3.0) ≈ 4.2 mm out from the wall.
  // Make the protective rib stick out past that so the rib tip shields
  // the arm.
  const LATCH_RIB_DEPTH = Math.max(ribDepth + 1, 5);
  const emitLatchRibs = (out: BuildOp[], zBot: number, zSpan: number): void => {
    if (zSpan <= 1) return;
    for (const latch of latches) {
      if (!latch.enabled) continue;
      const halfW = latch.width / 2;
      const offsets = [-(halfW + LATCH_RIB_GAP), halfW + LATCH_RIB_GAP];
      for (const off of offsets) {
        const tCenter = latch.uPosition + off;
        out.push(
          buildTaperedVerticalRib(latch.wall, tCenter, LATCH_RIB_W, zBot, zBot + zSpan, LATCH_RIB_DEPTH, EMBED, RIB_TAPER, dims),
        );
      }
    }
  };
  emitLatchRibs(caseRibs, ribZBottom, ribZSpan);
  if (lidShellMode) {
    emitLatchRibs(lidRibs, clear, lidTotalZ - 2 * clear);
  }

  return { caseRibs, lidRibs };
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
  const axis: 'x' | 'y' = wall === '+x' || wall === '-x' ? 'x' : 'y';
  const sign: 1 | -1 = wall === '+x' || wall === '+y' ? +1 : -1;
  const wallOuter =
    wall === '-x' || wall === '-y' ? 0 :
    wall === '+x' ? dims.outerX : dims.outerY;
  const tStart = tCenter - ribW / 2;
  const span = zTop - zBot;
  // Clamp the per-end taper to no more than 45% of the span — leaves at
  // least 10% of straight outer face in the middle so the hexagon
  // doesn't degenerate.
  const effTaper = Math.min(taper, Math.max(0, span * 0.45));
  if (effTaper < 0.5 || span < 1.5) {
    // Fall back to a plain cube when there's no room for a useful taper.
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
  pushVert(0,    -embed,  zBot);
  pushVert(0,    0,       zBot);
  pushVert(0,    ribDepth, zBot + effTaper);
  pushVert(0,    ribDepth, zTop - effTaper);
  pushVert(0,    0,       zTop);
  pushVert(0,    -embed,  zTop);
  // Back cap (t=ribW): indices 6..11
  pushVert(ribW, -embed,  zBot);
  pushVert(ribW, 0,       zBot);
  pushVert(ribW, ribDepth, zBot + effTaper);
  pushVert(ribW, ribDepth, zTop - effTaper);
  pushVert(ribW, 0,       zTop);
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
