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

const FORMAT_LABEL: Record<string, string> = {
  'stl-binary': 'STL (binary)',
  'stl-ascii': 'STL (ASCII)',
  '3mf': '3MF',
};

/** Phone breakpoint, matching the workspace's ≤640px block (#134). */
const COMPACT_MAX_W = 640;

/**
 * Issue #134 — below this breakpoint the header toolbar collapses its
 * secondary controls behind a ⋯ overflow menu. The full row is ~654px of
 * content; in a 390px window that left Save / Save as / Load / Export /
 * Parts / Docs / settings off-screen behind a silent horizontal swipe.
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
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [fsaAvailable, setProject]);

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
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (fileInput.current) fileInput.current.value = '';
      }
    },
    [setProject],
  );

  const onNew = useCallback(() => {
    if (!window.confirm('Start a new project? Unsaved changes will be lost.')) return;
    showWelcome();
    clearHistory();
  }, [showWelcome]);

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
              title="More actions — New, Save as, Load, Export, Docs, settings"
            >
              ⋯
            </button>
            {overflowOpen && (
              <div className="toolbar-overflow__panel" role="menu" data-testid="toolbar-overflow-panel">
                {newBtn}
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
