// User-selected sacrificial material (#213): the pure geometry, the validators, the jaw shift
// and the schema migration. Pure data — no wasm, no React, no worker.

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_BREAKTHROUGH,
  hasSacrificial,
  noneSacrificial,
  presetJawStrips,
  presetPartOnBoard,
  sacrificialBoxes,
  stripHeight,
  supportedFootprint,
  validateSacrificial,
  viseJawShift,
  type SacrificialBox,
} from '@/engine/cnc/sacrificial';
import { boxesOverlap } from '@/engine/cnc/fixture';
import type { ObstacleBox } from '@/engine/cnc/setup';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { aabbOfProfile } from '@/engine/compiler/profile';
import type { EngraveJob, Sacrificial } from '@/types/engraveJob';

const STOCK = { length: 100, width: 60, thickness: 12 };

/** The part itself as an obstacle box, for the "no box overlaps the part volume" check. */
const PART_BOX: ObstacleBox = { id: 'part', label: 'part', min: [0, 0, -12], max: [100, 60, 0] };

function asObstacle(b: SacrificialBox): ObstacleBox {
  return { id: b.id, label: b.id, min: b.min, max: b.max };
}

function withSacrificial(job: EngraveJob, s: Sacrificial): EngraveJob {
  return { ...job, sacrificial: s };
}

describe('sacrificialBoxes (#213)', () => {
  it('a board under the part with overhang is exactly as defined', () => {
    const s: Sacrificial = {
      ...noneSacrificial(),
      under: { thickness: 5, overhang: { left: 10, right: 10, front: 10, back: 10 }, attach: 'tape' },
    };
    const boxes = sacrificialBoxes(STOCK, s);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ id: 'under', min: [-10, -10, -17], max: [110, 70, -12] });
  });

  it('a flush left strip sits between the fixed jaw and the part', () => {
    const s: Sacrificial = {
      ...noneSacrificial(),
      sides: { ...noneSacrificial().sides, left: { thickness: 6, height: 'flush' } },
    };
    const boxes = sacrificialBoxes(STOCK, s);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ id: 'left', min: [-6, 0, -12], max: [0, 60, 0] });
  });

  it('right, front and back strips mirror the left construction', () => {
    const s: Sacrificial = {
      ...noneSacrificial(),
      sides: {
        left: null,
        right: { thickness: 4, height: 8 },
        front: { thickness: 3, height: 'flush' },
        back: { thickness: 5, height: 6 },
      },
    };
    const byId = Object.fromEntries(sacrificialBoxes(STOCK, s).map((b) => [b.id, b]));
    expect(byId.right).toMatchObject({ min: [100, 0, -12], max: [104, 60, -4] });
    expect(byId.front).toMatchObject({ min: [0, -3, -12], max: [100, 0, 0] });
    expect(byId.back).toMatchObject({ min: [0, 60, -12], max: [100, 65, -6] });
  });

  it('no sacrificial box overlaps the part volume (touching is not overlap)', () => {
    const s: Sacrificial = {
      ...noneSacrificial(),
      under: { thickness: 5, overhang: { left: 10, right: 10, front: 10, back: 10 }, attach: 'tape' },
      sides: {
        left: { thickness: 6, height: 'flush' },
        right: { thickness: 6, height: 'flush' },
        front: { thickness: 6, height: 'flush' },
        back: { thickness: 6, height: 'flush' },
      },
    };
    for (const b of sacrificialBoxes(STOCK, s)) {
      expect(boxesOverlap(asObstacle(b), PART_BOX)).toBe(false);
    }
  });

  it('stripHeight resolves "flush" to the part thickness', () => {
    expect(stripHeight({ thickness: 6, height: 'flush' }, 12)).toBe(12);
    expect(stripHeight({ thickness: 6, height: 8 }, 12)).toBe(8);
  });
});

describe('supportedFootprint (#213)', () => {
  it('is exactly the part outline with no sacrificial material', () => {
    const box = aabbOfProfile(supportedFootprint(STOCK, noneSacrificial()))!;
    expect(box.min).toEqual([0, 0]);
    expect(box.max).toEqual([100, 60]);
  });

  it('unions the part with the board overhang and the strips', () => {
    const s: Sacrificial = {
      ...noneSacrificial(),
      under: { thickness: 5, overhang: { left: 10, right: 10, front: 10, back: 10 }, attach: 'tape' },
      sides: { ...noneSacrificial().sides, right: { thickness: 6, height: 'flush' } },
    };
    const box = aabbOfProfile(supportedFootprint(STOCK, s))!;
    // The board reaches 110/70; the 6 mm right strip (to 106) sits inside it.
    expect(box.min).toEqual([-10, -10]);
    expect(box.max).toEqual([110, 70]);
  });
});

