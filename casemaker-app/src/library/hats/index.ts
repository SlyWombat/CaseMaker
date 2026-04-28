import type { HatProfile } from '@/types';
import { builtinHatProfileSchema } from '../hatSchema';
import cqrobotDmxRaw from './cqrobot-dmx-shield-max485.json';
import rpiPoEPlusRaw from './rpi-poe-plus.json';
import rpiSenseRaw from './rpi-sense-hat.json';
import pimoroniFanShimRaw from './pimoroni-fan-shim.json';
import arduinoEthernetRaw from './arduino-ethernet-shield-2.json';

const validated: HatProfile[] = [
  cqrobotDmxRaw,
  rpiPoEPlusRaw,
  rpiSenseRaw,
  pimoroniFanShimRaw,
  arduinoEthernetRaw,
].map((raw) => {
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

/**
 * Issue #71 — `clonedFromBoardId` is the original built-in id when the
 * project's active board is a custom clone. Compatibility matches either
 * the live id OR the source.
 */
export function hatsCompatibleWith(
  boardId: string,
  clonedFromBoardId?: string,
): HatProfile[] {
  return builtinHats.filter((h) => {
    if (h.compatibleBoards.length === 0) return true;
    if (h.compatibleBoards.includes(boardId)) return true;
    if (clonedFromBoardId && h.compatibleBoards.includes(clonedFromBoardId)) return true;
    return false;
  });
}
