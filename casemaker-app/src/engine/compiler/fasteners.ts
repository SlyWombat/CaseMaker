import type { Vec2, Vec3, Facing } from '@/types';
import { cylinder, extrude, rotate, translate, union, type BuildOp } from './buildPlan';
import { circleProfile, poly, pUnion } from './profile';

/**
 * Issue #140 — ONE way to describe a screw hole.
 *
 * Before this, every compiler module hand-rolled its own cylinders and carried
 * its own constants, so the same fastener came out differently depending on
 * which file you landed in: two head-recess depths by two rules (2 mm in
 * rack.ts, 1.5 mm in stand.ts), two head diameters inside rack.ts alone
 * (9.6 / 9.8), and `TAB_SCREW_CLEAR_D` a byte-identical duplicate of
 * `SCREW_CLEAR_D`. Nothing tied a hole to a named fastener, and nothing could
 * cut a countersink at all.
 *
 * A screw hole has three parts and they are not interchangeable:
 *
 *   1. **Head recess** (optional) — a counterbore for a cap or button head, a
 *      cone for a countersunk one, so the head finishes flush or sub-flush.
 *      Always leaves a floor of solid under it.
 *   2. **Clearance hole** — passes the THREAD and no more. Deliberately not
 *      oversized: these holes locate as well as pass, and every extra tenth is
 *      a tenth the joint can sit crooked.
 *   3. **Receiving hole** on the far part — sized to HOLD, not to clear. Either
 *      a plain starter hole the screw taps for itself, or a modelled thread it
 *      screws into. Confusing this with (2) is the classic way to build a joint
 *      that assembles perfectly and holds nothing.
 *
 * `screwHole()` emits 1 + 2, `screwStarter()` emits 3. Both return cutting
 * `BuildOp`s to subtract from a solid; neither knows what part it is cutting.
 *
 * ## Sources
 *
 * - Major diameter and coarse pitch: **ISO 261**. Basic internal minor
 *   D1 = D − 1.0825 × P, from the ISO 68-1 form (H = 0.866 P, engaged depth
 *   5H/8 = 0.5413 P).
 * - Clearance holes: **ISO 273**, close / normal / free.
 * - Head geometry: **ISO 4762** (hex socket cap), **ISO 7380-1** (button),
 *   **ISO 10642** (countersunk, 90°), **ISO 14583** (pan) — nominal head
 *   diameter `dk` and height `k`.
 * - Machine-screw pilot in PLA: **test print**, issue #140. This is the one
 *   number in the table that came from a part rather than a standard, and the
 *   only one that has been proved.
 */

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

export type FastenerSize = 'M2' | 'M2.5' | 'M3' | 'M4' | 'M5' | 'M6';

/** How the head is shaped — decides what a recess has to be cut as. */
export type HeadStyle = 'none' | 'socket-cap' | 'button' | 'countersunk' | 'pan';

/**
 * What the receiving part does with the screw.
 *
 * `self-tap` is a plain starter hole: the screw forms its own thread going in.
 * `pre-threaded` models a real helical thread in the bore, so the screw turns
 * into an existing thread instead of cutting one — which is what survives being
 * taken apart and put back together. It is not available at every size; see
 * {@link preThreadPrintable}.
 */
export type ReceiverMode = 'self-tap' | 'pre-threaded';

export interface HeadSpec {
  /** Head diameter, `dk`. */
  d: number;
  /** Head height, `k`. */
  h: number;
  /**
   * What the screws actually in hand measure, where that differs from nominal
   * enough to matter. Design against this: an M5 button head measured 9.2
   * across, and 0.3 mm of head diameter is most of the wall left outboard of
   * its counterbore.
   */
  measured?: { d: number; h: number };
}

