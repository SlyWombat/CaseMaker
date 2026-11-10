// @vitest-environment jsdom
// #1191 — THE STORE'S RE-CHECK OF A RESTORED RUN.
//
// The pure report replacement is `restoredRun1191.spec.ts`; here the store action is exercised:
// a stored program this build's verifier refuses leaves the run blocked with the finding (no Load,
// Generate is the way forward), and the programs are still build A's bytes.
import { beforeEach, describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore } from '@/store/engraveRunStore';
import { resetShopDefaultsStore } from '@/store/shopDefaultsStore';
import { resetLocationStore } from '@/store/locationStore';
import type { EngraveRunInputs } from '@/engine/cnc/engrave/runInputs';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';

const CLEAN: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [1, 1, 0] } },
};

/** Z at -2, then an X/Y rapid there: this build refuses it (rapid-too-low). */
const BAD_NC = 'G90 G21\nG1 Z-2 F100\nG0 X5 Y5\nM5\nM02\n';

const INPUTS = { job: 'job-sha-1' } as unknown as EngraveRunInputs;

function programFor(nc: string): EngraveProgram {
  return {
    setupIndex: 1,
    setupId: 'setup-1',
    toolKey: 'flat-1.0',
    nc,
    verify: CLEAN,
    frameNc: null,
    frameVerify: null,
    programHash: 'h-flat-1.0',
    cam: null,
  } as EngraveProgram;
}

function generatedWith(programs: EngraveProgram[]): EngraveGenerated {
  return {
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    threads: null,
    threadMachining: null,
    cam: null,
    nc: programs[0]?.nc ?? null,
    verify: programs[0]?.verify ?? null,
    frameNc: null,
    frameVerify: null,
    facingNc: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    predicted: [],
    programs,
    errors: [],
  } as unknown as EngraveGenerated;
}

beforeEach(() => {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  useEngraveJobStore.setState({ job });
  useEngraveRunStore.getState().reset();
  resetShopDefaultsStore();
  resetLocationStore();
});

describe('#1191 — the store re-checks a restored run', () => {
  it('a stored program this build refuses is refused with the finding, and Load stays off', async () => {
    const generated = generatedWith([programFor(BAD_NC)]);
    useEngraveRunStore.setState({
      generated,
      inputs: INPUTS,
      phase: 'ready',
      staleSince: null,
      restoreChecking: true,
    });
    await useEngraveRunStore.getState().recheckRestoredRun({ generated, inputs: INPUTS });
    const run = useEngraveRunStore.getState();
    expect(run.phase).toBe('blocked');
    expect(run.error).toContain("This build's verifier refused the stored program 1");
    // The bytes are still the stored ones; only the report changed.
    expect(run.generated!.programs[0]!.nc).toBe(BAD_NC);
    expect(run.generated!.programs[0]!.verify!.ok).toBe(false);
    expect(run.generated!.verify!.ok).toBe(false);
  });
});
