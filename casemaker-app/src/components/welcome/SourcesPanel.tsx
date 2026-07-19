import { useState } from 'react';
import { useLibraryStore } from '@/store/libraryStore';
import { builtinBoards } from '@/library';
import { shadowedIdsForSource } from '@/library/registry';

/** Official community index (github.com/SlyWombat/casemaker-library). */
const COMMUNITY_SOURCE_URL = 'https://slywombat.github.io/casemaker-library/index.json';

/**
 * Board-source manager, shown inline under the welcome header. Lists the
 * fixed sources (built-in bundle, local library) and every user-added
 * online source with enable/refresh/remove controls, plus the add-URL form.
 *
 * An online source is any URL returning board-profile JSON — a bare array
 * or `{ name, boards: [...] }` — e.g. a raw GitHub file or a published
 * community index. Results are cached locally so the picker works offline.
 */
export function SourcesPanel() {
  const localBoards = useLibraryStore((s) => s.localBoards);
  const remoteSources = useLibraryStore((s) => s.remoteSources);
  const refreshing = useLibraryStore((s) => s.refreshing);
  const addRemoteSource = useLibraryStore((s) => s.addRemoteSource);
  const refreshRemoteSource = useLibraryStore((s) => s.refreshRemoteSource);
  const removeRemoteSource = useLibraryStore((s) => s.removeRemoteSource);
  const setRemoteSourceEnabled = useLibraryStore((s) => s.setRemoteSourceEnabled);

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onAdd = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setError(null);
    const result = await addRemoteSource(url);
    setBusy(false);
    if (result.ok) setUrl('');
    else setError(result.error ?? 'Could not add source.');
  };

  return (
    <div className="wb-sources" data-testid="welcome-sources-panel">
      <ul className="wb-sources__list">
        <li className="wb-source">
          <span className="wb-source__label">Built-in</span>
          <span className="wb-source__meta">
            {builtinBoards.length} boards · bundled with the app
          </span>
        </li>
        <li className="wb-source">
          <span className="wb-source__label">My library</span>
          <span className="wb-source__meta">
            {localBoards.length} boards · imported JSON, stored in this browser
          </span>
        </li>
        {remoteSources.map((s) => (
          <li className="wb-source" key={s.id} data-testid={`welcome-source-${s.id}`}>
            <label className="wb-source__label" title={s.url}>
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => setRemoteSourceEnabled(s.id, e.target.checked)}
              />
              ⛁ {s.label}
            </label>
            <span className="wb-source__meta">
              {s.boards.length} boards
              {s.templates.length > 0 && ` + ${s.templates.length} templates`}
              {typeof s.invalidCount === 'number' && s.invalidCount > 0 && ` (${s.invalidCount} invalid skipped)`}
              {(() => {
                const shadowed = shadowedIdsForSource(s.id);
                return shadowed.length > 0 ? (
                  <span title={`Hidden because a higher-priority source already provides: ${shadowed.join(', ')}`}>
                    {' '}· {shadowed.length} shadowed
                  </span>
                ) : null;
              })()}
              {s.fetchedAt && ` · fetched ${new Date(s.fetchedAt).toLocaleDateString()}`}
              {s.error && <span className="wb-source__err"> · refresh failed: {s.error}</span>}
            </span>
            <span className="wb-source__actions">
              <button
                className="wb-btn wb-btn--ghost"
                onClick={() => void refreshRemoteSource(s.id)}
                disabled={refreshing.includes(s.id)}
                title="Re-fetch this source's board index"
              >
                {refreshing.includes(s.id) ? '…' : '↻ Refresh'}
              </button>
              <button
                className="wb-btn wb-btn--ghost wb-btn--danger"
                onClick={() => removeRemoteSource(s.id)}
                title="Remove this source and its cached boards"
              >
                Remove
              </button>
            </span>
          </li>
        ))}
      </ul>

      {!remoteSources.some((s) => s.url === COMMUNITY_SOURCE_URL) && (
        <div className="wb-sources__suggest">
          <span>
            <strong>Case Maker Community</strong> — the official community board index
          </span>
          <button
            className="wb-btn"
            disabled={busy}
            data-testid="welcome-source-add-community"
            onClick={async () => {
              setBusy(true);
              setError(null);
              const result = await addRemoteSource(COMMUNITY_SOURCE_URL);
              setBusy(false);
              if (!result.ok) setError(result.error ?? 'Could not add source.');
            }}
          >
            {busy ? 'Fetching…' : '+ Add community library'}
          </button>
        </div>
      )}

      <div className="wb-sources__add">
        <input
          type="url"
          placeholder="https://… board index URL (JSON array or {boards: […]})"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void onAdd();
          }}
          data-testid="welcome-source-url"
          aria-label="Online board source URL"
        />
        <button
          className="wb-btn"
          onClick={() => void onAdd()}
          disabled={busy || !url.trim()}
          data-testid="welcome-source-add"
        >
          {busy ? 'Fetching…' : '+ Add source'}
        </button>
      </div>
      {error && (
        <div className="wb-sources__error" data-testid="welcome-source-error">
          {error}
        </div>
      )}
    </div>
  );
}
