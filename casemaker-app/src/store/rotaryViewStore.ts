/**
 * #716 — HOW A ROTARY JOB IS BEING LOOKED AT (design `rotary-flow.md` §3.7, R-UI-5).
 *
 * `map` is the design's default: the stock's surface unrolled, where items are placed, dimensioned
 * and read in millimetres along and around (R10). `stock` wraps the SAME opened regions onto the
 * cylinder with the A-zero mark, so a stroke that merges on one merges on the other (R11).
 *
 * A view, not a document value: nothing here reaches the job, the CAM, the verifier or the run.
 * Session-only and deliberately NOT persisted — reopening a job starts on the map, the frame the
 * operator authors in.
 */
import { create } from 'zustand';

export type RotaryDesignView = 'map' | 'stock';

interface RotaryViewState {
  design: RotaryDesignView;
  setDesign: (view: RotaryDesignView) => void;
  reset: () => void;
}

export const useRotaryViewStore = create<RotaryViewState>((set) => ({
  design: 'map',
  setDesign: (design) => set({ design }),
  reset: () => set({ design: 'map' }),
}));
