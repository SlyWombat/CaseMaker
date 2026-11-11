/**
 * #1109 — THE WIZARD'S BLOCKER WORDS, in one place.
 *
 * Every disabled primary says the same three things in the same order: the FIELD the operator must
 * fill, the RULE it breaks, and a SUGGESTION that names a value to type — "<Field> needs <rule> —
 * <suggestion>." Keeping the shape here (rather than inline in two modules) is what makes the
 * capitalisation, the em dash and the full stop incapable of drifting between Step 2 and Stock.
 *
 * The example in a numeric suggestion is that field's decided default (#1109 item 3): a value that
 * is plausible for the field, never a placeholder the service would refuse. `typeExample` is the
 * one sentence that carries it.
 */

/** `<Field> needs <rule> — <suggestion>.` The one shape every blocker is built through. */
export function blocker(field: string, rule: string, suggestion: string): string {
  return `${field} needs ${rule} — ${suggestion}.`;
}

/** #1109 item 3 — the decided example value for each numeric field. */
export const FIELD_EXAMPLES = {
  /** The stock's length. */
  length: 80,
  width: 60,
  thickness: 12,
  /** A tube's wall. */
  wall: 2,
  diameter: 20,
  /** A cut depth (engrave, flat, outline pocket). */
  depth: 3,
  /** A preset pocket's depth. */
  pocketDepth: 6,
  /** A cut-out card's shape. */
  shapeLength: 60,
  shapeWidth: 40,
  /** A pocket card's recess. */
  pocketLength: 60,
  pocketWidth: 40,
} as const;

/** "type a number in mm (for example N)" — the suggestion every numeric blocker carries. */
export function typeExample(n: number): string {
  return `type a number in mm (for example ${n})`;
}
