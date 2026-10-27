import type { Mm } from './units';
import type { TextFont, TextWeight, CustomFont } from './textLabel';
import type { CutParams } from '@/engine/cnc/feeds';
import type { FastenerSize } from '@/engine/compiler/fasteners';
import type { Tool } from '@/engine/cnc/tool';
import type { Mount, MountSpec, Orientation, RemountStep } from '@/engine/cnc/setups/types';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';
import type { ClampPlacement } from '@/engine/cnc/mounts/bracket';

/**
 * The CNC-2 job document (#200): a rectangular blank of wood held in the vise with text
 * labels engraved into its top face, each label at its own depth.
 *
 * This is deliberately NOT a field on `Project` (decision: /Fabrication.md §4, decision 17).
 * A block of wood is not a board enclosure; `Project` models a case around a PCB. The badge
 * part type keeps its own optional field for now, and later produces the SAME `PartPlan`
 * this document's `toPartPlan` defines — that is where the two eventually meet.
 *
 * The label fields keep the SAME NAMES as `TextLabel` (`text`, `font`, `weight`, `size`,
 * `position`, `rotation`, `depth`, `enabled`) so the label editor's controls can be shared.
 * But this is its own type: `TextLabel` carries `face`, `mode` and `attachedToPortId`, which
 * mean nothing on a block of wood. `position` is `{ x, y }` (stock coordinates), not
 * `{ u, v }` (case-face coordinates).
 *
 * TYPES ONLY, like the rest of `src/types/`. The default job lives in
 * `@/engine/cnc/engrave/defaults`, so importing a type from here never pulls in the font
 * registry or the id generator.
 */

/**
 * What the blank is made of (#200, widened by #347 and #456).
 *
 * The first four are the materials this app's own STARTING TABLE has rows for — the ones it can
 * cut without anyone else's numbers. The rest are the materials a MACHINE PROFILE declares and
 * that only Makera's own catalogue can answer for: the profile offers them (`Z1.materials`), and
 * `feedsFor` refuses a job in one until the user's own synced catalogue has a row for the cutter
 * and the material (#347, Route A). Offering them is not the same as knowing them.
 *
 * The two aluminium alloys are SEPARATE materials on purpose. `t_MaterialList` names `6061
 * Aluminum` and `7075 Aluminum` as distinct rows with distinct feeds, so folding them into one
 * `aluminium` would let whichever row the catalogue listed first answer for both — a wrong number
 * in metal, silently. Every metal and wood here maps to exactly one vendor row
 * ({@link CATALOGUE_MATERIALS}).
 *
 * The printed-blank classes (#456) are PrusaSlicer's own `filament_type` words, because a printed
 * blank's material is stated by the file that printed it. The catalogue lists NO row for any of
 * them, so each is answered through `CATALOGUE_MATERIAL_ALIASES`'s nearest-plastic mapping (ABS or
 * acrylic), labelled everywhere as a mapping rather than a vendor claim. `pa-cf` and `pa-gf` are
 * separate from `pa` because fibre-filled nylon is abrasive and carries its own wear class.
 * `PET-CF`, `PC-CF` and `PETG-CF` do NOT get classes of their own (#464): they are their base
 * plastic here, and {@link FilamentFibre} carries the abrasive part.
 */
export type StockMaterial =
  | 'softwood'
  | 'hardwood'
  | 'mdf'
  | 'pla'
  | 'petg'
  | 'pet'
  | 'abs'
  | 'asa'
  | 'hips'
  | 'pa'
  | 'pa-cf'
  | 'pa-gf'
  | 'pc'
  | 'pp'
  | 'tpu'
  | 'pva'
  | 'acrylic'
  // #492 — a purchased two-colour laminate whose maker did not state what plastic it is. It is a
  // PLASTIC, not a printed blank: no layers, no filament, and (via #493) no facing. The catalogue
  // answers it through the same nearest-plastic mapping as the printed classes.
  | 'plastic'
  | 'aluminium-6061'
  | 'aluminium-7075'
  | 'brass'
  | 'copper';

/**
 * The fibre a printed blank's filament class states (#464): `cf` carbon, `gf` glass.
 *
 * Kept BESIDE the material rather than folded into it. A `PETG-CF` blank is PETG — that is what
 * the feeds table and the catalogue mapping need to know — and the fibre is what the tool wear
 * weighting needs to know. One flag over four base plastics is a smaller vocabulary than a
 * material per pair, and it is the honest one: the app knows the base exactly and the fill by
 * its class word. The fibre nylons keep their own materials (`pa-cf`, `pa-gf`) because those
 * classes predate the flag; a caller may still pass their fibre, and it changes nothing.
 */
export type FilamentFibre = 'cf' | 'gf';

/**
 * Where an asserted value came from (#246, and the same provenance rule as the vise and the
 * sacrificial setup — decision 28: never a hard-coded truth, but the source says which).
 *
 * - `computed` — the feeds table produced it (`feedsFor`); no one typed it. Only meaningful for
 *   `cutOverride`.
 * - `catalogue` — Makera's own catalogue supplied it (#310): a starting number for a cutter the
 *   vendor sells, read out of their database and clamped to this machine. A vendor's number is
 *   not a measurement of anything here, so it gets a word of its own rather than being folded
 *   into `computed` — the panel says "Makera's catalogue", never "measured".
 * - `user` — typed in the panel or answered in the guided job setup (#254). A typed value is
 *   not more trustworthy for having gone through a flow.
 * - `measured` — taken at the bench with calipers or a test cut (#208). Visibly different from
 *   `user`, so a typed number never reads as a bench reading.
 *
 * The sim's own `FieldSource` (`store/simSetupStore.ts`) is a DIFFERENT type — `header | user |
 * default`, about a file's `;@MKR|TOOL` header — and is not this one (#310).
 */
export type FieldSource = 'computed' | 'catalogue' | 'user' | 'measured' | 'assumed';

/**
 * Per-field provenance for the job's asserted values (#246 cutting overrides, #254 guided job
 * setup). Absent on the whole object means "nothing has been asserted" — the shipped defaults,
 * which are untagged and unmeasured. A key absent WITHIN a map means that one field is still the
 * shipped default.
 */
export interface EngraveJobSources {
  /**
   * Which stock fields were asserted, and how (#254). Absent = the shipped default blank. `colour`
   * is stamped by whoever copies a badge's print facts in (#285); `flatness` is stamped `measured`
   * by the registration step that measured the clamped piece (#475, #496), never by an import.
   *
   * `print` was this key's name before #492; a document that still carries it is migrated on load
   * to `colour` (see `engraveJobSchema.ts`), so nothing in this build reads the old key.
   */
  stock?: Partial<
    Record<
      | 'length'
      | 'width'
      | 'thickness'
      | 'material'
      | 'fibre'
      | 'colour'
      | 'flatness'
      | 'shape'
      | 'diameter'
      | 'wall',
      FieldSource
    >
  >;
  /** Provenance of `toolKey` (#254). Absent = the shipped default cutter. */
  tool?: FieldSource;
  /** Per-field provenance for `cutOverride` (#246). Absent = computed from the feeds table. */
  cut?: Partial<Record<keyof CutParams, FieldSource>>;
  /**
   * Per-label provenance, keyed by label id (#362, #363). Absent = the label's own fields are the
   * ones it shipped with, or the ones the recommendation wrote.
   *
   * It exists for TWO decisions, and a label answers them separately:
   *
   *   - `depth` / `depthIntent` — who decided the number, and the colour its floor means.
   *     `takeBadgeBlank` re-depths every label to the blank it is about to cut, and it must NOT
   *     overwrite a number the user typed (`'user'`) or one taken at the bench (`'measured'`) — the
   *     recommendation is a starting point, not an authority over a stated depth.
   *   - `layout` — who decided everything else about the label: its text, face, size, position,
   *     rotation, whether it is enabled and whether it is a construction. Those are the fields a
   *     route lays out in ONE go and only a person otherwise decides, so one stamp covers them; a
   *     route writes `computed` and an edit writes `user`. The badge route replaces the labels when
   *     this stamp says they are still a route's, so it will not re-lay a line someone has moved or
   *     retyped (#363 review).
   *
   * A key absent WITHIN the map is a label nobody has claimed, which is exactly what the re-depth —
   * and the badge route's replacement — is allowed to move.
   */
  labels?: Record<
    string,
    {
      layout?: FieldSource;
      depth?: FieldSource;
      depthIntent?: FieldSource;
      /**
       * #700 — this label is a blank ROUTE's untouched placeholder, written by a seed (the badge's
       * "Name", a bare blank's "Text"). The wizard's operation text fills it in place instead of
       * adding a second line on top. Any person's edit clears the stamp (`updateLabel`), so only a
       * line nobody has touched is replaced.
       */
      seed?: boolean;
    }
  >;
}

export interface EngraveLabel {
  id: string;
  text: string;
  font: TextFont; // a registry id, as TextLabel.font
  weight: TextWeight;
  /** Cap height, mm — same meaning as TextLabel.size. */
  size: Mm;
  /** Centre of the text's bounding box, mm from the stock's front-left corner. */
  position: { x: Mm; y: Mm };
  /** Degrees counter-clockwise about the text's centre. */
  rotation: number;
  /** Depth of this label's floor below the top face, mm. Positive. */
  depth: Mm;
  /**
   * Which colour the floor is MEANT to land in (decision 20, `/Fabrication.md` §7.2): `reveal`
   * reaches the bottom colour, `surface` stays in the top one, `custom` is the advanced override
   * that says nothing about intent.
   *
   * Since #345 this field does exactly ONE thing: it picks the SIDE of the colour split's depth
   * bound (`surface` → the floor must stay above the split, `reveal` → below it, `custom`/absent →
   * no bound from the split at all). It produces no rule of its own.
   *
   * OPTIONAL, and absent until #170's two-state control writes it — which is the honest state for
   * every job authored before that: with no stated intent there is nothing to be wrong about, so
   * `item-depth-bound` (#345, formerly #285's `item-wrong-colour`) cannot fire. The FIELD is
   * declared here rather than in #170 because that check has to read it off the item it is
   * judging; #170 owns the control that produces it, on `TextLabel` as well.
   */
  depthIntent?: 'reveal' | 'surface' | 'custom';
  enabled: boolean;
  /**
   * Reference-only (#215): the item produces no cut of its own and exists only to be named by a
   * `frame` or a `cutaway`. A label cleared as an ISLAND is the raised-text case.
   */
  construction?: boolean;
}

/**
 * The fields every shape pocket shares (#214). `position` is the shape's CENTRE (for a
 * polygon, the origin its points are relative to), and `rotation` is about that point — the
 * same convention as `EngraveLabel`, so the two are one union (`EngraveItem`) downstream.
 */
