/**
 * #888 item 6 — A GOAL IS A CUT. The Setups section read "Setups (1) empty" and "Add setup is
 * unavailable: the job has no cuts to plan" on a goal job that was generating two programs. The
 * goal now becomes a removal — its placed box in the stock frame, opening to the top, and to the
 * bottom too when the part does not reach the blank's bottom — and the implicit setup names its id.
 */

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { addSetupOffer, cutItemIds, readSetups } from '@/engine/cnc/setups';
import { removalsFrom } from '@/engine/cnc/setups/fromJob';
import { setupsSettings } from '@/engine/cnc/setups/settings';
import type { EngraveJob, EngraveTargetObject, JobSetup } from '@/types/engraveJob';

const SETTINGS = setupsSettings(null);

/** A 10 × 10 ramp falling 5 mm in Z, as a binary STL body. */
function rampStl(): string {
  const tris: [number, number, number][][] = [
    [[0, 0, 0], [10, 0, -5], [10, 10, -5]],
    [[0, 0, 0], [10, 10, -5], [0, 10, -5]],
  ];
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

function goal(over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id: 'goal-ramp',
    name: 'ramp.stl',
    format: 'stl',
    sha256: 'c'.repeat(64),
    data: rampStl(),
    size: { x: 10, y: 10, z: 5 },
    position: { x: 50, y: 30, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

function goalJob(target: EngraveTargetObject, thickness: number): EngraveJob {
  return {
    ...defaultEngraveJob(),
    labels: [],
    shapes: [],
    stock: { ...defaultEngraveJob().stock, thickness },
    targetObject: target,
  };
}

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

describe('#888 item 6 — a goal counts as a cut', () => {
  it('a goal job is not "empty": the goal is a removal and the implicit setup names it', () => {
    const job = goalJob(goal(), 12);
    const reading = readSetups(job);
    expect(reading.source).toBe('implicit');
    expect(cutItemIds(job)).toContain('goal-ramp');
    expect(jobSetups(job)[0]!.itemIds).toContain('goal-ramp');
    const removal = removalsFrom(job).find((r) => r.id === 'goal-ramp');
    expect(removal).toBeDefined();
    // The 10 × 10 ramp at 50/30 on a 100 × 60 × 12 blank: its box runs from the stock top down
    // 5 mm, so material is left below it and a flipped setup can take that material.
    expect(removal!.opensTo).toEqual(['top', 'bottom']);
    expect(removal!.box.max[2]).toBeCloseTo(12, 3);
    expect(removal!.box.min[2]).toBeCloseTo(7, 3);
  });

  it('Add setup is offered for the goal’s unheld side, not refused with "no cuts to plan"', () => {
    const job = goalJob(goal(), 12);
    const offer = addSetupOffer(job, SETTINGS);
    expect(offer.face).toBe('bottom');
    expect(offer.reason).toBeNull();
  });

  it('a goal that reaches the blank’s bottom opens to the top only', () => {
    const job = goalJob(goal(), 5);
    const removal = removalsFrom(job).find((r) => r.id === 'goal-ramp');
    expect(removal!.opensTo).toEqual(['top']);
    const offer = addSetupOffer(job, SETTINGS);
    expect(offer.face).toBeNull();
    expect(offer.reason).toContain('top');
  });

  it('a saved side setup naming its goal is not "no longer in the job"', () => {
    const target = goal();
    const base = goalJob(target, 12);
    const setups: JobSetup[] = [
      { id: 'setup-1', orientation: { ...IDENTITY }, mount: { kind: 'vise' }, itemIds: [target.id], tools: [base.toolKey] },
    ];
    const job: EngraveJob = { ...base, targetObject: undefined, targetObjects: [target], setups };
    const reading = readSetups(job);
    expect(reading.items[0]!.missing).toEqual([]);
    expect(reading.items[0]!.cut).toEqual([target.id]);
    expect(reading.findings.some((f) => f.code === 'setup-item-missing')).toBe(false);
    expect(reading.findings.some((f) => f.code === 'setup-no-cuts')).toBe(false);
  });
});
