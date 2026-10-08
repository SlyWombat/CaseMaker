import type { Mm } from './units';
import type { SnapCatch, FitVariant } from './snap';
import type { RackParams } from './rack';
import type { BadgeParams } from './badge';
import type { InsertParams } from './insert';
import type { BlankParams } from './blank';
import type { ToolboxParams } from './toolbox';

/**
 * Issue #153 — `FitVariant` lives with the snap types (`types/snap.ts`)
 * because a fit is a snap/joint concept; re-exported here so feature code
 * that already imports from `types/case` can name it.
 */
export type { FitVariant } from './snap';
export { FIT_VARIANTS, FIT_RELIEF_MM, fitRelief } from './snap';

/**
 * Issue #92 — barrel-hinge feature for snap-fit / flat-lid cases.
 *
 *  - 'external-pin': discrete knuckles + a separate user-supplied pin (M3 screw
 *                    or brass rod). Easiest to print, strongest action.
 *  - 'print-in-place': same knuckle layout, plus a centered pin solid printed
 *                      inside the through-hole with knuckleClearance/2 of slop
 *                      on each side. No assembly required.
 *
 * v1 limitations (deferred to follow-up issues): single hinge per case, side
 * faces only (±x / ±y), no detents, lid does NOT animate to its closed
 * position in Complete view (drops straight down regardless of hinge axis).
 */
export type HingeStyle =
  | 'external-pin'
  | 'print-in-place'
  /** Issue #110 — piano-continuous: many tightly-spaced knuckles giving a
   *  visually-continuous hinge bar. Strongest action, spreads load evenly. */
  | 'piano-continuous'
  /** Issue #110 — piano-segmented: 5–7 knuckle clusters with gaps. Easier
   *  to print than continuous; visually similar. */
  | 'piano-segmented'
  /** Issue #110 — pip-pivot: two short pivot bosses near the ends, no
   *  centerline pin. Lid clips on. Only suitable for shallow cases. */
  | 'pip-pivot'
  /** Issue #114 — hardware-screw: two short pivot bosses, one at each end of
   *  the hinge face, each closed by its own M3 self-tapping screw instead of a
   *  continuous pin. For big / heavy lids that are opened often (Whity's Rugged
   *  Box). No pin node is emitted; `hingeLength` does not size this style — the
   *  bosses sit at the face ends and are sized for the screw. */
  | 'hardware-screw';
export type HingePinMode = 'separate' | 'print-in-place';
export type HingePositioning = 'continuous' | 'pair-at-ends' | 'centered';

export interface HingeFeature {
  id: string;
  style: HingeStyle;
  /** Side face the hinge runs along. Top/bottom (±z) not supported in v1. */
  face: '+x' | '-x' | '+y' | '-y';
  /** Total knuckle slots; odd, ≥ 3 (so case knuckles outnumber lid knuckles
   *  by exactly one — the lid pivots between matched pairs). Default 5. */
  numKnuckles: number;
  /** Outside diameter of every knuckle cylinder (mm). Default 8. */
  knuckleOuterDiameter: Mm;
  /** Through-hole diameter and (for print-in-place) pin solid diameter (mm).
   *  Default 3 — fits an M3 screw or 3 mm brass rod. */
  pinDiameter: Mm;
  /** Axial gap between adjacent knuckles (mm). Default 0.4. */
  knuckleClearance: Mm;
  /** Layout strategy along the hinge edge. Default 'centered'. */
  positioning: HingePositioning;
  /** Total length of the knuckle run, including clearances (mm). Default 60. */
  hingeLength: Mm;
  /** Optional rotation stop in degrees from closed; undefined = no stop. */
  stopAngle?: number;
  /** Whether the pin is user-supplied or printed in place. Default 'separate'. */
  pinMode: HingePinMode;
  enabled: boolean;
}

/**
 * The six faces of an axis-aligned box-shaped case.
 *
 * Issue #50 — single canonical definition. Previously duplicated across
 * `fan.ts`, `mounting.ts`, `textLabel.ts`; those modules now re-export this
 * type so existing import paths keep working.
 */