export interface EngraveShapeBase {
  id: string;
  /** Optional human name, shown in operations and findings; a shape needs no text. */
  name?: string;
  /** Centre of the shape, mm from the stock's front-left corner (polygon: origin of `points`). */
  position: { x: Mm; y: Mm };
  /** Degrees counter-clockwise about `position`. */
  rotation: number;
  /** Depth of this pocket's floor below the top face, mm. Positive. */
  depth: Mm;
  enabled: boolean;
  /**
   * Reference-only (#215): the item produces no cut of its own and exists only to be named by a
   * `frame` or a `cutaway`. Its profile still resolves, so it can be a target or an island.
   */
  construction?: boolean;
  /**
   * Cut this pocket all the way through the blank into the under-board (#218). A through region
   * has no typed depth: its floor is the setup's `thickness + breakthrough`, and `depth` is
   * ignored by every consumer. Shapes only for the first pass (the answered question on #218):
   * a label, vector or combined through region would need its own depth semantics.
   */
  through?: boolean;
  /**
   * #665 — how a V-carved region's depth follows the design. Absent reads as `'plane'`, today's
   * constant-floor cut at the colour plane, so every saved job round-trips unchanged. `'variable'`
   * cuts the medial-axis depth map: a point at boundary distance `b` goes to
   * `min(depth, b / tanHalf)`, cut as a ladder of level sets from the shallowest to the deepest.
   * Where the V's width runs out at the cap, the middle stands as a core the carve cannot reach;
   * the setup's flat end mill pockets it flat at `depth` in its own program after the V-carve
   * (#677), and `vcarve-variable-core` warns by name only when no such cutter is set up or the one
   * named is wider than the core. Read only when the job's cutter is a cone.
   */
  vCarveDepth?: 'plane' | 'variable';
  /**
   * #673 — this region is a half of a V-CARVE INLAY: the design is cut as a pocket in one blank
   * (the FEMALE) and as the complement around the mirrored design in a second blank (the MALE),
   * and the two wedges are glued together. One marker per half; an inlay is two JOBS, one per
   * blank (see `engine/cnc/engrave/inlay.ts`).
   */
  inlay?: InlayMark;
  /**
   * #670 — a SURFACE TEXTURE: this region is not pocketed. A seeded pattern of short strokes is
   * derived at plan time and cut as traces at the shape's own `depth` (see
   * `engine/cnc/engrave/texture.ts`). The document stores the pattern's numbers, never the paths.
   */
  texture?: TextureMark;
  /**
   * #674 — a RAISED PRISM: the shape is not pocketed. A V-bit carves a ring AROUND it so it stands
   * at the shape's own `depth` with its sides sloping at the cone's angle (see
   * `engine/cnc/engrave/prism.ts`). This marker states the base's width; the cut's outer bound
   * derives.
   */
  prism?: PrismMark;
}

/**
 * #674 — a prism's own number, as the DOCUMENT holds it.
 *
 * `baseMm` is the FLAT BASE's width around the standing shape — the floor the V's tip clears,
 * between the shape's slope and the base's outer bevel. The standing height is the shape's own
 * `depth`; the cut's outer bound (the margin where the slope meets the untouched top face) is
 * derived as `base + 2·height·tan(halfAngle)`, never stored.
 */
export interface PrismMark {
  /** The flat base's width around the shape, mm. Absent = the CAM default (1 mm). */
  baseMm?: Mm;
}

/** #670 — the patterns the texture engine knows. */
export type TexturePattern = 'stipple' | 'scallop';

/**
 * #670 — a texture, as the DOCUMENT holds it: the pattern and its numbers.
 *
 * Every number is optional; an absent one reads as the CAM's labelled default
 * (`engine/cnc/engrave/texture.ts`), the #671/#672 precedent. The depth is the shape's OWN
 * `depth` field, not a second number here. The seed is part of the document because the same
 * document must post the same program byte for byte: the pattern is `mulberry32(seed)`, never
 * `Math.random`.
 */
export interface TextureMark {
  pattern: TexturePattern;
  /** Stroke and row spacing, mm. Absent = the CAM default (1 mm). */
  pitchMm?: Mm;
  /** A stipple stroke's length, mm. Absent = the CAM default (1 mm). Ignored by `scallop`. */
  strokeMm?: Mm;
  /** The stipple's jitter/direction seed. Absent = the CAM default (1). */
  seed?: number;
}

/**
 * #673 — one half of an inlay, as the DOCUMENT holds it.
 *
 * The FEMALE stores what the operator decides: the role and the glue gap (`glueGapMm`, default
 * 0.2 mm — the module's labelled default). Her pocket depth is the shape's own `depth`.
 *
 * The MALE stores the numbers it was BUILT for, as provenance, plus the one derived number its
 * geometry needs (`islandInsetMm` = `glueGapMm · tan(halfAngle)`, the erosion of the island it
 * carves around). A male is generated from a female by an action, not edited by hand; the run
 * sheet says to generate it again if the female changed.
 */
export interface InlayMark {
  role: 'female' | 'male';
  /** The glue gap, mm: the vertical clearance between the plug's end and the female's floor. */
  glueGapMm?: Mm;
  /** Male only: the female pocket depth the male was built for, mm. */
  pocketDepthMm?: Mm;
  /** Male only: the cone's half-angle tangent the male was built for. */
  tanHalf?: number;
  /**
   * Male only: the plug island's erosion at the male's TOP face, mm (`pocketDepthMm · tanHalf`).
   * The V's hole GROWS with depth, so the island's top face is the plug's TIP — the female
   * floor's extent — and its base at the male's floor is the visible ring.
   */
  islandInsetMm?: Mm;
}

/** A rectangle pocket. `cornerRadius` 0 = sharp — the cutter rounds it anyway. */
export interface EngraveRectShape extends EngraveShapeBase {
  kind: 'rect';
  width: Mm;
  height: Mm;
  /** Corner radius, mm. 0 = sharp; never more than min(width, height) / 2. */
  cornerRadius: Mm;
}

/** A round pocket. A "hole" larger than the cutter; plunge-drilling is #220, not this. */
export interface EngraveCircleShape extends EngraveShapeBase {
  kind: 'circle';
  diameter: Mm;
}

/** A stadium (slot) pocket: overall length, end radius = width / 2. */
export interface EngraveSlotShape extends EngraveShapeBase {
  kind: 'slot';
  /** Overall length, mm; never less than `width`. */
  length: Mm;
  width: Mm;
}

/** An arbitrary closed polygon, points relative to `position`, 3–500 of them. */
export interface EngravePolygonShape extends EngraveShapeBase {
  kind: 'polygon';
  points: [Mm, Mm][];
}

export type EngraveShape =
  | EngraveRectShape
  | EngraveCircleShape
  | EngraveSlotShape
  | EngravePolygonShape;

/**
 * The fields every DRILL item shares (#220).
 *
 * A drill is not a region: the cutter goes straight down at one XY and the hole is the cutter's
 * OWN diameter — there is nothing to offset or spiral, and no diameter to offer (a bigger hole
 * is a circle pocket, #214). So it lives in its OWN list (`EngraveJob.drills`), like `traces`,
 * and reaches `PartPlan.drills`, never `engraves`.
 *
 * `position` is the first hole's centre; a `drill-array` grows its lattice in +X/+Y from there.
 * `rotation` is IGNORED by a plain `drill` (a round hole has no orientation) and rotates the
 * pitch lattice about `position` for an array — the same convention as every other item.
 */
export interface EngraveDrillBase {
  id: string;
  /** Optional human name, shown in operations and findings. */
  name?: string;
  position: { x: Mm; y: Mm };
  rotation: number;
  /** Depth of the hole's flat floor below the top face, mm. Positive; ignored when `through`. */
  depth: Mm;
  enabled: boolean;
  /**
   * Cut all the way through the blank into the sacrificial board (#218). Its depth is the job's
   * breakthrough rule, not `depth`; the job's findings refuse it without a board
   * (`through-needs-board`) or when the bit's flutes do not reach the breakthrough
   * (`through-tool-reach`).
   */
  through: boolean;
  /**
   * #668 — how the hole is cut. Absent reads as `'drill'` (a plunge/peck hole the cutter's own
   * diameter wide), so every saved job round-trips unchanged. `'bore'` is a HOLE TO SIZE: an end
   * mill helixes down the wall at `diameter` and clears the floor — the hole may be wider than
   * the cutter.
   */
  mode?: 'drill' | 'bore';
  /**
   * #668 — the HOLE's diameter for a bore, mm. A drill's hole is the cutter's own diameter and
   * reads nothing here. A bore without one is refused by name (`bore-no-diameter`).
   */
  diameter?: Mm;
  /**
   * #675 — this hole's own PECK length, mm. Absent = the program's own source: a drill bit's
   * `drill.peckDiameters × ⌀` (the shop's chosen setting) or a milling cutter's feeds-row `peck`.
   * Typed here it replaces whichever binds, for THIS item and every hole in it. A bore is helixed,
   * not pecked, and reads nothing.
   */
  peckMm?: Mm;
}

/** One plunge-drilled hole at `position`: the cutter's own diameter, its floor at `depth`. */
export interface EngraveDrillItem extends EngraveDrillBase {
  kind: 'drill';
}

/** A rectangular grid of the same hole: `count.x × count.y` holes at `pitch` spacing. */
export interface EngraveDrillArrayItem extends EngraveDrillBase {
  kind: 'drill-array';
  /** Holes along X and Y. Whole numbers ≥ 1. */
  count: { x: number; y: number };
  /** Spacing between neighbouring holes, mm. Both > 0. */
  pitch: { x: Mm; y: Mm };
}

export type EngraveDrill = EngraveDrillItem | EngraveDrillArrayItem;

/**
 * One MILLED THREAD (#445, #434 phase 2), a sibling of `EngraveDrill` and never a region.
 *
 * A thread mill cuts a thread in a hole that already exists: the item assumes a pilot at the
 * thread's basic minor diameter, and the program never plunges into solid (D1). The ITEM states
 * the thread — its size carries the ISO 261 coarse pitch and minor through `FASTENERS` — because
 * the catalogue's own pitch/thread-angle extras are stripped before the wire (D2). One hole per
 * item: there is no array kind in phase 2.
 *
 * `position` is the hole's axis. There is no `rotation`: a round feature has no orientation, and
 * adding one now would be a field nothing reads. `standard` and `classFit` are single-valued on
 * purpose (D5): the repo has no UNC/UNF table and no 6G allowance table, so the CAM refuses those
 * by name rather than approximating them.
 */
export interface EngraveThreadItem {
  kind: 'thread';
  id: string;
  /** Optional human name, shown in operations and findings. */
  name?: string;
  /** The hole's axis, work XY — one hole. */
  position: { x: Mm; y: Mm };
  enabled: boolean;
  /** ISO metric coarse size; pitch and basic minor come from `FASTENERS`. */
  size: FastenerSize;
  /** One value: the repo's table is ISO 261. UNC/UNF are refused by the absent table. */
  standard: 'metric';
  /** One value: 6H is the basic internal thread (no allowance). 6G needs an allowance table. */
  classFit: '6H';
  /** Threaded length below the top face, mm. Positive; ignored when `through`. */
  depth: Mm;
  /** Through the blank. Gated like a drill: `thread-through-unavailable` until #213/#218. */
  through: boolean;
}

/** The one thread kind, named both ways the plan's prose uses: item and list entry. */
export type EngraveThread = EngraveThreadItem;

