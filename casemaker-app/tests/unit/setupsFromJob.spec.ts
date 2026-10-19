// #471 — the job document's cuts as the setups planner's `Removal[]`.
//
// The planner cannot read an `EngraveJob`: it knows boxes in the stock frame, the faces a removal
// opens to and a volume to weigh. This is the one translation, and the claim the specs pin is that
// the BOXES are the same ones the jaw check and the run sheet read (`sweptCuts`, #488) rather than a
// second walk of the profiles that could disagree with them.

import { describe, expect, it } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

// #516 item 5 — the default job no longer seeds a cutter; the recommendation names `flat-1.0`.
// These engine tests need the job to name its cutter, so `dj()` applies that recommendation.
function dj(...args: Parameters<typeof defaultEngraveJob>): ReturnType<typeof defaultEngraveJob> {
  const job = defaultEngraveJob(...args);
  job.toolKey = 'flat-1.0';
  return job;
}
import { sweptCuts } from '@/engine/cnc/engrave/partPlan';
import { FACING_REMOVAL_ID, isSyntheticRemovalId, removalsFrom } from '@/engine/cnc/setups';
import type { EngraveCircleShape, EngraveDrill, EngraveDrillArrayItem, EngraveDrillItem, EngraveThreadItem } from '@/types/engraveJob';

const shape = (over: Partial<EngraveCircleShape> = {}): EngraveCircleShape => ({
  kind: 'circle',
  id: 'shp-1',
  name: 'a round pocket',
  position: { x: 30, y: 30 },
  rotation: 0,
  depth: 1.5,
  enabled: true,
  diameter: 8,
  ...over,
});

const drill = (over: Partial<EngraveDrillItem> = {}): EngraveDrillItem => ({
  kind: 'drill',
  id: 'drl-1',
  name: 'a hole',
  position: { x: 20, y: 20 },
  rotation: 0,
  depth: 2,
  enabled: true,
  through: false,
  ...over,
});

const array = (over: Partial<EngraveDrillArrayItem> = {}): EngraveDrillArrayItem => ({
  kind: 'drill-array',
  id: 'drl-2',
  name: 'four holes',
  position: { x: 20, y: 20 },
  rotation: 0,
  depth: 2,
  enabled: true,
  through: false,
  count: { x: 2, y: 2 },
  pitch: { x: 10, y: 10 },
  ...over,
});

const thread = (over: Partial<EngraveThreadItem> = {}): EngraveThreadItem => ({
  kind: 'thread',
  id: 'thr-1',
  name: 'an M5 thread',
  position: { x: 40, y: 40 },
  enabled: true,
  size: 'M5',
  standard: 'metric',
  classFit: '6H',
  depth: 3,
  through: false,
  ...over,
});

/** The default job with a controlled item set: three labels out, only what the test adds. */
function jobWith(items: { shapes?: EngraveCircleShape[]; drills?: EngraveDrill[]; threads?: EngraveThreadItem[] }) {
  const job = dj();
  job.labels = [];
  job.shapes = items.shapes ?? [];
  job.drills = items.drills ?? [];
  job.threads = items.threads ?? [];
  return job;
}

describe('#471 removals from the job document', () => {
  it('one removal per enabled cut, with the box the swept-cut reading gives it', () => {
    const job = jobWith({ shapes: [shape()], drills: [drill()], threads: [thread()] });
    const removals = removalsFrom(job);
    expect(removals.map((r) => r.id)).toEqual(['shp-1', 'drl-1', 'thr-1']);
    for (const cut of sweptCuts(job)) {
      const removal = removals.find((r) => r.id === cut.id)!;
      expect(removal.box.min[0]).toBe(cut.box.minX);
      expect(removal.box.max[0]).toBe(cut.box.maxX);
      expect(removal.box.min[1]).toBe(cut.box.minY);
      expect(removal.box.max[1]).toBe(cut.box.maxY);
      // The cut rises from its floor to the stock's top face, never above it.
      expect(removal.box.min[2]).toBe(job.stock.thickness - cut.depth);
      expect(removal.box.max[2]).toBe(job.stock.thickness);
    }
    expect(removals.every((r) => r.opensTo.includes('top'))).toBe(true);
    expect(removals.every((r) => r.volume > 0)).toBe(true);
  });

  it('keeps the default job’s three labels, naming each by its item', () => {
    const job = dj();
    const removals = removalsFrom(job);
    expect(removals.map((r) => r.id)).toEqual(job.labels.map((l) => l.id));
    expect(removals.every((r) => r.name !== '')).toBe(true);
  });

  it('excludes a disabled item, a construction item and every keep-out', () => {
    const job = jobWith({ shapes: [shape(), shape({ id: 'off', enabled: false }), shape({ id: 'ref', construction: true })] });
    job.keepOuts = [
      { id: 'ko-1', name: 'magnet pocket', kind: 'rect', position: { x: 10, y: 10 }, rotation: 0, width: 6, height: 6, cornerRadius: 0, zCeiling: 2, enabled: true },
    ];
    expect(removalsFrom(job).map((r) => r.id)).toEqual(['shp-1']);
  });

  it('an empty job has no removals', () => {
    expect(removalsFrom(jobWith({}))).toEqual([]);
  });

  it('marks a single shape, a single drill and a thread as one connected opening; an array and a label are not', () => {
    const shapes = removalsFrom(jobWith({ shapes: [shape()] }));
    expect(shapes[0]!.connected).toBe(true);
    expect(removalsFrom(jobWith({ drills: [drill()] }))[0]!.connected).toBe(true);
    expect(removalsFrom(jobWith({ drills: [array()] }))[0]!.connected).toBeUndefined();
    expect(removalsFrom(jobWith({ drills: [array({ count: { x: 1, y: 1 } })] }))[0]!.connected).toBe(true);
    expect(removalsFrom(jobWith({ threads: [thread()] }))[0]!.connected).toBe(true);
    expect(removalsFrom(dj())[0]!.connected).toBeUndefined();
  });

  it('a through hole opens to the bottom as well and spans the whole stock', () => {
    const job = jobWith({ drills: [drill({ through: true })] });
    const [removal] = removalsFrom(job);
    expect(removal!.opensTo).toEqual(['top', 'bottom']);
    expect(removal!.box.min[2]).toBe(0);
    expect(removal!.box.max[2]).toBe(job.stock.thickness);
  });

  it('adds the facing pass as a synthetic top-layer removal, and never as an item id', () => {
    const job = jobWith({});
    job.facing = { enabled: true, depth: 0.6 };
    const removals = removalsFrom(job);
    expect(removals).toHaveLength(1);
    const [face] = removals;
    expect(face!.id).toBe(FACING_REMOVAL_ID);
    expect(face!.facing).toBe(true);
    expect(face!.box).toEqual({
      min: [0, 0, job.stock.thickness - 0.6],
      max: [job.stock.length, job.stock.width, job.stock.thickness],
    });
    expect(isSyntheticRemovalId(face!.id)).toBe(true);
    expect(isSyntheticRemovalId('shp-1')).toBe(false);

    job.facing = { enabled: false, depth: 0.6 };
    expect(removalsFrom(job)).toEqual([]);
    job.facing = { enabled: true, depth: 0 };
    expect(removalsFrom(job)).toEqual([]);
  });
});
