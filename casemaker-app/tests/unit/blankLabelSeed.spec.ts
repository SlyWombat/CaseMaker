// #363/#364 — the ONE line a blank route seeds.
//
// Taking a blank replaced the job's stock, void and depths (#271 route 1, #352, #362) but nothing
// had ever moved the LABELS: the shipped demo job's three lines, laid out for the 100 × 60 mm
// softwood plank, were left standing on whatever blank was taken — a 76.2 × 38.1 mm badge (where
// `CASE` at (50, 43) ran off the back edge and the wizard's blank step opened on three
// `item-outside-stock` errors), or a 60 × 40 mm bare blank (#364), in the same way. This spec covers
// the pure seed, the gate that decides when it may run, and the hand-off through the real store —
// including a real Manifold `generate`, because the bar the issues set is that the wizard does not
// hand over a job its own findings complain about.
//
// #363 REVIEW — the gate is on PROVENANCE, not on values: `computed` is the app's own past answer,
// and a job the OLD badge route had already re-depth-ed (three lines, 0.51 mm, stamped `computed`,
// never moved) is still the app's set and must be re-laid. The tests below pin both directions:
// that job re-seeds, and a line the person has touched does not — including the line a previous
// take seeded, which is recognised by its `layout: 'computed'` stamp alone.
//
// Real Manifold + the store's localStorage read, plain Node: the shim below is installed BEFORE the
// store is dynamically imported (the pattern `engraveJob.spec.ts` uses), because the store reads
// localStorage at module load.

import { describe, it, expect, vi } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { generate } from './helpers/engravePipeline';
import {
  BADGE_SEED_TEXT,
  BLANK_SEED_TEXT,
  blankLabelSeed,
  isShippedDemoLabelSet,
  mayRelayoutLabels,
  type SeedBlank,
  type LabelSeedInputs,
} from '@/engine/cnc/engrave/blankLabelSeed';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { badgeBlankFor } from '@/engine/cnc/engrave/fromBadge';
import { defaultBadgeParams } from '@/types/badge';
import { defaultBlankParams, type BlankParams } from '@/types/blank';
import { DEFAULT_FONT_ID } from '@/engine/fonts/registry';
import { labelGlyphMeasure } from '@/engine/cnc/engrave/partPlan';
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

const KEY = 'casemaker.engraveJob.v3';

async function freshStore() {
  vi.resetModules();
  return await import('@/store/engraveJobStore');
}

/** The badge route's own blank, in the seed's shape — the same extraction `takeBadgeBlank` does. */
const badge = badgeBlankFor(defaultBadgeParams());
const pocket = badge.pocket?.kind === 'rect' ? badge.pocket : null;
const BLANK: SeedBlank = {
  length: badge.stock.length,
  width: badge.stock.width,
  pocket,
};

/**
 * The face the app measures with — the app's OWN adapter (#363, #365), not a copy of it: the module
 * takes the measurement injected so it stays free of the font registry, and a spec that wants the
 * numbers the WIZARD gets should measure with the same function the store does. Correct for 'Name'
 * bold in the bundled default face: 3.536 mm of ink per millimetre of cap height, and 1.011 of
 * height.
 */
const measure = labelGlyphMeasure([]);

function seed(over: Partial<LabelSeedInputs> = {}) {
  return blankLabelSeed({
    blank: BLANK,
    edgeMargin: defaultEngraveJob().edgeMargin,
    font: DEFAULT_FONT_ID,
    weight: 'bold',
    measure,
    ...over,
  });
}

