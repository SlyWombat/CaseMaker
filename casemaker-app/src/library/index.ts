import type { BoardProfile } from '@/types';
import { builtinBoardProfileSchema } from './schema';
import rpi4bRaw from './boards/rpi-4b.json';

const validated: BoardProfile[] = [rpi4bRaw].map((raw) => {
  const parsed = builtinBoardProfileSchema.parse(raw);
  return parsed as BoardProfile;
});

export const builtinBoards: ReadonlyArray<BoardProfile> = Object.freeze(validated);

const byId = new Map(builtinBoards.map((b) => [b.id, b]));

export function getBuiltinBoard(id: string): BoardProfile | undefined {
  return byId.get(id);
}

export function listBuiltinBoardIds(): string[] {
  return Array.from(byId.keys());
}