export interface FastenerSpec {
  /** Nominal major diameter, mm. */
  major: number;
  /** Coarse pitch, mm (ISO 261). */
  pitch: number;
  /** Basic internal minor diameter, D1 = major − 1.0825 × pitch. */
  minor: number;
  /** ISO 273 clearance holes. */
  clearance: { close: number; normal: number; free: number };
  heads: Partial<Record<Exclude<HeadStyle, 'none'>, HeadSpec>>;
  /**
   * Starter hole for a STANDARD 60° METRIC MACHINE SCREW driven into PLA/PETG.
   * `coupon` was printed and driven; `derived` was not — see the note below.
   */
  pilotMachine: { d: number; source: 'coupon' | 'derived' };
  /**
   * Starter hole for a THREAD-FORMING screw (Delta PT, Plastite and friends) —
   * the ~0.8 × major rule of thumb. A different number for a different screw:
   * those have a ~30° profile that displaces material into the flanks, where a
   * 60° machine screw at the same diameter splits the boss instead.
   */
  pilotForming: number;
}

/**
 * Why only one machine-screw pilot is measured.
 *
 * One coupon has been printed and driven: `samples/pilot-coupon-m5.stl`, five
 * diameters from 4.0 to 4.8 in both layer orientations. **4.8 held best** — the
 * largest of the five, so the optimum is not even bracketed above.
 *
 * The 0.8 × major rule that suggested 4.0–4.3 is for thread-FORMING screws. A
 * 60° metric machine screw at that diameter does not form a thread in PLA, it
 * splits the boss: hoop stress rises faster than grip does, and the failure
 * mode is the part cracking rather than the thread shearing.
 *
 * That makes the useful margin an ABSOLUTE one — how much material the screw
 * has to displace radially — not a proportional one, so the other sizes are
 * extrapolated at the same 0.2 mm. That extrapolation has exactly one data
 * point behind it. Below M4 do not trust it without its own coupon: 0.1 mm of
 * radial displacement is a far larger fraction of an M3 thread than an M5 one.
 * `npm run pilot:coupon -- M3` prints one.
 */
const machinePilot = (
  major: number,
  source: 'coupon' | 'derived' = 'derived',
): { d: number; source: 'coupon' | 'derived' } => ({
  d: Math.round((major - 0.2) * 100) / 100,
  source,
});

export const FASTENERS: Readonly<Record<FastenerSize, FastenerSpec>> = {
  M2: {
    major: 2,
    pitch: 0.4,
    minor: 1.567,
    clearance: { close: 2.2, normal: 2.4, free: 2.6 },
    heads: {
      'socket-cap': { d: 3.8, h: 2.0 },
      button: { d: 3.8, h: 1.1 },
      countersunk: { d: 3.8, h: 1.2 },
      pan: { d: 4.0, h: 1.6 },
    },
    pilotMachine: machinePilot(2),
    pilotForming: 1.6,
  },
  'M2.5': {
    major: 2.5,
    pitch: 0.45,
    minor: 2.013,
    clearance: { close: 2.7, normal: 2.9, free: 3.1 },
    heads: {
      'socket-cap': { d: 4.5, h: 2.5 },
      button: { d: 4.7, h: 1.3 },
      countersunk: { d: 4.7, h: 1.5 },
      pan: { d: 5.0, h: 2.0 },
    },
    pilotMachine: machinePilot(2.5),
    pilotForming: 2.0,
  },
  M3: {
    major: 3,
    pitch: 0.5,
    minor: 2.459,
    clearance: { close: 3.2, normal: 3.4, free: 3.6 },
    heads: {
      'socket-cap': { d: 5.5, h: 3.0 },
      button: { d: 5.7, h: 1.65 },
      countersunk: { d: 6.0, h: 1.86 },
      pan: { d: 5.6, h: 2.4 },
    },
    pilotMachine: machinePilot(3),
    pilotForming: 2.4,
  },
  M4: {
    major: 4,
    pitch: 0.7,
    minor: 3.242,
    clearance: { close: 4.3, normal: 4.5, free: 4.8 },
    heads: {
      'socket-cap': { d: 7.0, h: 4.0 },
      button: { d: 7.6, h: 2.2 },
      countersunk: { d: 8.0, h: 2.48 },
      pan: { d: 7.5, h: 3.1 },
    },
    pilotMachine: machinePilot(4),
    pilotForming: 3.2,
  },
  M5: {
    major: 5,
    pitch: 0.8,
    minor: 4.134,
    clearance: { close: 5.3, normal: 5.5, free: 5.8 },
    heads: {
      'socket-cap': { d: 8.5, h: 5.0 },
      // The rack's plate-tab screws, measured off the ones in hand: 9.2 across
      // and a full 3.0 tall, against a 9.5 / 2.75 nominal.
      button: { d: 9.5, h: 2.75, measured: { d: 9.2, h: 3.0 } },
      countersunk: { d: 10.0, h: 3.1 },
      pan: { d: 9.2, h: 3.8 },
    },
    pilotMachine: machinePilot(5, 'coupon'),
    pilotForming: 4.0,
  },
  M6: {
    major: 6,
    pitch: 1.0,
    minor: 4.917,
    clearance: { close: 6.4, normal: 6.6, free: 7.0 },
    heads: {
      'socket-cap': { d: 10.0, h: 6.0 },
      button: { d: 10.5, h: 3.3 },
      countersunk: { d: 12.0, h: 3.72 },
      pan: { d: 11.0, h: 4.6 },
    },
    pilotMachine: machinePilot(6),
    pilotForming: 4.8,
  },
};

