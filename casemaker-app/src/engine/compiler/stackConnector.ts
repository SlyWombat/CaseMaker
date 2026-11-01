import {
  STACK_BACKING,
  STACK_BEAM_T,
  STACK_BEAM_W,
  STACK_BUMP,
  STACK_BUMP_TIP,
  STACK_CAPTURE,
  STACK_DEPTH,
  STACK_END_PLAY,
  STACK_FLOOR_W,
  STACK_LEAD_IN,
  STACK_MOUTH_W,
  STACK_NOTCH_DEPTH,
  STACK_NOTCH_FLAT,
  STACK_NOTCH_W,
  STACK_PAD_PROUD,
  STACK_PAD_W,
  STACK_SLIDE_CLEARANCE,
  STACK_STOP,
  STACK_WEB_PROUD,
  STACK_WINDOW_DEPTH,
  STACK_WINDOW_L,
  STACK_WINDOW_W,
  fitRelief,
  stackKeyLength,
  type ConnectorFace,
  type FitVariant,
  type Mm,
  type StackConnectorParams,
  type StackKeyVariant,
  type StackSocket,
} from '@/types';
import {
  cube,
  difference,
  extrude,
  hull,
  poly,
  rotate,
  translate,
  union,
  type BuildNode,
  type BuildOp,
  type Profile,
} from './buildPlan';
import { MIN_OVERLAP, clashesWith, describeOverlap, feature, shapeOfOp, type ClashFeature, type ClashMethod } from './interiorClash';

/**
 * Issue #149 — the stacking connector: dovetail sockets on the outside of the
 * case walls, and the printed double-ended key that locks two parts together.
 *
 * PROVENANCE and every number: `types/stackConnector.ts`. Read its header
 * first. This file is geometry only.
 *
 * ONE SOCKET, bottom to top, on a wall of exterior height H (the shell, plus
 * the lid when the lid sits ON the rim rather than in it):
 *
 *   z = 0 .. capture+play      RECEIVING POCKET, open at the bottom. The key
 *                              half standing proud of the part below slides up
 *                              into it as this part is lowered on.
 *   then STACK_STOP            the OVER-INSERTION STOP: solid pad.
 *   then .. H                  STORAGE CHANNEL, open at the top, exactly one
 *                              key long (+ end play). A key dropped in from the
 *                              top parks half-proud on its detent; pushed home
 *                              it bottoms on the stop with its top flush.
 *
 * Both open ends carry a 45° lead-in on the lips (forgiveness when a loaded
 * case is set down by feel) and a SEAM NOTCH across the floor: two stacked
 * parts' notches make one V-groove at the seam, which is where the key's bump
 * clicks home. The notch is cut into the pad's backing, never the wall.
 *
 * The channel is VERTICAL, so it locks the two parts against sliding apart and
 * against peeling off the wall, while lifting the upper part off is resisted
 * only by the detent — the reviewed design's choice, and the reason a lid that
 * the socket spans still lifts straight off. Registration (keeping a stack
 * square) is not this feature's job; see the companion stack skirt/rim work.
 *
 * Frame inside this file: X = s (across the channel), Y = n (out of the wall,
 * 0 on its outer face), Z = world z. `placeOnWall` turns that into the world.
 */

