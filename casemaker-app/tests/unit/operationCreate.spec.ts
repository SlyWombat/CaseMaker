// #1107 — A NEW RUN CANNOT CREATE AN EMPTY JOB.
//
// The question's primary is the shell's; on a NEW run, "nothing picked" used to create the empty
// job (#1123's door for the empty job). #1107 keeps that door for a RE-ENTRY (Done) and refuses
// it on a new run: the operator picks what to make first.

import { describe, expect, it } from 'vitest';

import { operationCreateBlocked } from '@/components/welcome/operationCreate';

describe('#1107 — the null choice', () => {
  it('a new run is refused with the one sentence', () => {
    expect(operationCreateBlocked(null, { reEntry: false })).toBe('Pick what to make first.');
    expect(operationCreateBlocked(null)).toBe('Pick what to make first.');
  });

  it('a re-entry keeps its Done path', () => {
    expect(operationCreateBlocked(null, { reEntry: true })).toBeNull();
  });
});
