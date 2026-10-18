// #471 — the saved setups read against the document.
//
// The saved list is authoritative: these specs pin that a missing or disabled item is REPORTED and
// the document is left alone, that a change drops exactly the approvals it invalidates (and the
// later ones whose stock it moves), and that "Add setup" is only offered where a cut can go.

import { describe, expect, it } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import {
  addSetupOffer,
  applySetupChange,
  cutItemIds,
  faceUpOf,
  materializeSetups,
  planFromSetups,
  readSetups,
  suggestedPlan,
  setupsInput,
} from '@/engine/cnc/setups';
import { orient } from '@/engine/cnc/setups/orient';
import { setupsSettings } from '@/engine/cnc/setups/settings';
import type { EngraveCircleShape, EngraveDrillItem, EngraveJob, JobSetup, JobSetupRegistration } from '@/types/engraveJob';

const SETTINGS = setupsSettings(null);

const IDENTITY = {
  top: 'top',
  bottom: 'bottom',
  left: 'left',
  right: 'right',
  front: 'front',
  back: 'back',
} as const;

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

function implicitJob(): EngraveJob {
  return defaultEngraveJob();
}

/** The default job with its cuts saved into one top-up vise setup. */
function savedJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.setups = [
    {
      id: 'setup-1',
      orientation: { ...IDENTITY },
      mount: { kind: 'vise' },
      itemIds: cutItemIds(job),
      tools: [job.toolKey],
    },
  ];
  return job;
}

/**
 * A job with a top pocket and a through hole, saved as two setups: the pocket top-up in the vise,
 * then the hole from the bottom in the bracket. A through hole is the only document feature that
 * opens to two faces, which is what makes a second setup expressible at all.
 */
function twoSetupJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [];
  job.shapes = [shape()];
  job.drills = [drill({ id: 'drl-through', name: 'a through hole', through: true })];
  const mount = { kind: 'bracket' } as const;
  const bottom = orient('bottom', mount, { x: job.stock.length, y: job.stock.width, z: job.stock.thickness });
  if (!bottom.ok) throw new Error(bottom.reason);
  job.setups = [
    {
      id: 'setup-top',
      orientation: { ...IDENTITY },
      mount: { kind: 'vise' },
      itemIds: ['shp-1'],
      tools: [job.toolKey],
    },
    {
      id: 'setup-bottom',
      orientation: { ...bottom.orientation },
      mount,
      itemIds: ['drl-through'],
      tools: [job.toolKey],
    },
  ];
  return job;
}

const registration = (): JobSetupRegistration => ({
  method: 'vise',
  plan: { steps: [] } as unknown as JobSetupRegistration['plan'],
  expected: 'planned',
});

const approved = (setup: JobSetup): JobSetup => ({
  ...setup,
  registration: registration(),
  remount: { instruction: ['turn it over'], confirm: null },
});

describe('#471 readSetups — the saved list against the document', () => {
  it('reads a job with no saved list as one implicit setup, freshly derived and never stale', () => {
    const job = implicitJob();
    const reading = readSetups(job);
    expect(reading.source).toBe('implicit');
    expect(reading.setups).toEqual(jobSetups(job));
    expect(reading.findings).toEqual([]);
    expect(reading.unassigned).toEqual([]);
    expect(reading.stale).toBe(false);
    // Every cut the planner can see is in the implicit setup — there is nowhere else to put it.
    expect(new Set(reading.items[0]!.cut)).toEqual(new Set(cutItemIds(job)));
  });

  it('reports no source of work when the job has nothing to cut', () => {
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [];
    expect(readSetups(job).source).toBe('empty');
  });

  it('accepts a saved list that still matches the document', () => {
    const job = savedJob();
    const reading = readSetups(job);
    expect(reading.source).toBe('saved');
    expect(reading.findings).toEqual([]);
    expect(reading.unassigned).toEqual([]);
    expect(reading.stale).toBe(false);
    expect(reading.items[0]!.missing).toEqual([]);
    expect(reading.items[0]!.notCut).toEqual([]);
  });

  it('surfaces a removed item as setup-item-missing and does NOT rewrite the saved list', () => {
    const job = savedJob();
    const gone = job.labels[0]!.id;
    job.labels = job.labels.filter((label) => label.id !== gone);

    const reading = readSetups(job);
    expect(reading.findings.map((f) => f.code)).toEqual(['setup-item-missing']);
    expect(reading.findings[0]!.setupIndex).toBe(1);
    expect(reading.findings[0]!.itemIds).toEqual([gone]);
    expect(reading.findings[0]!.message).toContain(gone);
    expect(reading.items[0]!.missing).toEqual([gone]);
    expect(reading.stale).toBe(true);

    // The document is the person's: the id stays until they remove it or re-plan.
    expect(job.setups![0]!.itemIds).toContain(gone);
  });

  it('says an item that still exists but no longer cuts is "not cut", not missing', () => {
    const job = savedJob();
    const off = job.labels[0]!.id;
    job.labels[0]!.enabled = false;

    const reading = readSetups(job);
    expect(reading.findings).toEqual([]);
    expect(reading.items[0]!.notCut).toEqual([off]);
    expect(reading.items[0]!.missing).toEqual([]);
    expect(reading.stale).toBe(true);
  });

  it('reports cut items in no setup as unassigned', () => {
    const job = savedJob();
    const kept = job.labels[0]!.id;
    job.setups![0]!.itemIds = [kept];

    const reading = readSetups(job);
    expect(reading.unassigned).toEqual(cutItemIds(job).filter((id) => id !== kept));
    expect(reading.findings).toEqual([]);
    expect(reading.stale).toBe(true);
  });

  it('a setup left with no cut item is setup-no-cuts — and a missing-only setup says both', () => {
    const job = savedJob();
    job.setups![0]!.itemIds = [];
    let reading = readSetups(job);
    expect(reading.findings.map((f) => f.code)).toEqual(['setup-no-cuts']);
    expect(reading.findings[0]!.message).toContain('names no items');

    job.setups![0]!.itemIds = ['gone-item'];
    reading = readSetups(job);
    expect(reading.findings.map((f) => f.code)).toEqual(['setup-item-missing', 'setup-no-cuts']);
  });
});

