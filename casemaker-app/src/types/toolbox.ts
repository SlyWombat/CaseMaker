import type { Mm } from './units';

/**
 * Issue #155 — the stacking-toolbox archetype: bins and lids that register on
 * each other with no connector at all.
 *
 * PROVENANCE. The module geometry is clean-room; the FLOOR SOCKET INTERFACE is
 * not, and the split is deliberate — see below.
 *
 *   The requirements here are derived from `/Toolbox.md`, which is a functional
 *   review of the commercial field (Systainer, Packout, ToughSystem, Sortimo,
 *   Makita MakPac, …) plus a list of what a stacking box must do. No geometry
 *   from any of those systems is reproduced: the foot, the seating ledge, the
 *   flare and the whole stacking joint are ours, chosen to satisfy a stated
 *   requirement, and none of them is a measurement taken from a reviewed
 *   product. The ToolStack system's 45° slider and its 13 mm / 6 mm skirt are
 *   not reused, and neither is any exterior dimension.
 *
 *   Its 5 × 5 mm socket lattice on a 12 mm pitch IS reused — a reversal of this
 *   file's original position, made 2026-10-07 when the floor grid stopped being
 *   host-less. The reasoning is `holeGrid.ts`'s, and it is the same one #150
 *   turned on: a hole pitch and a socket size are the dimensions of a mating
 *   part interface, which is a functional fact about the drawing rather than a
 *   design we reproduce, and copying them is what lets a third-party accessory
 *   or a printed divider fit. The tenon FIT is a different matter — that is a
 *   hypothesis about the user's printer and it stays PROVISIONAL in
 *   `dividerPegs.ts`. No compatibility is CLAIMED anywhere in the app: the grid
 *   is described by its own numbers, never as "fits ToolStack".
 *
 *   The licence position that made the clean-room route the plan of record still
 *   governs everything else: ToolStack ships without a licence, so its geometry
 *   may not be copied; Multiboard's is revocable, so no dimension of it should be
 *   depended on either; openGrid is CC-BY and safe to *study*.
 *
 * Frame — and this one is load-bearing, so it is written down:
 *
 *   - the outline is CENTRED on the XY origin, so the bounding box is
 *     `[-W/2, W/2] × [-D/2, D/2]`, matching `BadgeParams`/`BlankParams`;
 *   - `z = 0` is the module's SEATING PLANE — the face that rests on the module
 *     below, or on the bench — and it is ALSO the face that goes on the print
 *     bed. The box rises from it to `height`.
 *
 * HOW A STACK REGISTERS, and why it is shaped the way it is:
 *
 *   The module's bottom `TOOLBOX_FOOT_H` mm is a FOOT: the same box, inset
 *   `TOOLBOX_FOOT_INSET` on every side. The foot drops into the opening of the
 *   module below, which carries a matching SEATING LEDGE `height - TOOLBOX_FOOT_H`
 *   above its own seating plane. So the modules telescope into each other with
 *   `TOOLBOX_FIT_CLEAR` of sliding clearance and a 45° nose to lead the way in,
 *   and a stack is square with no connector at all.
 *
 *   The foot points UP in print orientation rather than down, and that is not a
 *   style choice — it is the only shape that prints. An earlier draft hung the
 *   same registration as a skirt BELOW the floor (so a module sat *on top of*
 *   the one below). That part cannot be printed in one piece: with the skirt on
 *   the bed the floor slab has to close a 292 × 192 mm span in mid-air, and with
 *   the floor on the bed the skirt is 12 mm on the far side of it. The foot is
 *   the same mechanism with the module's own flat base as the bed contact.
 *
 *   The cost is honest and visible: a stack NESTS — each joint sinks
 *   `TOOLBOX_FOOT_H` mm — rather than stacking rim-on-rim, so N modules of
 *   height `h` stand `h + (N-1)(h - FOOT_H)` tall.
 *
 * Naming follows `BlankParams` (`width` = X, `depth` = Y, matching the rack's
 * `width`/`depth` pair) rather than `EnclosureParams`' `size.x/y/z`, because a
 * toolbox has no board and no coordinate frame of its own to inherit.
 */
export interface ToolboxParams {
  enabled: boolean;
  /** External plan along X, mm — the stacking footprint, not the cavity. */
  width: Mm;
  /** External plan along Y, mm. */
  depth: Mm;
  /** External module height, seating plane to rim, mm — the free variable. */
  height: Mm;
  /** The blind socket grid in the bin's floor — the mount for `pegs`. */
  grid: boolean;
  /** Drop-in dividers standing in the bin. Absent or empty means none. */
  pegs?: ToolboxPeg[];
}

