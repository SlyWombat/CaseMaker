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
  customFonts: CustomFont[];
}
