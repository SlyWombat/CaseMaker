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
 */

import type { Tool } from './tool';

/** `0.5` → `"0.5"`, `1.00` → `"1"`, `3.175` → `"3.18"` — enough for a name, never a false precision. */
function number(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** The tool's display name — tip diameter, angle for a cone, and its kind. */
export function toolDisplayName(tool: Tool): string {
  const diameter = tool.tipDiameter ?? tool.diameter;
  const d = diameter === null ? 'cutter' : `${number(diameter)} mm`;
  switch (tool.shape) {
    case 'engraving':
      // A V-bit's half angle is what the record carries; operators know the INCLUDED angle.
      return tool.angle !== null && tool.angle > 0 ? `${d} ${number(tool.angle)}° engraver` : `${d} engraver`;
    case 'ball':
      return `${d} ball`;
    case 'drill':
      return `${d} drill`;
    case 'thread':
      return `${d} thread mill`;
    case 'bull':
      return `${d} bull nose`;
    default:
      return `${d} flat end`;
  }
}
