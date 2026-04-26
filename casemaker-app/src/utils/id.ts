import { customAlphabet } from 'nanoid';

const nano = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

let seededCounter = 0;
let seedActive = false;

export function setSeededIds(active: boolean): void {
  seedActive = active;
  seededCounter = 0;
}

export function resetSeed(seed = 0): void {
  seededCounter = seed;
  seedActive = true;
}

export function newId(prefix?: string): string {
  const core = seedActive ? `s${(++seededCounter).toString(36).padStart(6, '0')}` : nano();
  return prefix ? `${prefix}-${core}` : core;
}
