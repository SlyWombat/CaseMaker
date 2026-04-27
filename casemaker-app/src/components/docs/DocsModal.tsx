import { useMemo, useState, useEffect } from 'react';
import { marked } from 'marked';
import { DOCS, findDoc, type DocEntry } from '@/docs';

marked.setOptions({ gfm: true, breaks: false });

interface Props {
  initialId?: string;
  onClose: () => void;
}

export function DocsModal({ initialId, onClose }: Props) {
  const fallback = DOCS[0]!;
  const [activeId, setActiveId] = useState<string>(initialId ?? fallback.id);
  const active: DocEntry = findDoc(activeId) ?? fallback;
  const html = useMemo(() => marked.parse(active.source) as string, [active]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="docs-modal-backdrop" onClick={onClose} data-testid="docs-modal">
      <div className="docs-modal" onClick={(e) => e.stopPropagation()}>
        <header className="docs-modal-header">
          <h2>Case Maker Docs</h2>
          <button onClick={onClose} data-testid="docs-close" aria-label="Close docs">
            ✕
          </button>
        </header>
        <div className="docs-modal-body">
          <nav className="docs-modal-nav" aria-label="Docs navigation">
            {DOCS.map((d) => (
              <button
                key={d.id}
                onClick={() => setActiveId(d.id)}
                data-testid={`docs-nav-${d.id}`}
                className={d.id === activeId ? 'active' : ''}
              >
                {d.title}
              </button>
            ))}
          </nav>
          <article
            className="docs-modal-content markdown-body"
            data-testid={`docs-content-${activeId}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </div>
  );
}