/**
 * The axis a 3D primitive opens along (#435). `'z'` — the default when the field is absent —
 * opens at the stock's TOP face and is the only axis the 2.5D region CAM can cut. `'x'` and `'y'`
 * describe a side-opening undercut honestly, but are refused by name (`primitive-not-vertical`)
 * rather than silently turned into a top pocket: a side opening needs the 3D engine (#222).
 */
export type EngravePrimitiveAxis = 'z' | 'x' | 'y';

/**
 * The fields every 3D primitive shares (#435). A primitive is a NEGATIVE VOLUME stated as a
 * solid: `position` is its footprint centre in the stock frame, `rotation` turns it about Z,
 * and `depth` says how far below the top face the volume reaches. Its geometry is a box, a
 * cylinder, a cone or a sphere, chosen by `kind`.
 *
 * It lives in its OWN list (`EngraveJob.primitives`), like `drills` and `threads`, so every
 * exhaustive switch over the existing item unions is untouched. The forms that reduce to a
 * flat-floor region (a vertical box or cylinder) funnel through `toPartPlan`'s `engraves`;
 * the rest are refused BY NAME by `validateJob` and never become a toolpath.
 */
export interface EngravePrimitiveBase {
  id: string;
  /** Optional human name, shown in operations and findings. */
  name?: string;
  position: { x: Mm; y: Mm };
  rotation: number;
  enabled: boolean;
  /**
   * The opening's axis. ABSENT means `'z'` — the top-face pocket every existing CAM understands.
   * A non-Z axis is stored so a document can state the undercut it means, and refused by name
   * until the 3D engine lands (#222).
   */
  axis?: EngravePrimitiveAxis;
  /** How far below the top face the volume reaches, mm. Positive. */
  depth: Mm;
}

/** A rectangular cut-away. `width` is X, `height` is Y, before `rotation`. */
export interface EngraveBoxPrimitive extends EngravePrimitiveBase {
  kind: 'box';
  width: Mm;
  height: Mm;
}

/** A round cut-away: one diameter, reaching straight down from the top face. */
export interface EngraveCylinderPrimitive extends EngravePrimitiveBase {
  kind: 'cylinder';
  diameter: Mm;
}

/**
 * A conical cut-away: the wide `diameter` at the top face, tapering to `tipDiameter` at
 * `depth`. `tipDiameter` may be 0 (a sharp point). Refused by name (`primitive-cone-needs-cam`)
 * because the region CAM only cuts walls parallel to the axis; it is never approximated as a
 * cylinder.
 */
export interface EngraveConePrimitive extends EngravePrimitiveBase {
  kind: 'cone';
  diameter: Mm;
  tipDiameter: Mm;
}

/**
 * A spherical cut-away (a dimple). `diameter` is the ball's diameter and `depth` the cap's depth;
 * `depth ≤ diameter` or the cap would be more than a hemisphere. Refused by name
 * (`primitive-sphere-needs-3d`) because its floor is curved: a dexel job (#222), never a circle
 * pocket.
 */
export interface EngraveSpherePrimitive extends EngravePrimitiveBase {
  kind: 'sphere';
  diameter: Mm;
}

export type EngravePrimitive =
  | EngraveBoxPrimitive
  | EngraveCylinderPrimitive
  | EngraveConePrimitive
  | EngraveSpherePrimitive;

/**
 * An STL/3MF embedded in the document (#435, #533) so a job renders without the external file.
 *
 * Its `role` decides what it IS to the job:
 *
 * - `'reference'` (the default, and today's only behaviour): the part the cut-aways are
 *   positioned against. It is NOT cut. Cutting the stock around it (`stock − target`, with tabs)
 *   is the profile cut-out work tracked in #218; a reference exists so the operator can see what
 *   the pockets are for, and `validateJob` says so once with the warning `target-object-not-cut`.
 * - `'goal'` (#533, slice C): the mesh is the shape to MAKE — the target surface the roughing and
 *   finishing passes drive toward (a heightfield over the stock top). A goal IS the work, so it is
 *   NOT warned about as uncut; `validateJob` validates it as a goal instead. Generating the 3D
 *   toolpath for a goal is slice D (#534) and is not done here, so a goal gets an info finding
 *   until that lands.
 *
 * `position` places the mesh's bbox centre in X/Y and its TOP at `position.z` in the work frame
 * (z = 0 is the stock's top face), so leaving every field at 0 seats the object top-flush and
 * centred on the stock. `rotation` turns it about Z through that centre. `size` is the parsed
 * bbox, kept so the panel can name the object without decoding the file.
 */
export interface EngraveTargetObject {
  id: string;
  /** The imported file's name, shown in the row and on findings. */
  name: string;
  /**
   * #672 — `'png'` is an IMAGE RELIEF: the picture's luminance IS the goal's heightfield (no mesh
   * is built), sampled and surfaced by the same goal pipeline.
   */
  format: 'stl' | '3mf' | 'png';
  /** SHA-256 of the raw bytes, lowercase hex — the object's identity and the mesh cache key. */
  sha256: string;
  /**
   * The raw file bytes, base64 — present in the OPEN job and in a .cutjob file that embeds them.
   * Absent in the localStorage copy (#720: the bytes live in the app's IndexedDB mesh store, keyed
   * by `sha256`, so a 12 MB model is not base64'd into a ~5 MB quota), and absent when that blob
   * is gone — then the job says so and asks for an import again.
   */
  data?: string;
  /** Parsed bounding size in mm. */
  size: { x: Mm; y: Mm; z: Mm };
  position: { x: Mm; y: Mm; z: Mm };
  /** Degrees counter-clockwise about Z, through the mesh's bbox centre. */
  rotation: number;
  /** False hides the object in the viewport; a reference is never cut either way. */
  enabled: boolean;
  /**
   * What the mesh IS to the job (#533). Absent means `'reference'` — the only role before this
   * slice — so old documents keep today's behaviour. `'goal'` marks the mesh as the shape to make.
   */
  role?: EngraveTargetRole;
  /**
   * The goal operation's own settings (#535). OPTIONAL, and every field in it optional: absent
   * means the engine's default for that number — the feeds row's step-down and step-over, the
   * shop's `finish.stockToLeaveMm` and `sim.columnFlatPitchYMm` — so a document written before
   * this block existed rounds-trips byte-for-byte and a goal left alone cuts the same program.
   */
  surface?: EngraveSurfaceSettings;
  /**
   * #672 — a PNG goal's relief map: the depth the darkest (or, inverted, the lightest) tone is cut
   * to and which end of the greys sits at the top face. Absent = the engine's labelled defaults.
   */
  relief?: EngraveReliefSettings;
}

/**
 * #672 — how a picture's tones become depths. The map itself is one function
 * (`engine/cnc/cam/relief.ts`); these are its two numbers, both optional so a document that
 * states neither takes the labelled defaults (`reliefNumbers`).
 */
export interface EngraveReliefSettings {
  /** The deepest cut, mm below the image's top face. Default: the CAM's 1.5 mm. */
  maxDepthMm?: Mm;
  /** True puts BLACK at the top face; absent/false puts white there (the natural reading). */
  invert?: boolean;
}

/** The role an embedded mesh plays (#533): a part to position against, or a shape to make. */
export type EngraveTargetRole = 'reference' | 'goal';

/**
 * A goal mesh's surfacing settings (#535): the numbers the roughing and finishing passes run
 * with. Each one overrides the default named in its comment; `undefined` is "use that default",
 * never a zero.
 */
export interface EngraveSurfaceSettings {
  /** Roughing step-down per Z layer, mm. Default: the feeds row's step-down. */
  roughStepDownMm?: Mm;
  /** Roughing raster pitch between scan lines, mm. Default: the feeds row's step-over. */
  roughStepOverMm?: Mm;
  /** Finishing raster pitch between scan lines, mm. Default: the feeds row's step-over. */
  finishStepOverMm?: Mm;
  /** Heightfield sampling pitch (both axes), mm. Default: the shop's `sim.columnFlatPitchYMm`. */
  gridPitchMm?: Mm;
  /** Roughing allowance left on the goal surface, mm. Default: the shop's `finish.stockToLeaveMm`. */
  stockToLeaveMm?: Mm;
  /**
   * #671 — add the SCALLOP pass after the parallel finish: offset contours of the goal's outline,
   * spaced so the step measured ALONG THE SURFACE is `finishStepOverMm`. Absent = off, which is
   * the rough + parallel finish every pre-#671 job already cut.
   */
  scallop?: boolean;
  /**
   * #671 — add the PENCIL pass after the scallop: one path along every concave crease sharper than
   * `pencilCreaseDeg`. Absent = off.
   */
  pencil?: boolean;
  /** #671 — the crease angle the pencil pass follows, degrees. Default: the CAM's own 20°. */
  pencilCreaseDeg?: number;
}

/**
 * Holding tabs for a cut-out (#218): bridges of material left UNCUT across the kerf so the part
 * cannot move before the operator frees it.
 *
 * `width` is the tab's width IN MATERIAL, mm. The CAM stops the cutter's centre one tool radius
 * short on each side, so the span on the centre path is `width + 2 × toolRadius` — the off-by-one-
 * diameter the tab test measures.
 *
 * `height` is measured UP from the bottom face, mm: the bottom `height` of the blank is never cut,
 * so the tab's top is at `-(thickness - height)` in work Z.
 */
export interface CutoutTabs {
  /** How many bridges. 0 cuts the part free. */
  count: number;
  width: Mm;
  height: Mm;
}

/**
 * A PROFILE CUT-OUT (#218): one closed path around (or inside) another item's outline, cut to
 * the under-board and held by tabs. A cut-out is NOT a cleared region — it removes a kerf one
 * cutter wide, so it has no `depth`, no profile to pocket and no entry in `PartPlan.engraves`.
 * It is its own list, like traces/drills/keep-outs, and its own CAM class (`cam/profile.ts`).
 *
 * `of` names the item whose outline the path follows. `'stock-inset'` is the blank's own
 * rectangle: the path is inset from the blank edge by `inset`, which is the PATH's distance from
 * the edge, so the material left at the edge is `inset − toolRadius` (the answered Q1 on #218).
 * For an item reference `inset` is likewise the PATH's distance from that outline.
 *
 * `side` says which side of the referenced outline the path lies on. The kerf is the cutter's
 * width, centred on the path, so `outside` with `inset: 0` leaves the item's outline as the
 * kerf's inner edge.
 */
export interface EngraveCutout {
  kind: 'cutout';
  id: string;
  /** Optional human name, shown in operations and findings. */
  name?: string;
  enabled: boolean;
  /** The item id whose outline the path follows, or `'stock-inset'` for the blank's own edge. */
  of: string;
  side: 'outside' | 'inside';
  /** PATH distance from the referenced outline (or the blank edge), mm. Non-negative. */
  inset: Mm;
  tabs: CutoutTabs;
}

/** The one cut-out kind, named both ways the plan's prose uses: item and list entry. */
export type EngraveCutoutItem = EngraveCutout;

