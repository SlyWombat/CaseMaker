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
  | { kind: 'snap-catch'; catchId: string }      // Phase 4c (#95)
  | { kind: 'mounting-feature'; featureId: string } // Phase 4d (#96)
  | { kind: 'component'; componentId: string }   // Phase 4e (#97)
  // #441 — an item of the engrave preview. This is the ONE kind that belongs to a sidebar
  // section: it is set by clicking geometry in the engrave panel's own preview, so the click
  // must not take the right rail away from the panel whose row it opened.
  | { kind: 'engrave-item'; itemId: string }
  | null;

/** Sidebar section ID — set when the user clicks a section header in
 *  the left rail. Drives the right-rail content via ContextPanel.
 *  Mutually exclusive with the geometry `selection` above (setting one
 *  clears the other) so the right rail only ever shows ONE thing. */
export type SidebarSectionId =
  | 'board'
  | 'case'
  | 'rack'
  // #158 — the tool-insert holder archetype's editor.
  | 'insert'
  // #155 — the stacking-toolbox archetype's editor.
  | 'toolbox'
  // #282 — the board-less part archetypes' editor (a name badge or a bare blank). In the rail
  // only for those two, because `case.badge`/`case.blank` are the whole part.
  | 'part'
  | 'ports'
  | 'hats'
  | 'features'
  | 'assets'
  | 'export'
  // #196 — the CNC Simulate .nc panel (only present when `featureSim`, #343).
  | 'cnc-sim'
  // #205 — the CNC Engrave text panel (only present when `featureSim`, #343).
  | 'cnc-engrave';

// Issue #91 — 4-way view-mode picker that drives lid lift + per-mesh
// rendering:
//   complete  : lid sits assembled (no exploded gap; recessed lid drops in)
//   exploded  : lid lifted by max(deepest_lid_protrusion + 2 mm, 6) so no
//               two pieces overlap
//   base-only : only the case shell renders
//   lid-only  : only the lid renders
// Default 'exploded' so first-load behavior matches the pre-#91 lift hack.
export type ViewportViewMode = 'complete' | 'exploded' | 'base-only' | 'lid-only';

// Issue #163 — how the shell + lid are shaded.
//   xray  : translucent, interior features (board standoffs, ribs) visible
//   solid : opaque, the case as it will actually look and print
// Default 'xray'. #162 shipped a board resting on nothing partly because the
// viewport could not show the interior at all — the default has to be the
// one that reveals geometry, not the one that flatters it. 'solid' was
// previously unreachable: opacity was hardcoded at 0.55 / 0.6.
export type ShellRenderMode = 'xray' | 'solid';

interface PersistedViewportFlags {
  showLid?: boolean;
  showBoard?: boolean;
  showGrid?: boolean;
  activeTool?: ViewportTool;
  cameraMode?: ViewportCameraMode;
  viewMode?: ViewportViewMode;
  shellRender?: ShellRenderMode;
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
  if (flags.shellRender !== undefined) out.shellRender = flags.shellRender;
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
  /** Sidebar section currently expanded into the right rail (left-nav
   *  click moves the section's editor to the ContextPanel). Mutually
   *  exclusive with `selection`. */
  activeSidebarSection: SidebarSectionId | null;
  /** Issue #91 — 4-way view-mode picker. */
  viewMode: ViewportViewMode;
  shellRender: ShellRenderMode;
  /** Issue #120 — per-part visibility. Set entries are HIDDEN; absence =
   *  visible. Keyed by BuildPlan node id (shell, lid, gasket, hinge-pin,
   *  latch-arm-*, bumper-*). Session-only — not persisted; reverts to all-
   *  visible on reload, so a hidden part doesn't silently stay hidden when
   *  the user opens a different project. */
  hiddenParts: ReadonlySet<string>;
  setShowLid: (v: boolean) => void;
  setShowBoard: (v: boolean) => void;
  setShowGrid: (v: boolean) => void;
  toggleShowLid: () => void;
  selectPort: (id: string | null) => void;
  setActiveTool: (t: ViewportTool) => void;
  setCameraMode: (m: ViewportCameraMode) => void;
  setSelection: (s: ViewportSelection) => void;
  setActiveSidebarSection: (s: SidebarSectionId | null) => void;
  setViewMode: (m: ViewportViewMode) => void;
  setShellRender: (m: ShellRenderMode) => void;
  /** Issue #120 — toggle a part's visibility by node id. */
  togglePartVisible: (partId: string) => void;
  /** Issue #120 — set all parts visible (clear the hidden set). */
  showAllParts: () => void;
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
  shellRender: persisted.shellRender ?? 'xray',
  // Issue #83 — selection is session-scoped. Intentionally NOT loaded from
  // (or written to) localStorage so opening a project never resurrects a
  // stale selection that points at a HAT placement that may no longer
  // exist.
  selection: null,
  activeSidebarSection: null,
  hiddenParts: new Set<string>(),
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
  // #441 — every selection except an engrave item clears the active section, because the right
  // rail only ever shows ONE thing. An engrave item is the exception and not an oversight: it is
  // selected FROM the engrave section's preview, so clearing the section would unmount the panel
  // (and the preview) the click came from before its row could be seen open.
  setSelection: (s) =>
    set({
      selection: s,
      activeSidebarSection:
        s && s.kind !== 'engrave-item' ? null : get().activeSidebarSection,
    }),
  setActiveSidebarSection: (s) =>
    set((state) => {
      // Opening a section still clears the geometry selection. CLOSING one normally leaves the
      // selection alone, with one exception (#441): an engrave item means nothing once the
      // engrave preview that gave it is gone, so it is dropped rather than left pointing into a
      // row list nobody can see.
      const selection =
        s !== null || state.selection?.kind === 'engrave-item' ? null : state.selection;
      return { activeSidebarSection: s, selection };
    }),
  setShellRender: (m) => {
    set({ shellRender: m });
    savePersisted({ ...get(), shellRender: m });
  },
  setViewMode: (m) => {
    // Issue #91 — keep showLid in sync with the view mode for legacy
    // consumers that still gate on showLid (export layouts etc.). The
    // 4-way picker is the source of truth; showLid mirrors it.
    set({ viewMode: m, showLid: m !== 'base-only' });
    savePersisted({ ...get(), viewMode: m, showLid: m !== 'base-only' });
  },
  togglePartVisible: (partId) => {
    const cur = get().hiddenParts;
    const next = new Set(cur);
    if (next.has(partId)) next.delete(partId);
    else next.add(partId);
    set({ hiddenParts: next });
  },
  showAllParts: () => set({ hiddenParts: new Set<string>() }),
}));

/**
 * #441 — select one engrave item, from EITHER side of the preview/list pair.
 *
 * The preview's floor meshes and the panel's name controls both write this one selection, so
 * "which item is selected" cannot disagree between the two: there is no second, local notion of
 * selectedness to keep in step. Apart from the store so the row shell does not have to write the
 * kind literal itself, and so `activateEngraveItem` and the row use the same call.
 */
export function selectEngraveItem(itemId: string): void {
  useViewportStore.getState().setSelection({ kind: 'engrave-item', itemId });
}

/**
 * Whether the current selection is this item (#441). A pure predicate so a row can produce it
 * from a selector and a preview floor can decide its highlight without either owning the shape
 * of `ViewportSelection` or rebuilding a `{ kind, itemId }` object on every render.
 */
export function isEngraveItemSelected(selection: ViewportSelection, itemId: string): boolean {
  return selection?.kind === 'engrave-item' && selection.itemId === itemId;
}
