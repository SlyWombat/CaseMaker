import type { BoardProfile } from '@/types';
import { builtinBoardProfileSchema } from './schema';
import rpi4bRaw from './boards/rpi-4b.json';
import rpi5Raw from './boards/rpi-5.json';
import rpiZero2WRaw from './boards/rpi-zero-2w.json';
import arduinoUnoR3Raw from './boards/arduino-uno-r3.json';
import arduinoGigaR1WifiRaw from './boards/arduino-giga-r1-wifi.json';
import esp32DevkitV1Raw from './boards/esp32-devkit-v1.json';
import rpiPicoRaw from './boards/rpi-pico.json';
import teensy41Raw from './boards/teensy-41.json';
import jetsonNanoRaw from './boards/jetson-nano-b01.json';
import beagleboneBlackRaw from './boards/beaglebone-black.json';
import microbitV2Raw from './boards/microbit-v2.json';
import m5stackCore2Raw from './boards/m5stack-core2.json';

const validated: BoardProfile[] = [
  rpi4bRaw,
  rpi5Raw,
  rpiZero2WRaw,
  arduinoUnoR3Raw,
  arduinoGigaR1WifiRaw,
  esp32DevkitV1Raw,
  rpiPicoRaw,
  teensy41Raw,
  jetsonNanoRaw,
  beagleboneBlackRaw,
  microbitV2Raw,
  m5stackCore2Raw,
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