export type CaseFace = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export type JointType = 'snap-fit' | 'screw-down' | 'flat-lid';
/**
 * Issue #78 — only meaningful when joint === 'snap-fit'.
 *  - 'barb'   : discrete cantilever arms with inside-wall lips at each catch
 *               position. Lid is a flat plate. Print-friendly, easy to release.
 *  - 'full-lid': continuous lip ring around the entire perimeter — friction-fit
 *               between lid lip and cavity walls. Snap catches still optional.
 *               Tighter seal, harder to insert / remove.
 */
export type SnapType = 'barb' | 'full-lid';
export type InsertType =
  | 'self-tap'
  | 'heat-set-m2.5'
  | 'heat-set-m3'
  | 'pass-through'
  | 'none';
export type VentilationPattern = 'none' | 'slots' | 'hex' | 'chevron';

export type BossPosition = 'bottom' | 'top';

/** Issue #111 — rugged exterior options. Independent of the seal/hinge/
 *  latch features; usable on any case style for added drop protection
 *  and stiffness. */
export interface RuggedParams {
  enabled: boolean;
  corners: {
    enabled: boolean;
    /** Bumper outer radius extending past the case envelope. Typical 3–6 mm. */
    radius: Mm;
    /** Issue #121 — height of each discrete corner cap (NOT full case
     *  height — that produced full-height pillars at every corner, which
     *  is wrong). Bumpers are placed as TOP + BOTTOM caps so 4 vertical
     *  corners get 8 caps total. Default 12 mm. */
    capHeight?: Mm;
    /** When true, bumpers print as SEPARATE top-level nodes (in TPU) so
     *  the user can slip them on. When false, fused with the case body. */
    flexBumper: boolean;
  };
  ribbing: {
    enabled: boolean;
    direction: 'vertical' | 'horizontal';
    ribCount: number;
    ribDepth: Mm;
    /** Whity-style refinement: leave smooth bands at the top + bottom of
     *  each wall (ribs only span the middle band). 0 = full-height ribs. */
    clearBand: Mm;
  };
  feet: {
    enabled: boolean;
    pads: 4 | 6;
    padDiameter: Mm;
    padHeight: Mm;
  };
}

/** Issue #107 — waterproof gasket cross-section profile. 'flat' is a
 *  rectangular cross-section (most common for printable TPU). 'o-ring' is
 *  a circular cross-section (better seal, harder to print evenly). */
export type SealProfile = 'flat' | 'o-ring';

/** Issue #107 — gasket material, drives slicer hint sidecar in #108. */
export type SealGasketMaterial = 'tpu' | 'eva' | 'epdm';

/**
 * Issue #117 — how the two halves close.
 *
 *  - `'recess'` — tray + plate. The lid is a thin plate that drops into a
 *    pocket cut into the rim; the gasket sits in a channel in the rim top.
 *    (The original, and the default.)
 *  - `'clamshell'` — two boxes meeting at the rim. The lid is a full-
 *    footprint shell of its own, sitting ON the rim, with the gasket
 *    sandwiched between the two mating flanges. Pelican / Whity "Rugged
 *    Box" style. A `'clamshell'` lid is never recessed, by definition.
 */
export type SealMode = 'recess' | 'clamshell';

export interface SealParams {
  enabled: boolean;
  /**
   * Issue #117 — closure style. Absent = `'recess'`, so legacy projects
   * load and compile unchanged. `'clamshell'` overrides `lidRecess` (the
   * lid is a box by definition) and guarantees the lid has a cavity, so a
   * project cannot silently get a thin plate where it asked for a box.
   */
  mode?: SealMode;
  profile: SealProfile;
  /** Gasket cross-section width (or O-ring diameter). */
  width: Mm;
  /** Gasket cross-section depth — uncompressed thickness. */
  depth: Mm;
  /** Fraction of `depth` the tongue presses the gasket past flush. 0.20–0.30 typical. */
  compressionFactor: number;
  /** Informational; #108 uses this to pick slicer-hint defaults. */
  gasketMaterial: SealGasketMaterial;
  /** Issue #113 — per-feature tolerance (mm) added to channel + tongue
   *  widths so the gasket installs without binding. Optional; defaults to
   *  0.2 mm at the compiler boundary. Tune per printer. */
  gasketClearance?: Mm;
}

