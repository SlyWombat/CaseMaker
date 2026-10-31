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
  // #241 slice 2 — the face group's one field each. A flat's depth is a positive number; a ring
  // is at least three faces with a positive across-flats; a cross-hole's diameter is above 0. An
  // index is any finite number of degrees (it unwinds, so it may pass a turn).
  if (choice.type === 'flat') {
    if (!Number.isFinite(choice.a)) return 'Give the face an angle, in degrees.';
    return !Number.isFinite(choice.depth) || choice.depth <= 0 ? 'Depth must be above 0 mm.' : null;
  }
  if (choice.type === 'faces-all-round') {
    if (!Number.isInteger(choice.count) || choice.count < 3) return 'Faces all round needs at least 3 faces.';
    return !Number.isFinite(choice.acrossFlats) || choice.acrossFlats <= 0 ? 'Across flats must be above 0 mm.' : null;
  }
  if (choice.type === 'cross-hole') {
    if (!Number.isFinite(choice.a)) return 'Give the hole an angle, in degrees.';
    return !Number.isFinite(choice.diameter) || choice.diameter <= 0 ? 'The hole needs a diameter above 0 mm.' : null;
  }
  return null;
}
