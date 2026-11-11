/**
 * #1172 Part A — the bits list's own facts, kept out of the component so the header, the Have
 * column and the search cannot disagree with one another.
 *
 * THE HEADER COUNTS WHAT YOU OWN. The inventory is the physical shop; the catalogue and the
 * built-ins are rows a job could name, not bits on the shelf. `ownedCounts` reads the inventory
 * document alone.
 *
 * A PIECE NOBODY DESCRIBED IS UNKNOWN, NOT GOOD (#1149). `haveWords` counts only what the copies
 * state; an undescribed piece is called unknown. A copy in a machine is said as where it is
 * (`1 in Zoomba`), never also as a good piece in the box it is not in.
 */

import type { InventoryItem } from '@/platform/houseClient';
import { copyCase } from '@/engine/cnc/caseColour';

export interface OwnedCounts {
  /** Owned inventory rows. */
  kinds: number;
  /** The pieces those rows state. */
  pieces: number;
  broken: number;
  lost: number;
}

/** The header's facts: kinds and pieces you own, and the pieces that are out of service. */
export function ownedCounts(items: readonly InventoryItem[]): OwnedCounts {
  let pieces = 0;
  let broken = 0;
  let lost = 0;
  for (const item of items) {
    pieces += item.quantity;
    for (const copy of item.copies) {
      if (copy.condition === 'broken') broken += 1;
      else if (copy.condition === 'lost') lost += 1;
    }
  }
  return { kinds: items.length, pieces, broken, lost };
}

/**
 * The Have column, in the operator's words: `2 good`, `1 good · 1 broken`, `0 · lost`,
 * `1 good · 1 in Zoomba`, `2 unknown`. New and used are both good; a machine copy is named by the
 * machine it is in; a piece with no described copy is unknown.
 */
export function haveWords(item: InventoryItem, machineName: (id: string) => string): string {
  let good = 0;
  let worn = 0;
  let broken = 0;
  let lost = 0;
  const machines = new Map<string, number>();
  for (const copy of item.copies) {
    if (copy.whereabouts.kind === 'machine') {
      machines.set(copy.whereabouts.machineId, (machines.get(copy.whereabouts.machineId) ?? 0) + 1);
      continue;
    }
    if (copy.condition === 'new' || copy.condition === 'used') good += 1;
    else if (copy.condition === 'worn') worn += 1;
    else if (copy.condition === 'broken') broken += 1;
    else if (copy.condition === 'lost') lost += 1;
  }
  const unknown = Math.max(0, item.quantity - item.copies.length);
  const segments: string[] = [];
  // Nothing usable, and something is out of service: the zero is said before what became of it,
  // and a single out-of-service piece reads `0 · lost` — the mockup's own words — not `0 · 1 lost`.
  const nothingUsable = good + worn === 0 && broken + lost > 0;
  const singleOut = broken + lost === 1;
  if (nothingUsable) segments.push('0');
  if (good > 0) segments.push(`${good} good`);
  if (worn > 0) segments.push(`${worn} worn`);
  if (broken > 0) segments.push(nothingUsable && singleOut ? 'broken' : `${broken} broken`);
  if (lost > 0) segments.push(nothingUsable && singleOut ? 'lost' : `${lost} lost`);
  for (const [id, count] of machines) segments.push(`${count} in ${machineName(id)}`);
  if (unknown > 0) segments.push(`${unknown} unknown`);
  return segments.length === 0 ? '0' : segments.join(' · ');
}

/**
 * How many pieces a job could plan with: good or worn, and in the operator's hands. A piece in a
 * machine is not on the shelf, and broken/lost pieces are out of service (#1149). The list's Have
 * column sorts on this.
 */
export function usablePieces(item: InventoryItem): number {
  let usable = 0;
  for (const copy of item.copies) {
    if (copy.whereabouts.kind === 'machine') continue;
    if (copy.condition === 'new' || copy.condition === 'used' || copy.condition === 'worn') usable += 1;
  }
  return usable;
}

/**
 * What a row can be found by beyond its cutter numbers: the words on its case and the place it is
 * kept (#1172 item 2). The colour is the copy's (#491); the place today is the operator's note,
 * which the add doors call `where it lives`.
 */
export function possessionSearchText(item: InventoryItem): string {
  const parts: string[] = [];
  if (item.notes !== null) parts.push(item.notes);
  // #1172 item 3 — the item-level place and case colour are searchable beside the copies'.
  if (item.keptIn !== undefined) parts.push(item.keptIn);
  if (item.caseColour !== undefined) parts.push(item.caseColour);
  for (const copy of item.copies) {
    const kase = copyCase(copy);
    if (kase === null) continue;
    parts.push(kase.colour);
    if (kase.label !== null) parts.push(kase.label);
  }
  return parts.join(' ').toLowerCase();
}