export interface BossesParams {
  enabled: boolean;
  insertType: InsertType;
  outerDiameter: Mm;
  holeDiameter: Mm;
  /** Issue #104 — 'bottom' (default) anchors bosses to the case floor;
   *  'top' anchors them to the lid underside with a tapered support column
   *  on the inside wall. Optional for back-compat with v1..v7 projects. */
  position?: BossPosition;
}

/** Issue #75 — surfaces the vent pattern can be cut into. Multi-select; the
 *  same pattern + coverage applies to every selected surface. */
export type VentSurface = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/** Issue #76 — six-face naming for custom cutouts. Same set of values as
 *  VentSurface; kept as a separate alias so each feature can evolve its
 *  schema independently. */
export type CutoutFace = VentSurface;
export type CustomCutoutShape = 'rect' | 'round' | 'slot';

/**
 * Issue #76 — user-defined freeform cutout that isn't tied to a board
 * component. Disabling auto-generated cutouts is still done via the port's
 * `enabled` toggle; this type is for adding NEW holes the auto-detection
 * couldn't supply (cable pass-throughs, antenna leads, mod cuts).
 */
export interface CustomCutout {
  id: string;
  face: CutoutFace;
  shape: CustomCutoutShape;
  /** Position on the face, in mm from the (uMin, vMin) corner of that face. */
  u: Mm;
  v: Mm;
  /** For rect / slot: width × height in (u, v). For round: diameter (uses width). */
  width: Mm;
  height: Mm;
  /** Optional rotation in the face plane (degrees, 0 = u-axis aligned). */
  rotationDeg?: number;
  enabled: boolean;
  /** User-facing label shown in the editor (e.g. "antenna pass-through"). */
  label?: string;
}

export const VENT_SURFACES: ReadonlyArray<VentSurface> = [
  'top',
  'bottom',
  'front',
  'back',
  'left',
  'right',
];

/**
 * Issue #152 — disc magnet sizes the pocket table covers, as
 * outside-diameter × thickness in mm. Defined HERE rather than in
 * `engine/compiler/fasteners.ts` because a stored project has to name a magnet
 * and `types/` must not reach up into the engine; the table in `fasteners.ts`
 * re-exports this union.
 */
export type MagnetSize = '6x2' | '8x3' | '10x2';

/**
 * How a disc is held in its pocket.
 *  - 'glue'    : a slip-fit pocket + adhesive. The table's default.
 *  - 'press'   : an interference pocket, the disc pressed in and held by
 *                friction. Not a table number yet — PROVISIONAL until a coupon
 *                settles the fit (see `fasteners.ts`'s MAGNETS note).
 *  - 'captured': a thin printed membrane left over/under the pocket so the
 *                disc cannot fall out. The caller must know print orientation;
 *                the membrane is a bridge.
 */
export type MagnetRetention = 'glue' | 'press' | 'captured';

/**
 * Issue #152 — one magnet pocket cut into a case face, for retaining a
 * removable part (name plate, tool holder, a lid that must NOT latch). The
 * pocket geometry comes from the MAGNETS table in `engine/compiler/fasteners`;
 * this is only WHERE it goes. Same placement frame as `CustomCutout`.
 */
export interface MagnetPocket {
  id: string;
  /** Face the pocket is cut into. */
  face: CaseFace;
  /** Position on the face, in mm from the (uMin, vMin) corner of that face. */
  u: Mm;
  v: Mm;
  /** Which disc the pocket takes. */
  size: MagnetSize;
  /** Default 'glue'. See {@link MagnetRetention} — all fits are PROVISIONAL. */
  retention?: MagnetRetention;
  enabled: boolean;
  /** User-facing label shown in the editor (e.g. "nameplate magnet"). */
  label?: string;
}

export interface VentilationParams {
  enabled: boolean;
  pattern: VentilationPattern;
  coverage: number;
  /** Issue #75 — defaults to ['back'] when absent so legacy projects render
   *  byte-identical to today (single +y wall). */
  surfaces?: VentSurface[];
}

