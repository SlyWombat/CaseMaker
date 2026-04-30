import { useProjectStore } from '@/store/projectStore';

/**
 * Issue #103 — board reference metadata (cross-reference URL + datasheet
 * revision) lives at the bottom of the left sidebar in muted footer style.
 * Read-only for built-in boards (clickable link + text); editable for
 * custom boards (compact inputs with the same footer styling).
 */
export function SidebarFooter() {
  const board = useProjectStore((s) => s.project.board);
  const patchMeta = useProjectStore((s) => s.patchBoardMeta);
  const url = board.crossReference ?? '';
  const rev = board.datasheetRevision ?? '';

  if (board.builtin) {
    if (!url && !rev) return null;
    return (
      <footer className="sidebar-footer">
        {url && (
          <a
            className="sidebar-footer__link"
            href={url}
            target="_blank"
            rel="noopener"
            title={url}
            data-testid="sidebar-footer-crossref"
          >
            {prettyUrl(url)}
          </a>
        )}
        {rev && (
          <span className="sidebar-footer__rev" data-testid="sidebar-footer-revision">
            {rev}
          </span>
        )}
      </footer>
    );
  }

  return (
    <footer className="sidebar-footer">
      <input
        type="text"
        className="sidebar-footer__input"
        value={url}
        onChange={(e) => patchMeta({ crossReference: e.target.value })}
        placeholder="datasheet URL"
        data-testid="meta-crossref"
        aria-label="Cross-reference URL"
      />
      <input
        type="text"
        className="sidebar-footer__input"
        value={rev}
        onChange={(e) => patchMeta({ datasheetRevision: e.target.value })}
        placeholder="Rev — date"
        data-testid="meta-revision"
        aria-label="Datasheet revision"
      />
    </footer>
  );
}

function prettyUrl(s: string): string {
  try {
    const u = new URL(s);
    return u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    return s;
  }
}
