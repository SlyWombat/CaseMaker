import type { Mm } from './units';
import type { TextFont, TextWeight, CustomFont } from './textLabel';
import type { CutParams } from '@/engine/cnc/feeds';
import type { FastenerSize } from '@/engine/compiler/fasteners';
import type { Tool } from '@/engine/cnc/tool';
import type { Mount, MountSpec, Orientation, RemountStep } from '@/engine/cnc/setups/types';
import type { RegistrationPlan } from '@/engine/cnc/registration/plan';

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
   * and `flatness` are stamped by whoever copies a badge's print facts in (#285, #345), the same
   * way `material` is stamped when a badge becomes the blank.
   *
   * `print` was this key's name before #492; a document that still carries it is migrated on load
   * to `colour` (see `engraveJobSchema.ts`), so nothing in this build reads the old key.
   */
  stock?: Partial<
    Record<'length' | 'width' | 'thickness' | 'material' | 'fibre' | 'colour' | 'flatness', FieldSource>
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
    { layout?: FieldSource; depth?: FieldSource; depthIntent?: FieldSource }
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
   * Cut all the way through the blank. NOT AVAILABLE YET: a through hole is only permitted
   * where a sacrificial board exists (#213) and its depth is a rule of the through-cut work
   * (#218), so a job that asks for one is REFUSED with `drill-through-unavailable` rather than
   * cutting into the vise.
   */
  through: boolean;
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

/** A free polyline the cutter traces, its centre following the points (#219). */
export interface EngraveLineItem extends EngraveTraceBase {
  kind: 'line';
  /** Path points relative to `position`, mm. */
  points: [Mm, Mm][];
  /** Close the ring (feed back to the first point with no retract) — for borders and outlines. */
  closed: boolean;
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
 * How flat the blank's printed face is (#345), stated by whoever knows it: a badge's print spec
 * states the dome, a bare blank states none.
 *
 * `dome` is the height difference between the blank's centre and its edges on the face to be
 * engraved. It is the term a job running with NO autolevel grid must carry in its Z budget —
 * #176's grid is what removes it — so the recommendation names it rather than assuming a flat
 * blank (`flatness unknown` is its own answer, never an invented 0).
 *
 * PROVISIONAL on the default badge: 0.33 mm across its 38.1 mm side — the stock's `length` since
 * the blank is turned for the vise (#383) — measured on the printed blank for #166 and awaiting
 * the measured blank of #165.
 */
export interface StockFlatness {
  /** Centre-to-edge height difference on the engraved face, mm. */
  dome: Mm;
  /** The direction `dome` was measured across. */
  across: 'width' | 'length';
  /** Where the number came from — a default is not a measurement (decision 28). */
  source: 'badge' | 'user' | 'measured';
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
   * absent for every job that is not a two-colour blank or a laminate. `flatness` is the dome the
   * printed face carries (#345), where anyone has stated one.
   */
  stock: {
    length: Mm;
    width: Mm;
    thickness: Mm;
    material: StockMaterial;
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
  workholding: { kind: 'vise'; vise: ViseParams };
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

/** The forms a job's stock can take (#418): the rectangular ones. A rod, tube or disc is refused. */
export type JobStockForm = 'sheet' | 'plate' | 'block' | 'printed-blank';

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
