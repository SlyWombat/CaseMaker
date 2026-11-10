// #786 slice 6 — A CUTTER THE LOCATION NO LONGER HOLDS IS REPLACED BY THE SEARCH'S CHOICE.
//
// A saved job whose cutter key no longer resolves: the app substitutes a cutter the location holds,
// posts the program, and states which key was replaced. This drives the real headless command in
// process. #1180 split the two independent headless tests into parallel files; the plumbing is
// `helpers/casemakerEngrave.ts`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '../../src/engine/cnc/engrave/defaults';
import type { EngraveJob } from '../../src/types/engraveJob';
import { disposeScratch, engrave, scratchFor } from './helpers/casemakerEngrave';

const SCRATCH = scratchFor('casemaker-mixed-split-');
afterAll(() => disposeScratch(SCRATCH));

/** A saved job whose cutter key no longer resolves: the `tool-missing` the app substitutes for. */
function missingCutterJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'missing cutter job',
    toolKey: 'user:gone',
    tool: undefined,
    sources: { tool: 'user' },
  };
}

describe('#786 slice 6 the headless run answers a key the location does not hold', () => {
  it('chooses a cutter, posts the program, and says which key was replaced', async () => {
    const job = missingCutterJob();
    const run = await engrave(SCRATCH, job, 'missing-cutter');

    expect(
      run.code,
      JSON.stringify({ refusals: run.receipt?.refusals ?? null, diagnostics: run.receipt?.diagnostics ?? null }),
    ).toBe(0);
    expect(run.receipt?.ok).toBe(true);
    if (run.receipt?.command !== 'engrave') throw new Error('expected the engrave receipt');
    const written = run.receipt.details.programs[0]!;
    const nc = readFileSync(join(run.outDir, written.ncFile), 'utf8');
    // The program names a cutter the location holds — not the dead key.
    expect(nc).not.toContain('key=user:gone');
    // The substitution is stated, with both keys.
    expect(
      run.progress.some((line) => line.includes('substitute') && line.includes('user:gone') && line.includes('is not in the tool library')),
    ).toBe(true);
  }, 240_000);
});