/**
 * CaseMaker's own clearance fit, tighter than ISO 273 close on purpose.
 *
 * ISO close for M5 is 5.3; this gives 5.2. The tenth matters because these
 * holes LOCATE as well as pass — the rack's accessories are held square by the
 * screws through the side panels. Where a hole genuinely only has to pass a
 * screw, ask for an ISO grade by name instead.
 */
const CLEARANCE_LOCATED_OVER = 0.2;

/** Diameter clearance added around a head so it drops into its recess. */
const HEAD_FIT = 0.6;

/** Minimum solid left under a head recess, so it never breaks through. */
const DEFAULT_FLOOR = 1;

/** Overshoot so a cutter punches cleanly through the face it starts on. */
const OVER = 0.5;

export type ClearanceGrade = 'located' | 'close' | 'normal' | 'free';

/** Clearance-hole diameter for a size at a grade. */
export function clearanceDiameter(size: FastenerSize, grade: ClearanceGrade = 'located'): number {
  const spec = FASTENERS[size];
  if (grade === 'located') return spec.major + CLEARANCE_LOCATED_OVER;
  return spec.clearance[grade];
}

function head(size: FastenerSize, style: Exclude<HeadStyle, 'none'>): HeadSpec {
  const h = FASTENERS[size].heads[style];
  if (!h) throw new Error(`no ${style} head listed for ${size}`);
  return h;
}

/** Head diameter to design against — measured where we have measured. */
export function headDiameter(size: FastenerSize, style: Exclude<HeadStyle, 'none'>): number {
  const h = head(size, style);
  return h.measured?.d ?? h.d;
}

/** Head height to design against — measured where we have measured. */
export function headHeight(size: FastenerSize, style: Exclude<HeadStyle, 'none'>): number {
  const h = head(size, style);
  return h.measured?.h ?? h.h;
}

/** Recess diameter for a head: what it measures, plus a fit. */
export function headRecessDiameter(size: FastenerSize, style: Exclude<HeadStyle, 'none'>): number {
  return Math.round((headDiameter(size, style) + HEAD_FIT) * 100) / 100;
}

/** Starter-hole diameter on the receiving part. */
export function pilotDiameter(
  size: FastenerSize,
  profile: 'machine' | 'thread-forming' = 'machine',
): number {
  const spec = FASTENERS[size];
  return profile === 'machine' ? spec.pilotMachine.d : spec.pilotForming;
}

/**
 * Minimum thread engagement worth asking for, in mm of screw inside the
 * receiving part. 2 × major is the usual rule for thermoplastic; below that the
 * joint is holding on the first turn or two, which is where a plastic boss
 * strips. Advice, not enforcement — a caller with 6 mm of material has 6 mm of
 * material — so use it to decide whether to warn.
 */
export function minEngagement(size: FastenerSize): number {
  return 2 * FASTENERS[size].major;
}

// ---------------------------------------------------------------------------
// Modelled threads
// ---------------------------------------------------------------------------

/**
 * Nozzle width assumed when deciding whether a thread can print.
 *
 * There is no printer line-width in project state — the printer presets carry
 * bed volume only — so this is the 0.4 mm nozzle nearly every consumer FDM
 * machine ships with. If a line-width setting ever lands, this is the one place
 * that has to read it.
 */