/**
 * Per-side additive deltas on top of `internalClearance`, in mm. Each value
 * widens the cavity (and outer envelope) on exactly one side without scaling
 * the board itself. xMin pushes the -X wall further from the PCB's -X edge,
 * shifting the board origin in +X by that amount; xMax pushes the +X wall
 * further from the +X edge; ditto yMin/yMax. Z is governed by `zClearance`
 * and the board's standoff height, so no Z entries here.
 */
export interface CavityClearanceTweaks {
  xMin: Mm;
  xMax: Mm;
  yMin: Mm;
  yMax: Mm;
}

export interface CaseParameters {
  wallThickness: Mm;
  floorThickness: Mm;
  lidThickness: Mm;
  cornerRadius: Mm;
  internalClearance: Mm;
  /** Optional per-side widening; missing entries treated as 0. */
  clearanceTweaks?: CavityClearanceTweaks;
  zClearance: Mm;
  joint: JointType;
  /** Recessed-lid mode: lid drops into a pocket at the top of the shell, flush with the rim. */
  lidRecess?: boolean;
  /**
   * How the BOARD is retained inside the case — independent from the lid
   * `joint` (which governs lid retention). Lets the user pick lid screws
   * + board snap-fit, lid snap + board screws, both screwed, etc.
   *
   *   'screws':    board screws into the bosses from above (default; matches
   *                pre-#X behavior). Bosses must be enabled.
   *   'snap':      board snaps into cavity-wall snap fingers — no screws
   *                needed. (Geometry: future commit.)
   *   'press-fit': board friction-fits between cavity walls. No retention
   *                hardware; relies on internalClearance ≈ 0.
   *   'none':      board floats. The user provides their own retention
   *                (foam, double-sided tape, etc.).
   */
  boardRetention?: 'screws' | 'snap' | 'press-fit' | 'none';
  /**
   * Pelican-style shell lid: the lid is itself a hollow box (walls extending
   * UP from the lid plate, with a closed top). When > 0, buildLid produces
   * a shell with an internal cavity of this height; the latch striker rides
   * directly on the lid's outer side wall (no separate striker tab needed).
   * When 0 / undefined, the lid is a flat plate (legacy default).
   *
   * Wall thickness for the lid sides is the case `wallThickness`; the closed
   * top thickness is `lidThickness`.
   */
  lidCavityHeight?: Mm;
  /**
   * Issue #36 — extra cavity height (mm) added on top of the auto-computed
   * minimum. Grows the wall and pushes the lid up; cutout positions are
   * unchanged so connectors stay aligned with their openings.
   */
  extraCavityZ?: Mm;
  ventilation: VentilationParams;
  bosses: BossesParams;
  /** Issue #107 — waterproof gasket geometry. Optional so legacy projects
   *  load without a seal. When enabled, `lidRecess` is forced true at the
   *  UI layer (a flat lid can't compress a gasket reliably). */
  seal?: SealParams;
  /** Issue #109 — spring-cam locking latches (Pelican-style). Each latch
   *  emits a striker on the case wall and a cam arm as a separate top-
   *  level BuildNode. Optional. */
  latches?: import('./latch').Latch[];
  /** Issue #111 — rugged exterior options for protective cases. Corner
   *  bumpers, wall ribbing, integrated feet. Optional. */
  rugged?: RuggedParams;
  /**
   * Optional cantilever snap-fit catches (issue #29). Only consulted when
   * joint === 'snap-fit'; auto-populated by createDefaultProject when the
   * joint is changed to snap-fit.
   */
  snapCatches?: SnapCatch[];
  /**
   * Issue #78 — pick the snap-fit lid style. Default 'barb' (discrete catches +
   * flat lid). 'full-lid' restores the continuous perimeter friction lip.
   * Only meaningful when joint === 'snap-fit'.
   */
  snapType?: SnapType;
  /**
   * Issue #153 — project-level print-fit variant for the snap interfaces
   * (snap catches + board snap clips). Absent = 'tight' (the as-designed
   * number), so legacy projects load and compile unchanged. A `SnapCatch`
   * may override it per catch. See {@link FitVariant}.
   */
  fit?: FitVariant;
  /**
   * Issue #76 — freeform cutouts placed by hand on any case face. Optional
   * so legacy projects load with no migration; missing field = empty list.
   */
  customCutouts?: CustomCutout[];
  /**
   * Issue #152 — disc-magnet pockets for magnetic retention. Optional so
   * legacy projects load with no migration; missing field = empty list. No
   * geometry is emitted until an archetype consumes it (the primitive exists
   * in `engine/compiler/fasteners`, but nothing calls it yet).
   */
  magnetPockets?: MagnetPocket[];
  /**
   * Issue #92 — optional barrel hinge on a side face. Only one hinge per
   * case in v1; multi-hinge support is deferred. Missing/disabled = no hinge
   * geometry emitted, no envelope growth.
   */
  hinge?: HingeFeature;
  /**
   * Desk-stand archetype. When enabled, the project compiles to a STAND
   * instead of a shell+lid box: a picture frame the finished display module
   * screws into, tilted back, carried on a foot. Bypasses the whole
   * shell/lid/boss/vent pipeline — a stand has no cavity and no lid.
   * Requires a board whose `enclosure` block describes the finished module.
   */
  stand?: StandParams;
  /**
   * Parametric mini-rack archetype (see types/rack.ts). When enabled, the
   * project compiles to a RACK ASSEMBLY — side panels, top/bottom plates,
   * and accessories — instead of a shell+lid box. Like `stand`, it bypasses
   * the whole shell/lid/boss/vent pipeline; unlike `stand` it needs no real
   * board data at all (templates use `emptyBoard`).
   */
  rack?: RackParams;
  /**
   * Issue #167 — two-colour name-badge archetype (see types/badge.ts). When
   * enabled, the project compiles to the badge BLANK — two nodes, one per
   * extruder colour — instead of a shell+lid box. Like `rack` and `stand` it
   * bypasses the whole shell/lid/boss/vent pipeline, and like `rack` it needs
   * no real board data (the template uses `emptyBoard`).
   */
  badge?: BadgeParams;
  /**
   * Issue #158 — parametric tool-insert holder archetype (see types/insert.ts).
   * When enabled, the project compiles to a single INSERT PLATE — a slab with a
   * grid of pockets sized to the user's own tools — instead of a shell+lid box.
   * Like `rack` it needs no board data (the template uses `emptyBoard`); unlike
   * `stand` and `badge` it does not fall through for an empty or over-full item
   * list — those still yield a plate (blank, or carrying the items that fit),
   * with `insertProblem` naming what is wrong for the panel. Only a
   * non-positive plate dimension yields no geometry at all.
   */
  insert?: InsertParams;
  /**
   * Issue #280 — the bare-blank archetype (see types/blank.ts). When enabled
   * the project compiles to a single BLANK node — one plate, no board, no
   * shell, no cavity, no lid — the part the Engrave panel drives. It is the
   * weakest archetype claim, so it is checked LAST: a project that also sets
   * `badge`/`insert`/`stand`/`rack` builds that richer shape instead. Like
   * `rack` and `badge` it needs no board data (the template uses
   * `emptyBoard`); unlike `insert` it has no items to place, so a
   * non-positive dimension is the only way it yields no geometry.
   */
  blank?: BlankParams;
  /**
   * Issue #155 — stacking-toolbox archetype (see types/toolbox.ts). When
   * enabled the project compiles to a MODULE FAMILY — a bin and a shallow lid,
   * each a single printed part — instead of a shell+lid box. Like `rack` and
   * `stand` it bypasses the whole shell/lid/boss/vent pipeline and needs no
   * board data (the template uses `emptyBoard`).
   *
   * Precedence sits between the two established assemblies and the board-less
   * parts: a toolbox is a full cavity-and-lid shape, so it outranks
   * `badge`/`insert`/`blank`, while `rack`/`stand` are richer assemblies and
   * win. `z = 0` is the seating plane, not the bed — see the type's own header.
   */
  toolbox?: ToolboxParams;
  /**
   * Issue #148 — offer a bolted split of the case SHELL when it is too big for
   * the project's bed. Absent/false means nothing is built: the split costs two
   * to four intersection cuts plus a row of bolted laps on every compile, which
   * is a price a slider drag should not pay for an export most projects never
   * take. Same reasoning as the rack's `assembledExport`, in the other
   * direction — that one is gated on the part FITTING, this one on it not.
   */
  splitForPrint?: boolean;
}

