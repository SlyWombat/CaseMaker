import type { Mm } from './units';
import type { FitVariant } from './snap';

/**
 * Issue #149 — the stacking connector: a dovetail SOCKET cut into the outside
 * of chosen case walls, and a printed double-ended KEY that rides in the
 * sockets of two separately printed parts to lock them together.
 *
 * PROVENANCE. Clean-room. The BEHAVIOURS come from the ToolStack review in
 * `/Toolbox.md` ("Interface 2 of 3"): registration and retention are separate,
 * the key is double-ended and rides in identical open-ended channels, a
 * leaf-spring detent parks it half-proud and clicks at the seam, and an
 * over-insertion stop gives a flush storage position. The NUMBERS below are
 * ours — chosen from the case's own printing rules, not measured off the
 * reviewed part — and nothing claims to fit it (#147 decided against interop).
 * Where a number is set by a requirement the issue states (45° flanks, a 3 mm
 * engagement depth, a 1 mm beam and a 0.8 mm bump) it is that requirement, not
 * a copy: ToolStack's 11.4 / 16.0 channel, 9.8 × 35 key and 22 mm window are
 * not used.
 *
 * Frame of one socket, used by every constant here: `s` runs across the
 * channel (along the wall), `n` runs OUT of the wall (0 = the wall's outer
 * face) and `z` is world Z, along the channel.
 */

/** The four side walls a socket can go on. Never the top or bottom. */
export type ConnectorFace = '+x' | '-x' | '+y' | '-y';

export const CONNECTOR_FACES: ReadonlyArray<ConnectorFace> = ['-y', '+y', '-x', '+x'];

/**
 * The printed key's length.
 *
 *   'short' — two equal halves of {@link STACK_CAPTURE}: case to case, or a
 *             case to a base plate that carries the same socket.
 *   'long'  — the same two halves with {@link STACK_LONG_REACH} between them,
 *             for a joint with a gap in it: a case standing on rugged feet,
 *             or a hanger held off the wall.
 */
export type StackKeyVariant = 'short' | 'long';

export const STACK_KEY_VARIANTS: ReadonlyArray<StackKeyVariant> = ['short', 'long'];

/** One socket: which wall, and where along it. */
export interface StackSocket {
  face: ConnectorFace;
  /**
   * Shift of the socket's centre along the wall, mm, from the wall's centre.
   * Positive is toward +X on the ±Y walls and toward +Y on the ±X walls.
   */
  offset: Mm;
  /**
   * Cut a pad cut-out through the alignment brim and the rugged ribbing where
   * the socket stands, for a case whose brim or ribbing runs along the whole
   * wall. Absent or false cuts nothing.
   */
  cutThrough?: boolean;
}

export interface StackConnectorParams {
  /** At most one per face; an empty list cuts nothing. */
  sockets: StackSocket[];
  /** Which key the export prints, and so how deep the socket's storage channel is. */
  key: StackKeyVariant;
  /** How many keys to add to the export as separate parts (0 = none). */
  keys: number;
  /**
   * Print-fit variant for the key. Absent inherits `CaseParameters.fit`. The
   * relief goes on the KEY, not the socket — see {@link STACK_SLIDE_CLEARANCE}.
   */
  fit?: FitVariant;
  /**
   * #854 item 2 — REGISTRATION, separate from retention: a raised ring on the
   * lid's top and a matching groove in the floor's underside, so stacked cases
   * seat square with no key in them. Absent/false cuts nothing (legacy plans
   * stay byte-identical).
   */
  register?: boolean;
  /**
   * #854 item 4 — put the SAME socket shift on every wall, so two projects set
   * the same way line up: with it on, the first socket's offset is used for
   * all faces and the per-wall offsets are ignored.
   */
  matchShifts?: boolean;
  /**
   * #854 item 4 — export a BASE PLATE for this case: a shallow tray sharing
   * the case's footprint, its rim carrying the same sockets, so the case drops
   * onto it with the keys parked half-proud. The plate is the LOWER part of a
   * stack (its sockets carry the storage channel, not the receiving pocket).
   */
  basePlate?: boolean;
}