/**
 * #669 — a CHAMFER along a rim: the cone's flank held against the top edge of a profile's part or
 * a pocket's wall, cutting one flat bevel of `width` on the top face and `width / tan(halfAngle)`
 * down the wall. A separate list, like `cutouts` and `threads`, because a chamfer is not a region
 * and has no depth of its own — its depth is DERIVED from the width and the cutter's cone.
 *
 * `of` names the ITEM whose outline is the rim, and `side` says which side of that outline the
 * cutter runs — the air side of the edge. `'outside'` breaks a PART's edge (the material is inside
 * the outline; the tool runs over the offcut, which is why the chamfer comes before the cut-out
 * that frees the part), `'inside'` breaks a POCKET's rim (the material is outside the region; the
 * tool runs over the pocket's air, which is why the chamfer comes after the pocket).
 *
 * Naming the item, rather than the cut-out that follows it, is what lets the two live in different
 * programs at all: a cut-out profiles with a FLAT end mill and a chamfer is cut by a CONE, so they
 * can never share one — and the reference survives the program split only because the rim's
 * outline is the item's own.
 */
export interface EngraveChamfer {
  kind: 'chamfer';
  id: string;
  /** Optional human name, shown in operations and findings. */
  name?: string;
  enabled: boolean;
  /**
   * The id of the item whose outline the bevel follows — a shape, an imported outline or a
   * combined shape whose profile is the rim. ABSENT while a fresh chamfer has no rim to name yet:
   * `chamfer-needs-edge` asks for one, and the document still parses, so a chamfer added before
   * its pocket is not an unloadable job.
   */
  of?: string;
  /** The side of the rim's outline the cutter runs: a part's edge (outside) or a pocket's rim (inside). */
  side: 'outside' | 'inside';
  /** The chamfer's width ON THE TOP FACE, mm. Positive; bounded by the cutter's cone. */
  width: Mm;
}

/** The one chamfer kind, named both ways the plan's prose uses: item and list entry. */
export type EngraveChamferItem = EngraveChamfer;

/** The winding a vector outline's contours are read with (#217) — Manifold's two fill rules. */
export type VectorFillRule = 'NonZero' | 'EvenOdd';

/**
 * An imported vector outline (#217): an SVG or DXF traced to flattened contours, in mm.
 *
 * The file is parsed ONCE at import and only the flattened result is kept — the source file is
 * not stored. `contours` are rings relative to `position` (origin at their bounding-box centre,
 * exactly like a polygon's `points`), already in mm; `width`/`height` are the size the panel
 * shows, and the contours are what cuts. The rings carry their own winding, so `fillRule` says
 * how to read a hole: `NonZero` for font/SVG outlines that wind outer and inner rings opposite,
 * `EvenOdd` for SVG's evenodd.
 *
 * It lives in its OWN list (`EngraveJob.vectors`), like `combined` (#215) and `traces` (#219),
 * so the panel's exhaustive `EngraveShape` switch and the hand-built shape editor are untouched.
 * It funnels through the SAME `itemProfile`/`toPartPlan`/`PartPlan` pipeline as every other
 * region item, and is an `EngraveAnyItem`, so a `frame`/`cutaway` may name it.
 */
export interface EngraveVectorShape extends EngraveShapeBase {
  kind: 'vector';
  /** The imported file's name, shown in operations and findings. The file itself is not kept. */
  sourceName: string;
  /** Flattened rings, mm, relative to `position` (origin at their bbox centre). */
  contours: [Mm, Mm][][];
  /** How the rings' winding is read: outer/inner opposite (NonZero) or even-odd. */
  fillRule: VectorFillRule;
  /** Bounding size in mm, for the panel. The contours are already in mm. */
  width: Mm;
  height: Mm;
  /**
   * The design FILE this item was imported from (#437), when it came from one: the project's
   * Title and the bytes' SHA-256. A re-import of the same source replaces this item instead of
   * adding a second copy, and an identical hash makes the import a no-op. Absent on items from
   * SVG/DXF, hand-built items, and imports made before this field existed.
   */
  importedFrom?: { name: string; sha256: string };
}

/**
 * The three COMBINED kinds (#215): shapes built from other shapes or from the stock outline,
 * by union, difference and offset — not by a general boolean-expression editor.
 *
 * They are their own union, not extra members of `EngraveShape`, because they are DERIVED: a
 * `border` follows the stock, a `frame` follows another item, a `cutaway` clears one item and
 * leaves others standing. Their inherited `position`/`rotation` are IGNORED — the derived
 * geometry is already in the stock frame, and there is nothing for a centre or an angle to
 * move. `depth` and `enabled` still apply.
 *
 * `around`, `outer` and `islands` are item ids resolved by `resolveItems` (`partPlan.ts`). A
 * reference that is missing, disabled or part of a cycle is a finding, never a crash — see
 * `resolveItems`. A referenced item may be marked `construction: true` to suppress its own cut.
 */
export interface EngraveBorderShape extends EngraveShapeBase {
  kind: 'border';
  /** Distance from the stock outline in to the ring's outer edge, mm. */
  inset: Mm;
  /** Ring wall thickness, mm. */
  width: Mm;
}

/** A ring following another item's outline (#215). */
export interface EngraveFrameShape extends EngraveShapeBase {
  kind: 'frame';
  /** Id of the item whose outline the ring follows. */
  around: string;
  /** Clearance between the target outline and the ring's inner edge, mm. */
  gap: Mm;
  /** Ring wall thickness, mm. */
  width: Mm;
}

/**
 * A pocket cleared to `depth` with `islands` left standing (#215). A label island is raised
 * text: the panel is cleared and the letters stay at full height.
 */
export interface EngraveCutawayShape extends EngraveShapeBase {
  kind: 'cutaway';
  /** Id of the item whose outline is cleared. */
  outer: string;
  /** Ids of items left standing inside the cleared area. */
  islands: string[];
}

export type EngraveCombinedShape =
  | EngraveBorderShape
  | EngraveFrameShape
  | EngraveCutawayShape;

/**
 * A single-stroke font id (`engine/fonts/stroke/strokeFont.ts`). A stroke font is a set of open
 * polylines, not outlines, so tracing it cuts the letter as one cutter-wide line (#219).
 */
export type StrokeFontId = string;

/**
 * The fields every TRACE item shares (#219). A trace is not a region: it is one or more open or
 * closed polylines the cutter follows, its centre on the line, so a stroke is exactly the
 * cutter's width. They live in their own list (`EngraveJob.traces`) and reach `PartPlan.traces`,
 * never `PartPlan.engraves`, because the region pipeline (#201's opening) would erase a line.
 *
 * `position` is the origin `points` are relative to (a line) or the text's bounding-box centre (a
 * stroke label); `rotation` is about that point. `construction` is carried for symmetry with the
 * region items even though nothing references a trace today.
 */
export interface EngraveTraceBase {
  id: string;
  /** Optional human name, shown in operations and findings. */
  name?: string;
  position: { x: Mm; y: Mm };
  rotation: number;
  /** Depth of the traced line below the top face, mm. Positive. */
  depth: Mm;
  enabled: boolean;
  /** Reference-only (#215): reserved for symmetry; a trace produces its cut unless true. */
  construction?: boolean;
}

/**
 * #664 — the most vertices ONE `line` item may carry. The document schema enforces it, the row's
 * editor guards it, and the vector import splits a longer path into consecutive items that share
 * their seam vertex — one number, so a job the app writes is always a job the app can read back.
 */
export const MAX_LINE_POINTS = 5000;

/** A free polyline the cutter traces, its centre following the points (#219). */
export interface EngraveLineItem extends EngraveTraceBase {
  kind: 'line';
  /** Path points relative to `position`, mm. */
  points: [Mm, Mm][];
  /** Close the ring (feed back to the first point with no retract) — for borders and outlines. */
  closed: boolean;
  /**
   * #674 — a FLUTE: the same line, cut as a groove whose depth RAMPS in and out along its ends
   * instead of plunging to depth and retracting from it (see `engine/cnc/engrave/flute.ts`). The
   * trace's own `depth` is the groove's deepest point; this marker states the ramp.
   */
  flute?: FluteMark;
}

/**
 * #674 — a flute's own number, as the DOCUMENT holds it. The depth is the line's own `depth`; the
 * ramp is a length along the path, and an absent one reads as the CAM's labelled default (three
 * times the depth — see `engine/cnc/engrave/flute.ts`).
 */
export interface FluteMark {
  /** The ramp's length along the path, mm. Absent = three times the trace's depth. */
  rampMm?: Mm;
}

/** Text rendered in a single-stroke font and traced (#219). `font` must be a `StrokeFontId`. */
export interface EngraveStrokeLabelItem extends EngraveTraceBase {
  kind: 'stroke-label';
  text: string;
  font: StrokeFontId;
  /** Cap height, mm — the same meaning as `EngraveLabel.size`. */
  size: Mm;
  /**
   * Horizontal CONDENSE (#409), default 1 (absent). x is scaled by this and y is not, so a line
   * bound by its LENGTH (a long name across a rectangle) gains height without getting longer — the
   * cap height still equals `size`. Under 1 is narrower; over 1 is wider.
   */
  widthScale?: number;
  /**
   * Target CUT width for a BOLD stroke, mm (#409) — the width the union of the stroke's parallel
   * passes must reach. Absent = no bold (one cutter width). A number, NOT the `'regular'|'bold'`
   * enum `EngraveLabel` carries: that one picks a TTF face, this one states a V groove's measured
   * width. Only a V cone has the depth-dependent width bold offsets are built from, so a job whose
   * tool is absent or is not a cone ignores it (the layout is then the font's own).
   */
  weight?: Mm;
  /**
   * Widen the gaps between neighbouring glyphs to at least one groove's width of CLEAR, uncut
   * surface (#409). OPT-IN and ABSENT by default, so a job that states nothing here lays out
   * exactly as the font's own metrics do and regenerates byte-for-byte — turning this on by
   * default would silently re-cut every stored V-bit job.
   *
   * `'cut-width'` is the one value: the layout inserts tracking so that `inkGap ≥ 2 × cutWidth`
   * between two adjacent glyphs (a groove reaches half its width to either side of the centre
   * line it is cut on, so each neighbour eats half the gap). It needs a V cone — the cone's
   * depth-dependent opening is what makes "a groove's width" a number — so a tool-less or flat
   * job ignores it, exactly as it ignores `weight`.
   */
  spacing?: 'cut-width';
}

export type EngraveTraceItem = EngraveLineItem | EngraveStrokeLabelItem;

/**
 * Every item that can appear in a plan's `engraves` (#215, #217): a label, one of the four simple
 * shapes, one of the three combined kinds, or an imported vector outline. `EngraveItem` stays
 * label-or-simple-shape for the UI's exhaustive switches; the engine's wider type is this one.
 */
export type EngraveAnyItem = EngraveItem | EngraveCombinedShape | EngraveVectorShape;

/**
 * What `itemProfile` accepts: a text label or a shape (#214). The document keeps them in two
 * fields — `labels` (untouched, so version-1 jobs and the existing pipeline keep working) and
 * `shapes` — but both funnel through the SAME `PartPlan`, so there is one pipeline, not two.
 */
