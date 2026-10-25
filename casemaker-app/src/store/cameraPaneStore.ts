/**
 * #530 — whether the Camera pane is showing.
 *
 * One flag and no frame state: the pane owns its own socket and picture, and closing it releases
 * both. It lives in a store rather than in a component because the two places that open it — the
 * Cut step and the status strip's popover — sit in different trees from the pane itself, which is
 * mounted once by the shell.
 */

import { create } from 'zustand';

interface CameraPaneState {
  open: boolean;
  openPane: () => void;
  close: () => void;
}

export const useCameraPaneStore = create<CameraPaneState>()((set) => ({
  open: false,
  openPane: () => set({ open: true }),
  close: () => set({ open: false }),
}));

/** Test helper: back to closed, so one spec's pane cannot leak into the next. */
export function resetCameraPaneStore(): void {
  useCameraPaneStore.setState({ open: false });
}
