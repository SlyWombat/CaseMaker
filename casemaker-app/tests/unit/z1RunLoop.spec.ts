// #386 review — how the harness's poll loop ENDS: finished on 100 % + Idle, the mid-job Idle the
// loop must ride, and the end where the `P` field disappears. Split from z1RunLoop.spec.ts for
// parallel running; the fake controller and subprocess driver live in ./helpers/z1RunLoopHarness.

import { describe, expect, it } from 'vitest';

import {
  RUNNING,
  MID_JOB_IDLE,
  END,
  AFTER,
  fakeController,
  runHarness,
} from './helpers/z1RunLoopHarness';

describe('#386 run — the harness poll loop (against a fake controller)', () => {
  it(
    'plays the path once, polls on that one connection, and stops when percent 100 meets Idle',
    async () => {
      const controller = await fakeController([RUNNING, END]);
      try {
        const { code, stdout, stderr } = await runHarness(controller.port, ['--json']);
        expect(code).toBe(0);
        // The pre-play status poll comes FIRST, then the program line, and the program line is BUILT
        // from the path rather than passed through.
        expect(controller.seen[0]).toBe('?');
        expect(controller.seen[1]).toBe('play /sd/gcodes/fake.nc');
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?']);
        expect(JSON.parse(stdout)).toMatchObject({
          path: '/sd/gcodes/fake.nc',
          outcome: 'finished',
          polls: 2,
          state: 'Idle',
          percent: 100,
          line: 34,
        });
        // stdout is the JSON ALONE — the whole of it parses above — and the human-readable half is on
        // stderr: the machine's reply to `play`, then one line per poll.
        expect(stderr).toContain('File size 791');
        expect(stderr).toContain('Run');
        expect(stderr).toContain('100%');
      } finally {
        await controller.close();
      }
    },
    30_000,
  );
  it(
    'does not stop at the mid-job Idle, and ends on the poll after the P field disappears',
    async () => {
      // The 100 % reply is never seen (the fake goes straight past it), so the run has to end the
      // other honest way: a `P` was seen, and now it is gone.
      const controller = await fakeController([RUNNING, MID_JOB_IDLE, AFTER, AFTER]);
      try {
        const { code, stdout, stderr } = await runHarness(controller.port, ['--json']);
        expect(code).toBe(0);
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?', '?']);
        const out = JSON.parse(stdout) as { outcome: string; polls: number; percent: number | null };
        expect(out).toMatchObject({ outcome: 'finished', polls: 3, percent: null });
        // The mid-job Idle was displayed, not acted on: ONE more poll came after it (the review
        // corrected this comment's earlier "three"), and that poll ended the run because the `P` field
        // was gone — which is the only way this run can end when it misses the 100 % reply.
        expect(stderr).toContain('74%');
        expect(stderr).not.toContain('100%');
      } finally {
        await controller.close();
      }
    },
    45_000,
  );
  it(
    'rides out a mid-job Idle at a partial percent and keeps watching when Run comes back',
    async () => {
      // The mid-job `Idle` is not always bare: at `M05` the controller reports it with the job's own
      // `P` field still in place — `P:29,74` is line 29, percent 74, so it is emphatically not the end
      // (`END` is percent 100). The loop must carry on through it and end when the trip home finishes
      // (#386 review: the code handles this, nothing pinned it).
      const controller = await fakeController([RUNNING, MID_JOB_IDLE, RUNNING, END]);
      try {
        const { code, stdout, stderr } = await runHarness(controller.port, ['--json']);
        expect(code).toBe(0);
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?', '?', '?']);
        expect(JSON.parse(stdout)).toMatchObject({
          outcome: 'finished',
          polls: 4,
          state: 'Idle',
          percent: 100,
          line: 34,
        });
        // The pause was displayed as what it was, and the run went on from it.
        expect(stderr).toContain('74%');
        expect(stderr).toContain('100%');
      } finally {
        await controller.close();
      }
    },
    45_000,
  );
});
