// A 3D TARGET input (#533, slice C): an embedded mesh marked as a GOAL — the shape to MAKE —
// distinct from today's REFERENCE object, which is positioned against but never cut.
//
// Pure zod + pure validation, no React/wasm/worker. A localStorage shim is installed before the
// store import out of caution (the engrave schema shares the store barrel in some builds).

import { describe, it, expect } from 'vitest';

const backing = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => backing.get(k) ?? null,
  setItem: (k: string, v: string) => void backing.set(k, String(v)),
  removeItem: (k: string) => void backing.delete(k),
  clear: () => backing.clear(),
  key: (i: number) => [...backing.keys()][i] ?? null,
  get length() {
    return backing.size;
  },
} as Storage;

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

// Default stock is 100 × 60 × 12 mm (defaults.ts), so a 40 × 30 × 6 mm mesh fits comfortably.
const baseTarget: EngraveTargetObject = {
  id: 'tgt-1',
  name: 'bracket.stl',
  format: 'stl',
  sha256: 'a'.repeat(64),
  data: 'AAAA',
  size: { x: 40, y: 30, z: 6 },
  position: { x: 0, y: 0, z: 0 },
  rotation: 0,
  enabled: true,
};

function jobWithTarget(target: EngraveTargetObject): EngraveJob {
  return { ...defaultEngraveJob(), targetObject: target };
}

function codes(job: EngraveJob): string[] {
  return validateJob(job).map((f) => f.code);
}

describe('3D goal object (#533, slice C)', () => {
  it('round-trips the goal role through the Zod schema with the field intact', () => {
    const job = jobWithTarget({ ...baseTarget, role: 'goal' });
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The schema is strict and strips unknown keys; `role` must survive BOTH edits (types + zod).
    expect(parsed.job.targetObject?.role).toBe('goal');
    expect(parsed.job.targetObject).toEqual({ ...baseTarget, role: 'goal' });
  });

  it('leaves a role-less target object byte-for-byte unchanged (absent stays absent)', () => {
    const job = jobWithTarget({ ...baseTarget });
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.targetObject?.role).toBeUndefined();
    expect(parsed.job.targetObject).toEqual(baseTarget);
  });

  it('refuses an unknown role value', () => {
    const job = jobWithTarget({ ...baseTarget, role: 'cut' as never });
    expect(parseEngraveJob(JSON.parse(JSON.stringify(job))).ok).toBe(false);
  });

  it('#535 — round-trips the goal operation’s surface settings intact', () => {
    const surface = {
      roughStepDownMm: 0.3,
      roughStepOverMm: 1.1,
      finishStepOverMm: 0.2,
      gridPitchMm: 0.15,
      stockToLeaveMm: 0.25,
    };
    const job = jobWithTarget({ ...baseTarget, role: 'goal', surface });
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The schema is strict and strips unknown keys; `surface` must survive BOTH edits.
    expect(parsed.job.targetObject).toEqual({ ...baseTarget, role: 'goal', surface });
  });

  it('#535 — refuses a surface setting the CAM could not run', () => {
    for (const bad of [
      { roughStepDownMm: 0 },
      { roughStepOverMm: -0.5 },
      { gridPitchMm: 0 },
      { gridPitchMm: 5 },
      { stockToLeaveMm: -0.1 },
    ]) {
      const job = jobWithTarget({ ...baseTarget, role: 'goal', surface: bad as never });
      expect(parseEngraveJob(JSON.parse(JSON.stringify(job))).ok).toBe(false);
    }
  });

  it('#535 — a goal with no surface block keeps it absent (the engine defaults)', () => {
    const job = jobWithTarget({ ...baseTarget, role: 'goal' });
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.targetObject?.surface).toBeUndefined();
  });

  it('a GOAL mesh validates WITHOUT target-object-not-cut', () => {
    const found = codes(jobWithTarget({ ...baseTarget, role: 'goal' }));
    expect(found).not.toContain('target-object-not-cut');
    // The goal is recognised but not yet machinable (toolpaths are slice D, #534).
    expect(found).toContain('goal-object-no-toolpath');
    expect(found).not.toContain('goal-object-oversize');
  });

  it('a REFERENCE object (role absent) still gets target-object-not-cut', () => {
    const found = codes(jobWithTarget({ ...baseTarget }));
    expect(found).toContain('target-object-not-cut');
    expect(found).not.toContain('goal-object-no-toolpath');
    expect(found).not.toContain('goal-object-oversize');
  });

  it("an explicit role: 'reference' behaves exactly as an absent role", () => {
    const found = codes(jobWithTarget({ ...baseTarget, role: 'reference' }));
    expect(found).toContain('target-object-not-cut');
    expect(found).not.toContain('goal-object-no-toolpath');
  });

  it('a goal larger than the blank is refused as oversize, not warned as uncut', () => {
    // Footprint over-wide (120 > 100 mm X): cannot be carved from a 100 × 60 × 12 mm blank.
    const found = codes(jobWithTarget({ ...baseTarget, role: 'goal', size: { x: 120, y: 30, z: 6 } }));
    expect(found).toContain('goal-object-oversize');
    expect(found).not.toContain('goal-object-no-toolpath');
    expect(found).not.toContain('target-object-not-cut');
  });

  it('a goal deeper than the stock thickness is refused as oversize', () => {
    const found = codes(jobWithTarget({ ...baseTarget, role: 'goal', size: { x: 40, y: 30, z: 20 } }));
    expect(found).toContain('goal-object-oversize');
  });

  it('a disabled goal is silent — neither cut-warned nor goal-noted', () => {
    const found = codes(jobWithTarget({ ...baseTarget, role: 'goal', enabled: false }));
    expect(found).not.toContain('goal-object-no-toolpath');
    expect(found).not.toContain('goal-object-oversize');
    expect(found).not.toContain('target-object-not-cut');
  });
});