export const ASSUMED_NOZZLE = 0.4;

/**
 * Radial clearance between the modelled thread and the screw.
 *
 * UNVERIFIED. Nothing has been printed at this figure, unlike the 4.8 pilot
 * which a coupon settled. `npm run thread:coupon` prints a ladder of fits for
 * exactly this reason, and until one comes back no structural joint should be
 * switched from `self-tap` to `pre-threaded`. The last time a diameter here
 * moved on arithmetic alone it was heading for a printed part.
 */
export const THREAD_FIT = 0.15;

/**
 * Can a modelled thread at this size actually print?
 *
 * The governing dimension is PITCH, not diameter: the female thread's crest is
 * a wedge roughly a quarter-pitch wide at its tip, and below about two nozzle
 * widths of pitch there is nothing for the slicer to lay down — the thread
 * comes out as a smooth bore with texture on it. M5 (0.8) and M6 (1.0) clear a
 * 0.4 nozzle; M4 (0.7) and everything below do not.
 *
 * This is why `pre-threaded` is an option rather than the default, and why
 * asking for it on a small screw quietly gets you `self-tap` instead.
 */
export function preThreadPrintable(size: FastenerSize, nozzle = ASSUMED_NOZZLE): boolean {
  return FASTENERS[size].pitch >= 2 * nozzle;
}

/** Which receiver a request actually resolves to, once printability is applied. */
export function resolveReceiver(
  size: FastenerSize,
  mode: ReceiverMode,
  nozzle = ASSUMED_NOZZLE,
): ReceiverMode {
  return mode === 'pre-threaded' && preThreadPrintable(size, nozzle) ? 'pre-threaded' : 'self-tap';
}

/** ISO 68-1: engaged thread depth is 5H/8 = 0.5413 × pitch. */
const ISO_DEPTH_FACTOR = 0.5413;
const TAN30 = Math.tan(Math.PI / 6);
/** Facets per turn of the helix. 24 measured indistinguishable from 32. */
const DEFAULT_THREAD_SEGMENTS = 24;

export interface ThreadToolOptions {
  /** Radial clearance added to the screw's form. Defaults to {@link THREAD_FIT}. */
  fit?: number;
  /** Thread depth as a multiple of pitch. Lower truncates the female crest. */
  depthFactor?: number;
  segmentsPerTurn?: number;
  /** Cone the mouth open over one pitch so the screw finds the thread. */
  leadIn?: boolean;
}

/**
 * The solid a screw occupies — core plus helical ridge — to be SUBTRACTED from
 * the receiving part. Runs along +z from z = 0.
 *
 * Subtracting the screw's own shape is what leaves a matching female thread:
 * the tool's core takes the bore out to the minor diameter and the tool's ridge
 * takes the groove, so the material left standing between successive turns of
 * that ridge IS the female thread.
 *
 * Built as a twist extrusion, which needs no new primitive — `extrude` already
 * carries `twistDegrees`, so a 2D profile of "circle at the minor radius, plus
 * one tooth" traced through 360° per pitch sweeps the whole thread in one op.
 * The tooth is drawn in POLAR form, angle standing for axial position at 360°
 * per pitch, which is what makes the 60° flank exact rather than approximated:
 * an axial half-width w at radius r is drawn at ±360 × w / pitch degrees.
 *
 * Handedness: `twistDegrees` POSITIVE gives a right-hand thread. A left-hand
 * one passes every volume and bounding-box check ever written and is useless,
 * so that sign is pinned by test, not by argument.
 */
