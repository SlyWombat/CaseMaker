import type { BoardProfile, CaseParameters, HatPlacement, HatProfile } from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { mesh, type BuildOp } from './buildPlan';
import { computeShellDims } from './caseShell';

type HatResolver = (id: string) => HatProfile | undefined;
const NO_HATS: HatPlacement[] = [];
const NO_RESOLVE: HatResolver = () => undefined;
type DisplayResolver = (id: string) => DisplayProfile | undefined;
const NO_RESOLVE_DISPLAY: DisplayResolver = () => undefined;

/**
 * Board-retention snap fingers.
 *
 * When `boardRetention === 'snap'`, four small retainers are emitted on
 * the cavity walls — one per wall, centered along the wall tangent —
 * that overhang the PCB's top edge by FINGER_OVERHANG mm. The user
 * presses the PCB down past the fingers; the fingers' SLOPED bottom
 * faces guide the PCB past with a small lateral force (cavity walls
 * flex very slightly), and once the PCB top clears the finger the
 * horizontal top face holds it down.
 *
 * No screws, no foam — just a snap-in board. The PCB still sits on
 * standoffs (board.defaultStandoffHeight) for clearance underneath,
 * and the fingers hold it from lifting out of the case.
 *
 * Geometry per finger (in cavity-local coords for the -y wall, with
 * "n outward" meaning AWAY from the cavity = INTO the wall):
 *
 *      outer face          ┌─────────┐  ← top face (z = topZ)
 *      (interior end)      │         │
 *                          │         │
 *                          │ ╲       │  ← sloped bottom — high at the
 *                          │  ╲      │     interior end, low at the
 *                          │   ╲     │     wall side. PCB top edge
 *                          │    ╲    │     pushes against the slope as
 *                          │     ╲   │     it descends, briefly flexing
 *                          │      ╲  │     the wall outward.
 *                          │       ╲ │
 *      cavity-wall side    └────────╲┘  ← bottom face (z = botZ)
 *                                    ↑
 *                                  embedded into wall by EMBED for
 *                                  manifold-fusion with the case shell.
 */

const FINGER_W = 10;              // mm — along wall tangent
const FINGER_OVERHANG = 1.2;      // mm — protrusion past the PCB edge
const FINGER_THICKNESS = 1.6;     // mm — vertical extent of the finger
const FINGER_CLEARANCE_Z = 0.25;  // mm — gap above PCB top before the finger's lowest point
const EMBED = 0.5;                // mm — fuse with wall material

export interface BoardSnapOps {
  /** Snap retainer geometry, fused with the case shell (additive). */
  caseAdditive: BuildOp[];
}

