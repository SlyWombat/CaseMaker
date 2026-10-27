/**
 * #646 — THE TOOL'S NAME FOR PEOPLE, built from its own geometry.
 *
 * A cutter's record carries several names: the vendor's label (`4*0.5mm*30º Engraving(Metal)`), a
 * catalogue row's wording, a job's own title. None of them is a name an operator reads at a glance,
 * and a vendor string is DATA — it belongs in the hover, beside the T number and the provenance, not
 * in the slot that answers "what is in the spindle". So the strip, the run sheet and the pickers all
 * say what the tool IS: its cutting diameter, its angle when it is a cone, and its kind
 * ("0.5 mm 30° engraver", "1 mm flat end", "3 mm ball"). One function, so those three surfaces
 * cannot disagree.
 *
 * #651 — NO SHAPE IS GUESSED, AND THE SHANK IS NOT A CUTTING DIAMETER. Three shapes fell to a
 * default that called them flat ends (a chamfer, a tapered ball, and any row this build could not
 * classify), and every kind without a `tipDiameter` was named by `diameter=` — which for engravers,
 * drills and chamfers is the SHANK (`tool.ts`), so a 1 mm drill read "3.18 mm drill". Every shape has
 * its own name now, and an unclassifiable row is an "unknown cutter", never a kind it may not be.
 *
 * #687 — ONE FORM, AND THE LABEL IS NEVER THE NAME. The form is the vocabulary table's:
 *
 *     ⌀ 3.175 mm flat end · 12 mm flute
 *
 * with a `metal` tag beside it when the vendor's line says so (a tag, not part of the name — this
 * module exposes the fact and the caller draws it). Three things the old name did are gone: the
 * vendor label as the no-size name (`drill (1mm Drill(Metal))`), a curator's note anywhere in it,
 * and two decimals (`3.17` beside a 3.175 mm cutter). A name never carries a manufacturer's string;
 * the hover does.
 */

import { isMetalCutterName, parseLabelAngle, statedCuttingSize, type Tool, type ToolShape } from './tool';

/**
 * A millimetre value for a name: at most three decimals, trailing zeros dropped, never a binary
 * float's tail (`3.175`, `1`, `0.3`). #687 — `3.175` used to print as `3.17` beside records that
 * said 3.175, which is two names for one cutter.
 */
function mm(n: number): string {
  return String(Number(n.toFixed(3)));
}

/** The vendor's own words for the cutter, when the record carries any (name, else `type=`). */
function vendorLabel(tool: Tool): string | null {
  const name = tool.name.trim();
  if (name !== '') return name;
  const type = tool.typeText.trim();
  return type === '' ? null : type;
}

/** The shape in the operator's words, or null for one this build cannot classify. */
function kindName(shape: ToolShape): string | null {
  switch (shape) {
    case 'flat':
      return 'flat end';
    case 'ball':
      return 'ball';
    case 'bull':
      return 'bull nose';
    case 'engraving':
      return 'engraver';
    case 'chamfer':
      return 'chamfer';
    case 'drill':
      return 'drill';
    case 'thread':
      return 'thread mill';
    case 'tapered-ball':
      return 'tapered ball';
    default:
      return null;
  }
}

/**
 * What the pickers draw for one cutter.
 *
 * `name` is the whole display form; `metal` is the fact a chip states beside it. The vendor label is
 * deliberately NOT a field: this module will not hand a caller a second name form to print.
 */
export interface ToolDisplay {
  /**
   * `⌀ 3.175 mm flat end · 12 mm flute` — cutting size, cone angle (V and chamfer), kind, nose
   * radius (tapered ball), then the flute length when the record states one.
   *
   * With no honest cutting size the name keeps the one form's field style — `ball · cutting
   * diameter not stated`; an unclassifiable row is `unknown cutter`. Neither falls back to the
   * vendor's string, and neither invents a size (#726 W22: "ball — cutting diameter unknown" read
   * as a fragment beside the ⌀ names it sits among).
   */
  name: string;
  /** The vendor's line names Makera's "for Metal" range: draw a `metal` tag beside the name. */
  metal: boolean;
}

