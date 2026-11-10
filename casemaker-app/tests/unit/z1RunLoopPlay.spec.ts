// #386 review — what the harness does with `play`'s REPLY (an error stops the run, silence does
// not) and with a job that never reports a `P` field. Split from z1RunLoop.spec.ts for parallel
// running; the harness lives in ./helpers/z1RunLoopHarness.

import { describe, expect, it } from 'vitest';

import {
  RUNNING,
  END,
  AFTER,
  fakeController,
  runHarness,
} from './helpers/z1RunLoopHarness';

describe('#386 run — the harness poll loop (against a fake controller)', () => {
  it(
    'stops without polling when the controller answers `play` with an error',
    async () => {
      const controller = await fakeController([RUNNING, END], { playReply: 'Error: no such file\r\n' });
      try {
        const { code, stderr } = await runHarness(controller.port, ['--json']);
        expect(code).toBe(1);
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc']);
        expect(stderr).toContain('did not accept that program');
      } finally {
        await controller.close();
      }
    },
    30_000,
  );
  it(
    'watches anyway when `play` is not answered — only an error reply stops the run',
    async () => {
      // The controller may still be opening the file, and its reply can arrive later than a console
      // line's window. A silent `play` is not a refused one (#386 review), so the poll starts and the
      // job is watched to its end.
      const controller = await fakeController([RUNNING, END], { playReply: null });
      try {
        // The same window, same reason: this is the silent-`play` wait the test is about, and it is
        // also the pre-play poll's window. 250 ms is a loaded machine's coin flip at the poll, which
        // would fail the test on a rule it is not about; 2 s expires just as surely at the `play`.
        const { code, stdout, stderr } = await runHarness(controller.port, ['--json', '--first-reply', '2000']);
        expect(code).toBe(0);
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?', '?']);
        expect(stderr).toContain('was not answered');
        expect(stderr).toContain('started anyway');
        expect(JSON.parse(stdout)).toMatchObject({ outcome: 'finished', percent: 100 });
      } finally {
        await controller.close();
      }
    },
    30_000,
  );
  it(
    'stops polling, non-zero, when a job never reports a P field',
    async () => {
      // A `?` that keeps answering with no `P` is a controller that is up and a job this tool cannot
      // see either way. The old loop polled it forever (#386 review); the bound is `--no-progress`.
      const controller = await fakeController([AFTER, AFTER, AFTER, AFTER]);
      try {
        const { code, stdout, stderr } = await runHarness(controller.port, ['--json', '--no-progress', '400']);
        expect(code).toBe(1);
        expect(JSON.parse(stdout)).toMatchObject({ outcome: 'never-started' });
        expect(stderr).toContain('no `P` progress field');
        expect(stderr).toContain('nothing was stopped from here');
        // It did not keep polling: the pre-play poll, `play`, and one poll that found nothing.
        expect(controller.seen).toEqual(['?', 'play /sd/gcodes/fake.nc', '?']);
      } finally {
        await controller.close();
      }
    },
    30_000,
  );
});