export type EngraveItem = EngraveLabel | EngraveShape;

/**
 * An under-surface VOID the job must respect (#231 item 3): a pocket or cavity in the blank's
 * BOTTOM face — the magnet pocket of #165's badge is the case it was built for. #178's
 * `maxDepthAt` computes the safe cut depth from the compiled solid; this is where a JOB says
 * what void is there, so `toPartPlan` can carry it (`PartPlan.stock.keepOuts`) and
 * `engraveGenerate` can refuse a cut deeper than the material left over it allows.
 *
 * The four kinds mirror `EngraveShape`'s geometry (flat, the same `kind` discriminants) but are
 * their OWN union in their OWN list (`EngraveJob.keepOuts`), like `combined`/`traces`/`vectors`:
 * the panel's exhaustive engrave switches and the item pipelines are untouched. `position` is
 * the footprint's centre; `rotation` is about it — the same convention as every other item.
 */
export interface EngraveKeepOutBase {
  id: string;
  /** Optional human name, shown on the run sheet; a void needs no name. */
  name?: string;
  /** Footprint centre, mm from the stock's front-left corner (polygon: origin of `points`). */
  position: { x: Mm; y: Mm };
  /** Degrees counter-clockwise about `position`. */
  rotation: number;
  enabled: boolean;
  /**
   * The void's ceiling measured from a DIFFERENT datum than every `depth` in this document:
   * PART-frame z from the blank's BOTTOM face (z = 0 at the bottom, `stock.thickness` at the
   * engraved face). The void spans from the bottom face up to this height, so the solid
   * MEMBRANE the cutter must not break through is `stock.thickness − zCeiling` thick. A pocket
   * "2.3 mm deep in the bottom" has `zCeiling: 2.3`.
   *
   * This is the SAME number and the SAME frame `PartPlan.stock.keepOuts[].zCeiling` and
   * `LayerStackKeepOut.zCeiling` carry (#178), copied straight through so the badge's layer
   * stack and this job's depth limit cannot disagree about where the void's ceiling is.
   */
  zCeiling: Mm;
}

export interface EngraveKeepOutRect extends EngraveKeepOutBase {
  kind: 'rect';
  width: Mm;
  height: Mm;
  cornerRadius: Mm;
}

export interface EngraveKeepOutCircle extends EngraveKeepOutBase {
  kind: 'circle';
  diameter: Mm;
}

export interface EngraveKeepOutSlot extends EngraveKeepOutBase {
  kind: 'slot';
  length: Mm;
  width: Mm;
}

export interface EngraveKeepOutPolygon extends EngraveKeepOutBase {
  kind: 'polygon';
  points: [Mm, Mm][];
}

export type EngraveKeepOut =
  | EngraveKeepOutRect
  | EngraveKeepOutCircle
  | EngraveKeepOutSlot
  | EngraveKeepOutPolygon;

export interface ViseParams {
  /** How far the stock's top face stands above the jaw tops, mm. */
  stockProud: Mm;
  /**
   * What the blank's underside rests on (#508). `ledge` is the soft jaws' shelf, `LEDGE_STEP`
   * below the jaw tops — the shipped default; `floor` is the body's own top for taller parts
   * ("clamp directly against the bottom of the jaws"), `VISE_FLOOR_DEPTH` below the jaw tops.
   *
   * The seat is a MECHANISM, not a measurement: it says where the stock's underside is, and for a
   * shipped-default vise it is what `stockProud` is derived from (`defaultStockProud`). A saved
   * or measured vise keeps its own `stockProud`; the seat then only names where the app believes
   * the stock rests.
   */
  seat: 'ledge' | 'floor';
  /** Thickness of each jaw in X, mm. */
  fixedJawThickness: Mm;
  movingJawThickness: Mm;
  /** Jaw length in Y, and where it starts relative to the stock's front edge (negative = jaw extends in front of the stock). */
  jawLength: Mm;
  jawStartY: Mm;
  /** Where these numbers came from. A default is NOT a measurement (decision 28). */
  source: 'default' | 'saved' | 'measured';
  /** How far the real jaws may differ from these numbers, mm. Obstacles are inflated by it. */
  uncertainty: Mm;
  /**
   * ISO date (`YYYY-MM-DD`) the numbers were measured on. Absent for a shipped default; set when
   * the user records a measurement ("Save as my vise" / "I just measured these", #203).
   */
  measuredAt?: string;
}

/**
 * What a job says about the rotary module's three-jaw chuck (#240, `/Rotary.md` §3.4).
 *
 * The facts are Makera's, not readings of this machine: the module's wiki page states a three-jaw
 * chuck with REVERSE jaws fitted by default for larger work (standard jaws for small parts), a
 * tailstock with an adjustment knob, and — for the jaw capacity — nothing at all. "Not stated" is
 * `null` rather than a guessed millimetre; `source` names the page. The machine's own rotary
 * numbers (envelope, steps/°, rate, acceleration, homing, unwind) stay in
 * `MachineProfile.rotary` with their per-field provenance, never here.
 *
 * ABSENT IS THE VISE. A job written before this block existed carries no `rotary-chuck` and keeps
 * its exact shape; the field only exists on the alternative arm of {@link JobWorkholding}.
 */
export interface RotaryChuck {
  /**
   * How far the rod stands out of the chuck jaws along X, mm — the cuttable length
   * (`rotaryMapOf`: grip = the rest of the rod). The Holding step asks the GRIP and derives this
   * (#714): stick-out = the rod's length − grip.
   */
  stickout: Mm;
  /** The diameter the jaws close on, mm, or `null` when the chuck does not state its capacity. */
  gripDiameter: Mm | null;
  /**
   * Which jaws are fitted, by Makera's rule by diameter (#714, `docs/design/rotary-flow.md`
   * §3.4): `standard` under ⌀20 mm, `reverse-inner` from ⌀20 to ⌀35, `reverse-outer` over ⌀35.
   * A document written before the rule stores `'reverse'`, which reads as `reverse-inner`.
   */
  jawMode: RotaryJawMode;
  /** Whether the tailstock supports the free end. The wiki recommends a centre hole when it does. */
  tailstock: boolean;
  /** The page these facts come from, so a shipped default is never read as a measurement. */
  source: string;
}

/** The chuck's jaws, by Makera's rule by the rod's diameter (#714). */
export type RotaryJawMode = 'standard' | 'reverse-inner' | 'reverse-outer';

/**
 * A job held on the bed under tape (#707 BM-1, `docs/design/bed-mounts-flow.md` §3.4).
 *
 * The values are a SNAPSHOT of the setup the job was authored against — the roll's width, the
 * tape's thickness under the stock, where the stock was expected — so a later edit to the bed
 * profile does not silently rewrite a job already cut. `source` says which of the three they are
 * (decision 28: a default is never a measurement).
 *
 * The BOARD UNDER the stock (a 2 mm MDF board taped to the bed, the stock taped to it) is
 * `sacrificial.under` — the existing record, with its own thickness and `attach: 'tape'`
 * (`bed-mounts-flow.md` §3.2's write table). It is deliberately NOT a second field here: two records of
 * one board could disagree, and every engine reader (`through-needs-board`, the sweep's second
 * body, the stack the registration expects) already reads that one.
 */
export interface TapeHold {
  /** The roll's width, mm — the house roll (Makera's 20 mm tape, §5). */
  width: Mm;
  /** The tape's thickness under the stock, mm — typed on the bed profile; ~0.2 mm is Makera's
   * (its store page for the 20 mm tape), not measured on the roll in hand. */
  thickness: Mm;
  /** How far in from every edge the strips stop, mm (2 mm, §3.4: the edge scans land just past them). */
  inset: Mm;
  /**
   * Where on the surface the stock is expected — its front-left corner in MACHINE X/Y, mm — or
   * `null` for the middle of the surface. The probe finds the real position; this is the
   * expectation the picture draws and the registration starts from.
   */
  where: { x: Mm; y: Mm } | null;
  /** What the tape keeps square: the bed's front edge. The program is never rotated (§3.4). */
  squareTo: 'front';
  /** Where these numbers came from — the same provenance rule as the vise (decision 28). */
  source: 'default' | 'saved' | 'measured';
}

/**
 * A job pushed into the bracket's corner and clamped (#707 BM-1, §3.6).
 *
 * The CLAMP PLACES are the job's own: the CAM, the verifier and the simulation check these, never
 * the shop's default pair (the defect #707 found in `bracketMount`). Sizes — length, width, reach,
 * height — stay the shop's `clamps.top*` defaults with their provenance, and the bracket's own
 * sizes come from `bracketSettings` the same way; §9 moves the PLACES into the job, not the sizes.
 */
export interface BracketHold {
  /** The anchor the bracket is pinned at — Makera's origin is "relative to Anchor 1" (§5). */
  anchor: 1 | 2;
  /** The bracket fitted, as its fixture record names it — `thin`, the Makera kit's L-bracket. */
  variant: string;
  /**
   * The clamp places, on the free edges: `back` and `right` (the bracket holds the front and the
   * left). One to four, in the order the operator sees them.
   */
  clamps: ClampPlacement[];
  /** Where these came from — the same provenance rule as the vise (decision 28). */
  source: 'default' | 'saved' | 'measured';
}

/**
 * The bed profile a job was set up on (#513, folded into the bed-mounts umbrella #707). The
 * version is the `at` of the profile's last history line (bed-mounts-flow §10 Q12): the profile
 * carries no version field, and every change to it adds a line.
 */
export interface JobBedBinding {
  /** The active bed profile's id. */
  profileId: string;
  /** The profile's version: the `at` of its last history line. */
  profileVersion: string;
}

/**
 * How the job's stock is held. A discriminated union on `kind` (#240 §1, #707 BM-1): the vise
 * keeps exactly the shape every pre-rotary document has; the rotary chuck and the two bed mounts
 * (taped, and the bracket with its clamps) are the arms added since. The kind words `tape` and
 * `bracket` are the ones the setups engine, the registration planner and `bracketMount` already
 * use (`Mount = 'vise' | 'bracket' | 'tape'`), so the job and its first setup name the mount one
 * way.
 *
 * Readers that need the VISE's numbers for a non-vise job go through `jobVise`
 * (`engine/cnc/fixture.ts`), which answers the neutral shipped vise rather than inventing a
 * measurement — and the vise-only checks (jaw reach, jaw collision, the vise envelope) are the
 * vise arm's, skipped for the others.
 */
export type JobWorkholding =
  | { kind: 'vise'; vise: ViseParams }
  | { kind: 'rotary-chuck'; rotary: RotaryChuck }
  | { kind: 'tape'; tape: TapeHold }
  | { kind: 'bracket'; bracket: BracketHold };

/**
 * A sacrificial board UNDER the part (#213): material the job may cut into, with the work
 * origin and the Z datum still on the PART's top face. Its top face meets the part's underside
 * at Z = `−thickness`, so its own thickness can never reach a cut depth (decision 24's
 * argument, applied to the board).
 */