// ---------------------------------------------------------------------------
// Fixed specification. Constants, not controls (the house rule "fix the
// default before adding a control"); the compiler and the panel read these.
// ---------------------------------------------------------------------------

/** Engagement depth: channel floor to the lip's top face, mm. */
export const STACK_DEPTH: Mm = 3.0;
/** Flank angle, degrees from the wall face. The profile below assumes 45. */
export const STACK_FLANK_DEG = 45;
/** Channel width at its floor, mm. The mouth is this minus 2 × depth (45°). */
export const STACK_FLOOR_W: Mm = 14.0;
/** Channel width at the lips, mm — derived, never set. */
export const STACK_MOUTH_W: Mm = STACK_FLOOR_W - 2 * STACK_DEPTH;
/**
 * Pad material left between the wall and the channel floor, mm. It is what
 * the seam notch is cut into, so the notch never reaches the case wall.
 */
export const STACK_BACKING: Mm = 1.2;
/** How far the socket pad stands proud of the wall, mm. */
export const STACK_PAD_PROUD: Mm = STACK_BACKING + STACK_DEPTH;
/** Shoulder of pad either side of the channel floor, mm. */
export const STACK_PAD_SHOULDER: Mm = 4.0;
/** Pad width along the wall, mm. */
export const STACK_PAD_W: Mm = STACK_FLOOR_W + 2 * STACK_PAD_SHOULDER;
/** Dovetail captured in each part, mm — each half of the key. */
export const STACK_CAPTURE: Mm = 12.0;
/** Extra length of the long key between its two halves, mm. */
export const STACK_LONG_REACH: Mm = 16.0;
/** Over-insertion stop: the solid block under the storage channel, mm. */
export const STACK_STOP: Mm = 3.0;
/** Free length past the key's end in the storage channel and the pocket, mm. */
export const STACK_END_PLAY: Mm = 0.5;
/** 45° lead-in on the lips at each open end, mm. */
export const STACK_LEAD_IN: Mm = 1.0;
/** How far the key's web stands proud of the pad face — the grip, mm. */
export const STACK_WEB_PROUD: Mm = 1.5;

/** The leaf spring: beam thickness, mm. */
export const STACK_BEAM_T: Mm = 1.0;
/** Beam width across the key, mm. */
export const STACK_BEAM_W: Mm = 3.0;
/** Window behind the beam: its depth (the spring's travel room), mm. */
export const STACK_WINDOW_DEPTH: Mm = 2.0;
/** Window width across the key, mm (beam + a 1 mm slit each side). */
export const STACK_WINDOW_W: Mm = 5.0;
/** Free span of the beam around each bump, mm. */
export const STACK_WINDOW_L: Mm = 20.0;
/** How far the bump's tip reaches past the key's floor-side face, mm. */
export const STACK_BUMP: Mm = 0.8;
/** Length of the bump's flat tip along the key, mm. */
export const STACK_BUMP_TIP: Mm = 0.8;
/** Seam notch: depth into the backing, mm, and its flat at full depth. */
export const STACK_NOTCH_DEPTH: Mm = 1.0;
export const STACK_NOTCH_FLAT: Mm = 0.6;
/** Notch width across the floor, mm. */
export const STACK_NOTCH_W: Mm = STACK_MOUTH_W;

/**
 * Sliding clearance per engagement face at the 'tight' rung, mm. Ours and
 * UNPRINTED: it is the gap a 0.4 mm nozzle reliably leaves between two
 * printed faces that must slide, not a measurement. PROVISIONAL until the
 * `stack-connector` fit coupon has been printed and read.
 *
 * The fit ladder's relief (`FIT_RELIEF_MM`) is added to it ON THE KEY, the
 * reverse of the snap catches' "relief goes on the cut": a socket is part of
 * a finished case, a key is a 2 g reprint, so one socket must serve every key
 * — exactly how the reviewed system ships its loose slider.
 */
export const STACK_SLIDE_CLEARANCE: Mm = 0.15;

/** Key length for a variant, mm. */
export function stackKeyLength(variant: StackKeyVariant): Mm {
  return 2 * STACK_CAPTURE + (variant === 'long' ? STACK_LONG_REACH : 0);
}
