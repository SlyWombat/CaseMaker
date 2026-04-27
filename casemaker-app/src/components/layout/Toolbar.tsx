import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useProjectStore,
  undoProject,
  redoProject,
  clearHistory,
} from '@/store/projectStore';
import { useViewportStore } from '@/store/viewportStore';
import { downloadProjectJson, readProjectFromFile } from '@/store/persistence';
import { DocsModal } from '@/components/docs/DocsModal';

export function Toolbar() {
  const project = useProjectStore((s) => s.project);
  const setProject = useProjectStore((s) => s.setProject);
  const showLid = useViewportStore((s) => s.showLid);
  const toggleShowLid = useViewportStore((s) => s.toggleShowLid);
  const boardVisualization = useViewportStore((s) => s.boardVisualization);
  const cycleBoardVisualization = useViewportStore((s) => s.cycleBoardVisualization);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'l' && e.key !== 'L') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      toggleShowLid();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleShowLid]);

  const onSave = useCallback(() => {
    downloadProjectJson(project);
  }, [project]);

  const onLoadClick = useCallback(() => {
    fileInput.current?.click();
  }, []);

  const onFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      try {
        const loaded = await readProjectFromFile(f);
        setProject(loaded);
        clearHistory();
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (fileInput.current) fileInput.current.value = '';
      }
    },
    [setProject],
  );

  return (
    <div className="toolbar-buttons">
      <button onClick={undoProject} data-testid="undo-btn" title="Undo (Ctrl+Z)">
        ↶ Undo
      </button>
      <button onClick={redoProject} data-testid="redo-btn" title="Redo (Ctrl+Shift+Z)">
        ↷ Redo
      </button>
      <button onClick={onSave} data-testid="save-project">
        Save .caseproj.json
      </button>
      <button onClick={onLoadClick} data-testid="load-project">
        Load .caseproj.json
      </button>
      <input
        ref={fileInput}
        type="file"
        accept=".json,.caseproj.json,application/json"
        onChange={onFileChange}
        data-testid="load-project-input"
      />
      <button
        onClick={toggleShowLid}
        data-testid="toggle-lid-btn"
        title="Show/hide lid (L)"
        aria-pressed={showLid}
      >
        {showLid ? '👁 Lid' : '🚫 Lid'}
      </button>
      <button
        onClick={cycleBoardVisualization}
        data-testid="cycle-board-visualization-btn"
        title="Board visualization: schematic / photo / 3D"
      >
        Board: {boardVisualization}
      </button>
      <button onClick={() => setDocsOpen(true)} data-testid="docs-open">
        📖 Docs
      </button>
      {error && <span style={{ color: '#ff8888', fontSize: 12 }}>{error}</span>}
      {docsOpen && <DocsModal onClose={() => setDocsOpen(false)} />}
    </div>
  );
}
