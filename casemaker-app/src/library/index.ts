import type { BoardProfile } from '@/types';
import { builtinBoardProfileSchema } from './schema';

/**
 * Built-in board profiles are discovered from the filesystem — every
 * `boards/*.json` is picked up at build time, validated, and registered.
 * Adding a built-in board is now just "drop a JSON file in boards/";
 * there is no import list to maintain.
 *
 * `import.meta.glob` keys are relative paths ("./boards/rpi-4b.json"), so
 * iteration order follows the sorted path order Vite provides. UI surfaces
 * apply their own grouping/sorting; nothing may depend on this order.
 */
const boardModules = import.meta.glob<{ default: unknown }>('./boards/*.json', {
  eager: true,
});

const validated: BoardProfile[] = Object.entries(boardModules).map(([path, mod]) => {
  try {
    return builtinBoardProfileSchema.parse(mod.default) as BoardProfile;
  } catch (err) {
    throw new Error(`Invalid built-in board profile ${path}: ${String(err)}`);
  }
});

const byId = new Map(validated.map((b) => [b.id, b]));
if (byId.size !== validated.length) {
  const seen = new Set<string>();
  const dupes = validated.map((b) => b.id).filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  throw new Error(`Duplicate built-in board id(s): ${dupes.join(', ')}`);
}

export const builtinBoards: ReadonlyArray<BoardProfile> = Object.freeze(validated);

export function getBuiltinBoard(id: string): BoardProfile | undefined {
  return byId.get(id);
}

export function listBuiltinBoardIds(): string[] {
  return Array.from(byId.keys());
}

// Board resolution across ALL sources (builtin + local imports) lives in
// ./registry — import getBoard/listBoards from '@/library/registry'. Not
// re-exported here to keep the module graph acyclic (registry depends on
// the local-library store, which depends on this module).
