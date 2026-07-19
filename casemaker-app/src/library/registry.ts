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