export function threadTool(
  size: FastenerSize,
  length: number,
  opts: ThreadToolOptions = {},
): BuildOp {
  const { major, pitch } = FASTENERS[size];
  const fit = opts.fit ?? THREAD_FIT;
  const depthFactor = opts.depthFactor ?? ISO_DEPTH_FACTOR;
  const seg = opts.segmentsPerTurn ?? DEFAULT_THREAD_SEGMENTS;
  const rMaj = major / 2 + fit;
  const rMin = rMaj - depthFactor * pitch;
  const turns = length / pitch;

  // Axial half-width of the screw's thread at radius r: a flat P/16 either side
  // of the crest, opening out at 30° from the radial direction (a 60° included
  // angle). At the root this reaches ~0.3 mm for M5 — three quarters of a turn
  // of angular width, which is correct, and why the tool's volume comes out
  // well under a plain cylinder's.
  const halfWidth = (r: number): number => pitch / 16 + (rMaj - r) * TAN30;
  const steps = 6;
  const front: Vec2[] = [];
  const back: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const r = rMin + ((rMaj - rMin) * i) / steps;
    // Clamped so the tooth can never wrap onto itself, which would split the
    // extrusion into two components.
    const a = Math.min((2 * Math.PI * halfWidth(r)) / pitch, (170 * Math.PI) / 180);
    front.push([r * Math.cos(a), r * Math.sin(a)]);
    back.push([r * Math.cos(-a), r * Math.sin(-a)]);
  }
  const tooth = poly([...front, ...back.reverse()]);
  const profile = pUnion([circleProfile(rMin, Math.max(24, seg)), tooth]);

  const helix = extrude(profile, length, {
    twistDegrees: 360 * turns,
    divisions: Math.max(2, Math.ceil(turns * seg)),
  });
  if (opts.leadIn === false) return helix;
  // Mouth chamfer: opens the first pitch out to the major diameter so the screw
  // enters on a thread rather than on a crest.
  const lead: BuildOp = {
    kind: 'cylinder',
    height: pitch,
    radiusLow: rMaj,
    radiusHigh: rMin,
    segments: Math.max(24, seg),
  };
  return union([helix, lead]);
}

// ---------------------------------------------------------------------------
// The primitives
// ---------------------------------------------------------------------------

/**
 * Rotate a +z-built feature so it runs along `axis`, then place it at `at`.
 * Sign matters here in a way it does not for `axisCylinder`: a screw hole is
 * directional, because the head is at one end of it.
 */
function orient(axis: Facing, op: BuildOp): BuildOp {
  switch (axis) {
    case '+z':
      return op;
    case '-z':
      return rotate([180, 0, 0], op);
    case '+x':
      return rotate([0, 90, 0], op);
    case '-x':
      return rotate([0, -90, 0], op);
    case '+y':
      return rotate([-90, 0, 0], op);
    case '-y':
      return rotate([90, 0, 0], op);
  }
}

export interface ScrewHoleOptions {
  size: FastenerSize;
  /** Where the screw goes in: the centre of the hole on the ENTRY face. */
  at: Vec3;
  /** Direction the screw travels, into the material. Default '+z'. */
  axis?: Facing;
  /** Length of clearance hole to cut, from `at` along `axis`. */
  through: number;
  /** Head shape. 'none' cuts a plain through-hole and no recess. */
  head?: HeadStyle;
  /**
   * How far the head is let in. 'flush' sinks it by its own height; a number
   * sinks it that deep (more than the head height leaves it sub-flush); 'none'
   * or omitted leaves it proud.
   */
  recess?: 'none' | 'flush' | number;
  /** Clearance grade, when not overridden outright. */
  grade?: ClearanceGrade;
  /** Explicit clearance diameter — for data-driven callers with their own. */
  clearanceD?: number;
  /** Explicit head-recess diameter, for a head not in the table. */
  headD?: number;
  /** Minimum solid to leave under the recess floor. */
  floor?: number;
  /** Material available along the axis, if the recess must be floor-limited. */
  material?: number;
  segments?: number;
  /**
   * Facets on the head recess, when it wants more than the shank. A recess is a
   * seating face a head actually bears on and is usually visible on the
   * finished part; the shank hole is neither, so the two are allowed to differ.
   * Defaults to `segments`.
   */
  recessSegments?: number;
}

/**
 * Head recess + clearance hole, as one cutting op.
 *
 * The recess is always cut FROM the entry face — it is where the head sits, and
 * the head is at the end the screw goes in. Which way the part prints is not
 * this function's business: a counterbore whose ceiling faces down is a bridge,
 * and only the caller knows which way up its part goes on the bed
 * (`exportLayout`'s `PRINT_FLIP_NODE_IDS` is where that lives).
 */