describe('validateSacrificial (#213)', () => {
  it('flags a front strip with no board under the part', () => {
    const job = withSacrificial(defaultEngraveJob(), {
      ...noneSacrificial(),
      sides: { ...noneSacrificial().sides, front: { thickness: 6, height: 'flush' } },
    });
    const f = validateSacrificial(job).find((x) => x.code === 'side-strip-unsupported');
    expect(f?.severity).toBe('error');
  });

  it('allows a left strip with no board (it is clamped by the jaws)', () => {
    const job = withSacrificial(defaultEngraveJob(), {
      ...noneSacrificial(),
      sides: { ...noneSacrificial().sides, left: { thickness: 6, height: 'flush' } },
    });
    expect(validateSacrificial(job).some((x) => x.code === 'side-strip-unsupported')).toBe(false);
  });

  it('errors when a strip is taller than the part', () => {
    const job = withSacrificial(defaultEngraveJob(), {
      ...noneSacrificial(),
      sides: { ...noneSacrificial().sides, left: { thickness: 6, height: 20 } },
    });
    const f = validateSacrificial(job).find((x) => x.code === 'strip-taller-than-part');
    expect(f?.severity).toBe('error');
  });

  it('warns when the part is only loose on the board', () => {
    const job = withSacrificial(defaultEngraveJob(), {
      ...noneSacrificial(),
      under: { thickness: 10, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'loose' },
    });
    expect(validateSacrificial(job).some((x) => x.code === 'under-loose')).toBe(true);
  });

  it('errors when the board cannot absorb the breakthrough', () => {
    const job = withSacrificial(defaultEngraveJob(), {
      ...noneSacrificial(),
      under: { thickness: 1, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'tape' },
    });
    job.breakthrough = DEFAULT_BREAKTHROUGH; // 0.3 > 1 - 1
    expect(validateSacrificial(job).some((x) => x.code === 'under-too-thin')).toBe(true);
  });

  it('does not warn about default provenance when there is no sacrificial material', () => {
    expect(validateSacrificial(defaultEngraveJob()).some((x) => x.code === 'sacrificial-default')).toBe(false);
  });

  it('warns about default provenance when material is present', () => {
    const job = withSacrificial(defaultEngraveJob(), {
      ...noneSacrificial(),
      sides: { ...noneSacrificial().sides, left: { thickness: 6, height: 'flush' } },
    });
    expect(job.sacrificial.source).toBe('default');
    expect(validateSacrificial(job).some((x) => x.code === 'sacrificial-default')).toBe(true);
  });

  it('is surfaced through validateJob', () => {
    const job = withSacrificial(defaultEngraveJob(), {
      ...noneSacrificial(),
      sides: { ...noneSacrificial().sides, front: { thickness: 6, height: 'flush' } },
    });
    expect(validateJob(job).some((x) => x.code === 'side-strip-unsupported')).toBe(true);
  });
});

describe('viseJawShift (#213)', () => {
  it('moves the fixed jaw out by a 6 mm left strip', () => {
    const s: Sacrificial = {
      ...noneSacrificial(),
      sides: { ...noneSacrificial().sides, left: { thickness: 6, height: 'flush' } },
    };
    expect(viseJawShift(s)).toEqual({ left: 6, right: 0 });
  });

  it('takes the larger of the strip and the board overhang on each side', () => {
    const s: Sacrificial = {
      ...noneSacrificial(),
      under: { thickness: 5, overhang: { left: 10, right: 2, front: 4, back: 4 }, attach: 'tape' },
      sides: { ...noneSacrificial().sides, left: { thickness: 6, height: 'flush' } },
    };
    expect(viseJawShift(s)).toEqual({ left: 10, right: 2 });
  });
});

describe('presets (#213)', () => {
  it('"Strips between the jaws" is left+right 6 mm flush, and moves both jaws', () => {
    const s = presetJawStrips();
    expect(s.sides.left).toEqual({ thickness: 6, height: 'flush' });
    expect(s.sides.right).toEqual({ thickness: 6, height: 'flush' });
    expect(viseJawShift(s)).toEqual({ left: 6, right: 6 });
    expect(hasSacrificial(s)).toBe(true);
  });

  it('"Part on a larger board" is a taped board with a 10 mm overhang all round', () => {
    const s = presetPartOnBoard();
    expect(s.under).toEqual({
      thickness: 12,
      overhang: { left: 10, right: 10, front: 10, back: 10 },
      attach: 'tape',
    });
    expect(hasSacrificial(s)).toBe(true);
  });
});

describe('EngraveJob schema migration (#213)', () => {
  it('the default job is version 2 with no sacrificial material', () => {
    const job = defaultEngraveJob();
    expect(job.schemaVersion).toBe(2);
    expect(job.sacrificial).toEqual(noneSacrificial());
    expect(job.breakthrough).toBe(DEFAULT_BREAKTHROUGH);
  });

  it('round-trips a version-2 job with sacrificial material through JSON', () => {
    const job = withSacrificial(defaultEngraveJob(), presetJawStrips());
    const parsed = parseEngraveJob(JSON.parse(JSON.stringify(job)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.sacrificial).toEqual(presetJawStrips());
    expect(parsed.job).toEqual(job);
  });

  it('loads a version-1 job as version 2 with no sacrificial material', () => {
    const v2 = defaultEngraveJob();
    const v1 = { ...v2, schemaVersion: 1 } as Record<string, unknown>;
    delete v1.sacrificial;
    delete v1.breakthrough;

    const parsed = parseEngraveJob(v1);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.schemaVersion).toBe(2);
    expect(parsed.job.sacrificial).toEqual(noneSacrificial());
    expect(parsed.job.breakthrough).toBe(DEFAULT_BREAKTHROUGH);
  });

  it('rejects a version-2 job whose sacrificial side has a non-positive thickness', () => {
    const job = withSacrificial(defaultEngraveJob(), {
      ...noneSacrificial(),
      sides: { ...noneSacrificial().sides, left: { thickness: 0, height: 'flush' } },
    });
    expect(parseEngraveJob(job).ok).toBe(false);
  });
});