/**
 * A drop-in divider: a flat wall standing in the bin, held down by two square
 * tenons that plug into the floor's sockets.
 *
 * `spans` is the peg's own unit — how many SOCKET PITCHES apart its two tenons
 * are — so a divider is sized in holes rather than millimetres and stays right
 * when the pitch or the bin changes. `spans: 4` builds a wall whose tenons sit
 * four pitches apart; the wall is a little wider than that, because each end
 * carries an ear out to the socket's far edge (see `dividerPegs.ts`).
 *
 * The geometry is `dividerPegs.ts`'s and is shared with the drawer-pegs work in
 * #150; this is only what a toolbox divider IS.
 */
export interface ToolboxPeg {
  id: string;
  /** Socket pitches between the two tenons. At least 1. */
  spans: number;
  /** Wall height above the floor, mm. */
  height: Mm;
  /** Wall thickness, mm. */
  thickness: Mm;
  /** Which way the wall runs: `'x'` across the width, `'y'` across the depth. */
  axis: 'x' | 'y';
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// The module's fixed specification.
//
// These live here rather than beside the geometry because they are what the
// parameters *mean* — `toolboxParamsProblem` has to know them to say why a size
// will not build, and the compiler has to know the same numbers to build it.
// One source, so the two can never drift. `types/snap.ts` exports
// `FIT_RELIEF_MM` the same way. v1 keeps them constants, not controls, per the
// house rule "fix the default before adding a control".
// ---------------------------------------------------------------------------

/** Side wall thickness, mm. */
export const TOOLBOX_WALL_T: Mm = 3.0;
/** Floor thickness above the seating plane, mm. */
export const TOOLBOX_FLOOR_T: Mm = 4.0;
/** Height of the registration foot, mm — how far a module nests into the one
 *  below, and how deep the receiving ledge sits below the rim. */
export const TOOLBOX_FOOT_H: Mm = 12.0;
/** 45° lead-in on the foot's bottom edge, mm. */
export const TOOLBOX_LEAD_IN: Mm = 2.0;
/**
 * Sliding clearance per side between the foot and the receiving wall, mm.
 *
 * Provisional — none of this has been printed. The honest way to settle it is
 * #157's fit coupon, which v1 exports `toolboxFootOps` for but does not build.
 */
export const TOOLBOX_FIT_CLEAR: Mm = 0.3;
/** Inward reach of the seating ledge the module above's foot lands on, mm. */
export const TOOLBOX_LEDGE_W: Mm = 6.0;
/** Height of the lid module, mm — floor plus a 12 mm recess. */
export const TOOLBOX_LID_H: Mm = 16.0;
/** Material kept between the nearest socket edge and the foot's cavity wall, mm. */
export const TOOLBOX_GRID_GAP: Mm = 1.0;
/**
 * How deep the floor's sockets are cut, mm.
 *
 * Half the floor, so a socket leaves `TOOLBOX_FLOOR_T / 2` of material beneath
 * it and the bin stays sealed. DEEP is the load-bearing number for this grid,
 * not pitch: at a 12 mm pitch a 5 × 5 socket fills only 17% of its cell, so what
 * sets the floor's remaining section is how far down it goes.
 *
 * The dividers are built around it — `dividerPegs.ts` reaches `socketDepth` less
 * its own bottom gap — so changing this moves the tenon, not just the hole.
 * PROVISIONAL: nothing here has been printed, and #153 owns the fit.
 */
export const TOOLBOX_GRID_DEPTH: Mm = 2.0;

/** Inset of the foot's OUTER face from the module's outer face, mm. */
export const TOOLBOX_FOOT_INSET: Mm = TOOLBOX_WALL_T + TOOLBOX_FIT_CLEAR;
/** Inset of the foot's INNER (cavity) face from the module's outer face, mm. */
export const TOOLBOX_FOOT_CAVITY_INSET: Mm = TOOLBOX_FOOT_INSET + TOOLBOX_WALL_T;
/**
 * The smallest plan a module can have, mm, exterior.
 *
 * The foot's cavity is `TOOLBOX_FOOT_CAVITY_INSET` in from each edge, and the
 * seating ledge reaches a further `TOOLBOX_LEDGE_W` in — below twice their sum
 * there is no cavity left for the module above's foot to land in.
 */
export const TOOLBOX_MIN_PLAN: Mm = 2 * (TOOLBOX_FOOT_CAVITY_INSET + TOOLBOX_LEDGE_W);
/**
 * The shortest buildable module, mm.
 *
 * The outward flare that turns the foot into the full-width box takes
 * `TOOLBOX_FOOT_INSET` of height, and the foot itself takes `TOOLBOX_FOOT_H`;
 * below their sum there is no box left above the foot.
 */
export const TOOLBOX_MIN_HEIGHT: Mm = TOOLBOX_FOOT_H + TOOLBOX_FOOT_INSET;
/**
 * Inset of the nearest socket EDGE from the module's outer face, mm.
 *
 * The floor grid must not break into the foot's wall — the two features share
 * the floor, and a socket under the wall would leave it overhanging a notch. A
 * socket is only safe once its whole outline clears the foot's cavity face by
 * `TOOLBOX_GRID_GAP`.
 *
 * Measured to the EDGE, which is what `HoleGridOptions.margin` means; that
 * function adds half a socket itself before placing centres. The effective
 * inset is therefore unchanged from the old centre-measured constant (this plus
 * half a socket), so the lattice sits exactly where it used to.
 */
export const TOOLBOX_GRID_MARGIN: Mm = TOOLBOX_FOOT_CAVITY_INSET + TOOLBOX_GRID_GAP;

/**
 * The starter module: 300 × 200 × 110 mm with the floor grid on.
 *
 * 300 × 200 is the classic euro-container footprint and it prints on the small
 * beds that motivated #148 without a split. 110 mm is the middle rung of the
 * ladder below: tall enough for hand tools, short enough that a stack of three
 * still fits a shelf.
 */
export function defaultToolboxParams(overrides: Partial<ToolboxParams> = {}): ToolboxParams {
  return {
    enabled: true,
    width: 300,
    depth: 200,
    height: 110,
    grid: true,
    pegs: [],
    ...overrides,
  };
}

/** Wall thickness of a new divider, mm — stiff enough to divide, thin enough
 *  that two of them plus their sockets fit a 12 mm cell. */
export const TOOLBOX_PEG_THICKNESS: Mm = 2.4;

/**
 * A divider with the defaults filled in; the caller mints the `id` and the
 * height.
 *
 * The height is a REQUIRED argument rather than a default here on purpose. How
 * tall a divider may stand depends on the seating ledge, which is geometry —
 * and geometry lives in `engine/compiler/toolbox.ts`, not in the types. The
 * panel passes `toolboxPegHeadroom(...)` from there, so there is one formula
 * rather than one here and another beside the module.
 */
export function defaultToolboxPeg(
  id: string,
  spans: number,
  height: Mm,
  overrides: Partial<Omit<ToolboxPeg, 'id'>> = {},
): ToolboxPeg {
  return {
    id,
    spans,
    height,
    thickness: TOOLBOX_PEG_THICKNESS,
    axis: 'x',
    enabled: true,
    ...overrides,
  };
}

/**
 * Height presets, in mm — our own ladder, 50 mm apart.
 *
 * These are a CONVENIENCE over a free number, never a constraint: the module
 * height is `height`, and any buildable value builds. The ladder exists because
 * the useful thing about a stacking system is that modules of different heights
 * still line up, and four round numbers keep that legible.
 */
export const TOOLBOX_HEIGHT_LADDER: readonly Mm[] = [60, 110, 160, 210];

/**
 * Why these parameters will not make a module, or `null` when they will.
 *
 * Mirrors `blankParamsProblem`: the panel states the reason rather than the
 * compiler throwing out of a render, so a hand-edited or migrated project says
 * what is wrong instead of going silently blank.
 *
 * This is the ONLY predicate — `buildToolboxNodes` consults it rather than
 * repeating the limits, so a size that reports a reason is exactly a size that
 * will not build.
 */
export function toolboxParamsProblem(p: ToolboxParams): string | null {
  if (!(p.width > 0)) return 'the toolbox width must be positive';
  if (!(p.depth > 0)) return 'the toolbox depth must be positive';
  if (!(p.height > 0)) return 'the toolbox height must be positive';
  if (p.width < TOOLBOX_MIN_PLAN) {
    return `the toolbox width (${p.width} mm) is too narrow — the walls, the registration foot and the seating ledge need ${TOOLBOX_MIN_PLAN} mm`;
  }
  if (p.depth < TOOLBOX_MIN_PLAN) {
    return `the toolbox depth (${p.depth} mm) is too narrow — the walls, the registration foot and the seating ledge need ${TOOLBOX_MIN_PLAN} mm`;
  }
  if (p.height < TOOLBOX_MIN_HEIGHT) {
    return `the toolbox height (${p.height} mm) is too short — the registration foot alone is ${TOOLBOX_FOOT_H} mm, so it needs at least ${TOOLBOX_MIN_HEIGHT} mm`;
  }
  return null;
}
