import { useState } from 'react';
import { useLibraryStore, type RemoteSource } from '@/store/libraryStore';
import { builtinBoards } from '@/library';
import { shadowedIdsForSource, diffBoardVersions, type BoardVersionChange } from '@/library/registry';

/** Official community index (github.com/SlyWombat/casemaker-library). */
const COMMUNITY_SOURCE_URL = 'https://slywombat.github.io/casemaker-library/index.json';

/** Same per-index size cap the store enforces on a full fetch (#132). */
const MAX_INDEX_BYTES = 5 * 1024 * 1024;

/** Tooltip behind a source's "N invalid skipped" (#132): which entries failed
 * and why. Falls back to the bare count for caches written before the detail
 * existed, or when a hostile index pushed failures past the stored cap. */
function invalidDetail(s: RemoteSource): string {
  const count = s.invalidCount ?? 0;
  const shown = s.invalidBoards ?? [];
  if (shown.length === 0) {
    return `${count} ${count === 1 ? 'entry' : 'entries'} failed board validation`;
  }
  const lines = shown.map((i) => `#${i.index + 1}${i.id ? ` (${i.id})` : ''}: ${i.reason}`);
  const more = count - shown.length;
  if (more > 0) lines.push(`…and ${more} more`);
  return lines.join('\n');
}

/** #128 — read just the `{id, version}` pairs an index advertises. Deliberately
 * lenient: the update check only needs the version contract, so an entry the
 * board schema would reject is simply skipped here (the store's full fetch
 * still validates it). The size cap mirrors the store's so a hostile URL can't
 * make the check read a huge body. */
async function fetchBoardVersions(
  url: string,
): Promise<Array<{ id: string; version?: string | number }>> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_INDEX_BYTES) throw new Error('index too large');
  const doc: unknown = JSON.parse(text);
  const boards =
    Array.isArray(doc)
      ? doc
      : doc && typeof doc === 'object' && Array.isArray((doc as { boards?: unknown }).boards)
        ? (doc as { boards: unknown[] }).boards
        : null;
  if (!boards) throw new Error('not a board index');
  const out: Array<{ id: string; version?: string | number }> = [];
  for (const entry of boards) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, version } = entry as { id?: unknown; version?: unknown };
    if (typeof id !== 'string' || id.length === 0) continue;
    const v = typeof version === 'string' || typeof version === 'number' ? version : undefined;
    out.push(v === undefined ? { id } : { id, version: v });
  }
  return out;
}

/** One line per changed board, for the badge's title tooltip. */
function changeDetail(changes: BoardVersionChange[]): string {
  return changes
    .map((c) => {
      if (c.kind === 'new') return `${c.id}: new upstream`;
      if (c.kind === 'removed') return `${c.id}: removed upstream`;
      return `${c.id}: ${c.from ?? '(unversioned)'} → ${c.to ?? '(unversioned)'}`;
    })
    .join('\n');
}

/** Outcome of one source's update check. */
interface UpdateCheck {
  ok: boolean;
  changes?: BoardVersionChange[];
  error?: string;
}

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
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, UpdateCheck>>({});

  /** #128 — fetch the index and diff its per-board versions against the cache,
   * so the panel can offer a refresh instead of replacing silently. The check
   * is read-only; "↻ Refresh" applies it. */
  const onCheck = async (s: RemoteSource) => {
    if (checkingId) return;
    setCheckingId(s.id);
    try {
      const incoming = await fetchBoardVersions(s.url);
      setChecks((c) => ({
        ...c,
        [s.id]: { ok: true, changes: diffBoardVersions(s.boards, incoming) },
      }));
    } catch (err) {
      setChecks((c) => ({
        ...c,
        [s.id]: { ok: false, error: err instanceof Error ? err.message : String(err) },
      }));
    } finally {
      setCheckingId(null);
    }
  };

  /** A refresh (or a fresh check) invalidates the previous result. */
  const clearCheck = (id: string) =>
    setChecks((c) => {
      if (!(id in c)) return c;
      const next = { ...c };
      delete next[id];
      return next;
    });

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
              {typeof s.invalidCount === 'number' && s.invalidCount > 0 && (
                <span
                  data-testid={`welcome-source-invalid-${s.id}`}
                  title={invalidDetail(s)}
                >
                  {' '}· {s.invalidCount} invalid skipped
                </span>
              )}
              {(() => {
                const shadowed = shadowedIdsForSource(s.id);
                return shadowed.length > 0 ? (
                  <span title={`Hidden because a higher-priority source already provides: ${shadowed.join(', ')}`}>
                    {' '}· {shadowed.length} shadowed
                  </span>
                ) : null;
              })()}
              {(() => {
                const check = checks[s.id];
                if (!check) return null;
                if (!check.ok) {
                  return (
                    <span className="wb-source__err" data-testid={`welcome-source-updates-${s.id}`}>
                      {' '}· update check failed: {check.error}
                    </span>
                  );
                }
                const n = check.changes?.length ?? 0;
                if (n === 0) {
                  return <span data-testid={`welcome-source-updates-${s.id}`}> · up to date</span>;
                }
                return (
                  <span
                    data-testid={`welcome-source-updates-${s.id}`}
                    title={changeDetail(check.changes ?? [])}
                  >
                    {' '}· {n} changed upstream — Refresh to update
                  </span>
                );
              })()}
              {s.fetchedAt && ` · fetched ${new Date(s.fetchedAt).toLocaleDateString()}`}
              {s.error && <span className="wb-source__err"> · refresh failed: {s.error}</span>}
            </span>
            <span className="wb-source__actions">
              <button
                className="wb-btn wb-btn--ghost"
                onClick={() => void onCheck(s)}
                disabled={checkingId === s.id}
                title="Compare the cached boards against the index upstream"
                data-testid={`welcome-source-check-${s.id}`}
              >
                {checkingId === s.id ? '…' : 'Check'}
              </button>
              <button
                className="wb-btn wb-btn--ghost"
                onClick={() => {
                  clearCheck(s.id);
                  void refreshRemoteSource(s.id);
                }}
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
