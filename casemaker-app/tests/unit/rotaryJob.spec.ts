// #240 slice 1 — the rotary JOB: round stock and the chuck in the document, the holding write
// that swaps the box between the vise's standing rod and the axis frame, the package's frame
// record, and the timeline's A-keyed checkpoints.
//
// The post and the run gate have their own specs (`rotaryPost.spec.ts`, `rotaryRunGate.spec.ts`);
// this one is the document + engine side.

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultRotaryChuck, applyHoldAnswers } from '@/engine/cnc/engrave/setupFlow';
import { freezePackage } from '@/engine/cnc/engrave/package';
import { programHash } from '@/engine/cnc/programHash';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { mountOptions } from '@/components/welcome/holdingMounts';
import { buildTimeline, parseGcode, stubSetup, type Setup } from '@/engine/cnc';
import { unliftTimeline } from '@/workers/geometry/sweep';
import { MachineRecordSchema, type FixtureRecord, type MachineRecord } from '@/platform/locationClient';
import type { EngraveJob, RotaryChuck, Sacrificial, ViseParams } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCATION = join(HERE, 'fixtures', 'location-doc.json');
const LOCATION_DOC = JSON.parse(readFileSync(LOCATION, 'utf8')) as {
  machines: unknown[];
  accessories: FixtureRecord[];
};

const CHUCK: RotaryChuck = {
  stickout: 30,
  gripDiameter: null,
  jawMode: 'reverse-inner',
  tailstock: true,
  source: 'Makera Z1 wiki, 4-axis accessory',
};

const VISE: ViseParams = {
  stockProud: 1.5,
  seat: 'ledge',
  fixedJawThickness: 10,
  movingJawThickness: 1,
  jawLength: 100,
  jawStartY: -10,
  source: 'default',
  uncertainty: 0.2,
};

const NONE: Sacrificial = {
  under: null,
  sides: { left: null, right: null, front: null, back: null },
  source: 'default',
};

/** A rod standing on its end in the vise: ⌀10 × 30, so the box is 10 × 10 × 30. */
function standingRod(): EngraveJob {
  const base = defaultEngraveJob();
  return { ...base, stock: { ...base.stock, length: 10, width: 10, thickness: 30 } };
}

/** The same rod as the axis frame states it: LENGTH along X, the diameter across Y and Z. */
function rotaryRodDoc(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 30, width: 10, thickness: 10, shape: 'cylinder', diameter: 10 },
    workholding: { kind: 'rotary-chuck', rotary: { ...CHUCK } },
  };
}

describe('round stock and the chuck in the document (#240 §1)', () => {
  it('a cylinder + rotary-chuck job parses and round-trips field for field', () => {
    const job = rotaryRodDoc();
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job).toEqual(job);
    expect(parsed.job.stock.shape).toBe('cylinder');
    expect(parsed.job.stock.diameter).toBe(10);
    expect(parsed.job.workholding).toEqual({ kind: 'rotary-chuck', rotary: CHUCK });
  });

  it('a pre-rotary document keeps NO shape, diameter or rotary key — and saves the same bytes', () => {
    const job = defaultEngraveJob();
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job).toEqual(job);
    expect('shape' in parsed.job.stock).toBe(false);
    expect('diameter' in parsed.job.stock).toBe(false);
    expect(parsed.job.workholding.kind).toBe('vise');
    // The store saves `JSON.stringify(job)`, so opening and saving a job must write identical
    // bytes: nothing reordered, defaulted or dropped on the way past.
    const saved = JSON.stringify(parsed.job);
    const again = parseEngraveJob(JSON.parse(saved));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(JSON.stringify(again.job)).toBe(saved);
  });

  it('a cylinder is stated exactly: diameter present, box square to it', () => {
    const base = defaultEngraveJob();
    const bad = (stock: Partial<EngraveJob['stock']>): string[] => {
      const parsed = parseEngraveJob(JSON.parse(JSON.stringify({ ...base, stock: { ...base.stock, ...stock } })));
      return parsed.ok ? [] : parsed.errors;
    };

    expect(bad({ shape: 'cylinder', width: 10, thickness: 10 }).some((e) => e.includes('round stock states its diameter'))).toBe(true);
    expect(
      bad({ shape: 'cylinder', diameter: 12 }).some((e) => e.includes('round stock is as wide as its diameter, and as thick or as long as it')),
    ).toBe(true);
    // A STANDING cylinder — the wizard's D × D × L before Holding normalises it — is stated exactly
    // too (#713).
    expect(
      bad({ shape: 'cylinder', diameter: 12, width: 12, length: 12, thickness: 30 }).some((e) => e.includes('round stock is as wide')),
    ).toBe(false);
    expect(bad({ diameter: 10 }).some((e) => e.includes('a diameter needs the cylinder shape'))).toBe(true);
  });
});