export function buildBoardSnapOps(
  board: BoardProfile,
  params: CaseParameters,
  hats: HatPlacement[] = NO_HATS,
  resolveHat: HatResolver = NO_RESOLVE,
  display: DisplayPlacement | null | undefined = null,
  resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): BoardSnapOps {
  if (params.boardRetention !== 'snap') return { caseAdditive: [] };
  // Need a non-degenerate PCB footprint to anchor the fingers.
  if (board.pcb.size.x < FINGER_W + 4 || board.pcb.size.y < FINGER_W + 4) {
    return { caseAdditive: [] };
  }
  const dims = computeShellDims(board, params, hats, resolveHat, display, resolveDisplay);
  void dims;
  const wall = params.wallThickness;
  const cl = params.internalClearance;
  const pcbTopZ = params.floorThickness + board.defaultStandoffHeight + board.pcb.size.z;
  const botZ = pcbTopZ + FINGER_CLEARANCE_Z;
  const topZ = botZ + FINGER_THICKNESS;
  // PCB occupies world XY:
  //   x = [wall + cl, wall + cl + pcb.x]
  //   y = [wall + cl, wall + cl + pcb.y]
  const pcbXMin = wall + cl;
  const pcbXMax = pcbXMin + board.pcb.size.x;
  const pcbYMin = wall + cl;
  const pcbYMax = pcbYMin + board.pcb.size.y;
  // Wall inner surfaces:
  //   -y wall: y = wall    +y wall: y = wall + pcb.y + 2*cl
  //   -x wall: x = wall    +x wall: x = wall + pcb.x + 2*cl
  const wallInnerYMin = wall;
  const wallInnerYMax = wall + board.pcb.size.y + 2 * cl;
  const wallInnerXMin = wall;
  const wallInnerXMax = wall + board.pcb.size.x + 2 * cl;
  // Centers along each wall tangent.
  const xCenter = (pcbXMin + pcbXMax) / 2;
  const yCenter = (pcbYMin + pcbYMax) / 2;

  const ops: BuildOp[] = [];
  // -y wall: finger spans y from (wallInnerYMin - EMBED) to
  // (pcbYMin + FINGER_OVERHANG); embed extends INTO wall material at y < wall.
  ops.push(buildFingerY(
    /*sign*/ -1,
    /*tangentCenter*/ xCenter,
    /*outerN*/ wallInnerYMin,                        // wall inner surface (cavity side)
    /*innerN*/ pcbYMin + FINGER_OVERHANG,            // interior end overhanging PCB
    botZ, topZ,
  ));
  // +y wall
  ops.push(buildFingerY(
    /*sign*/ +1,
    /*tangentCenter*/ xCenter,
    /*outerN*/ wallInnerYMax,
    /*innerN*/ pcbYMax - FINGER_OVERHANG,
    botZ, topZ,
  ));
  // -x wall
  ops.push(buildFingerX(
    /*sign*/ -1,
    /*tangentCenter*/ yCenter,
    /*outerN*/ wallInnerXMin,
    /*innerN*/ pcbXMin + FINGER_OVERHANG,
    botZ, topZ,
  ));
  // +x wall
  ops.push(buildFingerX(
    /*sign*/ +1,
    /*tangentCenter*/ yCenter,
    /*outerN*/ wallInnerXMax,
    /*innerN*/ pcbXMax - FINGER_OVERHANG,
    botZ, topZ,
  ));

  return { caseAdditive: ops };
}

/** Build a -y / +y wall finger as a tapered slab — bottom face is sloped
 *  (low at wall side, high at interior end) so the PCB top can ramp past
 *  it during insertion. Implemented as a triangular-prism MESH so we get
 *  the slope cleanly without a difference operation. */
function buildFingerY(
  sign: -1 | 1,
  tangentCenterX: number,
  outerNy: number,         // wall-inner Y position (where the finger fuses with the wall)
  innerNy: number,         // interior end Y position (overhanging the PCB top)
  botZ: number,
  topZ: number,
): BuildOp {
  const xMin = tangentCenterX - FINGER_W / 2;
  const xMax = tangentCenterX + FINGER_W / 2;
  // Embed the wall side INTO wall material by EMBED for manifold fusion.
  // Embed INTO wall material: for -y wall (sign=-1) wall material is at
  // y < wallInner, so embeddedOuter = wallInner - EMBED (smaller y); for
  // +y wall (sign=+1) wall material is at y > wallInner, embeddedOuter =
  // wallInner + EMBED. Either way: + sign * EMBED.
  const embeddedOuter = outerNy + sign * EMBED;
  // Five vertices per cap (pentagon cross-section in y-z), extruded along
  // x. Cross-section vertices:
  //   A: wall-side bottom    (n = embeddedOuter, z = botZ)
  //   B: interior bottom     (n = innerNy,       z = topZ)   ← bottom is SLOPED, B is at topZ
  //   C: interior top        (n = innerNy,       z = topZ)
  //   D: wall-side top       (n = embeddedOuter, z = topZ)
  // …wait B and C are coincident if both at z=topZ. Use 4-vertex
  // trapezoid in y-z (no separate "interior bottom" vertex) — the slope
  // runs from A (wall-bottom) to C (interior-top).
  // Vertices in (y, z): A, B, C  where B is wall-side top, C is
  // interior-top. The bottom face (slope) is the edge A-C. The other
  // three faces are: A-B (wall side, vertical), B-C (top face,
  // horizontal), C-A (the slope, hypotenuse).
  // This is a triangular prism extruded along x.
  return makeTriPrism(
    [embeddedOuter, embeddedOuter, innerNy], // y values for A, B, C
    [botZ, topZ, topZ],                       // z values for A, B, C
    xMin,
    xMax,
    /*axis=*/'y',
    sign,
  );
}