describe('#471 materializeSetups — the one write from the implicit reading', () => {
  it('copies the implicit setup into stored form without changing the job', () => {
    const job = implicitJob();
    const stored = materializeSetups(job);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.itemIds).toEqual(jobSetups(job)[0]!.itemIds);
    expect(stored[0]!.mount).toEqual({ kind: 'vise' });
    expect(stored[0]!.orientation).toEqual(IDENTITY);
    // A copy, not the derived object.
    expect(stored).not.toBe(jobSetups(job));
    expect(job.setups).toBeUndefined();
  });

  it('returns a saved list untouched — materialising is not a normalisation pass', () => {
    const job = savedJob();
    expect(materializeSetups(job)).toBe(job.setups);
  });
});

describe('#471 setupsInput and the saved plan', () => {
  it('takes each setup’s mount keyed by its up face, and starts where the saved list starts', () => {
    const job = twoSetupJob();
    const input = setupsInput(job);
    expect(input.firstUp).toBe('top');
    expect(input.mounts).toEqual({ top: { kind: 'vise' }, bottom: { kind: 'bracket' } });
    expect(input.removals.map((r) => r.id)).toEqual(['shp-1', 'drl-through']);
    expect(input.stock).toEqual({ x: 100, y: 60, z: 12 });
  });

  it('builds the SAVED list in its saved order and mounts, not a fresh greedy grouping', () => {
    const job = twoSetupJob();
    const saved = planFromSetups(job, SETTINGS);
    expect(saved.setups.map((s) => s.faceUp)).toEqual(['top', 'bottom']);
    expect(saved.setups.map((s) => s.mount.kind)).toEqual(['vise', 'bracket']);
    expect(saved.setups.map((s) => s.itemIds)).toEqual([['shp-1'], ['drl-through']]);
    expect(faceUpOf(job.setups![1]!)).toBe('bottom');

    // The engine's fresh suggestion would cut both in the first top-up setup; the saved list wins.
    const fresh = suggestedPlan(job, SETTINGS);
    expect(fresh.setups).toHaveLength(1);
    expect(fresh.setups[0]!.itemIds).toEqual(['shp-1', 'drl-through']);
  });

  it('drops a missing id from the derived plan but leaves it in the document', () => {
    const job = savedJob();
    job.setups![0]!.itemIds = [...job.setups![0]!.itemIds, 'gone-item'];
    const plan = planFromSetups(job, SETTINGS);
    expect(plan.setups[0]!.itemIds).not.toContain('gone-item');
    expect(job.setups![0]!.itemIds).toContain('gone-item');
  });
});

describe('#471 addSetupOffer — fail closed where no cut can go', () => {
  it('offers the bottom face when a through hole opens there', () => {
    const job = twoSetupJob();
    job.setups = [job.setups![0]!];
    expect(addSetupOffer(job, SETTINGS)).toEqual({ face: 'bottom', reason: null });
  });

  it('is disabled with the document’s own answer when every cut opens to a held face', () => {
    const job = savedJob();
    expect(addSetupOffer(job, SETTINGS)).toEqual({
      face: null,
      reason: 'every cut opens to the top face, which is already a setup',
    });
  });

  it('is disabled with no cuts to plan', () => {
    const job = defaultEngraveJob();
    job.labels = [];
    job.shapes = [];
    expect(addSetupOffer(job, SETTINGS)).toEqual({ face: null, reason: 'the job has no cuts to plan' });
  });
});