describe('the holding write (#240 §2)', () => {
  beforeEach(() => {
    useEngraveJobStore.getState().reset();
  });

  it('writes the chuck and the axis-frame box together, and parses back', () => {
    useEngraveJobStore.getState().replace(standingRod());
    useEngraveJobStore.getState().setRotaryHolding(defaultRotaryChuck(useEngraveJobStore.getState().job), VISE);

    const job = useEngraveJobStore.getState().job;
    expect(job.workholding).toEqual({ kind: 'rotary-chuck', rotary: defaultRotaryChuck(standingRod()) });
    // LENGTH along X, the diameter across Y and Z — the frame every rotary Z is written in (R6).
    expect(job.stock).toEqual({ length: 30, width: 10, thickness: 10, material: 'softwood', shape: 'cylinder', diameter: 10 });
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.job).toEqual(job);
  });

  it('choosing the vise again restores the standing rod and a plain vise workholding', () => {
    useEngraveJobStore.getState().replace(standingRod());
    useEngraveJobStore.getState().setRotaryHolding(CHUCK, VISE);
    useEngraveJobStore.getState().setRotaryHolding(null, VISE, NONE);

    const job = useEngraveJobStore.getState().job;
    expect(job.workholding).toEqual({ kind: 'vise', vise: VISE });
    expect(job.stock).toEqual({ length: 10, width: 10, thickness: 30, material: 'softwood' });
    expect('shape' in job.stock).toBe(false);
    expect('diameter' in job.stock).toBe(false);
    expect(job.sacrificial).toEqual(NONE);
  });

  it('does nothing to a rectangular blank — the rotary holds round stock', () => {
    const plate = defaultEngraveJob(); // 100 × 60 × 12, a plate
    useEngraveJobStore.getState().replace(plate);
    useEngraveJobStore.getState().setRotaryHolding(CHUCK, VISE);
    expect(useEngraveJobStore.getState().job).toEqual(plate);
  });

  it('applyHoldAnswers never clobbers a rotary workholding', () => {
    useEngraveJobStore.getState().replace(standingRod());
    useEngraveJobStore.getState().setRotaryHolding(CHUCK, VISE);

    const job = useEngraveJobStore.getState().job;
    const answers = {
      workholding: 'vise' as const,
      sacrificial: NONE,
      stock: { length: 10, width: 10, thickness: 30, material: 'softwood' as const },
      // A DIFFERENT vise: if the answers won, this is the one that would be written.
      vise: { ...VISE, stockProud: 4 },
      rotary: CHUCK,
      sources: {
        stock: { length: 'user' as const, width: 'user' as const, thickness: 'user' as const, material: 'user' as const },
      },
    };
    const after = applyHoldAnswers(job, answers);
    expect(after.workholding).toEqual({ kind: 'rotary-chuck', rotary: CHUCK });
    // The sacrificial is still the answers': it is not the holding kind.
    expect(after.sacrificial).toEqual(NONE);
  });
});

describe('the frozen program’s frame (#240 §4)', () => {
  it('copies a stated frame, and writes no key when the program does not state one', () => {
    const job = rotaryRodDoc();
    const setup = { setupIndex: 1, setupId: 'setup-1', toolKey: 'flat-1.0', frameNc: null, programHash: programHash('nc') };

    const stated = freezePackage(job, [{ ...setup, nc: 'nc', frame: 'rotary' }], '2026-10-26T00:00:00.000Z');
    expect(stated.ok).toBe(true);
    if (!stated.ok) return;
    expect(stated.package.programs[0]!.frame).toBe('rotary');

    const absent = freezePackage(job, [{ ...setup, nc: 'nc' }], '2026-10-26T00:00:00.000Z');
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect('frame' in absent.package.programs[0]!).toBe(false);
  });

  it('the frame survives the document’s schema', () => {
    const job = rotaryRodDoc();
    const frozen = freezePackage(
      job,
      [{ setupIndex: 1, setupId: 'setup-1', toolKey: 'flat-1.0', nc: 'nc', frameNc: null, programHash: programHash('nc'), frame: 'rotary' }],
      '2026-10-26T00:00:00.000Z',
    );
    if (!frozen.ok) throw new Error(frozen.reason);
    const withPackage: EngraveJob = { ...job, package: frozen.package };
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(withPackage)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.package?.programs[0]?.frame).toBe('rotary');
  });
});

