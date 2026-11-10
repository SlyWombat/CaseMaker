// #922 — the five bench samples, split from pipelineIdentity so this group runs its own worker (#1180).

import { afterAll, describe, it } from 'vitest';

import { SAMPLES, cleanupIdentity, expectSameSample } from './helpers/pipelineIdentity922';

afterAll(cleanupIdentity);

describe('#922 one pipeline — the five bench samples', () => {
  for (const sample of SAMPLES) {
    it(
      `${sample.name} posts the same programs from both paths`,
      async () => {
        await expectSameSample(sample.name);
      },
      300_000,
    );
  }
});
