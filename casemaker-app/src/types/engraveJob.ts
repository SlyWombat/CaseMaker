import type { Mm } from './units';
import type { TextFont, TextWeight, CustomFont } from './textLabel';
import type { CutParams } from '@/engine/cnc/feeds';

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

export type StockMaterial = 'softwood' | 'hardwood' | 'mdf' | 'pla';

/**
 * Where an asserted value came from (#246, and the same provenance rule as the vise and the
 * sacrificial setup — decision 28: never a hard-coded truth, but the source says which).
 *
 * - `computed` — the feeds table produced it (`feedsFor`); no one typed it. Only meaningful for
 *   `cutOverride`.
 * - `user` — typed in the panel or answered in the guided job setup (#254). A typed value is
 *   not more trustworthy for having gone through a flow.
 * - `measured` — taken at the bench with calipers or a test cut (#208). Visibly different from
 *   `user`, so a typed number never reads as a bench reading.
 */
export type FieldSource = 'computed' | 'user' | 'measured';

/**
 * Per-field provenance for the job's asserted values (#246 cutting overrides, #254 guided job
 * setup). Absent on the whole object means "nothing has been asserted" — the shipped defaults,
 * which are untagged and unmeasured. A key absent WITHIN a map means that one field is still the
 * shipped default.
 */
export interface EngraveJobSources {
  /** Which stock fields were asserted, and how (#254). Absent = the shipped default blank. */
  stock?: Partial<Record<'length' | 'width' | 'thickness' | 'material', FieldSource>>;
  /** Provenance of `toolKey` (#254). Absent = the shipped default cutter. */
  tool?: FieldSource;
  /** Per-field provenance for `cutOverride` (#246). Absent = computed from the feeds table. */
  cut?: Partial<Record<keyof CutParams, FieldSource>>;
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

export interface EngraveJob {
  schemaVersion: 2;
  name: string;
  /** length = X, width = Y, thickness = Z. */
  stock: { length: Mm; width: Mm; thickness: Mm; material: StockMaterial };
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
  /** Key into TOOL_LIBRARY. */
  toolKey: string;
  workholding: { kind: 'vise'; vise: ViseParams };
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
   * Feeds/speeds the user overrode by hand (#205). Absent = use `feedsFor`'s values untouched;
   * a present key wins over the computed table for that field only. The computed values are
   * always shown next to it, so an override is visibly a departure from the starting values.
   */
  cutOverride?: Partial<CutParams>;
  /**
   * Where the asserted values came from (#246/#254). Optional: a job that has never had a setup
   * applied carries no key, so a pre-#246 document round-trips byte-for-byte.
   */
  sources?: EngraveJobSources;
  customFonts: CustomFont[];
}
