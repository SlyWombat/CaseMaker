import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useProjectStore,
  undoProject,
  redoProject,
  clearHistory,
} from '@/store/projectStore';
import { useSettingsStore } from '@/store/settingsStore';
import {
  downloadProjectJson,
  fileSystemAccessAvailable,
  openProjectViaPicker,
  readProjectFromFile,
  saveProjectViaPicker,
  type ProjectFileHandle,
} from '@/store/persistence';
import { DocsModal } from '@/components/docs/DocsModal';
import { SettingsMenu } from '@/components/layout/SettingsMenu';
import { PartsMenu } from '@/components/layout/PartsMenu';
import { ExportModal } from '@/components/panels/ExportModal';
import { useManageModeStore } from '@/store/manageModeStore';

const FORMAT_LABEL: Record<string, string> = {
  'stl-binary': 'STL (binary)',
  'stl-ascii': 'STL (ASCII)',
  '3mf': '3MF',
};

/** Tablet breakpoint — the widest window the full row does NOT fit cleanly in
 *  (#134). Measured: the row plus the wordmark needs ~848px before it even
 *  stops overflowing, and the buttons only stop wrapping their labels (52px
 *  tall instead of 71px) from 900px. Below it the toolbar collapses. */
const COMPACT_MAX_W = 900;

/**
 * Issue #134 — below this breakpoint the header toolbar collapses its
 * secondary controls behind a ⋯ overflow menu. The full row is ~890px of
 * content; at 390px that left Save / Save as / Load / Export / Parts / Docs /
 * settings off-screen behind a silent horizontal swipe, and at 641–900px the
 * header became a scroll container, which clipped the settings popover to the
 * 48px bar and hid the same controls just as silently. Phones (≤640px) also
 * drop the wordmark — see the .app-header__logo rule in index.css.
 *
 * This deliberately sits a little above the 848px the row needs to stop
 * overflowing: between 848 and 900 nothing is hidden, but every button label
 * wraps to two lines inside a 48px bar.
 */
