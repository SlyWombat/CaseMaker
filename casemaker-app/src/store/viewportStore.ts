import { create } from 'zustand';

export interface ViewportState {
  showLid: boolean;
  showBoard: boolean;
  showGrid: boolean;
  setShowLid: (v: boolean) => void;
  setShowBoard: (v: boolean) => void;
  setShowGrid: (v: boolean) => void;
}

export const useViewportStore = create<ViewportState>()((set) => ({
  showLid: true,
  showBoard: true,
  showGrid: true,
  setShowLid: (v) => set({ showLid: v }),
  setShowBoard: (v) => set({ showBoard: v }),
  setShowGrid: (v) => set({ showGrid: v }),
}));
