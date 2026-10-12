// #363 — the badge route seeds ONE name line.
//
// Taking a badge blank replaced the job's stock, void and depths (#271 route 1, #352, #362) but
// nothing had ever moved the LABELS: the shipped demo job's three lines, laid out for the 100 ×
// 60 mm softwood plank, were left standing on a 76.2 × 38.1 mm badge, so `CASE` at (50, 43) ran off
// the back edge and the wizard's blank step opened on three `item-outside-stock` errors for a job it
// had just built. This spec covers the pure seed, the gate that decides when it may run, and the
// hand-off through the real store — including a real Manifold `generate`, because the bar the issue
// set is that the wizard does not hand over a job its own findings complain about.
//
// Real Manifold + the store's localStorage read, plain Node: the shim below is installed BEFORE the
// store is dynamically imported (the pattern `engraveJob.spec.ts` uses), because the store reads
// localStorage at module load.

import { describe, it, expect, vi } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import {
  BADGE_SEED_TEXT,
  badgeLabelSeed,
  isShippedDemoLabelSet,
  type BadgeSeedBlank,
  type BadgeLabelSeedInputs,
  type SeedMeasure,
} from '@/engine/cnc/engrave/badgeLabelSeed';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultBadgeParams } from '@/types/badge';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { labelProfile } from '@/engine/cnc/engrave/partPlan';
import { aabbOfProfile } from '@/engine/compiler/profile';
import type { EngraveJob } from '@/types/engraveJob';

// A minimal in-memory Storage, installed before any store import — the unit suite runs on node,
// where localStorage does not exist and the store deliberately no-ops.
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

const KEY = 'casemaker.engraveJob.v1';

async function freshStore() {
  vi.resetModules();
  return await import('@/store/engraveJobStore');
}

/** The badge route's own blank, in the seed's shape — the same extraction `takeBadgeBlank` does. */
const badge = badgeBlankFor(defaultBadgeParams());
const pocket = badge.pocket?.kind === 'rect' ? badge.pocket : null;
const BLANK: BadgeSeedBlank = {
  length: badge.stock.length,
  width: badge.stock.width,
  pocket,
};

/**
 * The face the app measures with, mirrored from the store's adapter (#363): the module takes the
 * measurement injected so it stays free of the font registry, so a spec that wants the numbers the
 * WIZARD gets has to inject the real one. Correct for 'Name' bold in the bundled default face:
 * 3.536 mm of ink per millimetre of cap height, and 1.011 of height.
 */
const measure: SeedMeasure = (text, font, weight, size) => {
  try {
    const box = aabbOfProfile(
      labelProfile(
        { id: 'probe', text, font, weight, size, position: { x: 0, y: 0 }, rotation: 0, depth: 1, enabled: true },
        [],
      ),
    );
    return box ? { width: box.max[0] - box.min[0], height: box.max[1] - box.min[1] } : null;
  } catch {
    return null;
  }
};

function seed(over: Partial<BadgeLabelSeedInputs> = {}) {
  return badgeLabelSeed({
    blank: BLANK,
    edgeMargin: defaultEngraveJob().edgeMargin,
    font: DEFAULT_FONT_ID,
    weight: 'bold',
    measure,
    ...over,
  });
}

