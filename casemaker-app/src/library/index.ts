import type { BoardProfile } from '@/types';
import { builtinBoardProfileSchema } from './schema';
import rpi4bRaw from './boards/rpi-4b.json';
import rpi5Raw from './boards/rpi-5.json';
import rpiZero2WRaw from './boards/rpi-zero-2w.json';
import arduinoUnoR3Raw from './boards/arduino-uno-r3.json';
import esp32DevkitV1Raw from './boards/esp32-devkit-v1.json';

const validated: BoardProfile[] = [
  rpi4bRaw,
  rpi5Raw,
  rpiZero2WRaw,
  arduinoUnoR3Raw,
  esp32DevkitV1Raw,
].map((raw) => {
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