/** ±x walls — finger uses X as the wall-normal axis, extruded along Y.
 *  Mirror of buildFingerY with the axis swap baked into makeTriPrismX. */
function buildFingerX(
  sign: -1 | 1,
  tangentCenterY: number,
  outerNx: number,
  innerNx: number,
  botZ: number,
  topZ: number,
): BuildOp {
  const yMin = tangentCenterY - FINGER_W / 2;
  const yMax = tangentCenterY + FINGER_W / 2;
  const embeddedOuter = outerNx + sign * EMBED;
  return makeTriPrismX(
    [embeddedOuter, embeddedOuter, innerNx],
    [botZ, topZ, topZ],
    yMin, yMax,
    sign,
  );
}

/** Triangular prism extruded along Y (for axis='x' walls). Cross-section
 *  is the triangle in the (x, z) plane defined by 3 (x, z) pairs. */
function makeTriPrismX(
  xs: [number, number, number],
  zs: [number, number, number],
  yMin: number,
  yMax: number,
  sign: -1 | 1,
): BuildOp {
  const positions: number[] = [];
  for (let i = 0; i < 3; i++) positions.push(xs[i]!, yMin, zs[i]!);
  for (let i = 0; i < 3; i++) positions.push(xs[i]!, yMax, zs[i]!);
  // Reference winding: front cap at y=yMin (outward -y normal) → 0,1,2.
  // Back cap at y=yMax (outward +y normal) → 3,5,4.
  const tris: number[] = [
    0, 1, 2,
    3, 5, 4,
    0, 3, 4,  0, 4, 1,
    1, 4, 5,  1, 5, 2,
    2, 5, 3,  2, 3, 0,
  ];
  // Parity for axis='x': inverted iff sign === -1 (matches the rugged-rib
  // and lip-wedge pattern).
  const inverted = sign === -1;
  if (inverted) {
    for (let i = 0; i < tris.length; i += 3) {
      const swap = tris[i + 1]!;
      tris[i + 1] = tris[i + 2]!;
      tris[i + 2] = swap;
    }
  }
  return mesh(new Float32Array(positions), new Uint32Array(tris));
}

/** Triangular prism mesh extruded along the X axis (for axis='y'
 *  walls). The cross-section is the triangle defined by 3 (y, z) pairs.
 *  Winding is parity-flipped per (axis, sign) like the rugged ribs and
 *  snap-fit lip wedges. */
function makeTriPrism(
  ys: [number, number, number],
  zs: [number, number, number],
  xMin: number,
  xMax: number,
  axis: 'x' | 'y',
  sign: -1 | 1,
): BuildOp {
  const positions: number[] = [];
  // Front cap (x=xMin): vertices 0, 1, 2
  for (let i = 0; i < 3; i++) positions.push(xMin, ys[i]!, zs[i]!);
  // Back cap (x=xMax): vertices 3, 4, 5
  for (let i = 0; i < 3; i++) positions.push(xMax, ys[i]!, zs[i]!);
  // Reference winding (front cap CCW from -x view; flip per parity).
  // Sides: A→B, B→C, C→A. Each edge × extrusion = 1 quad → 2 tris.
  const tris: number[] = [
    // Front cap (-x normal): A, B, C → (0, 1, 2)
    0, 1, 2,
    // Back cap (+x normal): A', C', B' → (3, 5, 4)
    3, 5, 4,
    // Side A-B (vertical wall face): 0,3,4,1
    0, 3, 4,  0, 4, 1,
    // Side B-C (top face): 1,4,5,2
    1, 4, 5,  1, 5, 2,
    // Side C-A (slope): 2,5,3,0
    2, 5, 3,  2, 3, 0,
  ];
  // Parity flip — same rule as buildLipWedge / buildSmoothLatchRib.
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