describe('#363 — the badge label seed', () => {
  it('lays one name line on the default badge, centred, in the front band', () => {
    const line = seed();
    expect(line).not.toBeNull();
    if (!line) return;
    expect(line.text).toBe(BADGE_SEED_TEXT);
    // Centred on the blank's X…
    expect(line.position.x).toBeCloseTo(38.1, 6);
    // …and in the band BELOW the pocket, ties going to the front (the operator's edge). The pocket
    // is centred at 19.05 with a 13 mm height, so it spans 12.55 … 25.55 and the two free strips are
    // 1 … 12.55 and 25.55 … 37.1 — both exactly 11.55 tall, so the FRONT one wins the tie and the
    // line's centre is 6.775.
    expect(line.position.y).toBeCloseTo(6.775, 6);
    // 0.7 × 11.55 = 8.085, floored to the 8 mm cap the issue's decision quotes — and it fits the
    // 74.2 mm of usable width at that size, so nothing shrinks it.
    expect(line.size).toBe(8);
    expect(line.rotation).toBe(0);
    expect(line.enabled).toBe(true);
    // The placeholder depth is the same floor `newLabel` writes; `redepthLabelsForBlank` owns the
    // real number (asserted on the store hand-off below).
    expect(line.depth).toBe(0.5);
  });

  it('mints a fresh id every time, so two seeds never collide', () => {
    const a = seed();
    const b = seed();
    expect(a!.id).toBeTruthy();
    expect(a!.id).not.toBe(b!.id);
  });

  it('takes the roomier band, and the front one only on a tie', () => {
    // A pocket pushed to the front leaves a taller strip behind it.
    const line = seed({
      blank: {
        length: 76.2,
        width: 38.1,
        pocket: { ...pocket!, position: { x: 38.1, y: 8 }, height: 6 },
      },
    });
    // Bands are 1 … 5 (4 mm) and 11 … 37.1 (26.1 mm): the BACK one has the room.
    expect(line!.position.y).toBeCloseTo((11 + 37.1) / 2, 6);
    // floor(0.7 × 26.1) = 18, and the line fits the 74.2 mm of usable width at that size, so the
    // roomier band also gets the roomier line.
    expect(line!.size).toBe(18);
  });

  it('treats a blank with no pocket as one band over its whole usable area', () => {
    const line = seed({ blank: { length: 76.2, width: 38.1, pocket: null } });
    expect(line!.position.y).toBeCloseTo(19.05, 6); // the blank's own centre
    // 0.7 × 36.1 = 25 is the starting cap, but 'Name' is 3.536 mm of ink per millimetre of cap, so
    // 25 mm would run 88 mm past the 74.2 mm usable width: the search walks down to the largest size
    // that fits, 20 mm (70.7 mm wide).
    expect(line!.size).toBe(20);
  });

  it('falls back to the blank centre when the pocket leaves no free strip at all', () => {
    // A pocket taller than the usable width splits the area into two strips of negative height, so
    // there is no free band: the line is centred on the blank and the caller's `item-over-void`
    // warning is the honest report.
    const line = seed({
      blank: {
        length: 76.2,
        width: 20,
        pocket: { ...pocket!, position: { x: 38.1, y: 10 }, height: 30 },
      },
    });
    expect(line!.position.y).toBeCloseTo(10, 6);
  });

  it('estimates the ink box when the face is not parsed, and shrinks the size to fit', () => {
    // A 10-character line on a narrow blank: the ≈0.6 em/char estimate puts the widest that fits at
    // 0.6 × size × 10 ≤ 18, i.e. size 3.
    const line = badgeLabelSeed({
      blank: { length: 20, width: 30, pocket: null },
      edgeMargin: 1,
      font: DEFAULT_FONT_ID,
      weight: 'bold',
      text: 'AAAAAAAAAA',
      measure: () => null,
    });
    expect(line!.size).toBe(3);
    expect(line!.position.y).toBeCloseTo(15, 6);
  });

  it('shrinks a real measurement down until it fits, and gives up when none does', () => {
    const wide = badgeLabelSeed({
      blank: { length: 20, width: 30, pocket: null },
      edgeMargin: 1,
      font: DEFAULT_FONT_ID,
      weight: 'bold',
      measure: () => ({ width: 100, height: 1 }),
    });
    expect(wide).toBeNull();

    // A measurement that caps the height is honoured the same way — nothing fits under 1 mm, so
    // there is no line to seed.
    const tall = badgeLabelSeed({
      blank: { length: 76.2, width: 38.1, pocket: null },
      edgeMargin: 1,
      font: DEFAULT_FONT_ID,
      weight: 'bold',
      measure: () => ({ width: 1, height: 100 }),
    });
    expect(tall).toBeNull();
  });

  it('declines on a blank that cannot hold a line at all', () => {
    // No usable width: the edge inset meets in the middle.
    expect(seed({ blank: { length: 2, width: 10, pocket: null }, edgeMargin: 1 })).toBeNull();
    // No usable height either.
    expect(seed({ blank: { length: 50, width: 1, pocket: null }, edgeMargin: 0.6 })).toBeNull();
    // Nothing at 1 mm fits the width.
    expect(seed({ blank: { length: 2, width: 10, pocket: null }, edgeMargin: 0.5 })).toBeNull();
    // A whitespace placeholder is not a line.
    expect(seed({ text: '   ' })).toBeNull();
  });
});

