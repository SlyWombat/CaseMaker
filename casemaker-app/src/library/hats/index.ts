import type { HatProfile } from '@/types';
import { builtinHatProfileSchema } from '../hatSchema';
import cqrobotDmxRaw from './cqrobot-dmx-shield-max485.json';

const validated: HatProfile[] = [cqrobotDmxRaw].map((raw) => {
  const parsed = builtinHatProfileSchema.parse(raw);
  return parsed as HatProfile;
});

export const builtinHats: ReadonlyArray<HatProfile> = Object.freeze(validated);

const byId = new Map(builtinHats.map((h) => [h.id, h]));

export function getBuiltinHat(id: string): HatProfile | undefined {
  return byId.get(id);
}

export function listBuiltinHatIds(): string[] {
  return Array.from(byId.keys());
}

export function hatsCompatibleWith(boardId: string): HatProfile[] {
  return builtinHats.filter(
    (h) => h.compatibleBoards.length === 0 || h.compatibleBoards.includes(boardId),
  );
}
