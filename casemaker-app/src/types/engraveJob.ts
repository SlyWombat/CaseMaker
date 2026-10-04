import type { Mm } from './units';
import type { TextFont, TextWeight, CustomFont } from './textLabel';

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
}

export interface EngraveJob {
  schemaVersion: 1;
  name: string;
  /** length = X, width = Y, thickness = Z. */
  stock: { length: Mm; width: Mm; thickness: Mm; material: StockMaterial };
  labels: EngraveLabel[];
  /** Key into TOOL_LIBRARY. */
  toolKey: string;
  workholding: { kind: 'vise'; vise: ViseParams };
  /** Material that must remain under the deepest cut, mm. */
  minFloor: Mm;
  /** No label may come closer than this to a stock edge, mm (measured from the cut edge). */
  edgeMargin: Mm;
  customFonts: CustomFont[];
}