describe('#471 applySetupChange — only the approvals the edit invalidates', () => {
  const list = (): JobSetup[] => twoSetupJob().setups!.map(approved);

  it('a mount change clears that setup’s approvals and the next remount, but not the next registration', () => {
    const next = applySetupChange(list(), 0, { mount: { kind: 'bracket' } });
    expect(next[0]!.registration).toBeUndefined();
    expect(next[0]!.remount).toBeUndefined();
    // The next registration was approved for that setup's own mount; it is untouched.
    expect(next[1]!.registration).toBeDefined();
    // The remount turns FROM setup 1, so its words no longer hold.
    expect(next[1]!.remount).toBeUndefined();
  });

  it('an item change clears this setup and every later setup’s registration and remount', () => {
    const next = applySetupChange(list(), 0, { itemIds: ['shp-1', 'drl-through'] });
    expect(next[0]!.registration).toBeUndefined();
    expect(next[0]!.remount).toBeUndefined();
    expect(next[1]!.registration).toBeUndefined();
    expect(next[1]!.remount).toBeUndefined();
  });

  it('an orientation change behaves like a mount change', () => {
    const flip = orient('bottom', { kind: 'vise' }, { x: 100, y: 60, z: 12 });
    if (!flip.ok) throw new Error(flip.reason);
    const next = applySetupChange(list(), 0, { orientation: { ...flip.orientation } });
    expect(next[0]!.registration).toBeUndefined();
    expect(next[0]!.remount).toBeUndefined();
    expect(next[1]!.registration).toBeDefined();
    expect(next[1]!.remount).toBeUndefined();
  });

  it('a tools change and an identical value leave every approval alone', () => {
    const before = list();
    expect(applySetupChange(before, 0, { tools: ['flat-2.0'] })[0]!.registration).toBeDefined();
    expect(applySetupChange(before, 0, { tools: ['flat-2.0'] })[0]!.remount).toBeDefined();
    const sameMount = applySetupChange(before, 0, { mount: { kind: 'vise' } });
    expect(sameMount[0]!.registration).toBeDefined();
    expect(sameMount[0]!.remount).toBeDefined();
    const sameItems = applySetupChange(before, 0, { itemIds: [...before[0]!.itemIds] });
    expect(sameItems[0]!.registration).toBeDefined();
    expect(sameItems[1]!.registration).toBeDefined();
  });

  it('returns a new list, leaves earlier setups untouched and does not mutate its input', () => {
    const before = list();
    const snapshot = JSON.parse(JSON.stringify(before));
    const next = applySetupChange(before, 1, { mount: { kind: 'vise' } });
    expect(next).not.toBe(before);
    expect(next[0]).toBe(before[0]);
    expect(next[1]).not.toBe(before[1]);
    expect(before).toEqual(snapshot);
  });

  it('an out-of-range index is a no-op copy', () => {
    const before = list();
    const next = applySetupChange(before, 9, { mount: { kind: 'tape' } });
    expect(next).toEqual(before);
    expect(next).not.toBe(before);
  });
});

// #472 — the assignment is a statement about the setup's items and cutters. An edit that removes
// either must not leave a stale claim behind: an item that left the setup cannot stay assigned, and
// a cutter that left cannot keep its list.
describe('#472 applySetupChange — the per-cutter assignment follows the edit', () => {
  const withAssignments = (): { setups: JobSetup[]; a: string; b: string } => {
    const job = defaultEngraveJob();
    const [a, b] = cutItemIds(job) as [string, string];
    const setups: JobSetup[] = [
      {
        id: 'setup-1',
        orientation: { ...IDENTITY },
        mount: { kind: 'vise' },
        itemIds: [a, b],
        tools: ['flat-rough', 'flat-rest'],
        toolItems: { 'flat-rough': [a], 'flat-rest': [b] },
      },
    ];
    return { setups, a, b };
  };

  it('drops an item that left the setup, and a list left empty', () => {
    const { setups, a } = withAssignments();
    const next = applySetupChange(setups, 0, { itemIds: [a] });
    expect(next[0]!.toolItems).toEqual({ 'flat-rough': [a] });
  });

  it('deletes the map when the setup is cut by one cutter again', () => {
    // One cutter owns every item; an empty or partial map would read as "assigned nothing".
    const next = applySetupChange(withAssignments().setups, 0, { tools: ['flat-rough'] });
    expect(next[0]!.toolItems).toBeUndefined();
  });

  it('keeps only the assignments of cutters that are still named', () => {
    const { setups, a } = withAssignments();
    const next = applySetupChange(setups, 0, { tools: ['flat-rough', 'flat-other'] });
    expect(next[0]!.toolItems).toEqual({ 'flat-rough': [a] });
  });
});
