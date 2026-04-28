import { create } from 'zustand';

const LS_KEY = 'casemaker.viewport';

export type BoardVisualizationMode = 'none' | 'schematic' | 'photo' | '3d';

interface PersistedViewportFlags {
  showLid?: boolean;
  showBoard?: boolean;
  showGrid?: boolean;
  boardVisualization?: BoardVisualizationMode;
}

function loadPersisted(): PersistedViewportFlags {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PersistedViewportFlags;
    return parsed;
  } catch {
    return {};
  }
}

function savePersisted(flags: PersistedViewportFlags): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(flags));
  } catch {
    /* quota or private mode — fall back silently */
  }
}

export interface ViewportState {
  showLid: boolean;
  showBoard: boolean;
  showGrid: boolean;
  boardVisualization: BoardVisualizationMode;
  selectedPortId: string | null;
  setShowLid: (v: boolean) => void;
  setShowBoard: (v: boolean) => void;
  setShowGrid: (v: boolean) => void;
  toggleShowLid: () => void;
  setBoardVisualization: (mode: BoardVisualizationMode) => void;
  cycleBoardVisualization: () => void;
  selectPort: (id: string | null) => void;
}

const persisted = loadPersisted();

const VISUALIZATION_CYCLE: BoardVisualizationMode[] = ['schematic', 'photo', '3d', 'none'];

export const useViewportStore = create<ViewportState>()((set, get) => ({
  showLid: persisted.showLid ?? true,
  showBoard: persisted.showBoard ?? true,
  showGrid: persisted.showGrid ?? true,
  boardVisualization: persisted.boardVisualization ?? 'schematic',
  selectedPortId: null,
  setShowLid: (v) => {
    set({ showLid: v });
    savePersisted({ ...get(), showLid: v });
  },
  setShowBoard: (v) => {
    set({ showBoard: v });
    savePersisted({ ...get(), showBoard: v });
  },
  setShowGrid: (v) => {
    set({ showGrid: v });
    savePersisted({ ...get(), showGrid: v });
  },
  toggleShowLid: () => {
    const next = !get().showLid;
    set({ showLid: next });
    savePersisted({ ...get(), showLid: next });
  },
  setBoardVisualization: (mode) => {
    set({ boardVisualization: mode });
    savePersisted({ ...get(), boardVisualization: mode });
  },
  cycleBoardVisualization: () => {
    const cur = get().boardVisualization;
    const idx = VISUALIZATION_CYCLE.indexOf(cur);
    const next = VISUALIZATION_CYCLE[(idx + 1) % VISUALIZATION_CYCLE.length]!;
    set({ boardVisualization: next });
    savePersisted({ ...get(), boardVisualization: next });
  },
  selectPort: (id) => set({ selectedPortId: id }),
}));
