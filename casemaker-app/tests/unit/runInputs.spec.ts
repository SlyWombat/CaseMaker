// #581 — a Generate's input stamp: what it read, and what moved between two runs.
//
// #577 proved the sim + oracle deterministic, so two Generates on the same inputs cannot disagree.
// These tests pin the two halves of the answer: every input the run hands the worker has a stamp,
// and the stamp ignores the things that do NOT change the program — a default's source and reading
// time, a calibration's `measuredAt`, a condition's note text — while moving for anything that does.

import { describe, expect, it } from 'vitest';

import {
  RUN_INPUT_ORDER,
  changedInputs,
  cuttersKey,
  inputLabel,
  machineKey,
  runInputs,
  shopKey,
  staleSentence,
  surfaceKey,
  type EngraveRunInputs,
  type RunInputSources,
} from '@/engine/cnc/engrave/runInputs';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { MARGIN_DEFAULTS, effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import { FEEDS_TABLE, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import { TOOL_LIBRARY } from '@/engine/cnc/toolLibrary';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import type { ShopDefault, ShopDefaults } from '@/platform/defaultsClient';
import type { SurfacePostFit } from '@/engine/cnc/engrave/surfaceSpread';

const CAL: MachineCalibration = {
  machineId: 'Z1',
  frame: {
    anchor1: [-190.89, -193.83],
    anchor2Offset: [88.5, 45],
    toolrackOffset: [48.8, 181],
    clearanceXY: [-5, -21],
    clearanceZ: -3,
    toolrackZ: -60,
  },
  softEndstop: {} as MachineCalibration['softEndstop'],
  source: 'config-get sd on 192.168.10.43',
  measuredAt: '2026-10-07T18:00:00.000Z',
};

const def = (value: number, extra: Partial<ShopDefault> = {}): ShopDefault => ({
  value,
  source: 'seeded',
  setAt: null,
  unit: null,
  note: null,
  ...extra,
});

const DEFAULTS: ShopDefaults = {
  'engrave.lostDetailWarnRatio': def(0.5),
  'drill.peckClearanceMm': def(0.4),
};

const CATALOGUE: FeedCatalogueRow[] = [
  { cutterId: '112111313812', material: 'PLA', rpm: 12000, feed: 900, plungeFeed: 250, stepDown: 0.4 },
];

const CONDITIONS = new Map<string, ConditionSummary>([
  ['flat-3.175x12-metal', { best: 'new', usable: 2, note: null }],
]);

const SURFACE: SurfacePostFit = { plane: { offset: 0.12, slopeX: 0.001, slopeY: -0.002 }, z0: -0.35 };

/** ONE job object: `defaultEngraveJob()` mints a fresh id per call, and the stamp hashes it. */
const JOB = defaultEngraveJob();

function sources(): RunInputSources {
  const job = JOB;
  return {
    job,
    margins: effectiveMargins(job, MARGIN_DEFAULTS),
    calibration: CAL,
    shopDefaults: DEFAULTS,
    feeds: FEEDS_TABLE,
    catalogue: CATALOGUE,
    tools: TOOL_LIBRARY,
    conditions: CONDITIONS,
    surface: null,
  };
}

const STAMP = (): EngraveRunInputs => runInputs(sources());

describe('#581 the input stamp', () => {
  it('names every input, in reading order, in words', () => {
    expect(RUN_INPUT_ORDER.map(inputLabel)).toEqual([
      'the job',
      'the depth margins',
      'the machine frame',
      'the shop defaults',
      'the feed table',
      'the feed catalogue',
      'the cutter list',
      'the fitted surface frame',
    ]);
  });

  it('reports only the inputs whose stamp moved, in reading order', () => {
    const before = STAMP();
    const after: EngraveRunInputs = { ...before, job: 'other', surface: 'plane' };
    expect(changedInputs(before, after)).toEqual(['job', 'surface']);
    expect(changedInputs(before, before)).toEqual([]);
  });

  it('says which input a stale result followed, or keeps the generic sentence when it cannot know', () => {
    expect(staleSentence('job')).toBe('the job changed since it was generated');
    expect(staleSentence('machine')).toBe('the machine frame changed since it was generated');
    expect(staleSentence('margins')).toBe('the depth margins changed since it was generated');
    expect(staleSentence(null)).toBe('the job or the machine frame changed since it was generated');
    expect(staleSentence(undefined)).toBe('the job or the machine frame changed since it was generated');
  });

  it('does not move for a re-read of the same machine frame', () => {
    const reread: MachineCalibration = { ...CAL, source: 'a later read', measuredAt: '2026-10-24T09:00:00.000Z' };
    expect(machineKey(reread)).toBe(machineKey(CAL));
    const moved: MachineCalibration = { ...CAL, frame: { ...CAL.frame, anchor1: [-190.9, -193.83] } };
    expect(machineKey(moved)).not.toBe(machineKey(CAL));
    expect(machineKey(null)).toBe('none');
  });

  it('does not move for a default whose source or reading time changed, only its value', () => {
    const relabelled: ShopDefaults = {
      ...DEFAULTS,
      'engrave.lostDetailWarnRatio': { value: 0.5, source: 'measured', setAt: '2026-10-24T09:00:00.000Z', unit: null, note: 'calipered' },
    };
    expect(shopKey(relabelled)).toBe(shopKey(DEFAULTS));
    const renumbered: ShopDefaults = { ...DEFAULTS, 'drill.peckClearanceMm': def(0.5) };
    expect(shopKey(renumbered)).not.toBe(shopKey(DEFAULTS));
    expect(shopKey(null)).toBe('none');
  });

  it('moves for a condition that changes the pick, not for the note that describes it', () => {
    const base = cuttersKey(TOOL_LIBRARY, CONDITIONS);
    const renoted = cuttersKey(TOOL_LIBRARY, new Map([['flat-3.175x12-metal', { best: 'new', usable: 2, note: 'a worn copy exists' }]]));
    expect(renoted).toBe(base);
    const worn = cuttersKey(TOOL_LIBRARY, new Map([['flat-3.175x12-metal', { best: 'worn', usable: 2, note: null }]]));
    expect(worn).not.toBe(base);
  });

  it('states the fitted surface frame, or flat', () => {
    expect(surfaceKey(null)).toBe('flat');
    expect(surfaceKey(SURFACE)).toBe('0.12|0.001|-0.002|-0.35');
    expect(surfaceKey({ ...SURFACE, plane: { ...SURFACE.plane, slopeY: 0 } })).not.toBe(surfaceKey(SURFACE));
  });

  it('is stable for identical sources, and moves for each input a run actually reads', () => {
    const base = STAMP();
    expect(STAMP()).toEqual(base);

    const job = { ...sources(), job: { ...JOB, name: 'another job' } };
    expect(changedInputs(base, runInputs(job))).toEqual(['job']);

    const margins = { ...sources(), margins: { ...effectiveMargins(JOB, MARGIN_DEFAULTS), boundaryMargin: 0.4 } };
    expect(changedInputs(base, runInputs(margins))).toEqual(['margins']);

    const machine = { ...sources(), calibration: { ...CAL, machineId: 'Z1Pro' } };
    expect(changedInputs(base, runInputs(machine))).toEqual(['machine']);

    const shop = { ...sources(), shopDefaults: { ...DEFAULTS, 'drill.peckClearanceMm': def(0.6) } };
    expect(changedInputs(base, runInputs(shop))).toEqual(['shop']);

    const feeds = { ...sources(), feeds: FEEDS_TABLE.map((row, i) => (i === 0 ? { ...row, status: 'measured' as const, provenance: 'edited' } : row)) };
    expect(changedInputs(base, runInputs(feeds))).toEqual(['feeds']);

    const catalogue = { ...sources(), catalogue: [{ ...CATALOGUE[0]!, rpm: 13000 }] };
    expect(changedInputs(base, runInputs(catalogue))).toEqual(['catalogue']);

    const cutters = { ...sources(), conditions: new Map([['flat-3.175x12-metal', { best: 'broken' as const, usable: 0, note: null }]]) };
    expect(changedInputs(base, runInputs(cutters))).toEqual(['cutters']);

    const surface = { ...sources(), surface: SURFACE };
    expect(changedInputs(base, runInputs(surface))).toEqual(['surface']);
  });
});
