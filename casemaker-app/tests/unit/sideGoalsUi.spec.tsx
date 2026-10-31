// @vitest-environment jsdom
// #723 P2-3 — the SIDES list. A part cut from several sides gives each setup a goal; the Setups
// section states which goal each side cuts, and the store writes the multi-goal form
// (`targetObjects[]`, one goal per setup) without ever leaving a job that states both forms.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { EngraveSetupsSection } from '@/components/panels/EngraveSetupsSection';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups, jobTargetObjects, withSideGoal, withoutSideGoal } from '@/engine/cnc/engrave/jobSetup';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import { flatEndMill } from '@/engine/cnc/tool';
import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

function goal(id: string, over: Partial<EngraveTargetObject> = {}): EngraveTargetObject {
  return {
    id,
    name: `${id}.stl`,
    format: 'stl',
    // A valid hex digest: the schema checks the identity it stores.
    sha256: id.replace(/[^a-f0-9]/gi, 'a').padEnd(64, 'a').slice(0, 64),
    // The bytes travel with the job, so nothing waits on the blob store.
    data: 'AA==',
    size: { x: 20, y: 20, z: 8 },
    position: { x: 40, y: 25, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    ...over,
  };
}

/** A job with two saved setups and no targets yet. */
function twoSetupJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.stock = { ...job.stock, length: 80, width: 50, thickness: 26 };
  job.labels = [];
  job.shapes = [];
  job.toolKey = 'flat-3.175x12-metal';
  job.tool = flatEndMill(3);
  const base = jobSetups(job)[0]!;
  job.setups = [
    { ...base, id: 'setup-1', orientation: { ...base.orientation }, itemIds: [], tools: [job.toolKey] },
    { ...base, id: 'setup-2', orientation: { ...base.orientation }, itemIds: [], tools: [job.toolKey] },
  ];
  return job;
}

function parses(job: EngraveJob): boolean {
  return parseEngraveJob(JSON.parse(JSON.stringify(job))).ok;
}

afterEach(() => cleanup());

describe('#723 P2-3 — writing a side’s goal', () => {
  it('migrates the single target to the first setup, adds the side named, and parses', () => {
    const job = { ...twoSetupJob(), targetObject: goal('out') };
    const next = withSideGoal(job, 'setup-2', goal('in'));
    expect(next.targetObject).toBeUndefined();
    expect(next.targetObjects?.map((t) => [t.id, t.setupId])).toEqual([
      ['out', 'setup-1'],
      ['in', 'setup-2'],
    ]);
    expect(parses(next)).toBe(true);
  });

  it('replaces a side’s goal in place, leaving the other side alone', () => {
    const job: EngraveJob = {
      ...twoSetupJob(),
      targetObjects: [goal('out', { setupId: 'setup-1' }), goal('in', { setupId: 'setup-2' })],
    };
    const next = withSideGoal(job, 'setup-2', goal('in-2'));
    expect(next.targetObjects?.map((t) => [t.id, t.setupId])).toEqual([
      ['out', 'setup-1'],
      ['in-2', 'setup-2'],
    ]);
    expect(parses(next)).toBe(true);
  });

  it('clears one side’s goal, and the last one returns the job to no target', () => {
    const job: EngraveJob = {
      ...twoSetupJob(),
      targetObjects: [goal('out', { setupId: 'setup-1' }), goal('in', { setupId: 'setup-2' })],
    };
    const one = withoutSideGoal(job, 'setup-2');
    expect(one.targetObjects?.map((t) => t.id)).toEqual(['out']);
    const none = withoutSideGoal(one, 'setup-1');
    expect(none.targetObjects).toBeUndefined();
    expect(none.targetObject).toBeUndefined();
    expect(parses(none)).toBe(true);
  });

  it('the store actions write the same document', () => {
    act(() => {
      useEngraveJobStore.getState().replace(twoSetupJob());
      useEngraveJobStore.getState().setSideGoal('setup-1', goal('out'));
      useEngraveJobStore.getState().setSideGoal('setup-2', goal('in'));
    });
    const job = useEngraveJobStore.getState().job;
    expect(jobTargetObjects(job).map((t) => [t.id, t.setupId])).toEqual([
      ['out', 'setup-1'],
      ['in', 'setup-2'],
    ]);
    act(() => useEngraveJobStore.getState().clearSideGoal('setup-1'));
    expect(jobTargetObjects(useEngraveJobStore.getState().job).map((t) => t.id)).toEqual(['in']);
  });
});

describe('#723 P2-3 — the sides list in the Setups section', () => {
  beforeEach(() => {
    act(() => {
      useEngraveJobStore.getState().replace({
        ...twoSetupJob(),
        targetObjects: [goal('outside', { setupId: 'setup-1' }), goal('inside', { setupId: 'setup-2' })],
      });
    });
  });

  it('names each side’s goal, and offers Replace on a side that has one', () => {
    render(<EngraveSetupsSection onPickGoal={() => {}} onClearGoal={() => {}} />);
    expect(screen.getByTestId('engrave-side-goal-0').textContent).toContain('outside.stl');
    expect(screen.getByTestId('engrave-side-goal-1').textContent).toContain('inside.stl');
    expect(screen.getByTestId('engrave-side-goal-pick-0').textContent).toBe('Replace…');
  });

  it('a side with no goal says it cuts the stock flat and offers Goal…', () => {
    act(() => {
      useEngraveJobStore.getState().replace({
        ...twoSetupJob(),
        targetObjects: [goal('outside', { setupId: 'setup-1' })],
      });
    });
    render(<EngraveSetupsSection onPickGoal={() => {}} onClearGoal={() => {}} />);
    expect(screen.getByTestId('engrave-side-goal-1').textContent).toContain('none — this side cuts the stock flat');
    expect(screen.getByTestId('engrave-side-goal-pick-1').textContent).toBe('Goal…');
  });

  it('the presses hand the setup id back to the panel', () => {
    const pick = vi.fn();
    const clear = vi.fn();
    render(<EngraveSetupsSection onPickGoal={pick} onClearGoal={clear} />);
    fireEvent.click(screen.getByTestId('engrave-side-goal-pick-1'));
    fireEvent.click(screen.getByTestId('engrave-side-goal-clear-0'));
    expect(pick).toHaveBeenCalledWith('setup-2');
    expect(clear).toHaveBeenCalledWith('setup-1');
  });
});