export interface SacrificialUnder {
  thickness: Mm;
  /** How far the board extends past the part on each side, mm. 0 = flush. */
  overhang: { left: Mm; right: Mm; front: Mm; back: Mm };
  /** How the part is fixed to the board. Recorded for the run sheet; 'loose' is a warning. */
  attach: 'tape' | 'glue' | 'screws' | 'loose';
}

/**
 * A sacrificial strip BESIDE the part (#213). Its bottom is level with the part's bottom
 * (Z = `−thickness`); `flush` means the same height as the part, so its top is level with the
 * part's top face at Z = 0.
 */
export interface SacrificialSide {
  /** Thickness of the strip, measured away from the part, mm. */
  thickness: Mm;
  /** Height of the strip. Its bottom is level with the part's bottom; 'flush' = same height as the part. */
  height: 'flush' | Mm;
}

/**
 * What the user says is in the setup besides the part (#213, decision 28 in practice). All
 * four side strips are individually optional; left and right are the sides the VISE JAWS bear
 * on (the fixed jaw is on the left), so a left or right strip sits between the jaw and the
 * part and is clamped with it. Front and back strips are not clamped by the jaws and only make
 * sense on an under-board.
 *
 * Default: none (`under: null`, all sides `null`). A job that does not use it behaves exactly
 * as before.
 */
export interface Sacrificial {
  under: SacrificialUnder | null;
  sides: {
    left: SacrificialSide | null;
    right: SacrificialSide | null;
    front: SacrificialSide | null;
    back: SacrificialSide | null;
  };
  /** Where these numbers came from — the same provenance rule as the vise (decision 28). */
  source: 'default' | 'saved' | 'measured';
}

/**
 * The colour planes the depth model needs, and where they come from (#492, growing out of #285).
 *
 * A two-colour blank's go/no-go is its colour boundary. There are two ways a blank gets one:
 *
 *   - `printed` — a slicer laid down two filaments, so the boundary is a fact about the PRINT and
 *     lands on the slicer's layer grid. `layerHeight` is the grid (`buildLayerStack`, decision 27);
 *     unless it is stated the boundary is the stated cap, exactly as a laminate's is.
 *   - `laminate` — a PURCHASED sheet of one colour over another (#492). There are no layers and no
 *     filament to ask about: the cap's own thickness IS the boundary. `layerHeight` is meaningless
 *     and is refused by the schema.
 *
 * `capMm` is the TOP colour's thickness measured from the engraved face — the number every depth
 * sentence actually wants, and the film `f` #221's V-carve reads. On a printed blank it is
 * `thickness − split`, where `split` is the colour change height above the BOTTOM face that
 * `BadgeParams.splitHeight` carries; the schema migrates a pre-#492 `print: { split, … }` to that
 * form on load.
 *
 * OPTIONAL, and its ABSENCE IS THE SWITCH (#285). A job without it has no colour plane as far as
 * the app is concerned: its depth limit stays the analytic `jobDepthLimit` and its `.nc` is
 * byte-identical to before.
 *
 * A `Mm` is the MODEL's number — a slicer setting or a supplier's stated cap — never a
 * measurement of the blank in the vise.
 */
export interface StockColour {
  /** Where the second colour comes from: a print's layers, or a purchased laminate's cap. */
  kind: 'printed' | 'laminate';
  /** The top colour's thickness from the engraved face, mm. `0` only in a migrated degenerate print. */
  capMm: Mm;
  /** The slicer's layer height, mm. `printed` only; absent = no grid to snap to. */
  layerHeight?: Mm;
  /** The first layer's own height, mm; absent = the same as `layerHeight`. `printed` only. */
  firstLayerHeight?: Mm;
}

/**
 * Where a margin value came from (#345) — decision 28's provenance rule, applied to a THRESHOLD
 * rather than a measurement. A shipped default is not a recommendation, and a recommendation is
 * not a number the user chose, so all three read differently on screen.
 *
 * - `default` — shipped, or the house setting a new job was seeded with.
 * - `recommended` — this job's own arithmetic from what it knows about THIS blank and THIS setup
 *   (`recommendMargins`), taken in one click.
 * - `user` — typed in the panel.
 */
export type MarginSource = 'default' | 'recommended' | 'user';

/**
 * The Z-error margins a job runs with (#345), mm.
 *
 * These are the distances a floor must keep from a PLANE — the colour split, a void's ceiling,
 * the stock's underside. `zTolerance` is the budget itself: how far the job expects the blank
 * and the registration to put it out in Z. `boundaryMargin` is what a floor must stay clear by,
 * and it is recommended as `max(setting, zTolerance)` — the house setting is the floor, the
 * tolerance is the honest answer when it is larger.
 *
 * OPTIONAL on the job, and its ABSENCE IS THE SWITCH: a job with no `margins` runs on the house
 * setting at generate time, so every saved job keeps the behaviour it had and no stored document
 * needs migrating. See `engine/cnc/engrave/depthBounds.ts` for the resolution.
 */
export interface EngraveMargins {
  /** How far a floor must stay from any bound plane, mm. */
  boundaryMargin: Mm;
  /** The ± this job expects in Z after registration, mm — the budget `boundaryMargin` covers. */
  zTolerance: Mm;
  source: MarginSource;
}

/**
 * How flat the blank's top is, as MEASURED on the piece in the jaws (#496, #475).
 *
 * A bow belongs to the job, not to a shelf record or to the badge it was printed as: the same
 * nominal blank clamps differently every time, so the only honest figure is the one the extents
 * touches took on this piece. The pair is per stock AXIS — `xMm` is the centre-to-edge drop along
 * the stock's `length` (X), `yMm` across its `width` (Y) — because that is what the touches
 * measure, and the direction words (`'width'`/`'length'`) were read in opposite senses by different
 * modules (#496; the 2026-10-17 bench note corrects a direction claim for exactly this reason).
 *
 * It is the term a job running with NO autolevel grid carries in its Z budget — #176's grid is what
 * removes it. A job that has not measured its surface has NO flatness record: "not yet measured" is
 * its own answer, never an invented 0 and never a figure copied from a badge (#496 decision).
 */
export interface StockFlatness {
  /** Centre-to-edge drop along the stock's `length` (X), mm. */
  xMm: Mm;
  /** Centre-to-edge drop across the stock's `width` (Y), mm. */
  yMm: Mm;
  /** Only a measurement writes this record (#496). */
  source: 'measured';
  /** How many surface touches produced the pair. */
  touchCount: number;
  /** When the surface was measured, ISO 8601. */
  measuredAt: string;
}

/**
 * The registration half of a saved setup (#419 J2, §5.4; planned by #430).
 *
 * `plan` is the APPROVED choreography, frozen at the moment it was planned — a snapshot, not a
 * re-derivation. `planRegistration` is pure and deterministic given the same stock, mount and
 * settings, but a location's `registration.*` values are shop defaults that can move (#430), and
 * a mount can be re-probed: re-planning later would silently replace the steps the operator
 * approved with different ones. What a job stores is therefore what was approved.
 */
export interface JobSetupRegistration {
  /** The method this registration uses: the mount it is performed on. */
  method: Mount;
  /** The approved plan, as it was planned. Never re-derived from the engine's current settings. */
  plan: RegistrationPlan;
  /** The accuracy it is expected to hold, in words — e.g. "XY from the bracket ±0.1, Z touch". */
  expected: string;
}

/**
 * The directed step that takes the stock from the previous setup into this one (#419 J2, §5.4).
 *
 * The REMOUNT PAGE is #428's; this is only the record that page will read. `confirm` reuses
 * `RemountStep.confirm`'s shape — a landmark question the app can check, with the index of the
 * right answer — because the direction and the question are the same idea whether the planner or
 * the job holds them.
 */
export interface JobSetupRemount {
  /** The operator's steps, in order, in landmark words ("the SAME corner still in the bracket"). */
  instruction: string[];
  /** The landmark question, or null where no earlier feature tells a mirrored mount apart. */
  confirm: RemountStep['confirm'];
}

/**
 * One SETUP as the job saves it (#419 J2, §5.4): one held position — a mount and an orientation,
 * the items cut in it, the tools it uses, and what was approved for finding the stock again.
 *
 * DELIBERATELY NOT the setups engine's `Setup` (`engine/cnc/setups/types.ts`). That type is
 * derived PLANNER GEOMETRY — a rotation matrix, the stock state entering and leaving with every
 * `Removal[]`, findings, an index — all recomputed from the job and the planner, and all stale the
 * moment a setting or an item moves. This record stores INTENT AND PROVENANCE only, which is
 * exactly what §5.4's saved list names: `{ orientation, mount, itemIds, tools, registration,
 * remount }`.
 *
 * It REUSES the engine's vocabulary rather than restating it (`Orientation`, `MountSpec`,
 * `RegistrationPlan`, and `RemountStep.confirm`'s shape), so there is one meaning of a mount, of a
 * face orientation and of a registration plan across the planner and the document.
 */
export interface JobSetup {
  /**
   * Stable within the job. Creation sites mint it with `newId('setup')`, like every other item id
   * (`newEngraveLabelId`, `newEngraveShapeId`, …); the schema also mints a default the same way
   * `EngraveJob.id` does, so a setup written without one gains it on parse rather than failing to
   * load.
   */
  id: string;
  /**
   * Which STOCK face sits at each MACHINE face — `setups/types.ts`'s `Orientation`. A top-up mount
   * is the identity record.
   */
  orientation: Orientation;
  /** How the location holds the stock for this setup (vise, bracket, tape). */
  mount: MountSpec;
  /** The job item ids assigned to this setup, in the order they are cut. */
  itemIds: string[];
  /** The tool keys this setup uses, in use order — one program per key (#419 J3). */
  tools: string[];
  /**
   * Which of the setup's items each cutter owns (#472). The key is a tool key from {@link tools};
   * the value is the ids from {@link itemIds} that cutter takes. Absent on a one-tool setup (every
   * item is that cutter's). A multi-tool setup may omit it, which is the same reading: the first
   * cutter owns every item, and the later cutters are rest passes measured from the first one.
   *
   * A later cutter's whole items are left out of program 1 and cut in the rest program, so the
   * saved map says who is RESPONSIBLE for an item, not that each cutter gets a plain slice of the
   * design.
   */
  toolItems?: Record<string, string[]>;
  /** Present only once a registration has been planned and approved for this setup. */
  registration?: JobSetupRegistration;
  /** The directed step into this setup. Absent on the first setup, or where none is needed. */
  remount?: JobSetupRemount;
}

/**
 * One frozen program (#419 §4, #425): the text, its FNV key, and its frame file's text and key.
 *
 * This lived in `engine/cnc/engrave/package.ts` until v3 put the package block in the job
 * document: `EngraveJob.package` is typed with it, and the document's own types must not import
 * the engine that hashes it. `package.ts` re-exports both names, so every existing import site is
 * unchanged.
 */
