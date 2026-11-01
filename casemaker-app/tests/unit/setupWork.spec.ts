/**
 * #835 — THE SUB-JOB SEAM. The measured search judges a plan as ONE setup, so a multi-setup job
 * cannot be measured as a whole. These tests pin the three pure answers the panel and the command
 * line share: which keys are dead, what one setup's work looks like as a job, and the write-back
 * that leaves every other setup alone.
 */
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { setupWorkJob, writeSetupPlan, deadSetupKeys, setupsWithDeadCutters, replacementCutter } from '@/engine/cnc/engrave/setupWork';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { EngraveJob, JobSetup } from '@/types/engraveJob';

const IDENTITY = { top: 'top', bottom: 'bottom', left: 'left', right: 'right', front: 'front', back: 'back' } as const;

const FLAT: Tool = flatEndMill(3.175, { name: '3.175 mm flat end' });
const BALL: Tool = { ...flatEndMill(2, { name: '2 mm ball nose' }), shape: 'ball', typeText: 'Ball' };
const REST: Tool = flatEndMill(1, { name: '1 mm flat end' });

const KEY_FLAT = 'inv:flat';
const KEY_BALL = 'inv:ball';
const KEY_REST = 'inv:rest';
const KEY_GONE = 'inv:gone';

const ENTRIES: ToolLibraryEntry[] = [
  { key: KEY_FLAT, tool: FLAT, provenance: 'test' },
  { key: KEY_BALL, tool: BALL, provenance: 'test' },
  { key: KEY_REST, tool: REST, provenance: 'test' },
];

/**
 * A two-setup job: setup 1 cuts the first two labels with a flat; setup 2 cuts the third with a
 * ball and names a second, dead cutter after it. The goals are the sides form.
 */
function twoSetupJob(): EngraveJob {
  const base = defaultEngraveJob();
  const ids = base.labels.map((l) => l.id);
  const setups: JobSetup[] = [
    {
      id: 'setup-1',
      orientation: { ...IDENTITY },
      mount: { kind: 'vise' },
      itemIds: ids.slice(0, 2),
      tools: [KEY_FLAT],
    },
    {
      id: 'setup-2',
      orientation: { top: 'bottom', bottom: 'top', left: 'right', right: 'left', front: 'back', back: 'front' },
      mount: { kind: 'tape' },
      itemIds: ids.slice(2),
      tools: [KEY_BALL, KEY_GONE],
      toolItems: { [KEY_BALL]: ids.slice(2) },
    },
  ];
  return {
    ...base,
    toolKey: KEY_FLAT,
    tool: FLAT,
    setups,
    labels: base.labels.map((label, i) =>
      i === 0 ? { ...label, text: 'SIDE-A' } : i === 1 ? { ...label, text: 'TOP' } : { ...label, text: 'SIDE-B' },
    ),
  };
}

