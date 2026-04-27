import { useCallback, useRef, useState } from 'react';
import {
  useProjectStore,
  undoProject,
  redoProject,
  clearHistory,
} from '@/store/projectStore';
import { downloadProjectJson, readProjectFromFile } from '@/store/persistence';
import { DocsModal } from '@/components/docs/DocsModal';

export function Toolbar() {
  const project = useProjectStore((s) => s.project);
  const setProject = useProjectStore((s) => s.setProject);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);

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
      <button onClick={() => setDocsOpen(true)} data-testid="docs-open">
        📖 Docs
      </button>
      {error && <span style={{ color: '#ff8888', fontSize: 12 }}>{error}</span>}
      {docsOpen && <DocsModal onClose={() => setDocsOpen(false)} />}
    </div>
  );
}