export function screwHole(o: ScrewHoleOptions): BuildOp {
  const seg = o.segments ?? 32;
  const rseg = o.recessSegments ?? seg;
  const style = o.head ?? 'none';
  const clearD = o.clearanceD ?? clearanceDiameter(o.size, o.grade ?? 'located');
  const cuts: BuildOp[] = [
    translate([0, 0, -OVER], cylinder(o.through + 2 * OVER, clearD / 2, seg)),
  ];

  if (style !== 'none' && o.recess !== undefined && o.recess !== 'none') {
    const recessD = o.headD ?? headRecessDiameter(o.size, style);
    const floor = o.floor ?? DEFAULT_FLOOR;
    const limit = o.material !== undefined ? Math.max(0, o.material - floor) : Infinity;
    if (style === 'countersunk') {
      // A 90° head is a cone, and the cone needs no new op: `cylinder` already
      // carries radiusHigh through to Manifold — only the buildPlan helper
      // hides it. Its depth is set by its own geometry, not by `recess`: a
      // countersink cut shallower than the head simply leaves the head proud,
      // so when there is not enough material the MOUTH narrows instead and the
      // caller gets a smaller, still-flush head seat.
      const coneDepth = Math.min((recessD - clearD) / 2, limit);
      if (coneDepth > 0) {
        cuts.push(
          translate([0, 0, -OVER], {
            kind: 'cylinder',
            height: coneDepth + OVER,
            // The extra OVER of radius keeps the flank at a true 1:1 (45°,
            // i.e. a 90° included angle) while starting the cut ABOVE the
            // face, so no cutter face is coplanar with the part's — coincident
            // faces are what a slicer reports as a mesh needing repair.
            radiusLow: clearD / 2 + coneDepth + OVER,
            radiusHigh: clearD / 2,
            segments: rseg,
          }),
        );
      }
    } else {
      const wanted = o.recess === 'flush' ? headHeight(o.size, style) : o.recess;
      const depth = Math.min(wanted, limit);
      if (depth > 0) {
        cuts.push(translate([0, 0, -OVER], cylinder(depth + OVER, recessD / 2, rseg)));
      }
    }
  }
  return translate(o.at, orient(o.axis ?? '+z', union(cuts)));
}

export interface ScrewStarterOptions {
  size: FastenerSize;
  /** Mouth of the receiving hole. */
  at: Vec3;
  /** Direction the screw travels, into the material. Default '+z'. */
  axis?: Facing;
  /** How deep the screw reaches. */
  depth: number;
  /** Plain starter hole, or a modelled thread. Default 'self-tap'. */
  mode?: ReceiverMode;
  /** Which pilot column a self-tap hole reads. Default 'machine'. */
  profile?: 'machine' | 'thread-forming';
  /** Explicit pilot diameter, for a screw not in the table (fan self-tappers). */
  pilotD?: number;
  /** Passed through to {@link threadTool} when pre-threading. */
  thread?: ThreadToolOptions;
  segments?: number;
}

/**
 * The receiving hole — the half of a screw joint that HOLDS.
 *
 * `self-tap` cuts a plain starter hole at the pilot diameter. `pre-threaded`
 * subtracts a modelled thread instead, but falls back to `self-tap` wherever
 * the pitch is too fine to print (see {@link preThreadPrintable}). That
 * fallback is deliberate and not a nicety: a thread that fails to print is a
 * smooth bore at the MAJOR diameter, which holds nothing at all — far worse
 * than the starter hole it replaced. Callers that want to say so out loud
 * should ask {@link resolveReceiver} first.
 */
export function screwStarter(o: ScrewStarterOptions): BuildOp {
  const seg = o.segments ?? 24;
  const mode = resolveReceiver(o.size, o.mode ?? 'self-tap');
  const body =
    mode === 'pre-threaded'
      ? threadTool(o.size, o.depth + OVER, o.thread)
      : cylinder(
          o.depth + OVER,
          (o.pilotD ?? pilotDiameter(o.size, o.profile ?? 'machine')) / 2,
          seg,
        );
  return translate(o.at, orient(o.axis ?? '+z', translate([0, 0, -OVER], body)));
}
