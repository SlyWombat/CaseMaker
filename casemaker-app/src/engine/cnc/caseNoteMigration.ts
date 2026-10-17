/**
 * The one-off migration of the label import's case note into per-copy case records (#491).
 *
 * WHY A MIGRATION AT ALL. Since #309 `build-house.ts` has written `Case: yellow.` into an item's
 * NOTES — the physical box a bit came in. #491 moves that fact onto the copy (`whereabouts.case`),
 * where every presentation reads it. The note stays: it is the operator's record, and the brief is
 * explicit that the note is not consumed.
 *
 * WHAT IT ASSIGNS. A single-colour note assigns that colour to every copy of the item, and creates
 * the copy entries the inventory did not have (with NO condition — see `toolCondition.ts`). A
 * multi-colour note is exact only when its variant sentence says how many boxes of each ("2× yellow
 * with collar; 2× orange"): those counts are assigned in order. A note that names several colours
 * without saying how many copies each is LEFT ALONE — assigning either colour to every copy would be
 * a guess, and the feature's rule is that nothing guesses. A machine copy never receives a case:
 * the case is where a bit lives when it is not in a spindle.
 *
 * IDEMPOTENT. Copies that already state a case keep it; a second run finds nothing to change.
 */

import type { ToolCopy, Whereabouts } from './toolCondition';
import { parseCaseNote, type CopyCase } from './caseColour';

export interface MigratableItem {
  id: string;
  quantity: number;
  notes: string | null;
  copies: ToolCopy[];
}

export interface CaseMigration<T extends MigratableItem> {
  item: T;
  changed: boolean;
  /** One sentence for the CLI's log, or null when the item had nothing to migrate. */
  reason: string | null;
}

/** A deterministic copy id that does not collide with one already described. */
function copyId(n: number, used: Set<string>): string {
  let id = `case-copy-${n}`;
  let bump = 1;
  while (used.has(id)) id = `case-copy-${n}-${bump++}`;
  return id;
}

/** The case each physical slot should receive, in copy order; null leaves that slot uncoloured. */
function desiredCases(item: MigratableItem): (string | null)[] | null {
  const note = parseCaseNote(item.notes);
  if (note === null) return null;
  if (note.colours.length === 1) {
    // One colour: every copy is in that case, and the note needed no count to say so.
    return Array<string | null>(item.quantity).fill(note.colours[0]!);
  }
  if (note.counts.some((n) => n === null)) return null; // several colours, no split: never guess
  const desired: string[] = [];
  note.colours.forEach((colour, i) => {
    for (let n = 0; n < (note.counts[i] ?? 0); n++) desired.push(colour);
  });
  if (desired.length === 0 || desired.length > item.quantity) return null;
  // Fewer known slots than copies: the ones the note does not assign stay uncoloured.
  return [...desired, ...Array<string | null>(item.quantity - desired.length).fill(null)];
}

/**
 * Migrate one item. The input is not mutated; the returned item is a new object whose `copies`
 * array is new (the copy objects that change are new too).
 */
export function migrateCaseNote<T extends MigratableItem>(item: T): CaseMigration<T> {
  const note = parseCaseNote(item.notes);
  if (note === null) return { item, changed: false, reason: null };
  const desired = desiredCases(item);
  if (desired === null) {
    return {
      item,
      changed: false,
      reason:
        note.colours.length > 1
          ? `notes name ${note.colours.join(' + ')} but do not say how many copies of each — left uncoloured`
          : null,
    };
  }

  const copies: ToolCopy[] = item.copies.map((c) => ({
    ...c,
    whereabouts: { ...c.whereabouts } as Whereabouts,
  }));
  const used = new Set(copies.map((c) => c.id));
  let coloured = 0;
  let added = 0;

  const assign = (copy: ToolCopy, slot: number): ToolCopy => {
    if (copy.whereabouts.kind !== 'box') return copy;
    const colour = desired[slot];
    if (colour == null) return copy;
    if (copy.whereabouts.case != null) return copy; // already stated: not ours to overwrite
    coloured += 1;
    const value: CopyCase = { colour, label: null };
    return { ...copy, whereabouts: { kind: 'box', case: value } };
  };

  // The copy list's positions ARE the physical slots; a machine copy holds its slot but takes no case.
  for (let i = 0; i < copies.length; i++) copies[i] = assign(copies[i]!, i);

  // Undescribed copies: create an entry only where the note assigns a colour. The rest stay
  // implicit, exactly as before — an uncoloured copy is not a copy we know anything new about.
  for (let slot = copies.length; slot < item.quantity; slot++) {
    const colour = desired[slot];
    if (colour == null) continue;
    const id = copyId(slot + 1, used);
    used.add(id);
    copies.push({
      id,
      condition: null,
      whereabouts: { kind: 'box', case: { colour, label: null } },
      runtimeWarnMinutes: null,
      notes: null,
      runtimeMinutes: null,
    });
    added += 1;
  }

  if (coloured === 0 && added === 0) return { item, changed: false, reason: null };
  return {
    item: { ...item, copies },
    changed: true,
    reason: `assigned ${note.colours.map((c) => c.toLowerCase()).join(', ')} to ${coloured + added} cop${
      coloured + added === 1 ? 'y' : 'ies'
    }${added === 0 ? '' : ` (${added} new entr${added === 1 ? 'y' : 'ies'})`}`,
  };
}

/** Migrate a whole inventory. Pure; the caller writes back only the items that changed. */
export function migrateCaseNotes<T extends MigratableItem>(items: readonly T[]): CaseMigration<T>[] {
  return items.map((item) => migrateCaseNote(item));
}