export interface FrozenProgram {
  setupIndex: number;
  setupId: string;
  toolKey: string;
  nc: string;
  /** FNV of `nc` — exactly `EngraveProgram.programHash`. */
  hash: string;
  frameNc: string | null;
  /** FNV of `frameNc`, or null with it. */
  frameHash: string | null;
  /**
   * The frame the POST wrote this program in (#240 §4, `/Rotary.md` §3.3). `'flat'` is the 3-axis
   * dialect; `'rotary'` is the 4th axis's, where Z is the radius from the axis and A is the stock's
   * rotation. OPTIONAL and absent on every package frozen before the field existed: absence reads
   * `flat`, so an old package stays runnable and round-trips without gaining a key.
   */
  frame?: 'flat' | 'rotary';
}

/**
 * What Cut froze around a job (#419 §4, #425) — now a block in the document rather than a
 * localStorage copy (R8). The hashes are FNV (decision 3); `jobHash` is the fingerprint the
 * staleness comparison reads, and `hash` is the package's own key.
 */
export interface FrozenPackage {
  /** The job whose programmes this freezes — a reservation is keyed to the same id. */
  jobId: string;
  /** ISO 8601, for the sentence the Cut screen shows ("the package of 14:02"). */
  frozenAt: string;
  /** FNV over the job's fingerprint and the programs' keys. Decision 3's package hash. */
  hash: string;
  /** FNV over the job's program-relevant data at freeze time; staleness compares against the job now. */
  jobHash: string;
  programs: FrozenProgram[];
  /** The setups as frozen: the stored record, or the derived single setup. */
  setups: JobSetup[];
  /** The shelf entry this freeze reserved, or null when the job's stock is not on the shelf. */
  stockEntryId: string | null;
  /**
   * #608 — the fitted surface plane these programs were POSTED against, or null when they were
   * posted flat. Absent on a package frozen before the field existed (read as flat). This is what
   * lets the Cut step refuse to upload a flat package once a registration has measured a tilt the
   * programs do not follow.
   */
  surface?: { plane: { offset: number; slopeX: number; slopeY: number }; z0: number } | null;
}

/**
 * One file the job was made from (#425 §6): content-addressed by the SHA-256 of its raw bytes.
 *
 * The derived geometry is what the job cuts (`vectors[].contours`, the label layout, the stock's
 * print facts), so a reload renders and generates without the file. These bytes are provenance
 * and the source a re-import can prove itself against — embedded when the file is at most 4 MiB,
 * otherwise named with its hash so a missing or changed file can be refused precisely.
 */
export interface JobSource {
  /** Lowercase SHA-256 of the raw bytes; the record's identity, so identical files dedupe. */
  sha256: string;
  kind: 'svg' | 'dxf' | 'image' | '3mf' | 'font';
  /** The file's own name (a 3MF's Title for a design), for a person. */
  name: string;
  /** The raw bytes, base64, when embedded. `null` for a file over the 4 MiB cap. */
  embedded: { encoding: 'base64'; data: string } | null;
  /** The file's size in bytes, when it is known. */
  size: number | null;
  /** A path when one is known (CLI/desktop); null in the browser, which never exposes one. */
  path: string | null;
}

/**
 * One program's outcome on this job (#425 §6), the document's run log. Keyed by the program's
 * FNV `programHash` — the package's key and the machine record's key — so a re-freeze can tell
 * which entries still describe the programs it froze. A `stopped` or `failed` program is not
 * done: only `finished` lets a reopen resume at the next setup.
 */
export interface JobRunLogEntry {
  /** FNV of the program text — the package's key and the machine record's key. */
  programHash: string;
  setupIndex: number;
  setupId: string;
  toolKey: string;
  /** ISO 8601, when the outcome was known. */
  at: string;
  outcome: 'finished' | 'stopped' | 'failed';
  /** The run record's `ncHash` (SHA-256, first 8), when the record was written. */
  ncHash?: string;
  /** #604 — the machine-run transcript (the run lines, joined), persisted so a reload keeps it. */
  transcript?: string;
}

