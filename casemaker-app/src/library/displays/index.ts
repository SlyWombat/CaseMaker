import type { DisplayProfile } from '@/types/display';
import { builtinDisplayProfileSchema } from '../displaySchema';
import rpi7TouchRaw from './rpi-7-touch.json';
import hyperpixel4Raw from './hyperpixel-4.json';

const validated: DisplayProfile[] = [rpi7TouchRaw, hyperpixel4Raw].map((raw) => {
  const parsed = builtinDisplayProfileSchema.parse(raw);
  return parsed as DisplayProfile;
});

export const builtinDisplays: ReadonlyArray<DisplayProfile> = Object.freeze(validated);

const byId = new Map(builtinDisplays.map((d) => [d.id, d]));

export function getBuiltinDisplay(id: string): DisplayProfile | undefined {
  return byId.get(id);
}

export function listBuiltinDisplayIds(): string[] {
  return Array.from(byId.keys());
}

export function displaysCompatibleWith(boardId: string): DisplayProfile[] {
  return builtinDisplays.filter(
    (d) => d.compatibleBoards.length === 0 || d.compatibleBoards.includes(boardId),
  );
}
