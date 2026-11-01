// Issue #881 — the roughing level pool's size rule.
//
// The pool is the app's parallelism: `roughingAdaptiveMoves` hands every non-reused level to it.
// The rule keeps one core for the sim worker's own assembly, caps the pool so a many-core machine
// does not spawn a planner per level, and runs a single planner on a phone — the device whose
// cores and battery are not ours to spend.

import { describe, expect, it } from 'vitest';

import { adaptivePoolSize } from '@/engine/jobs/adaptivePool';

describe('#881 — the level pool size', () => {
  it('is one fewer than the machine has, capped at eight', () => {
    expect(adaptivePoolSize({ hardwareConcurrency: 8 }, false)).toBe(7);
    expect(adaptivePoolSize({ hardwareConcurrency: 16 }, false)).toBe(8);
    expect(adaptivePoolSize({ hardwareConcurrency: 64 }, false)).toBe(8);
  });

  it('never asks for more planners than there is work to give them', () => {
    expect(adaptivePoolSize({ hardwareConcurrency: 2 }, false)).toBe(1);
    expect(adaptivePoolSize({ hardwareConcurrency: 1 }, false)).toBe(1);
    expect(adaptivePoolSize({}, false)).toBe(1);
  });

  it('is one on a phone, whatever the core count says', () => {
    expect(adaptivePoolSize({ hardwareConcurrency: 8 }, true)).toBe(1);
  });
});
