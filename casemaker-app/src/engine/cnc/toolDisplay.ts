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
 * its own name now; a shank-diameter kind with no tip is named by the vendor label, the only honest
 * statement the record makes; and an unclassifiable row is an "unknown cutter (vendor label)", never
 * a kind it may not be.
 */

import type { Tool, ToolShape } from './tool';

/** `0.5` → `"0.5"`, `1.00` → `"1"`, `3.175` → `"3.17"` — enough for a name, never a false precision. */
function number(n: number): string {
  return String(Number(n.toFixed(2)));
}

/**
 * The kinds whose `diameter=` field is the SHANK, not a cutting size (`tool.ts`): Makera writes the
 * shank there for engravers, drills and chamfers. Their cutting size is `tipDiameter` or nothing.
 */
const SHANK_DIAMETER_KINDS: ReadonlySet<ToolShape> = new Set(['engraving', 'chamfer', 'drill']);

/** The vendor's own words for the cutter, when the record carries any (name, else `type=`). */
function vendorLabel(tool: Tool): string | null {
  const name = tool.name.trim();
  if (name !== '') return name;
  const type = tool.typeText.trim();
  return type === '' ? null : type;
}

/** `N mm` for the cutting size the record honestly states, or null when it states none. */
function cuttingSize(tool: Tool): string | null {
  const diameter = SHANK_DIAMETER_KINDS.has(tool.shape) ? tool.tipDiameter : (tool.tipDiameter ?? tool.diameter);
  return diameter === null ? null : `${number(diameter)} mm`;
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

/** The tool's display name — cutting size, angle for a cone, radius for a tapered ball, and its kind. */
export function toolDisplayName(tool: Tool): string {
  const label = vendorLabel(tool);
  const kind = kindName(tool.shape);
  // #651 — never a guessed kind: an unparsed catalogue row says so, with the vendor's own words.
  if (kind === null) return label === null ? 'unknown cutter' : `unknown cutter (${label})`;
  const size = cuttingSize(tool);
  if (size === null) {
    // A shank-diameter kind with no tip: the record names no cutting size, so the vendor label is
    // the name. Only reachable for those kinds — every other shape states its cutting diameter.
    return label === null ? `unknown ${kind}` : `${kind} (${label})`;
  }
  // `tool.angle` is the INCLUDED angle (the field the schema describes); the half-angle field is
  // `halfAngle`. Operators know the included angle, so that is what the name prints.
  const cone = (tool.shape === 'engraving' || tool.shape === 'chamfer') && tool.angle !== null && tool.angle > 0 ? ` ${number(tool.angle)}°` : '';
  // A tapered ball is told apart from a plain ball by its nose radius.
  const radius =
    tool.shape === 'tapered-ball' && tool.cornerRadius !== null && tool.cornerRadius > 0 ? ` R${number(tool.cornerRadius)}` : '';
  return `${size}${cone} ${kind}${radius}`;
}
