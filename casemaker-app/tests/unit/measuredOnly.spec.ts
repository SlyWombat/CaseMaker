// #641 — MEASURED-ONLY KEYS are one promise with two sides, and this holds them together:
//
//   * NO SEED. The fixture the app's tests run on must not carry one — a fresh location may not
//     claim a measurement nobody took (the Rust service enforces the same, `defaults.rs`).
//   * ONE BOUND. `defaults.rs` validates a write, `defaultsClient.ts` validates a read; the two
//     arms must accept and refuse the same numbers, or a value the service stores fails to parse
//     here (or the reverse) with no test noticing. The bound is read out of the Rust source and
//     probed through the Zod rule, so neither file can drift alone.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MEASURED_ONLY, readMeasured } from '@/platform/defaultsClient';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  defaults: Record<string, unknown>;
};
const RUST = readFileSync(join(HERE, '..', '..', 'src-tauri', 'src', 'defaults.rs'), 'utf8');

/** The `(min..=max)` of the key's match arm in `defaults.rs`, exactly as the service reads it. */
function rustBounds(key: string): { min: number; max: number } {
  const escaped = key.replace(/[.]/g, '\\.');
  const match = new RegExp(`"${escaped}" =>[\\s\\S]*?\\((-?\\d+(?:\\.\\d+)?)\\.\\.=(-?\\d+(?:\\.\\d+)?)\\)`).exec(RUST);
  if (match === null) throw new Error(`${key} has no bounded match arm in src-tauri/src/defaults.rs`);
  return { min: Number(match[1]), max: Number(match[2]) };
}

describe('#641 the measured-only keys', () => {
  const keys = Object.keys(MEASURED_ONLY);

  it('has at least the two bracket keys this pins (a rename must not empty the spec)', () => {
    expect(keys).toEqual(expect.arrayContaining(['bracket.seatMachineZ', 'bracket.armTopMm']));
  });

  it('carries no seed in the fixture the tests run on', () => {
    for (const key of keys) {
      expect(FIXTURE.defaults[key], `${key} is seeded in tests/unit/fixtures/location-doc.json`).toBeUndefined();
    }
  });

  it.each(keys)('%s accepts and refuses the SAME numbers as the Rust service', (key) => {
    const rust = rustBounds(key);
    const rule = MEASURED_ONLY[key]!.rule;
    expect(rule.safeParse(rust.min).success, `${key} accepts the service's minimum`).toBe(true);
    expect(rule.safeParse(rust.max).success, `${key} accepts the service's maximum`).toBe(true);
    expect(rule.safeParse(rust.min - 0.01).success, `${key} refuses below the service's minimum`).toBe(false);
    expect(rule.safeParse(rust.max + 0.01).success, `${key} refuses above the service's maximum`).toBe(false);
  });

  it.each(keys)('%s reads null until it is written, then its own value', (key) => {
    expect(readMeasured(FIXTURE.defaults as never, key)).toBeNull();
    const rust = rustBounds(key);
    const written = {
      ...FIXTURE.defaults,
      [key]: { value: rust.min, source: 'measured', setAt: '2026-10-25T00:00:00.000Z', unit: 'mm', note: null },
    };
    expect(readMeasured(written as never, key)).toMatchObject({ value: rust.min, source: 'measured' });
  });
});