describe('#363/#364 — the blank label seed', () => {
  it('lays one name line on the default badge blank, centred, in the front band', () => {
    // `BLANK` is `badgeBlankFor`'s own output, so it is the TURNED frame (#383): 38.1 across (X),
    // 76.2 along (Y). This case is the pure seed's default — text along X — on that blank.
    const line = seed();
    expect(line).not.toBeNull();
    if (!line) return;
    expect(line.text).toBe(BADGE_SEED_TEXT);
    // Centred on the blank's X…
    expect(line.position.x).toBeCloseTo(19.05, 6);
    // …and in the band BELOW the pocket, ties going to the front (the operator's edge). The pocket
    // is centred at 38.1 with a 45 mm height, so it spans 15.6 … 60.6 and the two free strips are
    // 1 … 15.6 and 60.6 … 75.2 — both exactly 14.6 tall, so the FRONT one wins the tie and the
    // line's centre is 8.3.
    expect(line.position.y).toBeCloseTo(8.3, 6);
    // The DEFAULT band fill, 0.7 × 14.6 = 10.22, floors to 10 mm — and the line fits the 36.1 mm
    // of usable width at that size, so nothing shrinks it.
    expect(line.size).toBe(10);
    expect(line.rotation).toBe(0);
    expect(line.enabled).toBe(true);
    // The placeholder depth is the same floor `newLabel` writes; `redepthLabelsForBlank` owns the
    // real number (asserted on the store hand-off below).
    expect(line.depth).toBe(0.5);
  });

  it('reads the line along Y when the badge route asks for it (#383)', () => {
    // The badge route's own call: the blank is on the bench turned, and a name reads along its long
    // side. The seed lays the line out in the TEXT's frame — the badge's own 76.2 × 38.1, whose
    // numbers the frame above used to be — and turns the answer back, so the line lands on the same
    // physical ink box as before the turn, reading along Y.
    const line = seed({ textAlong: 'y' });
    expect(line).not.toBeNull();
    if (!line) return;
    expect(line.rotation).toBe(90);
    // The text frame's (38.1, 6.775) — band centre 6.775, reading axis centred on 76.2 — mapped
    // back: job_x = length − v, job_y = u.
    expect(line.position.x).toBeCloseTo(38.1 - 6.775, 6);
    expect(line.position.y).toBeCloseTo(38.1, 6);
    // Same band, same cap height: only the direction and the turnaround changed.
    expect(line.size).toBe(8);
  });

  it('mints a fresh id every time, so two seeds never collide', () => {
    const a = seed();
    const b = seed();
    expect(a!.id).toBeTruthy();
    expect(a!.id).not.toBe(b!.id);
  });

  it('takes the roomier band, and the front one only on a tie', () => {
    // A pocket pushed to the front leaves a taller strip behind it. (Kept in the badge's own
    // 76.2 × 38.1 frame: this case is about the band arithmetic, which also runs in the text frame
    // the badge route uses — same numbers, same answer.)
    const line = seed({
      blank: {
        length: 76.2,
        width: 38.1,
        pocket: { ...pocket!, position: { x: 38.1, y: 8 }, height: 6 },
      },
    });
    // Bands are 1 … 5 (4 mm) and 11 … 37.1 (26.1 mm): the BACK one has the room.
    expect(line!.position.y).toBeCloseTo((11 + 37.1) / 2, 6);
    // floor(0.7 × 26.1) = 18, but the line has to fit the 74.2 mm of usable width too — 3.536 mm of
    // ink per millimetre of cap puts 18 mm at 63.6 mm, which does fit. Sized to the room, not the
    // width.
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
    // A 4-character line on a narrow blank, with no face up: the fallback's 1.95 em/char (an upper
    // bound over every bundled face, #364/#365 — see `inkBoxEstimate.spec.ts`) puts the widest that
    // fits at 1.95 × size × 4 ≤ 18, i.e. size 2, and 2 mm is laid out rather than nothing.
    const line = blankLabelSeed({
      blank: { length: 20, width: 30, pocket: null },
      edgeMargin: 1,
      font: DEFAULT_FONT_ID,
      weight: 'bold',
      text: 'AAAA',
      measure: () => null,
    });
    expect(line!.size).toBe(2);
    expect(line!.position.y).toBeCloseTo(15, 6);

    // The same blank and a 10-character line: the estimate needs 19.5 mm of width for even 1 mm of
    // cap, so there is no size at or above 1 that fits and nothing is seeded. That is the honest
    // answer for a line that long on an 18 mm face — and the SEED does not rely on it any more: the
    // callers load the faces first (`ensureFontsLoaded`), so this path is the residual one (#365
    // review).
    const tooLong = blankLabelSeed({
      blank: { length: 20, width: 30, pocket: null },
      edgeMargin: 1,
      font: DEFAULT_FONT_ID,
      weight: 'bold',
      text: 'AAAAAAAAAA',
      measure: () => null,
    });
    expect(tooLong).toBeNull();
  });

  it('shrinks a real measurement down until it fits, and gives up when none does', () => {
    const wide = blankLabelSeed({
      blank: { length: 20, width: 30, pocket: null },
      edgeMargin: 1,
      font: DEFAULT_FONT_ID,
      weight: 'bold',
      measure: () => ({ width: 100, height: 1 }),
    });
    expect(wide).toBeNull();

    // A measurement that caps the height is honoured the same way — nothing fits under 1 mm, so
    // there is no line to seed.
    const tall = blankLabelSeed({
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

describe('#451 — the band fill is the shop default', () => {
  it('uses the labelled fallback when the caller passes none', () => {
    // The default badge's front band is 14.6 mm in the turned frame (see the first test above):
    // 0.7 × 14.6 = 10.22, floored to the 10 mm cap the issue's decision quotes. The store hand-off
    // below exercises this same path, so the no-service build is covered through the real caller
    // as well.
    expect(seed()!.size).toBe(10);
  });

  it('takes the fraction the caller passes', () => {
    // 0.5 × 14.6 = 7.3, floored to 7 — and 'Name' fits the 36.1 mm of usable width at that size.
    expect(seed({ bandFill: 0.5 })!.size).toBe(7);
    // A full band is allowed: floor(1 × 14.6) = 14, but 'Name' bold is 3.536 × 14 = 49.5 mm wide,
    // past the 36.1 mm usable width, so the search walks down to 10 (35.4 mm wide, 10.1 mm tall).
    expect(seed({ bandFill: 1 })!.size).toBe(10);
  });

  it('falls back rather than seeding nothing when the fraction is out of range', () => {
    // Zero or less would floor the starting cap below 1 mm and the search would never run; more
    // than 1 is not "part of the band". The location's own rule refuses both, but a hand-built
    // caller can pass them, so the labelled fallback stands — the same reading the sim's pitches
    // take (#438/#451).
    for (const bad of [0, -0.2, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(seed({ bandFill: bad })!.size).toBe(10);
    }
  });
});

describe('#364 — the bare-blank seed', () => {
  it('sets one Text line on the whole usable face of a blank with no pocket', () => {
    const line = seed({ blank: { length: 100, width: 60, pocket: null }, text: BLANK_SEED_TEXT });
    expect(line).not.toBeNull();
    if (!line) return;
    expect(line.text).toBe(BLANK_SEED_TEXT);
    expect(line.text).toBe('Text');
    // No pocket, so `freeBands` answers the whole usable face as ONE band and the line is centred on
    // the blank itself (not in a front band, which is what the badge's split face gives).
    expect(line.position.x).toBeCloseTo(50, 6);
    expect(line.position.y).toBeCloseTo(30, 6);
    // The cap starts at floor(0.7 × 58) = 40 mm and the search walks down a millimetre at a time
    // until the real ink box fits both the band's 58 mm of height and the 98 mm of usable width.
    const ink = measure(line.text, DEFAULT_FONT_ID, 'bold', line.size)!;
    expect(ink.height).toBeLessThanOrEqual(58);
    expect(ink.width).toBeLessThanOrEqual(98);
    expect(line.rotation).toBe(0);
    expect(line.enabled).toBe(true);
    // The placeholder depth the caller's walk replaces; asserted on the store hand-off below.
    expect(line.depth).toBe(0.5);
  });

  it('carries the placeholder the caller asks for, and Name only by default', () => {
    // The module's default is still the badge's placeholder, so the bare route has to be explicit —
    // which is the point of having two exported constants rather than one string.
    expect(BADGE_SEED_TEXT).toBe('Name');
    expect(BLANK_SEED_TEXT).toBe('Text');
    expect(seed({ blank: { length: 100, width: 60, pocket: null } })!.text).toBe('Name');
    expect(
      seed({ blank: { length: 100, width: 60, pocket: null }, text: BLANK_SEED_TEXT })!.text,
    ).toBe('Text');
  });
});

describe('#363 — the gate that decides whether the labels may be replaced', () => {
  it('recognises the untouched default job', () => {
    expect(isShippedDemoLabelSet(defaultEngraveJob())).toBe(true);
    expect(mayRelayoutLabels(defaultEngraveJob())).toBe(true);
  });

  it('opens for a job the OLD badge route had already re-depth-ed (review)', () => {
    // Exactly what a pre-#363 badge hand-off left behind: the three demo lines, still where the
    // plank put them, re-depth-ed to the badge's 0.51 mm and stamped `computed` by the walk. That
    // stamp is the app's own past answer — not a person's — so treating it as a claim, or comparing
    // the depth, left these jobs unseeded for good and a second take never re-laid them.
    const old = defaultEngraveJob();
    old.labels = old.labels.map((l) => ({ ...l, depth: 0.51 }));
    old.sources = {
      labels: Object.fromEntries(old.labels.map((l) => [l.id, { depth: 'computed' as const }])),
    };
    expect(isShippedDemoLabelSet(old)).toBe(true);
    expect(mayRelayoutLabels(old)).toBe(true);

    // The same job with a depth the person stated is theirs, and is left alone.
    old.sources = {
      labels: Object.fromEntries(old.labels.map((l) => [l.id, { depth: 'user' as const }])),
    };
    expect(mayRelayoutLabels(old)).toBe(false);
  });

  it('stands aside the moment a label says something the shipped set does not', () => {
    const touched = (mutate: (job: EngraveJob) => void): boolean => {
      const job = defaultEngraveJob();
      mutate(job);
      return mayRelayoutLabels(job);
    };

    expect(touched((j) => (j.labels[0]!.text = 'DAVE'))).toBe(false);
    expect(touched((j) => (j.labels[0]!.position.y = 20))).toBe(false);
    expect(touched((j) => j.labels.pop())).toBe(false);
    expect(touched((j) => j.labels.reverse())).toBe(false);
    expect(touched((j) => (j.labels = []))).toBe(false);
    // The DEPTH alone no longer decides anything (#363 review): a typed depth is stamped `user` by
    // `updateLabel` (asserted on the store hand-off below), so an unstamped one is the app's own —
    // or one typed before #362, which the re-depth walk already documents as indistinguishable.
    expect(touched((j) => (j.labels[0]!.depth = 1.1))).toBe(true);
    // …and NEITHER does the INTENT, for the same reason (folding the #363-review follow-up): the
    // walk writes `'reveal'` on a printed badge's floor and stamps it `computed`, so the value alone
    // says nothing about who decided — a pre-#363 split-badge job would otherwise never re-seed.
    expect(touched((j) => (j.labels[0]!.depthIntent = 'surface'))).toBe(true);
    // An explicit `construction: false` is NOT a change: the label cuts either way, and the gate
    // compares what a label means, not which keys happen to be present.
    expect(touched((j) => (j.labels[0]!.construction = false))).toBe(true);
    expect(touched((j) => (j.labels[0]!.construction = true))).toBe(false);
    // A claim someone STATED is a person's, whatever the values say…
    expect(touched((j) => (j.sources = { labels: { l: { depth: 'user' } } }))).toBe(false);
    expect(touched((j) => (j.sources = { labels: { l: { layout: 'user' } } }))).toBe(false);
    expect(touched((j) => (j.sources = { labels: { l: { depthIntent: 'user' } } }))).toBe(false);
    // …and a `computed` one is not: it is a past answer of the app's own, not a decision.
    expect(touched((j) => (j.sources = { labels: { l: { layout: 'computed' } } }))).toBe(true);
    expect(
      touched((j) => (j.sources = { labels: { l: { depth: 'computed', depthIntent: 'computed' } } })),
    ).toBe(true);
  });

  it('re-seeds a pre-#363 split-badge job, whose walk wrote the intent it now carries (review)', () => {
    // What `redepthLabelsForBlank` leaves on a SPLIT badge: every label re-depth-ed and stamped
    // `computed`, and a `'reveal'` on each floor because the badge's second colour makes one
    // meaningful. Before the follow-up `demoShape` compared `depthIntent` by VALUE, so this job
    // looked touched for ever — the same trap the depth comparison was.
    const split = defaultEngraveJob();
    split.labels = split.labels.map((l) => ({ ...l, depth: 0.51, depthIntent: 'reveal' as const }));
    split.sources = {
      labels: Object.fromEntries(
        split.labels.map((l) => [l.id, { depth: 'computed' as const, depthIntent: 'computed' as const }]),
      ),
    };
    expect(isShippedDemoLabelSet(split)).toBe(true);
    expect(mayRelayoutLabels(split)).toBe(true);

    // A person's own intent IS a claim, and stops it — the guard the value comparison was standing in
    // for, said the way the rest of the gate says it.
    split.sources = {
      labels: Object.fromEntries(
        split.labels.map((l) => [l.id, { depth: 'computed' as const, depthIntent: 'user' as const }]),
      ),
    };
    expect(mayRelayoutLabels(split)).toBe(false);
  });
});

describe('#363 — the store hand-off', () => {
  it('takes a badge blank and hands over ONE seeded, re-depth-ed line', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    // `defaultBadgeParams` now carries a print (#368), and this test is about the HAND-OFF and the
    // per-line void query, whose numbers are the blank-geometry ones: a badge that states no print.
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ print: undefined })));
    const job = s().job;
    expect(job.stock.thickness).toBe(3.81);
    // The three demo lines are gone; one name line took their place.
    expect(job.labels).toHaveLength(1);
    const line = job.labels[0]!;
    expect(line.text).toBe('Name');
    // #383 — the line reads along Y: the seed's text-frame answer is the badge's own (38.1, 6.775),
    // turned back onto the stock as (length − 6.775, 38.1).
    expect(line.position.x).toBeCloseTo(31.325, 6);
    expect(line.position.y).toBeCloseTo(38.1, 6);
    expect(line.rotation).toBe(90);
    // The seeded line sits in the free band BESIDE the magnet pocket, so since #365 the void bound
    // asks about the voids the LINE reaches and finds none. Since #369 the JAWS are asked the same
    // way — by the line's own ink box — and this line is clear of them too: turned, its box spans
    // about 2.7 mm short of the moving jaw face at the measured size, past the reach the jaws are
    // judged by (`uncertainty + radius`, #391/#394). So NOTHING limits it: the blank's underside
    // (3.81 − 1 = 2.81 mm) is only a ceiling, and the recommendation is the depth the seed itself
    // gave the line (#440 — it used to recommend that ceiling, and 59 mm on a 60 mm blank). While
    // every line was charged the blank-wide jaw floor it took 1.905 − 1 = 0.905 whether or not it
    // went near a jaw; before #365 it was handed the pocket's 0.51 — half of what the blank allows,
    // on a line the seed had deliberately placed clear of the pocket.
    expect(line.depth).toBe(0.5);
    // Both claims on the one line: `layout` says the ROUTE laid it out (which is what lets a later
    // take replace it), `depth` says the walk worked the number out (#363 review).
    expect(job.sources?.labels).toEqual({ [line.id]: { layout: 'computed', depth: 'computed' } });
  });

  it('seeds the MEASURED line once the faces are up, and the estimate until then (#365 review)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    // No `measure` is injected anywhere on this path: `takeBadgeBlank` supplies the app's own
    // `labelGlyphMeasure`, and every other test in this file hands the pure seed the same adapter —
    // so all of them pass whether or not the STORE does. `vi.resetModules()` above also gave the
    // store a registry of its OWN, which is the cold start a browser has before anything has
    // fetched a face: cold, the measure answers null and the seed falls back to the estimate's
    // 5 mm cap, where the real face sets 8.
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
    expect(s().job.labels[0]!.size).toBe(5);

    // Which is why the CALLERS await the labels' faces before they call in (#365 review): the
    // wizard's hand-off and the panel's two buttons run `ensureLabelFontsLoaded` first. Up, the same
    // call re-lays the same line at the 8 mm the module's own rows show.
    await import('../setup/fonts'); // the seam the suite installs for every spec, for this generation
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
    const line = s().job.labels[0]!;
    expect(line.text).toBe(BADGE_SEED_TEXT);
    expect(line.size).toBe(8);
  });

  it('re-lays the line when a SECOND badge blank is taken (#363 review)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
    const first = s().job.labels[0]!;
    expect(first.position.x).toBeCloseTo(31.325, 6);

    // A larger badge. The line the first take seeded was laid out for the FIRST blank's size and
    // centre, and nobody has touched it since — so it is still a route's, and gets re-laid. Before
    // the review it could not be: its values no longer matched the demo set, so the gate closed for
    // good and the 38.1 mm badge's line stayed on the 100 mm blank.
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ width: 100, height: 50, thickness: 6 })));
    const job = s().job;
    expect(job.labels).toHaveLength(1);
    const second = job.labels[0]!;
    expect(second.id).not.toBe(first.id);
    // The 100 × 50 badge turns to a 50 × 100 stock; its pocket's bands are 1 … 18.5 and 31.5 … 49,
    // so the front one wins the tie and the line reads along Y at x = 50 − 9.75 = 40.25.
    expect(second.position.x).toBeCloseTo(40.25, 6);
    expect(second.position.y).toBeCloseTo(50, 6);
    expect(second.rotation).toBe(90);
    // The claims are the NEW line's alone: the dropped line's stamps went with it, not orphaned. The
    // second blank STATES a print (#368), so the walk's answer carries an intent alongside its depth
    // (`engraveJob.spec.ts` pins that number and its kind); the first badge in this file states none,
    // and the walk then writes the two-key pair the test above reads back.
    expect(job.sources?.labels).toEqual({
      [second.id]: { layout: 'computed', depth: 'computed', depthIntent: 'computed' },
    });
  });

  it('leaves a line the person moved alone, even on a second take (#363 review)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
    const id = s().job.labels[0]!.id;
    const x = s().job.labels[0]!.position.x;
    s().updateLabel(id, { position: { x, y: 12 } });

    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ width: 100, height: 50, thickness: 6 })));
    const job = s().job;
    expect(job.labels).toHaveLength(1);
    expect(job.labels[0]!.id).toBe(id); // the seed was not run again
    expect(job.labels[0]!.position.y).toBe(12); // …and the line is still where they put it
  });

  it('stamps an edit as the person’s, and only for the fields the claim covers (#363 review)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    const id = s().job.labels[0]!.id;

    // A depth is its own claim: it says nothing about where the line is or what it says.
    s().updateLabel(id, { depth: 1.2 });
    expect(s().job.sources?.labels?.[id]).toEqual({ depth: 'user' });
    // A field the route lays out is the person's the moment they touch it.
    s().updateLabel(id, { text: 'DAVE' });
    expect(s().job.sources?.labels?.[id]).toEqual({ depth: 'user', layout: 'user' });
  });

  it('leaves a label set the person has touched exactly where it is', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    const id = s().job.labels[0]!.id;
    s().updateLabel(id, { text: 'DAVE' });
    // The stand is STATED rather than inherited, because the subject here is the per-line answer
    // and the shipped default no longer has a jaw floor to give: since #391 review item 1 a new
    // job SEATS a 3.81 mm blank on the jaws' 3.1 mm ledges, so the blank stands 0.71 mm above the
    // jaw tops and no floor can keep the 1 mm of clearance a cut over a jaw must. The walk then
    // declines and the shipped depths stand — its own test, `engraveJob.spec.ts`'s "seats a badge
    // blank on the ledge it can reach". 1.905 mm is the default of the day for a 3.81 mm blank
    // (`min(4, t/2)` before the ledge rule), and stating it keeps this test about the arithmetic.
    s().setVise({ stockProud: 1.905 });
    // A badge stating NO print (#368): the point of this test is the PER-LINE answer, and the three
    // per-line constraints it names are the blank's own. A printed badge adds a fourth, tighter one
    // (the colour band) that binds all three alike — see the next test.
    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams({ print: undefined })));

    const job = s().job;
    expect(job.labels).toHaveLength(3);
    expect(job.labels.map((l) => l.text)).toEqual(['DAVE', 'MAKER', 'first chips']);
    // Nothing claimed a depth, so #362's walk still re-depths them for the new blank — the person
    // moved the words, not the numbers. Since #365 that is a PER-LINE answer, and since the blank
    // is TURNED (#383) this badge's magnet pocket lies along Y: it spans y 15.6–60.6, which all
    // three demo lines (y 43, 26, 10 — with the estimate's 2.1 em box) reach, so all three take
    // its 0.51. Before the turn the pocket lay across X, only the two middle lines reached it, and
    // the first took the jaws' 0.905 instead.
    expect(job.labels.map((l) => l.depth)).toEqual([0.51, 0.51, 0.51]);
  });

  it('re-depths the seeded lines onto the colour band when the badge states a print (#368)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));

    // The badge the template makes now states its print (#368), so the blank carries a colour
    // boundary and the walk has a band to place the seeded line in. The line is 8 mm tall on a
    // 76.2 × 38.1 blank, so its box comes no nearer than 6.9 mm to a jaw face at the estimate — past
    // the 1 mm reach the jaws are judged by — and since #369 the jaws leave it alone. So the split is the shallowest floor
    // and it wins outright: the blank's own reveal, 0.8 + 0.2 = 1.0, with the intent that means it.
    // Before #369 the jaw floor 0.905 was charged to every line alike, which lands INSIDE the split's
    // ±0.2 mm band where neither colour is decided, so the walk demoted it to the 0.6 `surface`.
    const labels = s().job.labels;
    expect(labels).toHaveLength(1);
    expect(labels.map((l) => [l.depth, l.depthIntent])).toEqual([[1.0, 'reveal']]);
    // The stamps are the route's, not the person's: the seed's `layout` and the walk's own two.
    expect(s().job.sources?.labels?.[labels[0]!.id]).toEqual({
      layout: 'computed',
      depth: 'computed',
      depthIntent: 'computed',
    });
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

describe('#364 — the bare-blank hand-off', () => {
  /** A bare blank in the shapes the issue's table measures, all through the same route. */
  const blank = (over: Partial<BlankParams> = {}) => defaultBlankParams(over);

  /** The codes of every error-severity finding, which is the bar the issue set: generate clean. */
  function errorCodes(g: ReturnType<typeof generate>): string[] {
    return [
      ...g.findings.filter((f) => f.severity === 'error'),
      ...(g.verify?.findings.filter((f) => f.severity === 'error') ?? []),
    ].map((f) => f.code);
  }

  it('keeps the demo plank’s three lines and re-depths them (100 × 60 × 12)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBlankStock(blank());

    const job = s().job;
    // The demo plank is the one blank those three words were written for, so they stay — by text,
    // position and id — and only their DEPTHS move (2 / 1 / 0.5 were never a recommendation).
    expect(job.labels.map((l) => l.text)).toEqual(['CASE', 'MAKER', 'first chips']);
    expect(job.labels.map((l) => l.position.x)).toEqual([50, 50, 50]);
    expect(job.labels.map((l) => l.depth)).toEqual([3, 3, 3]);
    // No seed ran, so nothing carries a route's `layout` stamp — only the walk's `computed` depths.
    expect(Object.values(job.sources?.labels ?? {}).every((c) => c.layout === undefined)).toBe(true);
    expect(Object.values(job.sources?.labels ?? {}).every((c) => c.depth === 'computed')).toBe(true);
  });

  it('replaces the demo set with ONE Text line on a smaller blank (60 × 40 × 12)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBlankStock(blank({ width: 60, height: 40 }));

    const job = s().job;
    expect([job.stock.length, job.stock.width, job.stock.thickness]).toEqual([60, 40, 12]);
    expect(job.labels).toHaveLength(1);
    const line = job.labels[0]!;
    expect(line.text).toBe(BLANK_SEED_TEXT);
    // Centred on the blank, in the whole face (a blank declares no pocket).
    expect(line.position.x).toBeCloseTo(30, 6);
    expect(line.position.y).toBeCloseTo(20, 6);
    // Nothing binds this line on a 60 × 40 face — it is clear of the jaws and there is no void —
    // so the walk agrees with the seed's own depth instead of raising it to the blank's ceiling
    // (#440: that is what it used to write). The claim is still the walk's, which is what lets a
    // later blank revise the number.
    expect(line.depth).toBe(0.5);
    expect(job.sources?.labels).toEqual({ [line.id]: { layout: 'computed', depth: 'computed' } });

    // The bar #363 set, on the real pipeline: the job the wizard hands over generates clean.
    const g = generate(tl, job);
    expect(g.ok).toBe(true);
    expect(errorCodes(g)).toEqual([]);
    expect(g.findings.some((f) => f.code === 'item-over-void')).toBe(false);
  }, 60_000);

  it('replaces the demo set on the swapped-axes blank too (60 × 100 × 12)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBlankStock(blank({ width: 60, height: 100 }));

    const job = s().job;
    expect(job.labels).toHaveLength(1);
    const line = job.labels[0]!;
    expect(line.text).toBe(BLANK_SEED_TEXT);
    expect(line.position.x).toBeCloseTo(30, 6);
    expect(line.position.y).toBeCloseTo(50, 6);
    // 60 × 100 is NOT the 100 × 60 footprint, so it is not the demo plank: the three words go even
    // though the two blanks hold the same 6000 mm².
    const g = generate(tl, job);
    expect(errorCodes(g)).toEqual([]);
  }, 60_000);

  it('keeps the three lines on a thinner slab of the same footprint (100 × 60 × 4)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBlankStock(blank({ thickness: 4 }));

    const job = s().job;
    // Thickness is deliberately NOT part of the footprint test: 100 × 60 × 4 is still the plank
    // those three words were written for, so they stay — and they keep the depths they ship with,
    // because on this blank the walk finds no floor to write.
    //
    // #391 review item 1 is why. A new job now SEATS the blank on the jaws' 3.1 mm ledges, so a
    // 4 mm slab stands `4 − 3.1 = 0.9` mm above the jaw tops — less than the 1 mm of clearance a
    // floor must keep over a jaw, which makes the jaw candidate `0.9 − 1 = −0.1` mm. A candidate
    // at or below zero is not a shallow depth to cut, it is a setup the jaw check reports, so
    // `recommendLabelDepth` answers null and every line keeps its number (#362's own rule).
    //
    // The hand-off runs before any face is parsed (#180), so the box that reaches those jaws is
    // `inkBoxOf`'s upper-bound estimate — 109.2 mm of 'CASE' on a 100 mm plank — and these centred
    // lines read as touching a jaw they in fact sit 26.9 mm clear of. Hence the asymmetry the two
    // assertions below pin: the WALK declines at hand-off, and the CHECKER, which measures, has
    // nothing to say about the jaws at all.
    expect(job.labels.map((l) => l.text)).toEqual(['CASE', 'MAKER', 'first chips']);
    expect(job.labels.map((l) => l.depth)).toEqual([2, 1, 0.5]);
    expect(job.workholding.vise.stockProud).toBeCloseTo(0.9, 9);

    const g = generate(tl, job);
    expect(errorCodes(g)).toEqual([]);
    // No jaw collision, for the measurement reason above: the deepest cut is 2 mm, which
    // a 4 mm blank's 1 mm floor allows (2 mm left under it), and which no jaw is under in fact.
    expect(g.findings.some((f) => f.code === 'vise-jaw-collision')).toBe(false);
    // And the grip warning #344 raised here is GONE rather than kept: the seated blank leaves
    // `4 − 0.9 = 3.1` mm below the jaw tops, past the 3 mm floor under which a part can lift, where
    // the 2 mm stand this blank used to be modelled at left only 2 mm.
    expect(g.findings.some((f) => f.code === 'vise-grip-shallow')).toBe(false);
  }, 60_000);

  it('never replaces a label set the person has touched', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();
    const id = s().job.labels[0]!.id;
    s().updateLabel(id, { text: 'DAVE' });

    s().takeBlankStock(blank({ width: 60, height: 40 }));

    const job = s().job;
    expect(job.labels.map((l) => l.text)).toEqual(['DAVE', 'MAKER', 'first chips']);
    // …re-depthed for the new blank, because the person moved the words, not the numbers.
    expect(job.labels[0]!.depth).toBeGreaterThan(0);
  });

  it('leaves a line the BADGE route seeded alone, re-depthed (#364 gate)', async () => {
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBadgeBlank(badgeBlankFor(defaultBadgeParams()));
    const name = s().job.labels[0]!;
    expect(name.text).toBe('Name');

    // The bare route's gate is `isShippedDemoLabelSet`, NOT the badge's wider
    // `mayRelayoutLabels`: a blank seeds only a placeholder, so it replaces the demo words it was
    // never written for and leaves a line another route placed — it does not hand back `Text`.
    //
    // The blank is 60 × 40, NOT the `blank()` default of 100 × 60: the default IS the demo plank,
    // so `isDemoPlank` short-circuits the gate before `isShippedDemoLabelSet` is ever consulted and
    // the test would pass for a reason it does not name. A blank that is not the plank reaches the
    // condition this test is about.
    s().takeBlankStock(blank({ width: 60, height: 40 }));
    const job = s().job;
    expect([job.stock.length, job.stock.width]).toEqual([60, 40]);
    expect(job.labels).toHaveLength(1);
    expect(job.labels[0]!.text).toBe('Name');
    expect(job.labels[0]!.id).toBe(name.id);
    // …and its depth is re-walked for the new blank, like every unclaimed line.
    expect(job.sources?.labels?.[name.id]?.depth).toBe('computed');
  });

  it('generates the seeded 60 × 40 blank clean and carries no leftover demo claim', async () => {
    // The wizard's own path, end to end: the same call `seedStockFromProject` makes, then the real
    // pipeline. A separate spec because this is the one the issue's table is about.
    backing.clear();
    const { useEngraveJobStore } = await freshStore();
    const s = () => useEngraveJobStore.getState();

    s().takeBlankStock(blank({ width: 60, height: 40 }));
    const g = generate(tl, s().job);
    expect(g.stage).toBe('done');
    expect(errorCodes(g)).toEqual([]);
    // The three `item-outside-stock` errors the issue measured are exactly what this rules out.
    expect(g.findings.some((f) => f.code === 'item-outside-stock')).toBe(false);
  }, 60_000);
});
