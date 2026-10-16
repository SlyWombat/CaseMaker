/**
 * Which item rows of the engrave panel are folded open (#411).
 *
 * SESSION-SCOPED AND DELIBERATELY NOT PERSISTED, as `manageModeStore` is: how a list is folded is
 * where the user left the panel, not a property of the job. Written into the document it would show
 * up as a difference in a file when nothing about the part had changed.
 *
 * IT HOLDS THE OPEN IDS, not the closed ones. An id nobody has touched is CLOSED, so a job that
 * arrives from a file lands as one compact line per item — which is the point of #411 — and the
 * three ways an item opens (its own chevron, `expand all`, and being added) are all explicit writes
 * to the same set.
 *
 * Apart from `engraveJobStore` because it is not job data, and apart from the panel's own state
 * because the panel re-mounts on a project switch while the fold should survive it.
 */

import { create } from 'zustand';

export interface EngraveRowState {
  /** The ids of the rows whose editors are showing. */
  open: ReadonlySet<string>;

  /** Fold one row the other way — the chevron. */
  toggle: (id: string) => void;
  /** Open one row. What adding an item does, so a new item arrives with its editor showing. */
  expand: (id: string) => void;
  /**
   * Fold the rows given — the section header's "collapse all", handed that LIST's own ids.
   *
   * It takes ids for the same reason `expandAll` does, and the reason is a bug this store used to
   * have (#411 review): a `collapseAll` that cleared the whole set folded the voids list when the
   * person pressed "collapse all" on the items header, and vice versa. A list header acts on its
   * own list.
   */
  collapseAll: (ids: readonly string[]) => void;
  /** Open every row given (the section header's "expand all"). */
  expandAll: (ids: readonly string[]) => void;
}

export const useEngraveRowStore = create<EngraveRowState>()((set) => ({
  open: new Set<string>(),

  toggle: (id) =>
    set((s) => {
      const open = new Set(s.open);
      if (!open.delete(id)) open.add(id);
      return { open };
    }),
  // A no-op write is still a new Set, and every row subscribed to this store re-renders on it.
  expand: (id) => set((s) => (s.open.has(id) ? s : { open: new Set([...s.open, id]) })),
  collapseAll: (ids) =>
    set((s) => {
      if (!ids.some((id) => s.open.has(id))) return s;
      const open = new Set(s.open);
      for (const id of ids) open.delete(id);
      return { open };
    }),
  expandAll: (ids) => set((s) => ({ open: new Set([...s.open, ...ids]) })),
}));

/** Open one row from outside React — what an "add" handler needs, since it has only an id. */
export function expandEngraveRow(id: string): void {
  useEngraveRowStore.getState().expand(id);
}

/** Test seam: every row folded, as at the start of a session. */
export function resetEngraveRows(): void {
  useEngraveRowStore.setState({ open: new Set<string>() });
}
