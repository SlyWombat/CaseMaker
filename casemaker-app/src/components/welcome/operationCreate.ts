/**
 * Step 2's Create gate, kept out of the component module so that file exports only its component
 * (react-refresh/only-export-components). The type comes from `OperationStep` as a type-only
 * import, so there is no runtime cycle.
 */

import { blocker, FIELD_EXAMPLES, typeExample } from '@/engine/cnc/wizardCopy';
import type { OperationChoice } from './OperationStep';

// #1109 — the one blocker shape is re-exported here for the panels that read this module.
export { blocker } from '@/engine/cnc/wizardCopy';

export interface CreateGateContext {
  /** A re-entry's primary is Done: an existing job may finish with nothing new to add. */
  reEntry?: boolean;
  /**
   * #1109 item 4 — the rod this answer is for. With it, the across-flats maximum is
   * `D × cos(π / faces)` and the blocker states the rod, the maximum and a value to try.
   */
  rodDiameterMm?: number;
}

/** The largest multiple of 5 at or below `m` — the across-flats suggestion on a big rod. */
function multipleOfFive(m: number): number {
  return Math.floor(m / 5) * 5;
}

/** The button's disabled state, in the one place both the shell and its spec read it. */
export function operationCreateBlocked(choice: OperationChoice | null, ctx: CreateGateContext = {}): string | null {
  // #1107 — a NEW run with nothing picked cannot create the empty job (the dowel starter's old
  // trap): the operator picks what to make first. A re-entry keeps its Done.
  if (choice === null) return ctx.reEntry === true ? null : 'Pick what to make first.';
  if (choice.type === 'engrave') {
    if (choice.text.trim() === '') return 'Type the text to engrave — for example, a name.';
    if (!Number.isFinite(choice.depth) || choice.depth <= 0) return blocker('Depth', 'a size above 0', typeExample(FIELD_EXAMPLES.depth));
    return null;
  }
  // The mesh is the operation's one field; Create waits for a file that read cleanly.
  if (choice.type === 'surface') return choice.target === null ? 'Pick the mesh to surface — a .stl or .step file.' : null;
  // #1100 — a preset card's numbers are the whole answer; only their own limits are gates.
  // #1109 item 3 — each blocker proposes the card's own decided default.
  if (choice.type === 'cutout') {
    if (!Number.isFinite(choice.length) || choice.length <= 0) return blocker('The shape', 'a length above 0', typeExample(FIELD_EXAMPLES.shapeLength));
    if (!Number.isFinite(choice.width) || choice.width <= 0) return blocker('The shape', 'a width above 0', typeExample(FIELD_EXAMPLES.shapeWidth));
    return null;
  }
  if (choice.type === 'pocket' && choice.length !== undefined) {
    if (!Number.isFinite(choice.length) || choice.length <= 0) return blocker('The pocket', 'a length above 0', typeExample(FIELD_EXAMPLES.pocketLength));
    if (choice.width === undefined || !Number.isFinite(choice.width) || choice.width <= 0)
      return blocker('The pocket', 'a width above 0', typeExample(FIELD_EXAMPLES.pocketWidth));
    return choice.depth === undefined || !Number.isFinite(choice.depth) || choice.depth <= 0
      ? blocker('The pocket depth', 'a size above 0', typeExample(FIELD_EXAMPLES.pocketDepth))
      : null;
  }
  // #1098 item 6 — a recognised project is the whole answer: the Stock step reads it at Create.
  if (choice.type === 'design') return null;
  // #1098 — a drawing IS the field, so it is always read; only Pocket it asks for a number.
  if (choice.type === 'outline') {
    if (choice.use === 'pocket') {
      return choice.depth === undefined || !Number.isFinite(choice.depth) || choice.depth <= 0
        ? blocker('Depth', 'a size above 0', typeExample(FIELD_EXAMPLES.depth))
        : null;
    }
    return null;
  }
  // #874 — a board's one field is its Gerber and drill set. There is nothing for Create to ADD
  // once it reads (the files wrote the items), so this is the whole gate.
  if (choice.type === 'pcb') return choice.imported ? null : "Pick the board's Gerber and drill files.";
  // #752 — a rotary flute's field is its length, and a length is a positive number.
  if (choice.type === 'flute' && choice.lengthMm !== undefined) {
    return !Number.isFinite(choice.lengthMm) || choice.lengthMm <= 0
      ? blocker('The flute', 'a length above 0', typeExample(FIELD_EXAMPLES.length))
      : null;
  }
  // #241 slice 2 — the face group's one field each. A flat's depth is a positive number; a ring
  // is at least three faces with a positive across-flats; a cross-hole's diameter is above 0. An
  // index is any finite number of degrees (it unwinds, so it may pass a turn).
  if (choice.type === 'flat') {
    if (!Number.isFinite(choice.a)) return 'Give the face an angle in degrees — type a number (for example 45).';
    return !Number.isFinite(choice.depth) || choice.depth <= 0
      ? blocker('Depth', 'a size above 0', typeExample(FIELD_EXAMPLES.depth))
      : null;
  }
  if (choice.type === 'faces-all-round') {
    if (!Number.isInteger(choice.count) || choice.count < 3) return 'Faces all round needs at least 3 — type 6 for a hex.';
    if (!Number.isFinite(choice.acrossFlats) || choice.acrossFlats <= 0) {
      // #1109 item 4 — ON A ROD the answer cannot exceed the flats it can be turned to: the largest
      // across-flats a D rod admits over `faces` steps is D × cos(π / faces).
      const d = ctx.rodDiameterMm;
      if (d !== undefined && Number.isFinite(d) && d > 0) {
        const max = d * Math.cos(Math.PI / choice.count);
        const upTo = Math.floor(max);
        const tryMm = max >= 10 ? multipleOfFive(upTo) : Math.floor(max * 0.85 * 10) / 10;
        return `Across flats needs a size — the rod is ⌀${Number(d.toFixed(3))}, so up to ${upTo} mm; try ${tryMm}.`;
      }
      return 'Across flats needs a size above 0 — type a number in mm (for example 15).';
    }
    return null;
  }
  if (choice.type === 'cross-hole') {
    if (!Number.isFinite(choice.a)) return 'Give the hole an angle in degrees — type a number (for example 45).';
    return !Number.isFinite(choice.diameter) || choice.diameter <= 0
      ? blocker('The hole', 'a diameter above 0', typeExample(FIELD_EXAMPLES.diameter))
      : null;
  }
  return null;
}
