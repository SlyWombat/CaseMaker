// #922 — the three program-identity cases, split from the samples and the stick so each group runs its own worker (#1180).

import { join } from 'node:path';

import { afterAll, describe, it } from 'vitest';

import { BADGE, JOBS, cleanupIdentity, expectSameProgram } from './helpers/pipelineIdentity922';

afterAll(cleanupIdentity);

describe('#922 one pipeline', () => {
  it('the committed 10-24 badge job posts the same program from both paths', async () => {
    await expectSameProgram('badge', BADGE);
  }, 120_000);

  it('j16-chamfer-a-bevel posts the same program from both paths', async () => {
    await expectSameProgram('j16', join(JOBS, 'j16-chamfer-a-bevel.json'));
  }, 120_000);

  // #922's reported divergence: red on 2026-11-02, kept as the fix's acceptance case. Session B
  // unskips this in the change that makes the two paths one.
  //
  // WHAT IT REPRODUCES with committed fixtures: the CLI's shop omits `finish.stockToLeaveMm`
  // (scripts/lib/casemaker/engrave.ts's `shop` literal), so j13's flat regions post a single pass
  // from the CLI and rough+finish from the app — 52194 lines / 2934 depths vs 56071 / 2932, and
  // the run-time header differs from line 12. The bench's feed divergence (10000/F1000/300 vs
  // 12000/F500/200) needs the k3 catalogue's PLA rows, which are not committed; it is the same
  // defect — the CLI hands the generator a thinner options object than the app does.
  it('j13-tool-tray posts the same program from both paths (red on 2026-11-02)', async () => {
    await expectSameProgram('j13', join(JOBS, 'j13-tool-tray.json'));
  }, 120_000);
});

// #922 — THE STICK GOAL JOB. Was RED on 2026-11-03 (cand/wave2) on ONE line: both doors post the
// same two programs (the ⌀2 ball and the ⌀0.5 rest), and the rest program differed only in its
// `;@CM|TOOL|key=` header — the app named the catalogue's `cat:` definition, the CLI the
// inventory's `inv:` possession, of the same physical cutter (id 161032055031). #922's identity
// rule (`toolLibrary.ts`'s `dedupeCutterEntries`) keeps one entry per physical cutter, the owned
// key over the catalogue's, so both doors now name the same cutter; see `expectSameStickGoal`.
// The full-library location and the elephant mesh are local-only, so the case skips without them.