describe('#835 the setup sub-job seam', () => {
  it('names the dead keys of ONE setup, in use order, and the setups that have them', () => {
    const job = twoSetupJob();
    expect(deadSetupKeys(job, ENTRIES, 0)).toEqual([]);
    expect(deadSetupKeys(job, ENTRIES, 1)).toEqual([KEY_GONE]);
    expect(setupsWithDeadCutters(job, ENTRIES)).toEqual([1]);
  });

  it('builds that setup’s own work as a single-setup job: its items, its mount, its first cutter', () => {
    const job = twoSetupJob();
    const sub = setupWorkJob(job, ENTRIES, 1);
    expect(sub).not.toBeNull();
    if (sub === null) return;
    expect(sub.setups).toHaveLength(1);
    expect(sub.setups?.[0]?.id).toBe('setup-2');
    expect(sub.setups?.[0]?.mount.kind).toBe('tape');
    // Only the third label is this setup's work.
    expect(sub.labels.map((l) => l.text)).toEqual(['SIDE-B']);
    // The setup's first cutter is the job's named cutter, so the plan prefers to keep it.
    expect(sub.toolKey).toBe(KEY_BALL);
    expect(sub.tool?.name).toBe('2 mm ball nose');
    // No job-level substitution record rides into the measurement.
    expect(sub.substitution).toBeUndefined();
  });

  it('measures a side’s GOAL with that side only', () => {
    const job = twoSetupJob();
    const goalFor = (id: string): NonNullable<EngraveJob['targetObject']> =>
      ({
        id: `goal-${id}`,
        name: `goal ${id}`,
        role: 'goal',
        enabled: true,
        setupId: id,
        format: 'stl',
        data: '',
        sha256: 'x'.repeat(64),
        position: { x: 0, y: 0 },
        size: { x: 10, y: 10, z: 5 },
      }) as unknown as NonNullable<EngraveJob['targetObject']>;
    const withGoals: EngraveJob = {
      ...job,
      targetObjects: [goalFor('setup-1'), goalFor('setup-2')],
      targetObject: undefined,
    };
    const sub = setupWorkJob(withGoals, ENTRIES, 1);
    expect(sub?.targetObject?.id).toBe('goal-setup-2');
    expect(sub?.targetObjects).toBeUndefined();
  });

  it('returns null for a setup that cuts nothing', () => {
    const job = twoSetupJob();
    const empty: EngraveJob = { ...job, labels: [] };
    expect(setupWorkJob(empty, ENTRIES, 1)).toBeNull();
  });

  it('writes a plan into ONE setup and leaves the others and the job keys alone', () => {
    const job = twoSetupJob();
    const items = job.labels.map((l) => l.id).slice(2);
    const next = writeSetupPlan(job, ENTRIES, 1, [
      { key: KEY_BALL, items },
      { key: KEY_REST, items: [] },
    ]);
    expect(next.setups?.[1]?.tools).toEqual([KEY_BALL, KEY_REST]);
    expect(next.setups?.[1]?.toolItems).toEqual({ [KEY_BALL]: items, [KEY_REST]: [] });
    // Setup 1 is untouched, and so is the document's legacy cutter pair (setup 0's).
    expect(next.setups?.[0]).toEqual(job.setups?.[0]);
    expect(next.toolKey).toBe(KEY_FLAT);
    expect(next.tool?.name).toBe('3.175 mm flat end');
  });

  it('mirrors the job’s own keys when the plan is written into setup 0', () => {
    const job = twoSetupJob();
    const next = writeSetupPlan(job, ENTRIES, 0, [{ key: KEY_REST, items: job.setups![0]!.itemIds }]);
    expect(next.setups?.[0]?.tools).toEqual([KEY_REST]);
    expect(next.toolKey).toBe(KEY_REST);
    expect(next.tool?.name).toBe('1 mm flat end');
    expect(next.setups?.[1]).toEqual(job.setups?.[1]);
  });

  it('names the cutter that takes over: program 1 for a dead first key, the rest cutter for a later one', () => {
    const job = twoSetupJob();
    const setup = job.setups![1]!;
    const cutters = [
      { key: KEY_FLAT, items: [] },
      { key: KEY_REST, items: [] },
    ];
    expect(replacementCutter(cutters, setup, KEY_BALL).key).toBe(KEY_FLAT);
    expect(replacementCutter(cutters, setup, KEY_GONE).key).toBe(KEY_REST);
    // A one-cutter plan answers both.
    expect(replacementCutter([{ key: KEY_REST, items: [] }], setup, KEY_GONE).key).toBe(KEY_REST);
    // …unless the plan says which cutter took the dead key's own items: that one is named.
    const items = setup.itemIds;
    const withItems = { ...setup, toolItems: { [KEY_GONE]: items } };
    expect(replacementCutter([{ key: KEY_FLAT, items }, ...cutters.slice(1)], withItems, KEY_GONE).key).toBe(KEY_FLAT);
  });
});