/**
 * The display form for a cutter, and whether it is on the metal line.
 *
 * One source for every screen that names a cutter (the panel's select, its recommendation, the
 * Simulate panel's Tool select, the strip and the run sheet), so no two can print different names
 * for the same bit.
 */
export function toolDisplay(tool: Tool): ToolDisplay {
  const metal = isMetalCutterName(tool.name);
  const kind = kindName(tool.shape);
  const label = vendorLabel(tool);
  // #651 — never a guessed kind: an unparsed catalogue row says so. #687 — and never the vendor
  // label as a parenthetical, which was the fourth name form the operator had to read.
  if (kind === null) return { name: 'unknown cutter', metal };
  // #699 — the size and the recommendation share one rule for what a record STATES.
  const size = statedCuttingSize(tool);
  if (size === null) {
    // A shank-diameter kind with no tip, or a row whose size never parsed. Say the kind and that
    // the size is missing; the vendor label stays in the hover. #726 W22 — the same ` · ` field
    // separator the sized form uses, so every option in a picker reads as one kind of name.
    return { name: `${kind} · cutting diameter not stated`, metal };
  }
  // `tool.angle` is the INCLUDED angle (the field the schema describes); the half-angle field is
  // `halfAngle`. Operators know the included angle, so that is what the name prints. #658 — a
  // catalogue engraver's `angle` is empty and the angle lives only in the vendor label
  // (`4*0.5mm*30º …`), so the label is the fallback, never a guess at a value the record omits.
  const coneAngle =
    tool.shape === 'engraving' || tool.shape === 'chamfer'
      ? tool.angle !== null && tool.angle > 0
        ? tool.angle
        : label === null
          ? null
          : parseLabelAngle(label)
      : null;
  const cone = coneAngle !== null && coneAngle > 0 ? ` ${mm(coneAngle)}°` : '';
  // A tapered ball is told apart from a plain ball by its nose radius.
  const radius =
    tool.shape === 'tapered-ball' && tool.cornerRadius !== null && tool.cornerRadius > 0 ? ` R${mm(tool.cornerRadius)}` : '';
  // #687 — the flute length is the last field of the form (the vocabulary table's example), and it
  // is omitted rather than invented when the record does not state one.
  const flute = tool.fluteLength !== null && tool.fluteLength > 0 ? ` · ${mm(tool.fluteLength)} mm flute` : '';
  return { name: `⌀ ${mm(size)} mm${cone} ${kind}${radius}${flute}`, metal };
}

/** The display name alone, for a sentence that names the cutter. */
export function toolDisplayName(tool: Tool): string {
  return toolDisplay(tool).name;
}

/**
 * One group of the cutter list, in the order the design names them (first-job flow §3.6):
 * flat end · ball · V and chamfer · engraver · drill · thread.
 *
 * A bull nose is a flat end with a rounded corner and sits in the flat-end group; a tapered ball is
 * a ball with a radius. An unclassifiable row belongs to no group and is drawn without one — the
 * list never invents a seventh heading for it.
 */
export interface ToolGroup {
  id: string;
  /** The group's heading, in the vocabulary table's words. */
  label: string;
  shapes: readonly ToolShape[];
}

export const TOOL_GROUPS: readonly ToolGroup[] = [
  { id: 'flat', label: 'flat end', shapes: ['flat', 'bull'] },
  { id: 'ball', label: 'ball', shapes: ['ball', 'tapered-ball'] },
  { id: 'chamfer', label: 'V and chamfer', shapes: ['chamfer'] },
  { id: 'engraver', label: 'engraver', shapes: ['engraving'] },
  { id: 'drill', label: 'drill', shapes: ['drill'] },
  { id: 'thread', label: 'thread', shapes: ['thread'] },
];
