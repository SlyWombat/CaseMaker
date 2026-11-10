// #922 — the j29 stick goal, split from pipelineIdentity so it runs its own worker (#1180).

import { afterAll, describe, it } from 'vitest';

import { HAVE_STICK, cleanupIdentity, expectSameStickGoal } from './helpers/pipelineIdentity922';

afterAll(cleanupIdentity);

describe.skipIf(!HAVE_STICK)('#922 one pipeline — the stick goal job', () => {
  it('j29-elephant-stick posts the same programs from both paths', async () => {
    await expectSameStickGoal();
  }, 600_000);
});

