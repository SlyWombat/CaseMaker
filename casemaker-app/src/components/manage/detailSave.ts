/**
 * The detail panel's ONE Save (#1172 Part A item 7).
 *
 * The panel edits two documents — the cutter's definition and the inventory record — across several
 * blocks (the definition fields, the count and notes, the copies). Each block used to carry its own
 * save, and "Save copies" sat far from the fields it saved (mockup 9's pin 8). The footer now has one
 * Save: every editor registers its draft here, and the footer commits them:
 *
 *   - a `save` part commits its own document (the definition, via `updateTool`);
 *   - a `merge` part folds its fields onto the inventory record, and ALL merge parts are composed
 *     into ONE `updateItem` call. Two separate inventory `PATCH`es would each carry a whole
 *     document, so the second would silently undo the first — the one reason a single Save is also
 *     the correct Save.
 *
 * A part is `null` on unmount: switching rows must not leave the previous row's draft behind.
 * `blocked` carries the editor's refusal (a typed zero, a count below its copies); the footer is
 * disabled and shows that sentence rather than saving something the service would refuse.
 */

import { createContext, useContext } from 'react';
import type { InventoryItem } from '@/platform/houseClient';

export interface DetailSavePart {
  /** This editor has unsaved changes. */
  dirty: boolean;
  /** The draft is refused; the sentence is what the footer shows instead of saving. */
  problem?: string | null;
  /** Fold this editor's fields onto the inventory record (composed into one update). */
  merge?: (item: InventoryItem) => InventoryItem;
  /** Save this editor's own document (a tool definition). */
  save?: () => void | Promise<unknown>;
}

/** `register(id, part)`; `register(id, null)` removes a part that unmounted. */
export type DetailSaveRegister = (id: string, part: DetailSavePart | null) => void;

export const DetailSaveContext = createContext<DetailSaveRegister | null>(null);

/** The footer's seam. `null` outside a detail panel (a standalone editor keeps its own Save). */
export function useDetailSave(): DetailSaveRegister | null {
  return useContext(DetailSaveContext);
}
