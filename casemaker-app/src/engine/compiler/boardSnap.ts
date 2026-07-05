import type { BoardProfile, CaseParameters, HatPlacement, HatProfile } from '@/types';
import type { DisplayPlacement, DisplayProfile } from '@/types/display';
import { cavityClearance, cavityOriginXY } from '@/engine/coords';
import { cube, translate, mesh, type BuildOp } from './buildPlan';

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
 * that overhang the PCB's top edge by FINGER_OVERHANG mm. The board is
 * pressed DOWN into the cavity: its top edge first meets the finger's
 * SLOPED TOP face (the insertion lead-in), which cams the finger/wall
 * aside so the board slides past. Once the board top clears the finger,
 * the wall springs back and the finger's FLAT BOTTOM face sits over the
 * board edge — square to the pull-out direction, so removal is resisted.
 * Ramp-in, catch-out: the taper favours insertion, not removal.
 *
 * No screws, no foam — just a snap-in board. The PCB still sits on
 * standoffs (board.defaultStandoffHeight) for clearance underneath,
 * and the fingers hold it from lifting out of the case.
 *
 * Geometry per finger (in cavity-local coords for the -y wall, with
 * "n outward" meaning AWAY from the cavity = INTO the wall):
 *
 *      cavity-wall side    ┌╲            ← sloped TOP face (z: topZ at the
 *                          │ ╲              wall, ramping DOWN to botZ at the
 *                          │  ╲             interior tip). The descending
 *                          │   ╲            board edge rides this ramp and
 *                          │    ╲           flexes the wall outward.
 *                          │     ╲
 *                          └──────┘  ← flat BOTTOM face (z = botZ) — the
 *      (interior end) ────────────↑    catch: square to pull-out, holds
 *                                      the board down.
 *                          ↑
 *                        wall side embedded by EMBED for manifold fusion.
 */

const FINGER_W = 10;              // mm — along wall tangent
const FINGER_OVERHANG = 1.2;      // mm — protrusion past the PCB edge
const FINGER_THICKNESS = 1.6;     // mm — vertical extent of the finger
const FINGER_CLEARANCE_Z = 0.25;  // mm — gap above PCB top before the finger's lowest point
const EMBED = 0.5;                // mm — fuse with wall material

// Seat-shoulder (board.retentionShoulder). A raised rim around the cavity
// perimeter that brings the walls IN to the PCB/glass footprint over the
// seat height (bezel lip → finger catch), so a face-down panel drops into a
// snug pocket instead of floating in the internal-clearance gap. Without it,
// when internalClearance per side exceeds FINGER_OVERHANG the panel can shift
// far enough to slip past the fingers entirely and fall through — which is
// exactly what happens on the ESP32-S3-Touch-LCD-4.3B (1.5 mm/side clearance
// vs 1.2 mm overhang). The shoulder eliminates the lateral float; the fingers
// then reliably overhang the seated panel's top edge.
const SHOULDER_FIT = 0.15;           // mm — lateral clearance per side (pocket = footprint + 2×)
const SHOULDER_FINGER_EXTRA = 0.4;   // mm — extra finger overhang in shoulder mode (more positive catch)

export interface BoardSnapOps {
  /** Snap retainer geometry, fused with the case shell (additive). */
  caseAdditive: BuildOp[];
}