/** Small overlap so unions fuse and cutters clear the faces they open. */
const EPS = 0.01;
/** How far a cutter overshoots the face it opens, mm. */
const OVER = 1;
const SQRT2 = Math.SQRT2;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The dovetail region's half-width at height `y` (n), for a boundary moved
 * `inset` mm perpendicular to the 45° flank (positive = into the channel, the
 * key's side; negative = into the lip, a relieved socket).
 */
function flankHalfWidth(y: number, inset: number): number {
  return STACK_FLOOR_W / 2 - (y - STACK_BACKING) - inset * SQRT2;
}

/** A trapezoid between two n levels, flanks inset by `inset`. */
function dovetailTrapezoid(yLow: number, yHigh: number, inset: number): Profile {
  const lo = flankHalfWidth(yLow, inset);
  const hi = flankHalfWidth(yHigh, inset);
  return poly([
    [-lo, yLow],
    [lo, yLow],
    [hi, yHigh],
    [-hi, yHigh],
  ]);
}

function rectXY(x0: number, x1: number, y0: number, y1: number): Profile {
  return poly([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
}

/** A box between two corners, in this file's frame. */
function box(min: [number, number, number], max: [number, number, number]): BuildOp {
  return translate(min, cube([max[0] - min[0], max[1] - min[1], max[2] - min[2]]));
}

/**
 * The channel's cross-section as a list of CONVEX pieces (so each can be
 * hulled for a lead-in): the dovetail under the lips, and the mouth between
 * them out past the pad face. `relief` opens every engagement face that far —
 * 0 for a real case, the ladder rung on the fit coupon.
 */
export function socketSectionPieces(relief = 0): Profile[] {
  const floorY = STACK_BACKING - relief;
  const lipY = STACK_BACKING + STACK_DEPTH;
  return [
    dovetailTrapezoid(floorY, lipY, -relief),
    rectXY(-(STACK_MOUTH_W / 2 + relief), STACK_MOUTH_W / 2 + relief, lipY - EPS, STACK_PAD_PROUD + OVER),
  ];
}

/**
 * The key's cross-section pieces at a per-face clearance `c`: the same
 * dovetail moved `c` off every engagement face (floor and both flanks), and
 * the web through the mouth, `c` off each lip, standing `STACK_WEB_PROUD`
 * past the pad face as the grip.
 */
export function keySectionPieces(c: number): Profile[] {
  const baseY = STACK_BACKING + c;
  return [
    dovetailTrapezoid(baseY, STACK_BACKING + STACK_DEPTH, c),
    rectXY(-(STACK_MOUTH_W / 2 - c), STACK_MOUTH_W / 2 - c, baseY, STACK_PAD_PROUD + STACK_WEB_PROUD),
  ];
}

// ---------------------------------------------------------------------------
// Layout along the wall's height
// ---------------------------------------------------------------------------

export interface SocketZLayout {
  /** Exterior height the socket was laid out on, mm. */
  height: Mm;
  /** Storage channel, open at `height`. */
  channel: [Mm, Mm];
  /** Over-insertion stop block. */
  stop: [Mm, Mm];
  /** Receiving pocket, open at z = 0; null when the wall is too short for it. */
  pocket: [Mm, Mm] | null;
  /** True when a key pushed home sits flush (within the end play) with the top. */
  flush: boolean;
  /** How far a stored key stands proud of the top when not flush, mm. */
  storedProud: Mm;
}

/** The pad height a full socket needs for `variant`, mm. */
export function socketFullHeight(variant: StackKeyVariant): Mm {
  return stackKeyLength(variant) + STACK_END_PLAY + STACK_STOP + STACK_CAPTURE + STACK_END_PLAY;
}

/** The least height that still takes a storage channel one capture long, mm. */
export function socketMinHeight(): Mm {
  return STACK_CAPTURE + STACK_END_PLAY + STACK_STOP;
}

/**
 * Lay a socket out on a wall `height` mm tall, or null when even the storage
 * channel does not fit. Priorities, in order: the storage channel (without
 * it there is no socket), the receiving pocket (without it the part can only
 * be the LOWER one of a stack), and last a storage channel deep enough to
 * hold the key flush.
 */
export function socketZLayout(height: Mm, variant: StackKeyVariant): SocketZLayout | null {
  const store = stackKeyLength(variant) + STACK_END_PLAY;
  const pocketTop = STACK_CAPTURE + STACK_END_PLAY;
  if (height < socketMinHeight()) return null;
  const roomForPocket = height >= pocketTop + STACK_STOP + pocketTop;
  const floor = roomForPocket ? pocketTop + STACK_STOP : STACK_STOP;
  const channelBottom = Math.max(floor, height - store);
  const depth = height - channelBottom;
  return {
    height,
    channel: [channelBottom, height],
    stop: [channelBottom - STACK_STOP, channelBottom],
    pocket: roomForPocket ? [0, pocketTop] : null,
    flush: depth >= store - 1e-9,
    storedProud: Math.max(0, store - depth),
  };
}

// ---------------------------------------------------------------------------
// Socket solids (in the socket frame)
// ---------------------------------------------------------------------------

function extrudeBetween(p: Profile, z0: number, z1: number): BuildOp {
  return translate([0, 0, z0], extrude(p, z1 - z0));
}

/**
 * A 45° lead-in on the lips at an open end: each convex section piece hulled
 * from `STACK_LEAD_IN` wider at the end plane to its own size `STACK_LEAD_IN`
 * in. The floor is not widened — that is the notch's job.
 */
function leadIn(zEnd: number, dir: 1 | -1, relief: number): BuildOp[] {
  const L = STACK_LEAD_IN;
  const nominal = socketSectionPieces(relief);
  const floorY = STACK_BACKING - relief;
  const lipY = STACK_BACKING + STACK_DEPTH;
  const grown: Profile[] = [
    dovetailTrapezoid(floorY, lipY, -(relief + L)),
    rectXY(-(STACK_MOUTH_W / 2 + relief + L), STACK_MOUTH_W / 2 + relief + L, lipY - EPS, STACK_PAD_PROUD + OVER),
  ];
  const at = (z: number, thick: number, p: Profile): BuildOp =>
    dir > 0 ? extrudeBetween(p, z, z + thick) : extrudeBetween(p, z - thick, z);
  return nominal.map((piece, i) =>
    hull([at(zEnd, OVER, grown[i]!), at(zEnd - dir * L - dir * EPS, EPS, piece)]),
  );
}

/**
 * The seam notch at an open end: full depth for `STACK_NOTCH_FLAT` in from
 * the end, then a 45° ramp out to the floor. Sized so the bump's 45° flanks
 * clear it everywhere when the bump's tip is centred on the seam.
 */
function seamNotch(zEnd: number, dir: 1 | -1, relief: number): BuildOp {
  const floorY = STACK_BACKING - relief;
  const hw = STACK_NOTCH_W / 2;
  // The notch bottom stays put when the socket is relieved (the fit coupon):
  // the bump's tip is set from the NOMINAL floor, so this is where it lands.
  const deep = STACK_BACKING - STACK_NOTCH_DEPTH;
  const flatEnd = zEnd - dir * STACK_NOTCH_FLAT;
  const rampEnd = zEnd - dir * (STACK_NOTCH_FLAT + STACK_NOTCH_DEPTH);
  const zA = Math.min(flatEnd, zEnd + dir * OVER);
  const zB = Math.max(flatEnd, zEnd + dir * OVER);
  return hull([
    box([-hw, deep, zA], [hw, floorY + EPS, zB]),
    box([-hw, floorY - EPS, Math.min(rampEnd, rampEnd + dir * EPS)], [hw, floorY + EPS, Math.max(rampEnd, rampEnd + dir * EPS)]),
  ]);
}

export interface SocketSolids {
  /** The pad, as pieces bounded in z (split at the shell/lid seam by the caller). */
  pad(z0: number, z1: number): BuildOp;
  /** Everything the socket cuts, full height. */
  cuts: BuildOp[];
}

/**
 * The pad and cutters for one socket in the socket frame. `embed` is how far
 * the pad sinks into the wall so the union fuses (half the wall: never into
 * the cavity).
 */
export function socketSolids(layout: SocketZLayout, embed: number, relief = 0): SocketSolids {
  const pieces = socketSectionPieces(relief);
  const cuts: BuildOp[] = [];
  const top = layout.height;
  for (const p of pieces) cuts.push(extrudeBetween(p, layout.channel[0], top + OVER));
  cuts.push(...leadIn(top, 1, relief), seamNotch(top, 1, relief));
  if (layout.pocket) {
    for (const p of pieces) cuts.push(extrudeBetween(p, -OVER, layout.pocket[1]));
    cuts.push(...leadIn(0, -1, relief), seamNotch(0, -1, relief));
  }
  return {
    pad: (z0, z1) => box([-STACK_PAD_W / 2, -embed, z0], [STACK_PAD_W / 2, STACK_PAD_PROUD, z1]),
    cuts,
  };
}

// ---------------------------------------------------------------------------
// The key (built in the socket frame, z = 0 at its lower end)
// ---------------------------------------------------------------------------

export interface StackKeyDims {
  variant: StackKeyVariant;
  length: Mm;
  fit: FitVariant;
  /** Fit-ladder relief added to the key, mm. */
  relief: Mm;
  /** Gap per engagement face (floor and each flank), mm. */
  clearance: Mm;
  /** How far the seated key can move out of the wall before a flank bears, mm. */
  pullOutPlay: Mm;
  /** How far each key wing reaches under its lip, across the channel, mm. */
  lipOverlap: Mm;
  /** Height of the key wing under the lips (engagement depth less the floor gap), mm. */
  engagedDepth: Mm;
  /** Dovetail captured in each part, mm. */
  capture: Mm;
  /** Bump centres along the key, mm from its lower end. */
  bumps: Mm[];
  /** The beam's free span, mm. */
  beamSpan: Mm;
  /** Peak bending strain in the beam pushed fully onto the floor (fixed-fixed, centre load). */
  beamStrain: number;
  /** Width across the key, mm. */
  width: Mm;
  /** Thickness lying flat, bump included, mm. */
  thickness: Mm;
  /** Where the clearance number comes from, for the panel. */
  source: string;
}

/** Fit and engagement numbers for a key — pure, shared by the panel and the tests. */
export function stackKeyDims(variant: StackKeyVariant, fit: FitVariant = 'tight'): StackKeyDims {
  const length = stackKeyLength(variant);
  const relief = fitRelief(fit);
  const c = STACK_SLIDE_CLEARANCE + relief;
  const bumps = [...new Set([STACK_CAPTURE, length - STACK_CAPTURE])];
  const w0 = Math.max(1.5, Math.min(...bumps) - STACK_WINDOW_L / 2);
  const w1 = Math.min(length - 1.5, Math.max(...bumps) + STACK_WINDOW_L / 2);
  const span = w1 - w0;
  // Fixed-fixed beam deflected δ at its centre: peak strain 12·t·δ/L². A
  // two-bump long key is softer than this; the formula is the short key's
  // worst case and an estimate either way, not a measurement.
  const strain = (12 * STACK_BEAM_T * STACK_BUMP) / (span * span);
  return {
    variant,
    length,
    fit,
    relief,
    clearance: c,
    pullOutPlay: c * SQRT2,
    lipOverlap: STACK_DEPTH - c * (1 + SQRT2),
    engagedDepth: STACK_DEPTH - c,
    capture: STACK_CAPTURE,
    bumps,
    beamSpan: span,
    beamStrain: strain,
    width: STACK_FLOOR_W - 2 * c * (1 + SQRT2),
    thickness: STACK_DEPTH + STACK_WEB_PROUD + STACK_BUMP,
    source:
      `${STACK_SLIDE_CLEARANCE} mm sliding gap per face (our default, not yet printed) ` +
      `+ ${relief} mm ${fit} relief on the key. Provisional until the stacking-connector ` +
      `fit coupon is printed.`,
  };
}

/** Window z range along the key (the beam's free span). */
function windowRange(d: StackKeyDims): [number, number] {
  const w0 = Math.max(1.5, Math.min(...d.bumps) - STACK_WINDOW_L / 2);
  return [w0, w0 + d.beamSpan];
}

/**
 * The key in the SOCKET frame — X across, Y out of the wall (its floor-side
 * face at `STACK_BACKING + clearance`), Z along it from 0 to its length. Built
 * here so a test can drop it straight into a socket. `bump: false` leaves the
 * detent bumps off (a key pushed home has its bump sprung flat on the floor,
 * which a rigid mesh check cannot model).
 */
export function buildStackKeyLocal(
  variant: StackKeyVariant,
  fit: FitVariant = 'tight',
  opts: { bump?: boolean; clearance?: number } = {},
): BuildOp {
  const d = stackKeyDims(variant, fit);
  const c = opts.clearance ?? d.clearance;
  const L = d.length;
  const body = union(keySectionPieces(c).map((p) => extrude(p, L)));
  const [w0, w1] = windowRange(d);
  const baseY = STACK_BACKING + c;
  const ww = STACK_WINDOW_W / 2;
  const bw = STACK_BEAM_W / 2;
  const window = box([-ww, baseY + STACK_BEAM_T, w0], [ww, baseY + STACK_BEAM_T + STACK_WINDOW_DEPTH, w1]);
  const slitA = box([bw, baseY - OVER, w0], [ww, baseY + STACK_BEAM_T + EPS, w1]);
  const slitB = box([-ww, baseY - OVER, w0], [-bw, baseY + STACK_BEAM_T + EPS, w1]);
  let key: BuildOp = difference([body, window, slitA, slitB]);
  if (opts.bump !== false) {
    // The tip always reaches `STACK_BUMP` past the channel FLOOR, whatever
    // the clearance — a relieved key gets a taller bump so the click still
    // lands (the reviewed loose key does the same).
    const tipY = STACK_BACKING - STACK_BUMP;
    const rise = baseY - tipY;
    const bumps = d.bumps.map((zb) =>
      hull([
        box([-bw, baseY - EPS, zb - STACK_BUMP_TIP / 2 - rise], [bw, baseY + 0.3, zb + STACK_BUMP_TIP / 2 + rise]),
        box([-bw, tipY, zb - STACK_BUMP_TIP / 2], [bw, tipY + EPS, zb + STACK_BUMP_TIP / 2]),
      ]),
    );
    key = union([key, ...bumps]);
  }
  return key;
}

/** Height of the key lying flat, web face on the bed, before the bump, mm. */
const KEY_FLAT_TOP = STACK_PAD_PROUD + STACK_WEB_PROUD;

/**
 * The key in PRINT orientation: web face on the bed (z = 0), the beam and the
 * bump on top, length along +Y, centred on x = 0. Nothing overhangs — the
 * dovetail flanks lean OUT going up at 45° and the beam bridges its window.
 */
export function buildStackKeyPrint(variant: StackKeyVariant, fit: FitVariant = 'tight'): BuildOp {
  return translate([0, 0, KEY_FLAT_TOP], rotate([-90, 0, 0], buildStackKeyLocal(variant, fit)));
}

// ---------------------------------------------------------------------------
// Placement on the case
// ---------------------------------------------------------------------------

/** Rotation about Z that turns the socket frame's +Y to the face's outward normal. */
function faceTurn(face: ConnectorFace): number {
  switch (face) {
    case '+y':
      return 0;
    case '-y':
      return 180;
    case '+x':
      return -90;
    case '-x':
      return 90;
  }
}

/** Wall length along the face (the u extent), mm. */
export function faceLength(face: ConnectorFace, outerX: number, outerY: number): number {
  return face === '+y' || face === '-y' ? outerX : outerY;
}

/** World point on the face's outer plane at u = `u`, z = 0. */
function faceAnchor(face: ConnectorFace, u: number, outerX: number, outerY: number): [number, number, number] {
  switch (face) {
    case '-y':
      return [u, 0, 0];
    case '+y':
      return [u, outerY, 0];
    case '-x':
      return [0, u, 0];
    case '+x':
      return [outerX, u, 0];
  }
}

function placeOnWall(op: BuildOp, face: ConnectorFace, u: number, outerX: number, outerY: number): BuildOp {
  return translate(faceAnchor(face, u, outerX, outerY), rotate([0, 0, faceTurn(face)], op));
}

/** Largest |offset| that keeps the pad off the rounded corners, mm (may be < 0). */
export function maxSocketOffset(face: ConnectorFace, outerX: number, outerY: number, cornerRadius: number): number {
  return faceLength(face, outerX, outerY) / 2 - Math.max(0, cornerRadius) - STACK_PAD_W / 2;
}

/**
 * What a socket occupies, as solids for the shared clash check: the pad (its
 * half-wall embed included, so a port or a pocket cut through the wall under
 * it is caught) and the key's grip standing out of the mouth. The channel cuts
 * all lie inside the pad, so the pad is the socket's real extent.
 */
export function socketClashOps(
  face: ConnectorFace,
  offset: number,
  height: number,
  wall: number,
  outerX: number,
  outerY: number,
  /** Extra half-width along the wall, mm: a socket swept that far each way. */
  sweep = 0,
): BuildOp[] {
  const u = faceLength(face, outerX, outerY) / 2 + offset;
  const embed = wall / 2;
  return SOCKET_BOXES.map(({ halfW, y0, y1 }) =>
    placeOnWall(box([-(halfW + sweep), y0(embed), 0], [halfW + sweep, y1, height]), face, u, outerX, outerY),
  );
}

/** The socket's two boxes in its own frame: the pad, and the key's grip out of the mouth. */
const SOCKET_BOXES: { halfW: number; y0: (embed: number) => number; y1: number }[] = [
  { halfW: STACK_PAD_W / 2, y0: (embed) => -embed, y1: STACK_PAD_PROUD },
  { halfW: STACK_MOUTH_W / 2, y0: () => STACK_PAD_PROUD, y1: STACK_PAD_PROUD + STACK_WEB_PROUD },
];

/** Side gap left between the pad and a cut-out through the brim or ribbing, mm. */
export const PAD_CUTOUT_GAP = 0.5;
/** How far out from the wall a pad cut-out reaches, mm (past any brim or rib). */
const PAD_CUTOUT_REACH = 25;

/**
 * The notch a socket with `cutThrough` takes out of the alignment brim and the
 * rugged ribbing (WORLD coordinates): the pad's width plus a gap each side,
 * from the pad's embed in the wall out past the brim, the full height of the
 * socket. It is subtracted from the brim and rib ops only, never the shell, so
 * the wall and the pad are untouched. Empty when no socket asks for one.
 */
export function stackPadCutouts(
  params: StackConnectorParams | undefined,
  geom: Pick<StackConnectorCase, 'outerX' | 'outerY' | 'top' | 'wall' | 'cornerRadius'>,
): BuildOp[] {
  if (!stackConnectorWanted(params)) return [];
  const out: BuildOp[] = [];
  const seen = new Set<ConnectorFace>();
  for (const s of params.sockets) {
    if (seen.has(s.face)) continue;
    seen.add(s.face);
    if (!s.cutThrough) continue;
    const limit = maxSocketOffset(s.face, geom.outerX, geom.outerY, geom.cornerRadius);
    if (limit < 0 || !socketZLayout(geom.top, params.key)) continue;
    const offset = Math.abs(s.offset) > limit ? Math.sign(s.offset) * limit : s.offset;
    const u = faceLength(s.face, geom.outerX, geom.outerY) / 2 + offset;
    const hw = STACK_PAD_W / 2 + PAD_CUTOUT_GAP;
    const notch = box([-hw, -(geom.wall / 2 + 0.05), 0], [hw, PAD_CUTOUT_REACH, geom.top + OVER]);
    out.push(placeOnWall(notch, s.face, u, geom.outerX, geom.outerY));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The whole feature
// ---------------------------------------------------------------------------

/**
 * A feature already on the case that a socket must not land on — any shared
 * clash-check feature (`interiorClash.ts`); its `label` is the phrase a
 * statement names it by ("a port cutout", "the hinge").
 */
export type ConnectorKeepOut = ClashFeature;

export type ConnectorNoteKind = 'clash' | 'clamped' | 'no-pocket' | 'too-short' | 'duplicate' | 'pad-cutout';

export interface ConnectorNote {
  face: ConnectorFace;
  kind: ConnectorNoteKind;
  message: string;
  /** The offer to move: an offset (mm) that clears every clash on this wall. */
  suggestedOffset?: Mm;
  /**
   * The offer to cut a pad cut-out through the brim or ribbing at
   * `suggestedOffset`, when they block every position along the wall.
   */
  padCutout?: boolean;
  /** How the clash was found (the shared check's method). */
  method?: ClashMethod;
}

export interface PlacedSocket {
  face: ConnectorFace;
  /** Offset actually used (after clamping off the corners), mm. */
  offset: Mm;
  layout: SocketZLayout;
}

export interface StackConnectorReport {
  sockets: PlacedSocket[];
  notes: ConnectorNote[];
  key: StackKeyDims;
  /**
   * #854 item 1 — HOW A STORED KEY PARKS, as a fact about the case rather than
   * a statement: every socket on a case shares one height, and most cases are
   * too short to seat the key flush, so "not flush" fired on nearly every case
   * and stopped being information. The connector section shows this quietly
   * ("key parks half-proud"); null when no socket was placed.
   */
  storage: { flush: boolean; storedProud: Mm; channelMm: Mm } | null;
}

export interface StackConnectorOps {
  shellAdd: BuildOp[];
  shellCut: BuildOp[];
  /** Pad and cuts for the lid's share of the socket, in WORLD coordinates. */
  lidAdd: BuildOp[];
  lidCut: BuildOp[];
  keyNodes: BuildNode[];
  report: StackConnectorReport | null;
}

export interface StackConnectorCase {
  outerX: number;
  outerY: number;
  /** Shell height, mm (top of the rim). */
  shellTop: number;
  /** Exterior height the socket can use, mm: the shell, plus an on-rim lid. */
  top: number;
  wall: number;
  cornerRadius: number;
  /** Case-level fit, inherited when the connector sets none. */
  caseFit?: FitVariant;
}

const FACE_NAME: Record<ConnectorFace, string> = {
  '-y': 'front',
  '+y': 'back',
  '-x': 'left',
  '+x': 'right',
};

const fmt = (v: number): string => `${Math.round(v * 10) / 10}`;

/** True when the connector asks for anything at all. */
export function stackConnectorWanted(p: StackConnectorParams | undefined): p is StackConnectorParams {
  return !!p && (p.sockets.length > 0 || p.keys > 0);
}

/** Offsets (open intervals, mm) at which a socket on `face` would run into a keep-out. */
type Blocked = { keep: ConnectorKeepOut; from: number; to: number }[];

/**
 * Every offset along the wall at which the socket would clash, found in one
 * intersection per keep-out: each of the socket's boxes is swept along the
 * whole wall, intersected with the keep-out's real solid, and the overlap's
 * pieces are projected back onto the wall. A box of half-width w at offset o
 * meets a piece spanning [a, b] along the wall exactly when o lies in
 * (a − c − w, b − c + w), c being the wall's centre — the same answer as
 * testing the socket at every offset, at the cost of one test.
 */
function blockedOffsets(face: ConnectorFace, limit: number, geom: StackConnectorCase, keepOuts: ConnectorKeepOut[]): Blocked {
  const out: Blocked = [];
  if (limit < 0) return out;
  const c = faceLength(face, geom.outerX, geom.outerY) / 2;
  const axis = face === '+y' || face === '-y' ? 0 : 1;
  const sweep = limit + 1;
  const ops = socketClashOps(face, 0, geom.top, geom.wall, geom.outerX, geom.outerY, sweep);
  ops.forEach((op, i) => {
    const w = SOCKET_BOXES[i]!.halfW;
    const swept = feature(`socket-sweep:${face}:${i}`, 'socket', 'socket', [shapeOfOp(op)]);
    for (const { with: keep, hit } of clashesWith(swept, keepOuts)) {
      for (const p of hit.pieces) {
        const a = p.min[axis]!;
        const b = p.max[axis]!;
        // A sliver thinner than the clash threshold is not a clash.
        out.push({ keep, from: a - c - w + MIN_OVERLAP, to: b - c + w - MIN_OVERLAP });
      }
    }
  });
  return out;
}

/** The first offset nearest `from` (0.5 mm steps) clear of every blocked interval, or null. */
function clearOffset(from: number, limit: number, blocked: Blocked, skip: (k: ConnectorKeepOut) => boolean = () => false): number | null {
  if (limit < 0) return null;
  const live = blocked.filter((b) => !skip(b.keep));
  const clear = (o: number): boolean => live.every((b) => o <= b.from || o >= b.to);
  const steps = Math.ceil((2 * limit) / 0.5) + 1;
  for (let i = 0; i <= steps; i++) {
    for (const sign of [1, -1]) {
      const o = Math.round((from + sign * i * 0.5) * 2) / 2;
      if (Math.abs(o) <= limit + 1e-9 && clear(o)) return o;
    }
  }
  return null;
}

function socketFeature(face: ConnectorFace, offset: number, geom: StackConnectorCase): ClashFeature {
  return feature(
    `socket:${face}`,
    'socket',
    `the ${FACE_NAME[face]} socket`,
    socketClashOps(face, offset, geom.top, geom.wall, geom.outerX, geom.outerY).map((op) => shapeOfOp(op)),
  );
}

/** Keep-outs a pad cut-out can go through. */
const CUTTABLE = new Set(['brim', 'ribbing']);

/**
 * Build the connector for one case. Returns empty arrays and a null report
 * when the connector asks for nothing, so the caller can splice the arrays in
 * unconditionally and an unconnected project's plan stays byte-identical.
 */
export function buildStackConnector(
  params: StackConnectorParams | undefined,
  geom: StackConnectorCase,
  keepOuts: ConnectorKeepOut[] = [],
): StackConnectorOps {
  const out: StackConnectorOps = { shellAdd: [], shellCut: [], lidAdd: [], lidCut: [], keyNodes: [], report: null };
  if (!stackConnectorWanted(params)) return out;
  const fit = params.fit ?? geom.caseFit ?? 'tight';
  const key = stackKeyDims(params.key, fit);
  const report: StackConnectorReport = { sockets: [], notes: [], key, storage: null };
  const embed = geom.wall / 2;
  const seen = new Set<ConnectorFace>();

  for (const s of params.sockets as StackSocket[]) {
    const face = s.face;
    const name = FACE_NAME[face];
    if (seen.has(face)) {
      report.notes.push({
        face,
        kind: 'duplicate',
        message: `The ${name} wall already has a socket; the second one is not cut.`,
      });
      continue;
    }
    seen.add(face);
    const layout = socketZLayout(geom.top, params.key);
    if (!layout) {
      report.notes.push({
        face,
        kind: 'too-short',
        message:
          `The ${name} wall is ${fmt(geom.top)} mm tall; a socket needs at least ` +
          `${fmt(socketMinHeight())} mm, so none is cut there.`,
      });
      continue;
    }
    const limit = maxSocketOffset(face, geom.outerX, geom.outerY, geom.cornerRadius);
    if (limit < 0) {
      report.notes.push({
        face,
        kind: 'too-short',
        message:
          `The ${name} wall is ${fmt(faceLength(face, geom.outerX, geom.outerY))} mm long; a socket pad ` +
          `is ${fmt(STACK_PAD_W)} mm wide plus the corner rounding, so none is cut there.`,
      });
      continue;
    }
    let offset = s.offset;
    if (Math.abs(offset) > limit) {
      const clamped = Math.sign(offset) * limit;
      report.notes.push({
        face,
        kind: 'clamped',
        message:
          `The ${name} socket at ${fmt(offset)} mm would run off the rounded corner; ` +
          `it is cut at ${fmt(clamped)} mm instead.`,
      });
      offset = clamped;
    }
    report.sockets.push({ face, offset, layout });

    if (!layout.pocket) {
      report.notes.push({
        face,
        kind: 'no-pocket',
        message:
          `At ${fmt(geom.top)} mm tall the ${name} wall has room for the storage channel but not ` +
          `the receiving pocket under it (a full socket needs ${fmt(socketFullHeight(params.key))} mm): ` +
          `this case can be the lower part of a stack, not the upper.`,
      });
    } else if (report.storage === null) {
      // #854 item 1 — the storage mode is a FACT about the case (one height for
      // every socket), shown quietly in the connector section, not a statement:
      // a note here fired on nearly every case and drowned the real ones.
      report.storage = {
        flush: layout.flush,
        storedProud: layout.storedProud,
        channelMm: layout.channel[1] - layout.channel[0],
      };
    }

    const found = clashesWith(socketFeature(face, offset, geom), keepOuts);
    if (found.length > 0) {
      const hits = [...new Set(found.map((f) => f.with.label))];
      const method = found.reduce<ClashMethod>(
        (m, f) => (f.hit.method === 'bounds' || m === 'bounds' ? 'bounds' : f.hit.method === 'solid' ? 'solid' : m),
        'footprint',
      );
      const blocked = blockedOffsets(face, limit, geom, keepOuts);
      const move = clearOffset(offset, limit, blocked);
      const what = hits.length === 1 ? hits[0]! : `${hits.slice(0, -1).join(', ')} and ${hits[hits.length - 1]}`;
      // Where the brim or the ribbing is all that stands in the way at every
      // position, the answer is a notch through it, not "nowhere".
      const pad =
        move === null && found.some((f) => CUTTABLE.has(f.with.kind))
          ? clearOffset(offset, limit, blocked, (k) => CUTTABLE.has(k.kind))
          : null;
      const first = found[0]!;
      const overlap = found.length === 1 ? ` (they overlap ${describeOverlap(first.hit)})` : '';
      let offer: string;
      if (move !== null) offer = `Moving it to ${fmt(move)} mm clears it.`;
      else if (pad !== null) {
        const cuttable = [...new Set(found.filter((f) => CUTTABLE.has(f.with.kind)).map((f) => f.with.label))];
        offer =
          `Every position along this wall runs into ${cuttable.join(' and ')}. ` +
          (pad === offset ? 'A' : `At ${fmt(pad)} mm, a`) +
          ` pad cut-out through ${cuttable.length > 1 ? 'them' : 'it'}, ${fmt(STACK_PAD_W + 2 * PAD_CUTOUT_GAP)} mm wide, makes room for the socket.`;
      } else offer = 'No position along this wall clears it; the socket is cut as placed.';
      report.notes.push({
        face,
        kind: 'clash',
        message: `The ${name} socket at ${fmt(offset)} mm runs into ${what}${overlap}. ${offer}`,
        method,
        ...(move !== null ? { suggestedOffset: move } : pad !== null ? { suggestedOffset: pad, padCutout: true } : {}),
      });
    }
    if (s.cutThrough) {
      report.notes.push({
        face,
        kind: 'pad-cutout',
        message:
          `The ${name} socket has a pad cut-out, ${fmt(STACK_PAD_W + 2 * PAD_CUTOUT_GAP)} mm wide, through the ` +
          `alignment brim and the ribbing; the wall and the seal inside the rim are not cut.`,
      });
    }

    const u = faceLength(face, geom.outerX, geom.outerY) / 2 + offset;
    const solids = socketSolids(layout, embed);
    const place = (op: BuildOp): BuildOp => placeOnWall(op, face, u, geom.outerX, geom.outerY);
    out.shellAdd.push(place(solids.pad(0, geom.shellTop)));
    out.shellCut.push(...solids.cuts.map(place));
    if (geom.top > geom.shellTop + EPS) {
      out.lidAdd.push(place(solids.pad(geom.shellTop, geom.top)));
      out.lidCut.push(...solids.cuts.map(place));
    }
  }

  // The keys print as their own parts, lying flat beside the +X wall.
  const keyCount = Math.max(0, Math.min(8, Math.floor(params.keys)));
  const pitch = key.width + 6;
  for (let i = 0; i < keyCount; i++) {
    out.keyNodes.push({
      id: `stack-key-${i + 1}`,
      op: translate(
        [geom.outerX + STACK_PAD_PROUD + 12 + i * pitch, 0, 0],
        buildStackKeyPrint(params.key, fit),
      ),
    });
  }
  out.report = report;
  return out;
}
