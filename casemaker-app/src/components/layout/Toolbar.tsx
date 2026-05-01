import { useCallback, useRef, useState } from 'react';
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
import { triggerExport } from '@/engine/exportTrigger';
import { DocsModal } from '@/components/docs/DocsModal';
import { SettingsMenu } from '@/components/layout/SettingsMenu';
import { PartsMenu } from '@/components/layout/PartsMenu';

const FORMAT_LABEL: Record<string, string> = {
  'stl-binary': 'STL (binary)',
  'stl-ascii': 'STL (ASCII)',
  '3mf': '3MF',
};

export function Toolbar() {
  const project = useProjectStore((s) => s.project);
  const setProject = useProjectStore((s) => s.setProject);
  const showWelcome = useProjectStore((s) => s.showWelcome);
  const exportFormat = useSettingsStore((s) => s.exportFormat);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Issue #70 — remember the last file handle so subsequent saves overwrite
  // in place. Reset whenever the user picks "Save as…" or loads a new file.
  const fileHandleRef = useRef<ProjectFileHandle>(null);
  const fsaAvailable = fileSystemAccessAvailable();

  // L-key shortcut for lid show/hide is now part of the view-mode picker
  // (#91 — Shift+1..4 cycles Complete / Exploded / Base / Lid). The
  // legacy single toggle is retired alongside the toolbar button.

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

  const onExport = useCallback(async () => {
    setExporting(true);
    try {
      await triggerExport(useSettingsStore.getState().exportFormat);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, []);

  return (
    <div className="toolbar-buttons">
      <button
        onClick={onNew}
        data-testid="new-project"
        title="Start a new project (returns to the board / template picker)"
      >
        ✨ New
      </button>
      <button onClick={undoProject} data-testid="undo-btn" title="Undo (Ctrl+Z)">
        ↶ Undo
      </button>
      <button onClick={redoProject} data-testid="redo-btn" title="Redo (Ctrl+Shift+Z)">
        ↷ Redo
      </button>
      <button
        onClick={onSave}
        data-testid="save-project"
        title={
          fsaAvailable
            ? 'Save project (.caseproj.json) — overwrites the open file after first Save As'
            : 'Save project — downloads .caseproj.json to your Downloads folder'
        }
      >
        💾 Save
      </button>
      {fsaAvailable && (
        <button
          onClick={onSaveAs}
          data-testid="save-project-as"
          title="Save the project to a new .caseproj.json file (pick filename + folder)"
        >
          💾 Save as…
        </button>
      )}
      <button
        onClick={onLoadClick}
        data-testid="load-project"
        title="Load a project from a .caseproj.json file"
      >
        📂 Load
      </button>
      <button
        onClick={onExport}
        disabled={exporting}
        data-testid="export-default"
        title={`Export current case as ${FORMAT_LABEL[exportFormat] ?? exportFormat} (change format in ⚙)`}
      >
        {exporting ? '⏳ Exporting…' : '⬇ Export'}
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".json,.caseproj.json,application/json"
        onChange={onFileChange}
        data-testid="load-project-input"
      />
      {/* Issue #120 — Parts pulldown replaces the Show-board toggle. Lists
          every top-level node in the current BuildPlan (case, lid, gasket,
          fasteners, accessories) with per-part visibility checkboxes. The
          host-board visibility is no longer split out — it's a separate
          rendering layer that the view-mode picker covers via base-only
          mode. */}
      <PartsMenu />
      <button
        onClick={() => setDocsOpen(true)}
        data-testid="docs-open"
        title="Open the User Manual"
      >
        📖 Docs
      </button>
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
        {settingsOpen && <SettingsMenu onClose={() => setSettingsOpen(false)} />}
      </div>
      {error && <span style={{ color: '#ff8888', fontSize: 12 }}>{error}</span>}
      {docsOpen && <DocsModal initialId="user-manual" onClose={() => setDocsOpen(false)} />}
    </div>
  );
}