/**
 * Desk stand for a finished display module (see BoardProfile.enclosure).
 *
 * The frame is a flat plate matching the module's outline: the module's rear
 * body passes THROUGH the frame's opening, its front flange seats on the
 * frame's face, and screws pass from the frame's back into the module's
 * mounting bosses (which sink into counterbored pockets so the flange sits
 * flush). The centre is open, so back-facing connectors stay reachable.
 */
export interface StandParams {
  enabled: boolean;
  /**
   * 'desk' (default): frame + tilted foot, printed as one part.
   * 'wall':  two parts — a WALL PLATE that screws to the drywall (open middle
   *          for wires, countersunk screw holes), and a BODY (the same frame,
   *          plus a shroud housing the cable) that SNAPS onto it. The plate's
   *          cantilever fingers click into windows in the shroud walls.
   * 'slider': one part — a tilted COLUMN carrying a male T-bracket that the
   *          device's rear channel (enclosure.sliderChannel) slides down onto,
   *          on a wide anti-tip foot. No screws: gravity seats the device on
   *          the bracket. Params are reused: frameThickness = column plate
   *          thickness, bezelMargin = column width margin per side beyond the
   *          channel cavity, openingClearance = bracket-to-channel fit
   *          clearance per side.
   * 'pocket': one part — a wall-mounted SHELF the finished module nests into:
   *          back plate with a wall-screw ear each side, a floor and two walls
   *          forming the pocket, 45° lead-ins at the mouth. Retention is
   *          gravity + the walls, so the module's face stays fully visible
   *          (there is no front lip). Sized from the module's own envelope;
   *          only openingClearance is reused (the nesting fit per side). The
   *          tray is one 4 mm gauge + fixed wall-fixing sizes (see
   *          rack.ts WALL_SCREW_D) — deliberately not tunable.
   */
  mount?: 'desk' | 'wall' | 'slider' | 'pocket';
  /** Backward lean of the screen from vertical, in degrees. Wall mount: 0. */
  tiltAngleDeg: number;
  /** Frame plate thickness (must exceed bossHeight + a few mm of screw land). */
  frameThickness: Mm;
  /** Extra material added around the module outline. 0 = frame matches the module. */
  bezelMargin: Mm;
  /** Clearance per side around the module's rear body in the frame opening. */
  openingClearance: Mm;
  /** Screw clearance-hole diameter through the frame (M2 → 2.4). */
  screwHoleDiameter: Mm;
  /** Foot depth, front to back. Must out-reach the leaning screen's centre of mass. */
  baseDepth: Mm;
  /** Foot plate thickness. */
  baseThickness: Mm;
  /** Thickness of each side gusset bracing the frame against the foot. */
  gussetThickness: Mm;
  /** How far up the frame the gussets reach, as a fraction of frame height. */
  gussetHeightFraction: number;

  // ---- Wall mount only (ignored when mount === 'desk') --------------------
  /** Depth of the shroud behind the frame: room for the USB plug + wire bend.
   *  NOTE the frame needs a `bezelMargin` big enough that the shroud walls
   *  don't pinch the module's rear body — the module's own rim is only ~2 mm. */
  shroudDepth?: Mm;
  /** Shroud wall thickness. */
  shroudWall?: Mm;
  /** Wall plate thickness. */
  plateThickness?: Mm;
  /** Border of solid plate around its central wire opening. */
  plateBorder?: Mm;
  /** Clearance hole for the drywall screws (shank, not the head). */
  drywallScrewDiameter?: Mm;
  /** Counterbore diameter for the drywall screw heads (recessed so the plate
   *  still lies flat on the wall). */
  drywallHeadDiameter?: Mm;
}