export function buildBoardSnapOps(
  board: BoardProfile,
  params: CaseParameters,
  // hats/display are accepted for the uniform compiler-op signature but the
  // snap fingers + seat shoulder are anchored purely on the PCB footprint.
  _hats: HatPlacement[] = NO_HATS,
  _resolveHat: HatResolver = NO_RESOLVE,
  _display: DisplayPlacement | null | undefined = null,
  _resolveDisplay: DisplayResolver = NO_RESOLVE_DISPLAY,
): BoardSnapOps {
  if (params.boardRetention !== 'snap') return { caseAdditive: [] };
  // Retention footprint — the sub-rectangle actually captured. Defaults to the
  // whole PCB, but an extended board (e.g. SlyTherm's +X MSR-2 bay) scopes it to
  // the screen so the rim/fingers don't wrap the extension.
  const rf = board.retentionFootprint;
  const fpX = rf?.x ?? 0;
  const fpY = rf?.y ?? 0;
  const fpW = rf?.width ?? board.pcb.size.x;
  const fpH = rf?.height ?? board.pcb.size.y;
  // Need a non-degenerate footprint to anchor the fingers.
  if (fpW < FINGER_W + 4 || fpH < FINGER_W + 4) {
    return { caseAdditive: [] };
  }
  const wall = params.wallThickness;
  const cl = cavityClearance(params);
  const origin = cavityOriginXY(params);
  const pcbTopZ = params.floorThickness + board.defaultStandoffHeight + board.pcb.size.z;
  const botZ = pcbTopZ + FINGER_CLEARANCE_Z;
  const topZ = botZ + FINGER_THICKNESS;
  // Seat-shoulder mode: fingers reach a touch further past the (now snug)
  // panel edge for a more positive catch; a perimeter rim locates the panel.
  const shoulder = board.retentionShoulder === true;
  const overhang = FINGER_OVERHANG + (shoulder ? SHOULDER_FINGER_EXTRA : 0);
  // Captured panel occupies world XY = origin + footprint offset.
  const pcbXMin = origin.x + fpX;
  const pcbXMax = pcbXMin + fpW;
  const pcbYMin = origin.y + fpY;
  const pcbYMax = pcbYMin + fpH;
  // Full-board cavity wall inner surfaces.
  const wallInnerYMin = wall;
  const wallInnerYMax = wall + board.pcb.size.y + cl.yMin + cl.yMax;
  const wallInnerXMin = wall;
  const wallInnerXMax = wall + board.pcb.size.x + cl.xMin + cl.xMax;
  // Per-side "back" coordinate for the rim/finger anchor: fill to the cavity
  // wall when the panel edge is within RIB_FILL_MAX of it, else stand a
  // standalone internal rib RIB_W outboard of the panel edge (used on the side
  // that faces an extension bay rather than a wall).
  const RIB_W = 2.0;
  const RIB_FILL_MAX = 4.0;
  const backLo = (edge: number, wallC: number) => (edge - wallC <= RIB_FILL_MAX ? wallC : edge - RIB_W);
  const backHi = (edge: number, wallC: number) => (wallC - edge <= RIB_FILL_MAX ? wallC : edge + RIB_W);
  const backXLo = backLo(pcbXMin, wallInnerXMin);
  const backXHi = backHi(pcbXMax, wallInnerXMax);
  const backYLo = backLo(pcbYMin, wallInnerYMin);
  const backYHi = backHi(pcbYMax, wallInnerYMax);
  // Centers along each edge tangent.
  const xCenter = (pcbXMin + pcbXMax) / 2;
  const yCenter = (pcbYMin + pcbYMax) / 2;

  const ops: BuildOp[] = [];
  // -y edge: finger fuses at backYLo (wall or rib), tip overhangs the panel.
  ops.push(buildFingerY(-1, xCenter, backYLo, pcbYMin + overhang, botZ, topZ));
  // +y edge
  ops.push(buildFingerY(+1, xCenter, backYHi, pcbYMax - overhang, botZ, topZ));
  // -x edge
  ops.push(buildFingerX(-1, yCenter, backXLo, pcbXMin + overhang, botZ, topZ));
  // +x edge
  ops.push(buildFingerX(+1, yCenter, backXHi, pcbXMax - overhang, botZ, topZ));

  // Seat-shoulder rim: a picture-frame around the captured footprint over the
  // seat height (floor top → finger catch). Its opening is footprint + 2×
  // SHOULDER_FIT so the panel drops in snug; each side runs out to its `back`
  // coord — filling the clearance gap to a nearby wall, or a slim internal rib
  // where the footprint faces an extension bay.
  if (shoulder) {
    const z0 = params.floorThickness;
    const z1 = botZ;
    const openXLo = pcbXMin - SHOULDER_FIT;
    const openXHi = pcbXMax + SHOULDER_FIT;
    const openYLo = pcbYMin - SHOULDER_FIT;
    const openYHi = pcbYMax + SHOULDER_FIT;
    // Embed toward a wall for fusion; a standalone rib needs no embed.
    const eXLo = backXLo <= wallInnerXMin + 1e-3 ? backXLo - EMBED : backXLo;
    const eXHi = backXHi >= wallInnerXMax - 1e-3 ? backXHi + EMBED : backXHi;
    const eYLo = backYLo <= wallInnerYMin + 1e-3 ? backYLo - EMBED : backYLo;
    const eYHi = backYHi >= wallInnerYMax - 1e-3 ? backYHi + EMBED : backYHi;
    const box = (bxLo: number, bxHi: number, byLo: number, byHi: number): BuildOp =>
      translate([bxLo, byLo, z0], cube([bxHi - bxLo, byHi - byLo, z1 - z0]));
    ops.push(box(eXLo, openXLo, eYLo, eYHi));   // -x rim
    ops.push(box(openXHi, eXHi, eYLo, eYHi));   // +x rim
    ops.push(box(eXLo, eXHi, eYLo, openYLo));   // -y rim
    ops.push(box(eXLo, eXHi, openYHi, eYHi));   // +y rim
  }

  return { caseAdditive: ops };
}

/** Build a -y / +y wall finger as a tapered slab — the TOP face is sloped
 *  (high at the wall, ramping DOWN to the interior tip) so the descending
 *  board rides it and flexes the wall aside during insertion; the BOTTOM
 *  face is flat (the catch, square to pull-out). Implemented as a
 *  triangular-prism MESH so we get the slope cleanly without a difference. */
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
  // Triangular cross-section in (y, z), extruded along x:
  //   A: wall-side bottom  (n = embeddedOuter, z = botZ)
  //   B: wall-side top     (n = embeddedOuter, z = topZ)
  //   C: interior tip      (n = innerNy,       z = botZ)  ← tip at BOTTOM
  // Faces: A-B wall-side (vertical), B-C the sloped TOP ramp (wall-top down
  // to interior-bottom = the insertion lead-in), C-A the flat BOTTOM catch
  // (both at botZ). Only C's z differs from the removal-taper version
  // (botZ, not topZ) — same vertex order, so winding/normals are unchanged.
  return makeTriPrism(
    [embeddedOuter, embeddedOuter, innerNy], // y values for A, B, C
    [botZ, topZ, botZ],                       // z values for A, B, C
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
  // Sloped TOP ramp (insertion lead-in) + flat BOTTOM catch — interior tip
  // at botZ, mirroring buildFingerY. Only the tip's z differs from the
  // removal-taper version.
  return makeTriPrismX(
    [embeddedOuter, embeddedOuter, innerNx],
    [botZ, topZ, botZ],
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