describe('#363 — the shipped-demo gate', () => {
  it('recognises the untouched default job', () => {
    expect(isShippedDemoLabelSet(defaultEngraveJob())).toBe(true);
  });

  it('stands aside the moment a label says something the shipped set does not', () => {
    const touched = (mutate: (job: EngraveJob) => void): boolean => {
      const job = defaultEngraveJob();
      mutate(job);
      return isShippedDemoLabelSet(job);
    };

    expect(touched((j) => (j.labels[0]!.text = 'DAVE'))).toBe(false);
    expect(touched((j) => (j.labels[0]!.position.y = 20))).toBe(false);
    expect(touched((j) => (j.labels[0]!.depth = 1.1))).toBe(false);
    expect(touched((j) => (j.labels[0]!.depthIntent = 'surface'))).toBe(false);
    // An explicit `construction: false` is NOT a change: the label cuts either way, and the gate
    // compares what a label means, not which keys happen to be present.
    expect(touched((j) => (j.labels[0]!.construction = false))).toBe(true);
    expect(touched((j) => (j.labels[0]!.construction = true))).toBe(false);
    expect(touched((j) => j.labels.pop())).toBe(false);
    expect(touched((j) => j.labels.reverse())).toBe(false);
    expect(touched((j) => (j.sources = { labels: { l: { depth: 'user' } } }))).toBe(false);
  });
});

describe('#363 — the store hand-off', () => {
  it('takes a badge blank and hands over ONE seeded, re-depth-ed line', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
    const job = s().job;
    expect(job.stock.thickness).toBe(3.81);
    // The three demo lines are gone; one name line took their place.
    expect(job.labels).toHaveLength(1);
    const line = job.labels[0]!;
    expect(line.text).toBe('Name');
    expect(line.position).toMatchObject({ x: 38.1 });
    expect(line.position.y).toBeCloseTo(6.775, 6);
    // The magnet pocket leaves 3.81 − 2.3 − 1 = 0.51 mm of material above it, which is shallower
    // than the jaws' own 1.905 − 1 = 0.905 — so 0.51 is the answer #362's walk writes, and the
    // STARTING_DEPTH placeholder is gone.
    expect(line.depth).toBe(0.51);
    expect(job.sources?.labels).toEqual({ [line.id]: { depth: 'computed' } });
  });

  it('leaves a label set the person has touched exactly where it is', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    const id = s().job.labels[0]!.id;
    s().updateLabel(id, { text: 'DAVE' });
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));

    const job = s().job;
    expect(job.labels).toHaveLength(3);
    expect(job.labels.map((l) => l.text)).toEqual(['DAVE', 'MAKER', 'first chips']);
    // Nothing claimed a depth, so #362's walk still re-depths them for the new blank — the person
    // moved the words, not the numbers.
    expect(job.labels.map((l) => l.depth)).toEqual([0.51, 0.51, 0.51]);
  });

  it('a removed label takes its claim with it (#363 review nit)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    const id = s().job.labels[0]!.id;
    s().updateLabel(id, { depth: 1.2 });
    expect(s().job.sources?.labels?.[id]).toEqual({ depth: 'user' });

    s().removeLabel(id);
    // The entry is gone, not orphaned — and with no claims left at all, so is the map, so the job
    // is byte-identically the one it was before the label was ever touched.
    expect(s().job.sources?.labels).toBeUndefined();
    expect(isShippedDemoLabelSet(s().job)).toBe(false); // two demo labels remain, so still not shipped
  });

  it('generates the seeded badge clean: no error finding, and no cut over the pocket (#363)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));

    const g = generate(tl, s().job);
    expect(g.ok).toBe(true);
    expect(g.stage).toBe('done');
    expect(g.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(g.verify!.findings.filter((f) => f.severity === 'error')).toEqual([]);
    // The line sits in the free band, clear of the magnet pocket, so there is nothing to warn about.
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  }, 60_000);

  it('is not affected by a job loaded from storage that already carries a claim', async () => {
    backing.clear();
    const seeded = defaultEngraveJob();
    const id = seeded.labels[0]!.id;
    seeded.labels[0] = { ...seeded.labels[0]!, depth: 1.2 };
    seeded.sources = { labels: { [id]: { depth: 'user' } } };
    backing.set(KEY, JSON.stringify(seeded));

    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));

    // The person's depth kept the job out of the seed, so the three lines stay — and the claimed
    // one keeps its number through the re-depth.
    expect(s().job.labels).toHaveLength(3);
    expect(s().job.labels[0]!.depth).toBe(1.2);
  });
});
