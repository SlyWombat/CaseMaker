/**
 * #1059 — THE RECEIPT'S FACE-ANGLE FIELD (red-first; the square chuck's levelled A zero).
 *
 * A square block in the chuck is levelled by the face-angle step, and the bed profile stores the
 * result as `datums.rotaryFaceAngle` (degrees + the run's residual). The receipt must carry the
 * datum the job was planned against, and must NOT gain a key on any other job: a round rod has no
 * face to level, and a square job with nothing levelled has nothing to state.
 */
import { describe, expect, it } from 'vitest';

import { faceAngleReceiptFor } from '../../scripts/lib/casemaker/engrave';
import { engraveDetailsSchema } from '@/platform/headless/receipt';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import type { LoadedLocation } from '@/platform/headless/bootstrap';
import type { EngraveJob } from '@/types/engraveJob';

const ROTARY = {
  kind: 'rotary-chuck' as const,
  rotary: { stickout: 40, gripDiameter: 44.5, jawMode: 'reverse-inner' as const, tailstock: false, source: 'test fixture' },
};

function squareChuckJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, length: 60, width: 44.5, thickness: 44.5 },
    stockEntry: { kind: 'made', shelfId: null, file: null, form: 'block', finish: 'rough', conductive: false },
    workholding: ROTARY,
    bed: {
      profileId: 'bp-1',
      profileVersion: '2026-11-08T00:00:00.000Z',
      datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null, rotaryFaceAngle: 1.25 },
    },
  };
}

function rodJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    stock: { ...base.stock, shape: 'cylinder', length: 60, width: 20, thickness: 20 },
    stockEntry: { kind: 'made', shelfId: null, file: null, form: 'rod', finish: 'rough', conductive: false },
    workholding: ROTARY,
    bed: squareChuckJob().bed,
  };
}

function where(datum: { value: number; measuredAt: string; by: string; at: [number, number] | null; residualMm?: number } | null): LoadedLocation {
  const machine = {
    id: 'machine-1',
    profileId: 'Z1',
    activeBedProfileId: 'bp-1',
    bedProfiles: [
      {
        id: 'bp-1',
        datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null, rotaryFaceAngle: datum },
      },
    ],
  };
  return { machines: [machine] } as unknown as LoadedLocation;
}

const DATUM = { value: 1.25, measuredAt: '2026-11-08T01:00:00.000Z', by: 'wired-probe', at: null as [number, number] | null, residualMm: 0.03 };

describe('#1059 the receipt carries a square chuck job’s face angle', () => {
  it('the fixture is a SQUARE chuck job (a rect section), so the premise holds', () => {
    expect(rotaryMapOf(squareChuckJob(), null)?.section.kind).toBe('rect');
    expect(rotaryMapOf(rodJob(), null)?.section.kind).toBe('round');
  });

  it('a square job with a datum carries degrees and the residual', () => {
    // RED at the parent: no resolver existed, so no receipt could carry the datum at all.
    expect(faceAngleReceiptFor(squareChuckJob(), where(DATUM))).toEqual({ degrees: 1.25, residualMm: 0.03 });
    expect(faceAngleReceiptFor(squareChuckJob(), where({ ...DATUM, residualMm: undefined }))).toEqual({ degrees: 1.25 });
  });

  it('nothing levelled → no key; a ROUND rod → no key even with a datum', () => {
    expect(faceAngleReceiptFor(squareChuckJob(), where(null))).toBeUndefined();
    expect(faceAngleReceiptFor(rodJob(), where(DATUM))).toBeUndefined();
  });

  it('a two-machine location lends the job its OWN machine’s datum, never the other one’s (C’s review)', () => {
    const other = {
      id: 'machine-2',
      profileId: 'Z2',
      activeBedProfileId: 'bp-2',
      bedProfiles: [{ id: 'bp-2', datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null, rotaryFaceAngle: { ...DATUM, value: 9.5 } } }],
    };
    const mine = {
      id: 'machine-1',
      profileId: 'Z1',
      activeBedProfileId: 'bp-1',
      bedProfiles: [{ id: 'bp-1', datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null, rotaryFaceAngle: DATUM } }],
    };
    // The OTHER machine is first: an unbound job naming Z1 must still take Z1's 1.25, not 9.5.
    const two = { machines: [other, mine] } as unknown as LoadedLocation;
    const job = { ...squareChuckJob(), machineId: 'Z1' };
    expect(faceAngleReceiptFor(job, two)).toEqual({ degrees: 1.25, residualMm: 0.03 });
  });

  it('the schema takes the field and stays optional (older receipts parse byte-for-byte)', () => {
    const withAngle = { kind: 'job' as const, outDir: '/x', programs: [], coupon: null, pair: null, faceAngle: { degrees: 1.25, residualMm: 0.03 } };
    expect(engraveDetailsSchema.parse(withAngle).faceAngle).toEqual({ degrees: 1.25, residualMm: 0.03 });
    const without = { kind: 'job' as const, outDir: '/x', programs: [], coupon: null, pair: null };
    expect(engraveDetailsSchema.parse(without).faceAngle).toBeUndefined();
  });
});