describe('A-keyed checkpoints (#240 R4)', () => {
  const part = { kind: 'prism' as const, outline: { kind: 'p-rect' as const, size: [20, 20] as [number, number] }, thickness: 10 };
  const setup = (): Setup => stubSetup(part, { kind: 'tape-down', contact: part.outline });
  const FLAT_SURFACE = { plane: { offset: 0, slopeX: 0, slopeY: 0 }, z0: 0 };

  it('splits a run when A changes, and carries A on the bucket', () => {
    const src = [
      'G90 G21 G17',
      'G0 X0 Y0 Z12 A0',
      'M3 S12000',
      'G1 X0 Z9.5 A0 F500',
      'G1 X10 Z9.5 A0 F500',
      'G1 X10 Z9.5 A90 F500',
      'G1 X20 Z9.5 A90 F500',
    ].join('\n');
    const tl = buildTimeline(parseGcode(src), setup());
    expect(tl.checkpoints.map((cp) => ({ a: cp.a, steps: cp.steps.length }))).toEqual([
      { a: 0, steps: 2 },
      { a: 90, steps: 2 },
    ]);

    // The un-lift re-buckets into the surface frame; A travels with the bucket, so the two faces
    // cannot fold into one solid. (Both are at the same Z, so Z alone would merge them.)
    const out = unliftTimeline(tl, FLAT_SURFACE);
    expect(out.checkpoints.map((cp) => cp.a)).toEqual([0, 90]);
  });

  it('every flat program’s checkpoints carry null', () => {
    const src = ['G90 G21 G17', 'G0 X0 Y0 Z2', 'M3 S12000', 'G1 X0 Z-0.5 F500', 'G1 X10 Z-0.5 F500'].join('\n');
    const tl = buildTimeline(parseGcode(src), setup());
    expect(tl.checkpoints.length).toBeGreaterThan(0);
    expect(tl.checkpoints.every((cp) => cp.a === null)).toBe(true);
  });
});

describe('the Holding step’s rotary option (#240 §2)', () => {
  const ROTARY: FixtureRecord = {
    id: 'fx-rotary-1',
    kind: 'rotary-module',
    product: 'makera-4th-axis',
    variant: null,
    constants: {},
    unit: {},
    provenance: {},
    whereabouts: { kind: 'box' },
    history: [],
  };

  /** The fixture machine, moved from the vise to the rotary on the pins. */
  function rotaryMachine(): MachineRecord {
    const machine = MachineRecordSchema.parse(JSON.parse(JSON.stringify(LOCATION_DOC.machines[0])));
    const profile = machine.bedProfiles![0]!;
    profile.placements = [
      {
        id: 'pl-rotary',
        fixture: ROTARY.id,
        where: { kind: 'pins', pins: 'rotary', anchor: null },
        count: null,
        frame: { fixedJawFaceX: -181.2, jawStartY: -203.5 },
        provenance: { fixedJawFaceX: 'typed', jawStartY: 'typed' },
      },
    ];
    return machine;
  }

  it('is disabled for a plate, with the step-2 sentence', () => {
    const options = mountOptions({
      machine: rotaryMachine(),
      accessories: [...LOCATION_DOC.accessories, ROTARY],
      stock: { length: 80, width: 60, thickness: 8 },
    });
    const rotary = options.find((o) => o.mount === 'rotary');
    expect(rotary).toBeDefined();
    expect(rotary!.disabled).toBe(true);
    expect(rotary!.reason).toBe('the rotary holds round stock — say a rod in step 2');
    // The stock's own refusal: no machine change can fix it, so there is no escape to offer.
    expect(rotary!.escape).toBeNull();
  });

  it('is available when the stock is round and fits the module', () => {
    const options = mountOptions({
      machine: rotaryMachine(),
      accessories: [...LOCATION_DOC.accessories, ROTARY],
      stock: { length: 30, width: 10, thickness: 10 },
      round: true,
    });
    const rotary = options.find((o) => o.mount === 'rotary');
    expect(rotary).toBeDefined();
    expect(rotary!.disabled).toBe(false);
    expect(rotary!.reason).toBeNull();
  });
});
