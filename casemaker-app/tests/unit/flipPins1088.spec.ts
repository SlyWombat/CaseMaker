/**
 * #1088 — ONE SOURCE FOR THE HOLES. Side 2's pins are side 1's posted bore centres reflected by
 * the flip; a stored pin set that disagrees with the reflection is refused by name, never
 * measured on. RED at the base: neither `reflectedPins` nor `planFlipAttempt` exists.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { flipZ0 } from '@/engine/cnc/engrave/flipChoice';
import { reflectedPins, planFlipAttempt, planFlipAttemptForJob } from '@/engine/cnc/registration/flipAttempt';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';

const STOCK = { xMax: 90, yMax: 60 };
const BORES = [
  { x: 20, y: 15 },
  { x: 70, y: 15 },
];

/** A flip job: side 1 plain, side 2 flipped left-right on two pins. */
function flipJob(pins?: [{ x: number; y: number }, { x: number; y: number }]): EngraveJob {
  const base = defaultEngraveJob();
  const setup0 = {
    id: 'setup-1',
    orientation: { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' },
    mount: { kind: 'vise' as const },
    itemIds: ['part'],
    tools: [],
  } as unknown as JobSetup;
  const setup1 = {
    ...setup0,
    id: 'setup-2',
    flip: { method: 'tabs-in-blank' as const, axis: 'left-right' as const },
    ...(pins === undefined ? {} : { pins: { at: pins } }),
  } as unknown as JobSetup;
  return {
    ...base,
    stock: { ...base.stock, length: 90, width: 60, thickness: 20 },
    labels: [],
    shapes: [],
    setups: [setup0, setup1],
  } as unknown as EngraveJob;
}

const INPUT = () => ({
  sideOneBores: BORES,
  settings: registrationSettings(null).settings,
  probeTipDiameterMm: 2,
  seekFromMachineZ: -3,
  z0: flipZ0({ seatMm: -87.25, thicknessMm: 20, toleranceMm: 0.3 }),
});

describe('#1088 side 2’s pins are side 1’s bores, reflected', () => {
  it('the reflection: left-right mirrors X through the length; front-back mirrors Y through the width', () => {
    expect(reflectedPins(BORES, 'left-right', STOCK)).toEqual([
      { x: 70, y: 15 },
      { x: 20, y: 15 },
    ]);
    expect(reflectedPins(BORES, 'front-back', STOCK)).toEqual([
      { x: 20, y: 45 },
      { x: 70, y: 45 },
    ]);
  });

  it('m1trayF’s real numbers: a bore at X 156 on a 160 blank is a pin at X 4, Y unchanged', () => {
    // The tray's own side-1 hold: (156, 37.8) and (156, 88.2) on side 1 → (4, 37.8)/(4, 88.2)
    // on side 2 (the Manager's bench numbers, the flip left-right through 160).
    const trayBores = [
      { x: 156, y: 37.8 },
      { x: 156, y: 88.2 },
    ];
    expect(reflectedPins(trayBores, 'left-right', { xMax: 160, yMax: 126 })).toEqual([
      { x: 4, y: 37.8 },
      { x: 4, y: 88.2 },
    ]);
  });

  it('the flip plan’s holes ARE the reflected bores — one source, never a second copy', () => {
    const r = planFlipAttempt(flipJob(), INPUT());
    expect(r?.kind).toBe('plan');
    if (r?.kind !== 'plan') return;
    const finds = r.attempt.plan.steps.flatMap((s) => (s.kind === 'hole' ? [s.find.at] : []));
    expect(finds).toEqual(reflectedPins(BORES, 'left-right', STOCK));
  });

  it('a stored pin set that agrees is accepted; one that disagrees is refused by name with both', () => {
    const agreeing = planFlipAttempt(flipJob([{ x: 70, y: 15 }, { x: 20, y: 15 }]), INPUT());
    expect(agreeing?.kind).toBe('plan');
    const wrong = planFlipAttempt(flipJob([{ x: 20, y: 45 }, { x: 70, y: 45 }]), INPUT());
    expect(wrong?.kind).toBe('refused');
    if (wrong?.kind !== 'refused') return;
    expect(wrong.reason).toContain('(20, 45)');
    expect(wrong.reason).toContain('(70, 15)');
    expect(wrong.reason).toContain('disagree');
  });

  it('no posted bores, no probe tip, no carried Z0: each refused by name', () => {
    expect(planFlipAttempt(flipJob(), { ...INPUT(), sideOneBores: null })?.kind).toBe('refused');
    expect(planFlipAttempt(flipJob(), { ...INPUT(), probeTipDiameterMm: null })?.kind).toBe('refused');
    expect(planFlipAttempt(flipJob(), { ...INPUT(), z0: null })?.kind).toBe('refused');
    // A non-flip job is not this function's business.
    const plain = flipJob();
    expect(planFlipAttempt({ ...plain, setups: [plain.setups![0]!] }, INPUT())).toBeNull();
  });

  it('#1088 — the app-side attempt comes from the job’s own stored pins, and refuses without them', () => {
    // The stored pair IS side 2's frame; the plan's holes are exactly those pins (the reflection is
    // its own inverse), so the probe is aimed at what the job says side 1 left.
    // The Cut step's card is the flipped setup's own; its first setup states the flip and the pins.
    const base = flipJob([{ x: 70, y: 15 }, { x: 20, y: 15 }]);
    const job = { ...base, setups: [base.setups![1]!] };
    const r = planFlipAttemptForJob(job, INPUT());
    expect(r?.kind).toBe('plan');
    if (r?.kind !== 'plan') return;
    const finds = r.attempt.plan.steps.flatMap((s) => (s.kind === 'hole' ? [s.find.at] : []));
    expect(finds).toEqual([
      { x: 70, y: 15 },
      { x: 20, y: 15 },
    ]);
    // No stored pins: refused by name, never re-planned from a guess.
    const bare = flipJob();
    const refused = planFlipAttemptForJob({ ...bare, setups: [bare.setups![1]!] }, INPUT());
    expect(refused?.kind).toBe('refused');
    if (refused?.kind !== 'refused') return;
    expect(refused.reason).toContain('locating pins');
    // A job whose first setup is not flipped is side 1's, and not this helper's business.
    const plain = flipJob();
    expect(planFlipAttemptForJob({ ...plain, setups: [plain.setups![0]!] }, INPUT())).toBeNull();
  });
});
