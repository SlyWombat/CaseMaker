/**
 * `stockEntry` follows the stock (#418 review): once the job's stock is edited away from the piece
 * an entry was taken from, the job no longer names that entry, and Cut mode (#419) must not reserve
 * it.
 *
 * A SUBSCRIPTION, not a change to `engraveJobStore.setStock`, so every route that moves the stock —
 * the panel's fields, "Use the blank", a design import, the guided setup — is covered by one rule
 * without each of them knowing about the entry. It clears only when the update did NOT itself set
 * the entry (the wizard writes the stock first and the entry after it), and only when the size or
 * the material really changed (`stockStillNamed`): a setup that re-states the same numbers keeps it.
 *
 * Imported for its side effect by the start wizard, which `AppShell` always loads.
 */

import { stockStillNamed } from '@/engine/cnc/stockStart';
import { useEngraveJobStore } from './engraveJobStore';

useEngraveJobStore.subscribe((state, prev) => {
  const entry = prev.job.stockEntry;
  if (entry === undefined || state.job.stockEntry !== entry) return;
  if (stockStillNamed(prev.job.stock, state.job.stock)) return;
  const next = { ...state.job };
  delete next.stockEntry;
  state.replace(next);
});
