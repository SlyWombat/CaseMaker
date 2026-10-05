import type { BoardProfile } from '@/types';
import { builtinBoards, getBuiltinBoard } from './index';
import { useLibraryStore } from '@/store/libraryStore';

/**
 * Board registry — the single lookup surface for board profiles regardless
 * of where they came from. Sources, in resolution-priority order:
 *
 *   builtin — JSON files bundled with the app (src/library/boards/*.json)
 *   local   — user-imported profiles persisted in localStorage
 *   remote  — online sources the user added (index URL, cached locally);
 *             any number of them, in the order they were added
 *
 * On id collision the higher-priority source wins and the shadowed remote
 * board is dropped from listings — locals can't collide (addLocalBoard
 * auto-renames), remotes can (two sources publishing the same board).
 */
export type BoardOrigin =
  | { kind: 'builtin' }
  | { kind: 'local' }
  | { kind: 'remote'; sourceId: string; sourceLabel: string };

export interface RegisteredBoard {
  board: BoardProfile;
  origin: BoardOrigin;
}

export function listBoards(): RegisteredBoard[] {
  const { localBoards, remoteSources } = useLibraryStore.getState();
  const out: RegisteredBoard[] = [
    ...builtinBoards.map((board): RegisteredBoard => ({ board, origin: { kind: 'builtin' } })),
    ...localBoards.map((board): RegisteredBoard => ({ board, origin: { kind: 'local' } })),
  ];
  const seen = new Set(out.map((e) => e.board.id));
  for (const source of remoteSources) {
    if (!source.enabled) continue;
    for (const board of source.boards) {
      if (seen.has(board.id)) continue; // shadowed by a higher-priority source
      seen.add(board.id);
      out.push({ board, origin: { kind: 'remote', sourceId: source.id, sourceLabel: source.label } });
    }
  }
  return out;
}

/**
 * Ids in the given remote source that are shadowed by a higher-priority
 * source (builtin, local, or an earlier-added remote) — #128: surfaced in
 * the Sources panel instead of silently dropping them from listings.
 */
export function shadowedIdsForSource(sourceId: string): string[] {
  const { localBoards, remoteSources } = useLibraryStore.getState();
  const higher = new Set<string>([
    ...builtinBoards.map((b) => b.id),
    ...localBoards.map((b) => b.id),
  ]);
  for (const source of remoteSources) {
    if (source.id === sourceId) {
      return source.boards.map((b) => b.id).filter((id) => higher.has(id));
    }
    if (source.enabled) for (const b of source.boards) higher.add(b.id);
  }
  return [];
}

export function getBoard(id: string): BoardProfile | undefined {
  const builtin = getBuiltinBoard(id);
  if (builtin) return builtin;
  const { localBoards, remoteSources } = useLibraryStore.getState();
  const local = localBoards.find((b) => b.id === id);
  if (local) return local;
  for (const source of remoteSources) {
    if (!source.enabled) continue;
    const hit = source.boards.find((b) => b.id === id);
    if (hit) return hit;
  }
  return undefined;
}

/** #128 — one board whose upstream index disagrees with the cached copy. */
export interface BoardVersionChange {
  id: string;
  /** Version in the local cache (absent = never seen / unversioned). */
  from?: string;
  /** Version the index now advertises (absent = no version recorded). */
  to?: string;
  kind: 'new' | 'updated' | 'removed';
}

/** Board versions may be a string or a number; compare their text form so a
 * JSON `3` and `"3"` are the same version. */
function normVersion(v: string | number | undefined): string | undefined {
  return v === undefined ? undefined : String(v);
}

/**
 * #128 — diff the boards cached for a remote source against the board entries
 * an index advertises right now (id + version only). Underpins the
 * "N boards changed upstream — refresh" offer in the Sources panel, so a
 * refresh no longer replaces the whole source's cache silently.
 *
 *  - `updated` — the id is on both sides with a different version;
 *  - `new`     — the index has an id the cache doesn't;
 *  - `removed` — the cache has an id the index dropped.
 *
 * A board whose version is absent on both sides counts as unchanged: the
 * version is the publisher's declared contract, and with none recorded the
 * conditional-refresh path (ETag / Last-Modified 304) is what detects a
 * whole-index change. The function is pure so the panel's network probe stays
 * a thin fetch.
 */
export function diffBoardVersions(
  cached: ReadonlyArray<{ id: string; version?: string | number }>,
  incoming: ReadonlyArray<{ id: string; version?: string | number }>,
): BoardVersionChange[] {
  const from = new Map(cached.map((b) => [b.id, normVersion(b.version)]));
  const to = new Map(incoming.map((b) => [b.id, normVersion(b.version)]));
  const changes: BoardVersionChange[] = [];
  for (const [id, v] of to) {
    if (!from.has(id)) {
      changes.push({ id, ...(v !== undefined ? { to: v } : {}), kind: 'new' });
      continue;
    }
    const f = from.get(id);
    if (f !== v) {
      changes.push({
        id,
        ...(f !== undefined ? { from: f } : {}),
        ...(v !== undefined ? { to: v } : {}),
        kind: 'updated',
      });
    }
  }
  for (const [id, v] of from) {
    if (!to.has(id)) {
      changes.push({ id, ...(v !== undefined ? { from: v } : {}), kind: 'removed' });
    }
  }
  return changes.sort((a, b) => a.id.localeCompare(b.id));
}
