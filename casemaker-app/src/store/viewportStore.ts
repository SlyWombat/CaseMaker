import { create } from 'zustand';

const LS_KEY = 'casemaker.viewport';

// Issue #59 — board visualization cycle (schematic / photo / 3d) was a
// no-op: no built-in board carries a `visualAssets.glb` or `topImage`, so
// every project rendered as the schematic placeholder regardless of mode.
// The cycle button + fallback banner are removed; board visibility is now
// just a single `showBoard` boolean. Re-introduce the cycle when GLB
// assets actually exist (issue #39 phase 2).

// Issue #86 — toolbar overlay state. ActiveTool drives the click-handler
// for the viewport (Select gates #83's hit-testing); CameraMode snaps
// OrbitControls to canonical views.
export type ViewportTool = 'select' | 'pan' | 'orbit';
export type ViewportCameraMode = 'perspective' | 'top' | 'front' | 'side';

// Issue #83 — host PCB / HAT in-viewport selection. Session-scoped (NOT
// persisted) — fresh page load = no selection. The selection drives the
// ContextPanel content (right rail) and the keyboard nudge handler.
//
// Issue #94 (Phase 4b) — extended with `port` so PortEditorRow's old
// inline expand block can route through the same selection plumbing.
// Clicking a port row in the left rail OR a port marker in the 3D
// viewport sets `{ kind: 'port', portId }` and the right rail renders
// the position / size / margin / shape detail form.
export type ViewportSelection =
  | { kind: 'host' }
  | { kind: 'hat'; hatPlacementId: string }
  | { kind: 'port'; portId: string }
  | null;

// Issue #91 — 4-way view-mode picker that drives lid lift + per-mesh
// rendering:
//   complete  : lid sits assembled (no exploded gap; recessed lid drops in)
//   exploded  : lid lifted by max(deepest_lid_protrusion + 2 mm, 6) so no
//               two pieces overlap
//   base-only : only the case shell renders
//   lid-only  : only the lid renders
// Default 'exploded' so first-load behavior matches the pre-#91 lift hack.
export type ViewportViewMode = 'complete' | 'exploded' | 'base-only' | 'lid-only';

interface PersistedViewportFlags {
  showLid?: boolean;
  showBoard?: boolean;
  showGrid?: boolean;
  activeTool?: ViewportTool;
  cameraMode?: ViewportCameraMode;
  viewMode?: ViewportViewMode;
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
  // Issue #83 — explicit whitelist so callers passing `{ ...get(), ... }`
  // can't leak runtime-only fields (e.g. session-scoped `selection`) into
  // localStorage. Only the documented PersistedViewportFlags keys land on
  // disk.
  const out: PersistedViewportFlags = {};
  if (flags.showLid !== undefined) out.showLid = flags.showLid;
  if (flags.showBoard !== undefined) out.showBoard = flags.showBoard;
  if (flags.showGrid !== undefined) out.showGrid = flags.showGrid;
  if (flags.activeTool !== undefined) out.activeTool = flags.activeTool;
  if (flags.cameraMode !== undefined) out.cameraMode = flags.cameraMode;
  if (flags.viewMode !== undefined) out.viewMode = flags.viewMode;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(out));
  } catch {
    /* quota or private mode — fall back silently */
  }
}

export interface ViewportState {
  showLid: boolean;
  showBoard: boolean;
  showGrid: boolean;
  selectedPortId: string | null;
  activeTool: ViewportTool;
  cameraMode: ViewportCameraMode;
  /** Issue #83 — host PCB / HAT in-viewport selection. */
  selection: ViewportSelection;
  /** Issue #91 — 4-way view-mode picker. */
  viewMode: ViewportViewMode;
  setShowLid: (v: boolean) => void;
  setShowBoard: (v: boolean) => void;
  setShowGrid: (v: boolean) => void;
  toggleShowLid: () => void;
  selectPort: (id: string | null) => void;
  setActiveTool: (t: ViewportTool) => void;
  setCameraMode: (m: ViewportCameraMode) => void;
  setSelection: (s: ViewportSelection) => void;
  setViewMode: (m: ViewportViewMode) => void;
}

const persisted = loadPersisted();

export const useViewportStore = create<ViewportState>()((set, get) => ({
  showLid: persisted.showLid ?? true,
  showBoard: persisted.showBoard ?? true,
  showGrid: persisted.showGrid ?? true,
  selectedPortId: null,
  activeTool: persisted.activeTool ?? 'orbit',
  cameraMode: persisted.cameraMode ?? 'perspective',
  viewMode: persisted.viewMode ?? 'exploded',
  // Issue #83 — selection is session-scoped. Intentionally NOT loaded from
  // (or written to) localStorage so opening a project never resurrects a
  // stale selection that points at a HAT placement that may no longer
  // exist.
  selection: null,
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
  selectPort: (id) => set({ selectedPortId: id }),
  setActiveTool: (t) => {
    set({ activeTool: t });
    savePersisted({ ...get(), activeTool: t });
  },
  setCameraMode: (m) => {
    set({ cameraMode: m });
    savePersisted({ ...get(), cameraMode: m });
  },
  setSelection: (s) => set({ selection: s }),
  setViewMode: (m) => {
    // Issue #91 — keep showLid in sync with the view mode for legacy
    // consumers that still gate on showLid (export layouts etc.). The
    // 4-way picker is the source of truth; showLid mirrors it.
    set({ viewMode: m, showLid: m !== 'base-only' });
    savePersisted({ ...get(), viewMode: m, showLid: m !== 'base-only' });
  },
}));
