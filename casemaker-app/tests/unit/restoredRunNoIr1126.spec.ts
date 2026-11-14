// #1126 slice 2 — A RESTORED RUN IS RE-CHECKED WITH THE PLAN'S IR ABSENT.
//
// No result carries a plan's toolpath IR (the house's document and the in-page worker both reduce a
// plan with `planSummary`). The re-check's inputs ride beside each program as `verifyContext`, so
// `recheckStoredPrograms` needs nothing of the plan: this spec feeds it a JSON-round-tripped result
// (the house's shape) whose plan is the summary, and shows the check reads the stored hop height. A
// result whose programs carry no context is not read: it asks to be planned again.
import { describe, expect, it } from 'vitest';

import { jobMachine } from '@/engine/cnc/calibration';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { planSummary, type ProgramVerifyContext } from '@/engine/cnc/engrave/planSummary';
import { recheckStoredPrograms } from '@/engine/cnc/engrave/restoredRun';
import type { ModelPlanOutput } from '@/engine/cnc/cam/model/plan';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';

const CLEAN: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [1, 1, 0] } },
};
/** Z is established at 5, then an XY rapid runs at 5: clean at a 1 mm hop, too low under a 6 mm one. */
const NC = 'G90 G21\nG0 Z5\nG0 X0 Y0\nM5\nM02\n';

function stored(context: ProgramVerifyContext | undefined): EngraveGenerated {
  const program = {
    setupIndex: 1,
    setupId: 'setup-1',
    toolKey: 'flat-1.0',
    nc: NC,
    verify: CLEAN,
    frameNc: null,
    frameVerify: null,
    programHash: 'h',
    cam: null,
    ...(context === undefined ? {} : { verifyContext: context }),
  } as EngraveProgram;
  // The plan as the page holds it: the summary, built from a plan that DID carry an IR.
  const withIr = {
    perSetup: [{ setupIndex: 0, notes: [], ops: [], programs: [{ hopZ: 6, operations: [] }], clGrid: [] }],
  } as unknown as ModelPlanOutput;
  const generated = {
    ok: true,
    stage: 'done',
    findings: [],
    feeds: null,
    nc: NC,
    verify: CLEAN,
    programs: [program],
    plan: planSummary(withIr),
    errors: [],
  } as unknown as EngraveGenerated;
  expect(JSON.stringify(generated)).not.toContain('hopZ');
  return JSON.parse(JSON.stringify(generated)) as EngraveGenerated;
}

function recheck(generated: EngraveGenerated) {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  const machine = jobMachine(job, null);
  return recheckStoredPrograms({ job, generated, machine, mount: null, setup: toSetup(job, machine, undefined, null), defaults: null });
}

describe('#1126 — the re-check reads verifyContext, not the plan', () => {
  it('a stored hop of 1 mm passes the program; the IR is nowhere in the result', () => {
    const out = recheck(stored({ minRapidZ: 1, outsideAllowancesMm: [], throughKerf: [] }));
    expect(out.regenerate).toBe(false);
    expect(out.errors).toEqual([]);
  });

  it('a stored hop of 6 mm refuses the same bytes: the number comes from the context', () => {
    const out = recheck(stored({ minRapidZ: 6, outsideAllowancesMm: [], throughKerf: [] }));
    expect(out.regenerate).toBe(false);
    expect(out.errors.map((e) => e.finding.code)).toContain('rapid-too-low');
  });

  it('a plan that exists but has no entry for a program’s setup is planned again, not checked against the job’s limit', () => {
    const generated = stored({ minRapidZ: 1, outsideAllowancesMm: [], throughKerf: [] });
    const missingSetup: EngraveGenerated = { ...generated, plan: { outcome: null, perSetup: [] } };
    const out = recheck(missingSetup);
    expect(out.regenerate).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.generated).toBe(missingSetup);
  });

  it('a result with no verifyContext is not re-checked: it asks to be planned again, unchanged', () => {
    const generated = stored(undefined);
    const out = recheck(generated);
    expect(out.regenerate).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.generated).toBe(generated);
  });
});
