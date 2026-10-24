// #527 §6 — the machine layer's two selectors: WHERE the body is drawn (the live WPos while the
// machine answers, else the scrub step) and WHICH cutter is in it (the release program being run,
// else the job's own). Pure, so the simulation and the engrave preview share one rule and their
// tests can check it without a renderer.

import { describe, it, expect } from 'vitest';
import { fittedTool, toolPlacement } from '@/components/viewport/liveMachineTool';
import { flatEndMill, type Tool } from '@/engine/cnc/tool';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

describe('#527 — toolPlacement: one position source at a time', () => {
  const scrub: [number, number, number] = [10, 20, -1];

  it('takes the live WPos when the heartbeat answered and all three axes are known', () => {
    const p = toolPlacement({ reachable: true, wpos: { x: 1.5, y: -2, z: 0.25 } }, scrub);
    expect(p).toEqual({ at: [1.5, -2, 0.25], source: 'live' });
  });

  it('never draws a half position as live: a null axis falls back to the scrub step', () => {
    const p = toolPlacement({ reachable: true, wpos: { x: 1, y: null, z: 3 } }, scrub);
    expect(p).toEqual({ at: scrub, source: 'scrub' });
  });

  it('a stale line is not an answer: reachable null or false falls back to the scrub step', () => {
    const wpos = { x: 1, y: 2, z: 3 };
    expect(toolPlacement({ reachable: null, wpos }, scrub)).toEqual({ at: scrub, source: 'scrub' });
    expect(toolPlacement({ reachable: false, wpos }, scrub)).toEqual({ at: scrub, source: 'scrub' });
  });

  it('is null when there is neither a live position nor a scrub step (the engrave preview idle)', () => {
    expect(toolPlacement({ reachable: true, wpos: null }, null)).toBeNull();
    expect(toolPlacement({ reachable: false, wpos: { x: 0, y: 0, z: 0 } }, null)).toBeNull();
  });
});

describe('#527 — fittedTool: the cutter the machine has now', () => {
  const job = defaultEngraveJob();
  const facing = flatEndMill(3.175);
  const engraving = flatEndMill(0.3);
  const toolBy = (key: string): Tool | null =>
    key === 'facing-key' ? facing : key === 'engrave-key' ? engraving : null;
  const release = (over: Partial<{ jobId: string; active: number | null }> = {}) => ({
    jobId: job.id,
    active: 1,
    files: [
      { index: 1, toolKey: 'facing-key' },
      { index: 2, toolKey: 'engrave-key' },
    ],
    ...over,
  });

  it('follows the release program the machine is on, so the confirmed bit change changes the body', () => {
    expect(fittedTool(job, engraving, release({ active: 1 }), toolBy)).toBe(facing);
    expect(fittedTool(job, engraving, release({ active: 2 }), toolBy)).toBe(engraving);
  });

  it('falls back to the job’s cutter with no release, another job’s release, or no active program', () => {
    expect(fittedTool(job, engraving, null, toolBy)).toBe(engraving);
    expect(fittedTool(job, engraving, release({ jobId: 'another-job' }), toolBy)).toBe(engraving);
    expect(fittedTool(job, engraving, release({ active: null }), toolBy)).toBe(engraving);
  });

  it('falls back when the key does not resolve (a job viewed without its registry)', () => {
    const unresolved = { jobId: job.id, active: 2, files: [{ index: 2, toolKey: 'cat:missing' }] };
    expect(fittedTool(job, engraving, unresolved, toolBy)).toBe(engraving);
  });
});