function useIsCompactBar(): boolean {
  const [isCompact, setIsCompact] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= COMPACT_MAX_W : false,
  );
  useEffect(() => {
    function onResize(): void {
      setIsCompact(window.innerWidth <= COMPACT_MAX_W);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return isCompact;
}

export function Toolbar() {
  const project = useProjectStore((s) => s.project);
  const setProject = useProjectStore((s) => s.setProject);
  const showWelcome = useProjectStore((s) => s.showWelcome);
  // While the welcome overlay is up, the store still holds the LAST project
  // (or the createDefaultProject placeholder) — Save / Save as / Export
  // would silently operate on that stale state, which is what the user hits
  // when they click "Export" after returning to the welcome screen and see
  // the previous project's STL come down. Disable those entry points until
  // a board / template is picked. Load stays enabled — it's another valid
  // way out of welcome mode.
  const welcomeMode = useProjectStore((s) => s.welcomeMode);
  const exportFormat = useSettingsStore((s) => s.exportFormat);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Issue #134 — the ⋯ overflow menu, phone widths only.
  const overflowRef = useRef<HTMLDivElement | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const isCompactBar = useIsCompactBar();
  // Issue #70 — remember the last file handle so subsequent saves overwrite
  // in place. Reset whenever the user picks "Save as…" or loads a new file.
  const fileHandleRef = useRef<ProjectFileHandle>(null);
  const fsaAvailable = fileSystemAccessAvailable();
  // #311 — the house surface. Entered from here because the toolbar is the one chrome the app draws
  // in every mode, including with no project open — which is exactly when someone sets up cutters.
  const manageOpen = useManageModeStore((s) => s.open);
  const openManage = useManageModeStore((s) => s.openManage);
  const closeManage = useManageModeStore((s) => s.closeManage);

  // L-key shortcut for lid show/hide is now part of the view-mode picker
  // (#91 — Shift+1..4 cycles Complete / Exploded / Base / Lid). The
  // legacy single toggle is retired alongside the toolbar button.

  // Dismiss the ⋯ menu on an outside tap (same pattern as PartsMenu).
  useEffect(() => {
    if (!overflowOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (!overflowRef.current) return;
      if (!overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    };
    window.addEventListener('mousedown', onDoc);
    return () => window.removeEventListener('mousedown', onDoc);
  }, [overflowOpen]);

  const onSave = useCallback(async () => {
    if (!fsaAvailable) {
      downloadProjectJson(project);
      return;
    }
    try {
      const handle = await saveProjectViaPicker(project, fileHandleRef.current ?? undefined);
      fileHandleRef.current = handle;
      setError(null);
    } catch (err) {
      // AbortError from a cancelled picker is harmless; ignore it.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project, fsaAvailable]);

  const onSaveAs = useCallback(async () => {
    if (!fsaAvailable) {
      downloadProjectJson(project);
      return;
    }
    try {
      const handle = await saveProjectViaPicker(project); // no existing handle → picker
      fileHandleRef.current = handle;
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project, fsaAvailable]);

  const onLoadClick = useCallback(async () => {
    if (!fsaAvailable) {
      fileInput.current?.click();
      return;
    }
    try {
      const { project: loaded, handle } = await openProjectViaPicker();
      setProject(loaded);
      clearHistory();
      fileHandleRef.current = handle;
      setError(null);
      // #311 — a project was opened: the Manage surface is left, so what was just loaded is what is
      // drawn. Both entry points into a project do this (`onFileChange` is the other), because the
      // mode is about the house and the load is about the project.
      closeManage();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fsaAvailable, setProject, closeManage]);

  const onFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const loaded = await readProjectFromFile(f);
        setProject(loaded);
        clearHistory();
        // Fallback path: no handle, so subsequent Save behaves like Save As.
        fileHandleRef.current = null;
        setError(null);
        // #311 — same as the picker path: opening a project leaves the Manage surface.
        closeManage();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (fileInput.current) fileInput.current.value = '';
      }
    },
    [setProject, closeManage],
  );

  const onNew = useCallback(() => {
    if (!window.confirm('Start a new project? Unsaved changes will be lost.')) return;
    // #311 — New returns to the board picker, so the Manage surface has to come down first: left
    // open on top of the overlay it would hide the very thing New just asked for, and the button
    // would look like it did nothing.
    closeManage();
    showWelcome();
    clearHistory();
  }, [showWelcome, closeManage]);

  // Open the multi-part export modal — per-part Save buttons + thumbnails
  // + a Save All footer that lays everything flat for printing. The old
  // direct-trigger behavior bypassed that workflow.
  const onExport = useCallback(() => {
    setExportOpen(true);
  }, []);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // One node per control, rendered in exactly one place per layout. Desktop
  // keeps the original left-to-right order; below the breakpoint the primary
  // controls stay inline and the rest move into the ⋯ menu.
  const newBtn = (
    <button
      onClick={onNew}
      data-testid="new-project"
      title="Start a new project (returns to the board / template picker)"
    >
      ✨ New
    </button>
  );
  // #311 — the Manage toggle, and the reason it sits beside New: both leave the project behind and
  // go somewhere that is not the viewport. Gated on `__FEATURE_SIM__` with the rest of the CNC UI
  // (the web deployment switches the house off wholesale), and `aria-pressed` is how the toolbar
  // shows it is up — the app's toolbar buttons carry no class of their own, so the state has to hang
  // off an attribute that means exactly this (`.toolbar-buttons button[aria-pressed="true"]`).
  const manageBtn = __FEATURE_SIM__ ? (
    <button
      type="button"
      aria-pressed={manageOpen}
      data-testid="manage-open"
      title={
        manageOpen
          ? 'Leave the house — back to what you had open'
          : 'The house and its machines — your cutters, the Makera catalogue, and what the bench answered (#311)'
      }
      onClick={() => (manageOpen ? closeManage() : openManage())}
    >
      🧰 Manage
    </button>
  ) : null;
  const undoBtn = (
    <button onClick={undoProject} data-testid="undo-btn" title="Undo (Ctrl+Z)">
      ↶ Undo
    </button>
  );
  const redoBtn = (
    <button onClick={redoProject} data-testid="redo-btn" title="Redo (Ctrl+Shift+Z)">
      ↷ Redo
    </button>
  );
  const saveBtn = (
    <button
      onClick={onSave}
      data-testid="save-project"
      disabled={welcomeMode}
      title={
        welcomeMode
          ? 'Pick a board or template first'
          : fsaAvailable
            ? 'Save project (.caseproj.json) — overwrites the open file after first Save As'
            : 'Save project — downloads .caseproj.json to your Downloads folder'
      }
    >
      💾 Save
    </button>
  );
  const saveAsBtn = fsaAvailable ? (
    <button
      onClick={onSaveAs}
      data-testid="save-project-as"
      disabled={welcomeMode}
      title={
        welcomeMode
          ? 'Pick a board or template first'
          : 'Save the project to a new .caseproj.json file (pick filename + folder)'
      }
    >
      💾 Save as…
    </button>
  ) : null;
  const loadBtn = (
    <button
      onClick={onLoadClick}
      data-testid="load-project"
      title="Load a project from a .caseproj.json file"
    >
      📂 Load
    </button>
  );
  const exportBtn = (
    <button
      onClick={onExport}
      disabled={welcomeMode}
      data-testid="export-default"
      title={
        welcomeMode
          ? 'Pick a board or template first'
          : `Open the export modal — per-part thumbnails + Save All (current format: ${FORMAT_LABEL[exportFormat] ?? exportFormat}, change in ⚙)`
      }
    >
      ⬇ Export…
    </button>
  );
  const docsBtn = (
    <button
      onClick={() => setDocsOpen(true)}
      data-testid="docs-open"
      title="Open the User Manual"
    >
      📖 Docs
    </button>
  );
  const settingsMenu = settingsOpen ? <SettingsMenu onClose={closeSettings} /> : null;

  return (
    <div className="toolbar-buttons">
      {isCompactBar ? (
        <>
          {undoBtn}
          {redoBtn}
          {saveBtn}
          {/* Issue #120 — Parts keeps its own popover; it stays inline rather
              than nesting a popover inside the ⋯ menu. */}
          <PartsMenu compact />
          <div className="toolbar-overflow" ref={overflowRef}>
            <button
              type="button"
              className="toolbar-overflow__toggle"
              onClick={() => setOverflowOpen((v) => !v)}
              data-testid="toolbar-overflow-toggle"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              title="More actions — New, Manage, Save as, Load, Export, Docs, settings"
            >
              ⋯
            </button>
            {overflowOpen && (
              <div className="toolbar-overflow__panel" role="menu" data-testid="toolbar-overflow-panel">
                {newBtn}
                {manageBtn}
                {saveAsBtn}
                {loadBtn}
                {exportBtn}
                {docsBtn}
                <button
                  type="button"
                  onClick={() => {
                    setOverflowOpen(false);
                    setSettingsOpen(true);
                  }}
                  data-testid="settings-open"
                  aria-haspopup="dialog"
                  aria-expanded={settingsOpen}
                  title="App settings"
                >
                  ⚙ Settings
                </button>
              </div>
            )}
            {settingsMenu}
          </div>
        </>
      ) : (
        <>
          {newBtn}
          {manageBtn}
          {undoBtn}
          {redoBtn}
          {saveBtn}
          {saveAsBtn}
          {loadBtn}
          {exportBtn}
          {/* Issue #120 — Parts pulldown replaces the Show-board toggle. Lists
              every top-level node in the current BuildPlan (case, lid, gasket,
              fasteners, accessories) with per-part visibility checkboxes. The
              host-board visibility is no longer split out — it's a separate
              rendering layer that the view-mode picker covers via base-only
              mode. */}
          <PartsMenu />
          {docsBtn}
          <div className="toolbar-settings-wrap">
            <button
              onClick={() => setSettingsOpen((v) => !v)}
              data-testid="settings-open"
              title="App settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
            >
              ⚙
            </button>
            {settingsMenu}
          </div>
        </>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,.caseproj.json,application/json"
        onChange={onFileChange}
        data-testid="load-project-input"
      />
      {error && <span style={{ color: '#ff8888', fontSize: 12 }}>{error}</span>}
      {docsOpen && <DocsModal initialId="user-manual" onClose={() => setDocsOpen(false)} />}
      {exportOpen && <ExportModal onClose={() => setExportOpen(false)} />}
    </div>
  );
}
