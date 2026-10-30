/**
 * Step 2's Create gate, kept out of the component module so that file exports only its component
 * (react-refresh/only-export-components). The type comes from `OperationStep` as a type-only
 * import, so there is no runtime cycle.
 */

import type { OperationChoice } from './OperationStep';

/** The button's disabled state, in the one place both the shell and its spec read it. */
export function operationCreateBlocked(choice: OperationChoice | null): string | null {
  if (choice === null) return null;
  if (choice.type === 'engrave') {
    if (choice.text.trim() === '') return 'Type the text to engrave.';
    if (!Number.isFinite(choice.depth) || choice.depth <= 0) return 'Depth must be above 0 mm.';
    return null;
  }
  // The mesh is the operation's one field; Create waits for a file that read cleanly.
  if (choice.type === 'surface') return choice.target === null ? 'Choose the mesh to surface.' : null;
  // #752 — a rotary flute's field is its length, and a length is a positive number.
  if (choice.type === 'flute' && choice.lengthMm !== undefined) {
    return !Number.isFinite(choice.lengthMm) || choice.lengthMm <= 0 ? 'The flute needs a length above 0 mm.' : null;
  }
  return null;
}
