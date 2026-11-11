/**
 * Step 2's Create gate, kept out of the component module so that file exports only its component
 * (react-refresh/only-export-components). The type comes from `OperationStep` as a type-only
 * import, so there is no runtime cycle.
 */

import type { OperationChoice } from './OperationStep';

export interface CreateGateContext {
  /** A re-entry's primary is Done: an existing job may finish with nothing new to add. */
  reEntry?: boolean;
}

/** The button's disabled state, in the one place both the shell and its spec read it. */
export function operationCreateBlocked(choice: OperationChoice | null, ctx: CreateGateContext = {}): string | null {
  // #1107 — a NEW run with nothing picked cannot create the empty job (the dowel starter's old
  // trap): the operator picks what to make first. A re-entry keeps its Done.
  if (choice === null) return ctx.reEntry === true ? null : 'Pick what to make first.';
  if (choice.type === 'engrave') {
    if (choice.text.trim() === '') return 'Type the text to engrave — for example, a name.';
    if (!Number.isFinite(choice.depth) || choice.depth <= 0) return 'Depth needs a size above 0 — 0.5 mm engraves; 3 mm pockets.';
    return null;
  }
  // The mesh is the operation's one field; Create waits for a file that read cleanly.
  if (choice.type === 'surface') return choice.target === null ? 'Pick the mesh to surface — a .stl or .step file.' : null;
  // #1100 — a preset card's numbers are the whole answer; only their own limits are gates.
  if (choice.type === 'cutout') {
    if (!Number.isFinite(choice.length) || choice.length <= 0) return 'The shape needs a length above 0 mm.';
    if (!Number.isFinite(choice.width) || choice.width <= 0) return 'The shape needs a width above 0 mm.';
    return null;
  }
  if (choice.type === 'pocket' && choice.length !== undefined) {
    if (!Number.isFinite(choice.length) || choice.length <= 0) return 'The pocket needs a length above 0 mm.';
    if (choice.width === undefined || !Number.isFinite(choice.width) || choice.width <= 0)
      return 'The pocket needs a width above 0 mm.';
    return choice.depth === undefined || !Number.isFinite(choice.depth) || choice.depth <= 0
      ? 'Depth must be above 0 mm.'
      : null;
  }
  // #1098 item 6 — a recognised project is the whole answer: the Stock step reads it at Create.
  if (choice.type === 'design') return null;
  // #1098 — a drawing IS the field, so it is always read; only Pocket it asks for a number.
  if (choice.type === 'outline') {
    if (choice.use === 'pocket') {
      return choice.depth === undefined || !Number.isFinite(choice.depth) || choice.depth <= 0
        ? 'Depth needs a size above 0 — 0.5 mm engraves; 3 mm pockets.'
        : null;
    }
    return null;
  }
  // #874 — a board's one field is its Gerber and drill set. There is nothing for Create to ADD
  // once it reads (the files wrote the items), so this is the whole gate.
  if (choice.type === 'pcb') return choice.imported ? null : "Pick the board's Gerber and drill files.";
  // #752 — a rotary flute's field is its length, and a length is a positive number.
  if (choice.type === 'flute' && choice.lengthMm !== undefined) {
    return !Number.isFinite(choice.lengthMm) || choice.lengthMm <= 0 ? 'The flute needs a length above 0 — type a number in mm.' : null;
  }
  // #241 slice 2 — the face group's one field each. A flat's depth is a positive number; a ring
  // is at least three faces with a positive across-flats; a cross-hole's diameter is above 0. An
  // index is any finite number of degrees (it unwinds, so it may pass a turn).
  if (choice.type === 'flat') {
    if (!Number.isFinite(choice.a)) return 'Give the face an angle in degrees — type a number (for example 45).';
    return !Number.isFinite(choice.depth) || choice.depth <= 0 ? 'Depth needs a size above 0 — 0.5 mm engraves; 3 mm pockets.' : null;
  }
  if (choice.type === 'faces-all-round') {
    if (!Number.isInteger(choice.count) || choice.count < 3) return 'Faces all round needs at least 3 — type 6 for a hex.';
    return !Number.isFinite(choice.acrossFlats) || choice.acrossFlats <= 0 ? 'Across flats needs a size above 0 — type a number in mm (for example 15).' : null;
  }
  if (choice.type === 'cross-hole') {
    if (!Number.isFinite(choice.a)) return 'Give the hole an angle in degrees — type a number (for example 45).';
    return !Number.isFinite(choice.diameter) || choice.diameter <= 0 ? 'The hole needs a diameter above 0 — type a number in mm.' : null;
  }
  return null;
}