export interface EngraveJob {
  schemaVersion: 3;
  /**
   * The job's own identity (#419): a stock reservation and `RunContext.jobId` are keyed to this,
   * and a job is renamed freely, so neither `name` nor `machineId` can serve as the key.
   *
   * REQUIRED, not optional. A lazily-minted id lets two callers disagree about which id a job has,
   * and the reservation would then be held against one of them. The schema is the one place that
   * mints it: `engraveJobSchema`'s `.default(() => newId('job'))`, and the v1 transform below it,
   * so a document written before this field existed gains an id on parse with no version bump.
   */
  id: string;
  name: string;
  /**
   * The MILL this job is written for (#347) — a `MACHINES` key, and `'Z1'` today, because that is
   * the only mill this app models.
   *
   * A PLAIN STRING, for the same reason `toolKey` is one: a second machine is an entry in
   * `MACHINES`, not a migration, and a saved job keeps resolving. `jobMachine(job, calibration)`
   * in `engine/cnc/calibration.ts` is the reader; the job schema coerces an id this build does not
   * know to the one it does, so a document written by a later build still loads here.
   *
   * It is not decoration. The work envelope the stock is bounded by, the spindle ceiling the feeds
   * are clamped to, the frame the probe positions come from — and, since #347, WHICH MATERIALS the
   * setup flow offers — are all the machine's, not the app's.
   */
  machineId: string;
  /**
   * length = X, width = Y, thickness = Z. `colour` is the colour-plane input (#492, from #285);
   * absent for every job that is not a two-colour blank or a laminate. `flatness` is the bow
   * MEASURED on this piece in the jaws (#496), absent until the surface has been measured.
   */
  stock: {
    length: Mm;
    width: Mm;
    thickness: Mm;
    material: StockMaterial;
    /**
     * The stock's plan shape (#240 §1, `/Rotary.md` R6). ABSENT is a rectangle — every pre-rotary
     * job — and is kept absent through a save/open so those documents round-trip byte-for-byte.
     * `'cylinder'` says the box around the stock is round stock. The box is still what the CAM
     * plans in; the word says which way to read it, and nothing pretends a square is a cylinder.
     *
     * TWO FRAMES, ONE ROD (#683, #713): the stock step writes a rod or tube STANDING ON ITS END in
     * the vise — `D × D × L` — and the Holding step's chuck write normalises it to the axis frame
     * — `L × D × D` (#240 slice 1). `cylinderFrameOf` within `stockStart.ts` reads which one a
     * document holds.
     */
    shape?: 'cylinder';
    /**
     * The rod's or tube's OUTER diameter, mm — present iff `shape` is `'cylinder'` (schema-checked
     * against the box: the diameter is across one face and the rod's own length along the other).
     */
    diameter?: Mm;
    /**
     * A tube's wall thickness, mm (#713) — the stock's own fact, and the cap every later cut depth
     * is read against. ABSENT for a rod, and absent for every document written before #713, so
     * those round-trip byte-for-byte.
     */
    wall?: Mm;
    /**
     * The fibre the blank's filament states (#464), BESIDE the material rather than folded into it
     * — see {@link FilamentFibre}. `PETG-CF` is `material: 'petg'` with `fibre: 'cf'`: the feeds
     * table and the catalogue read the base, and the run's tool wear reads the fibre.
     *
     * OPTIONAL and absent when no file has stated one, like `print`/`flatness`, so a job that has
     * never seen a fibre filament round-trips byte-for-byte. It is also a field a patch can CLEAR
     * (`setStock`): re-importing a plain PETG design over a PETG-CF one must take the flag away,
     * or every later run is still weighed as abrasive.
     */
    fibre?: FilamentFibre;
    colour?: StockColour;
    flatness?: StockFlatness;
  };
  labels: EngraveLabel[];
  /** Shape pockets (#214), each at its own depth. Empty for a text-only job. */
  shapes: EngraveShape[];
  /**
   * PROFILE CUT-OUTS (#218): paths that free a part from the blank, held by tabs. A separate
   * list, like `traces`/`drills`/`keepOuts`, because a cut-out is not a cleared region and has
   * no `depth`; they funnel into `PartPlan.cutouts` and CAM's `cam/profile.ts`.
   *
   * Optional, so a pre-#218 document round-trips byte-for-byte; the schema keeps it absent (not
   * defaulted) for the same reason as `combined`, `traces` and `vectors`.
   */
  cutouts?: EngraveCutout[];
  /**
   * CHAMFERS (#669): one flat bevel along a profile's part edge or a pocket's rim, cut by the
   * cone's flank. A separate list, like `cutouts` and `threads`, so every exhaustive item switch
   * keeps compiling and old documents keep parsing; `toPartPlan` carries them to
   * `PartPlan.chamfers` and CAM writes one closed pass each.
   *
   * Optional, so a pre-#669 document round-trips byte-for-byte; the schema keeps it absent (not
   * defaulted) for the same reason as every list above it. Consumers read `job.chamfers ?? []`.
   */
  chamfers?: EngraveChamfer[];
  /**
   * Combined shapes (#215): borders, frames and cut-aways built from other items or from the
   * stock. A separate list, like `labels` and `shapes`, so the panel's exhaustive `EngraveShape`
   * switch is untouched; all three lists funnel through the one `PartPlan` downstream.
   *
   * Optional so an existing job (and every literal that does not build one) is unchanged; the
   * schema defaults it to empty on load.
   */
  combined?: EngraveCombinedShape[];
  /**
   * Single-line traces (#219): free polylines and single-stroke text. A separate list, like
   * `combined`, so the region pipeline and every exhaustive region-item switch is untouched; they
   * funnel into `PartPlan.traces`, a sibling of `engraves`.
   *
   * Optional, so an existing job (and every literal that does not build one) is unchanged; the
   * schema keeps it absent (not defaulted) so a pre-#219 document round-trips byte-for-byte.
   */
  traces?: EngraveTraceItem[];
  /**
   * Imported vector outlines (#217): SVG/DXF traces, flattened to mm at import. A separate list,
   * like `combined` and `traces`, so the simple-shape editor and its exhaustive switch are
   * untouched; they funnel into `engraves` through `itemProfile` like every other region item.
   *
   * Optional, so a pre-#217 document round-trips byte-for-byte; the schema keeps it absent (not
   * defaulted) for the same reason as `combined` and `traces`.
   */
  vectors?: EngraveVectorShape[];
  /**
   * Under-surface voids (#231 item 3): pockets or cavities in the blank's bottom face that the
   * job must not cut through. A separate list, like `combined`/`traces`/`vectors`, so the item
   * pipelines and the panel's exhaustive switches are untouched; `toPartPlan` carries them to
   * `PartPlan.stock.keepOuts` and the generated depth limit, and the run sheet names them.
   *
   * Optional, so a pre-#231 document round-trips byte-for-byte; the schema keeps it absent (not
   * defaulted) for the same reason as `combined`, `traces` and `vectors`. Consumers read
   * `job.keepOuts ?? []`.
   */
  keepOuts?: EngraveKeepOut[];
  /**
   * Plunge-drilled holes (#220). A separate list, like `combined`/`traces`/`vectors`/`keepOuts`,
   * so the region pipelines and every exhaustive item switch are untouched; `toPartPlan` carries
   * them to `PartPlan.drills` and CAM writes a peck cycle for each hole.
   *
   * Optional, so a pre-#220 document round-trips byte-for-byte; the schema keeps it absent (not
   * defaulted) for the same reason as `combined`, `traces`, `vectors` and `keepOuts`. Consumers
   * read `job.drills ?? []`.
   */
  drills?: EngraveDrill[];
  /**
   * Milled threads (#445, #434 phase 2). A separate list, like `combined`/`traces`/`vectors`/
   * `keepOuts`/`drills`, so the region pipelines and every exhaustive item switch are untouched;
   * `toPartPlan` carries them to `PartPlan.threads` and CAM writes one helical operation each.
   *
   * Optional, so a pre-#445 document round-trips byte-for-byte; the schema keeps it absent (not
   * defaulted) for the same reason as every list above it. Consumers read `job.threads ?? []`.
   */
  threads?: EngraveThread[];
  /**
   * 3D primitives (#435): box, cylinder, cone and sphere cut-aways. A separate list, like
   * `drills` and `threads`, so every exhaustive item switch keeps compiling and old documents
   * keep parsing; the forms that reduce to a flat-floor region join `PartPlan.engraves` in
   * `toPartPlan`, and the rest are refused by name.
   *
   * Optional, so a pre-#435 document round-trips byte-for-byte; the schema keeps it absent (not
   * defaulted) for the same reason as every list above it. Consumers read
   * `job.primitives ?? []`.
   */
  primitives?: EngravePrimitive[];
  /**
   * The reference object the primitives are positioned against (#435). OPTIONAL and absent on
   * every document that predates it. It is embedded rather than referenced by path, so the job
   * stays self-contained (the #425 source-file rule), and it is never cut — `stock − target` is
   * #218's cut-out work.
   */
  targetObject?: EngraveTargetObject;
  /**
   * The key of the cutter this job is written for — a builtin (`flat-1.0`), or a later registry
   * tier's key (`cat:`, `user:`, `inv:`). A PLAIN STRING, so no saved job has ever needed
   * migrating when a tier was added (#305).
   */
  toolKey: string;
  /**
   * The materialised cutter this job was written with (#305 design point 2) — the same
   * provenance discipline the fixture obstacles use (decision 28), and the reason a job reopened
   * while the catalogue service is absent can still be generated, verified and simulated.
   *
   * OPTIONAL, and absent until the cutter is picked: a document written before this field
   * existed round-trips byte-for-byte. `jobTool` reads it FIRST, ahead of the registry entry
   * `toolKey` names, so re-collaring a bit does not silently re-prove an old job at a new
   * stick-out.
   */
  tool?: Tool | null;
  workholding: JobWorkholding;
  /**
   * The job's setups (#419 J2, §5.4): one per held position, in run order.
   *
   * OPTIONAL, and absent is meaningful: it is today's single implicit setup — the blank top-up in
   * the vise, cut with `toolKey` and held as `workholding` says — so every document written before
   * this field existed round-trips byte-for-byte and keeps exactly the behaviour it had.
   * `jobSetups` (`engine/cnc/engrave/jobSetup.ts`) is the reader that derives that one setup; the
   * implicit reading is a compatibility answer, not a second stored truth.
   *
   * WHEN PRESENT IT IS AUTHORITATIVE: `setups[]` says what is cut where, mounted how and with
   * which tools, and `workholding`/`toolKey` then describe setup 0's mount and tool. Those two keys
   * are deliberately NOT removed: every existing reader (the emulator, the run sheet, the feeds
   * table) still asks them, and a single-setup job must give the same answer whichever reading a
   * consumer takes. Consumers that understand setups read them; consumers written before this
   * field read the old keys and describe setup 0.
   */
  setups?: JobSetup[];
  /**
   * The bed profile this job was set up on (#513, folded into #707 BM-1). OPTIONAL and absent on
   * every document that predates it: an older job keeps its exact shape and round-trips
   * byte-for-byte. Its readers (the `bed-changed` findings, the receipt) are BM-11's; the field is
   * here so a bed job can say WHERE it was set up from the moment it is authored.
   */
  bed?: JobBedBinding;
  /** Material that must remain under the deepest cut, mm. */
  minFloor: Mm;
  /** No label may come closer than this to a stock edge, mm (measured from the cut edge). */
  edgeMargin: Mm;
  /** User-selected sacrificial material, under the part and/or beside it (#213). */
  sacrificial: Sacrificial;
  /**
   * How far a through-cut may pass below the part's underside, mm — into the under-board
   * (#213/#218). PROVISIONAL 0.3: enough to part cleanly; measured on the first through-cut.
   */
  breakthrough: Mm;
  /**
   * How far a cut's floor must stay above the vise jaws' TOPS, mm (#362). PROVISIONAL 1.0, the
   * same clearance the jaw check carried as a bare constant before #345's rule moved the number
   * onto the document (#488); the house setting (`MarginSettings.jawClearance`) only SEEDS it,
   * exactly as it seeds `minFloor`.
   *
   * A property of the SETUP and not of the blank, which is why the job states its own: a blank
   * that will be re-fixtured, or an operator who wants more room over hardened jaws, should not
   * have to change the house number to say so.
   */
  jawClearance: Mm;
  /**
   * The Z-error margins this job runs with (#345), or absent — in which case it runs on the house
   * setting (`AppSettings.margins`) at generate time. Absent is what every stored job is, so none
   * of them changes behaviour by this field existing.
   *
   * `minFloor`, `edgeMargin`, `breakthrough` and `jawClearance` above are NOT repeated here: they
   * are a different quantity (material that must remain, clearance to an edge, travel into the
   * board, room over the jaws), each with its own owner, and the house setting only SEEDS them for
   * a new job.
   */
  margins?: EngraveMargins;
  /**
   * Feeds/speeds the user overrode by hand (#205). Absent = use `feedsFor`'s values untouched;
   * a present key wins over the computed table for that field only. The computed values are
   * always shown next to it, so an override is visibly a departure from the starting values.
   */
  cutOverride?: Partial<CutParams>;
  /**
   * #572 — the operator explicitly acknowledged a refused cutter/material pair (a "for Metal" line
   * on a non-metal stock, `tool-metal-line`). The refusal downgrades to a warning and Generate
   * unblocks; feeds/speeds are then a guess, not a vendor-measured number. Absent = the protective
   * refusal stands. Per-job only, never a shop default.
   */
  metalLineOverride?: boolean;
  /**
   * Whether the job FACES the stock first, and how deep (#432) — a skim over the whole top so Z0
   * lands on a cut surface rather than on whatever the blank arrived as.
   *
   * OPTIONAL, and absent is off: every document written before this field existed round-trips
   * byte-for-byte and plans exactly as it did. Present, `enabled` is the two-state choice the
   * finish SEEDS (`facingDefault`) and `depth` is the number a person is asked for once facing is
   * on — the depth the whole job is then posted relative to, which is why it lives on the document
   * and not on an item.
   */
  facing?: EngraveFacing;
  /**
   * Where the asserted values came from (#246/#254). Optional: a job that has never had a setup
   * applied carries no key, so a pre-#246 document round-trips byte-for-byte.
   */
  sources?: EngraveJobSources;
  customFonts: CustomFont[];
  /**
   * Where the stock came from (#418, §5.1) — the shelf entry, the file, or a piece typed in the start
   * wizard — and the facts about it the rectangle above cannot carry: its form and its finish.
   *
   * OPTIONAL, and absent on every job written before the material-first start, so such a document
   * round-trips byte-for-byte. Nothing RESERVES the entry yet: Cut mode (#419) reserves `shelfId`
   * when the job enters it; until then the job only names it.
   */
  stockEntry?: JobStockEntry;
  /**
   * The files this job was made from (#425 §6). OPTIONAL, and absent on every v2 document and on
   * a job built only from typed items — which is what the byte-for-byte rule for those documents
   * requires. Records are content-addressed, so the same file named twice appears once.
   *
   * Named `sourceFiles`, not `sources`: `sources` has been the per-field PROVENANCE map since
   * #246/#254 (`EngraveJobSources`), and every v2 key carries forward unchanged. Two different
   * things both called "sources" in one document would invite exactly the wrong read.
   */
  sourceFiles?: JobSource[];
  /**
   * What Cut froze at approval (#419 §4, R8) — the package block that replaces
   * `engravePackageStore`'s localStorage copy. ABSENT until the first freeze; Save never creates
   * one (freezing is Cut's gate, D-17).
   */
  package?: FrozenPackage;
  /**
   * What has been run of this job so far (#425 §6), one entry per program outcome. ABSENT until
   * the first end of run. It is the job's own progress; the machine's `finishedPrograms` list
   * remains the machine's record of what finished on it, and the two are not duplicates.
   */
  runLog?: JobRunLogEntry[];
}

/**
 * The forms a job's stock can take (#418, #683, #713). A disc, a rod and a tube are round, but the
 * job still plans on the rectangle around them, and the round piece is held so its cut face is
 * flat: a disc ⌀D × T is D × D × T (cut on its flat top), a rod ⌀D × L is D × D × L — standing on
 * its end in the vise, cut on that ⌀D end. A tube is a rod with a bore: its box is its OUTER
 * diameter, and `wall` is how thick its side is. The form keeps the round fact for the screens.
 */
export type JobStockForm = 'sheet' | 'plate' | 'block' | 'printed-blank' | 'disc' | 'rod' | 'tube';

/** A shelf entry's finish (#413) — what decides the facing default (decision Q6, #432). */
export type JobStockFinish = 'rough' | 'finished' | 'printed' | 'unknown';

/** Where a job's stock came from (#418). See {@link EngraveJob.stockEntry}. */
export interface JobStockEntry {
  /** `shelf` — picked off the location's shelf; `file` — an STL/3MF used as the stock; `made` — typed. */
  kind: 'shelf' | 'file' | 'made';
  /** The shelf entry's id: set for `shelf`, and for `made` when it was also put on the shelf. */
  shelfId: string | null;
  /** The file the stock was read from, with its SHA-256 (hex), for `file`. */
  file: { name: string; sha256: string } | null;
  form: JobStockForm;
  finish: JobStockFinish;
  /** Whether a touch probe can find its edges electrically (§5.9); the shelf entry's own answer. */
  conductive: boolean;
}

/**
 * The job's facing choice (#432). See {@link EngraveJob.facing}.
 *
 * `depth` is the TOTAL material taken off the top, not the per-pass bite: the pass step comes from
 * the feeds row for the cutter and material, and the plan divides one by the other. Keeping the
 * document's number whole means re-picking a cutter does not silently change what the job claims
 * to remove.
 */
export interface EngraveFacing {
  /** The two-state choice. `facingDefault` seeds it from the stock's finish; a person overrides it. */
  enabled: boolean;
  /** Material taken off the top face, mm — the depth every later program is posted from. */
  depth: Mm;
  /**
   * The cutter the facing program runs with (#432 slice 2), as a registry key — its OWN choice,
   * never the job's engraving cutter. Optional and null/absent asks the default rule
   * (`engrave/facingTool.ts`): the largest flat end mill the catalogue recommends for the blank's
   * material.
   */
  toolKey?: string | null;
}
