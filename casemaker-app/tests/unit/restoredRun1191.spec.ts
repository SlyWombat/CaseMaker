// #1191 — THIS BUILD CHECKS A STORED RUN'S BYTES, WITHOUT RE-PLANNING.
//
// A stored run belongs to the job, not the build. Across builds the stored programs are put
// through this build's verifier again (the checks, never the planner): a report the older build
// wrote is replaced by what THIS build reads from the same `.nc`; the programs themselves are
// untouched. A program whose cutter this build cannot resolve keeps its stored report and is
// reported as unresolved (the sweep refuses it by name).
import { PROGRAM_CONTEXT } from './helpers/programContext';
import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobMachine } from '@/engine/cnc/calibration';
import { toSetup } from '@/engine/cnc/engrave/jobSetup';
import { recheckStoredPrograms } from '@/engine/cnc/engrave/restoredRun';
import type { VerifyReport } from '@/engine/cnc/verify';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';

const CLEAN: VerifyReport = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: 0, bbox: { min: [0, 0, 0], max: [1, 1, 0] } },
};

/** A report an older build wrote — this build must replace it with its own reading. */
const OLD_REFUSAL: VerifyReport = {
  ok: false,
  findings: [{ severity: 'error', code: 'cut-too-deep', line: 2, message: 'an older build refused this' }],
  stats: { lines: 1, cuttingMoves: 0, deepestZ: -9, bbox: { min: [0, 0, 0], max: [1, 1, 0] } },
};

/** Z is established above the hop, then nothing moves below it: this build passes it. */
const GOOD_NC = 'G90 G21\nG0 Z5\nG0 X0 Y0\nM5\nM02\n';
/** Z is established at -2, then an X/Y rapid runs at -2, below the hop (1): this build refuses it. */
const BAD_NC = 'G90 G21\nG1 Z-2 F100\nG0 X5 Y5\nM5\nM02\n';

function jobWithCutter() {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0'; // a built-in, so `jobTool` resolves it in this realm
  return job;
}

function programFor(nc: string, verify: VerifyReport, toolKey: string): EngraveProgram {
  return {
    setupIndex: 1,
    setupId: 'setup-1',
    toolKey,
    nc,
    verify,
    frameNc: null,
    frameVerify: null,
    programHash: `h-${toolKey}`,
    ...PROGRAM_CONTEXT,
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

function recheck(generated: EngraveGenerated, job = jobWithCutter()) {
  const machine = jobMachine(job, null);
  return recheckStoredPrograms({
    job,
    generated,
    machine,
    mount: null,
    setup: toSetup(job, machine, undefined, null),
    defaults: null,
  });
}

describe('#1191 — the stored bytes are re-verified by this build', () => {
  it('passes bytes the stored report called clean', () => {
    const out = recheck(generatedWith([programFor(GOOD_NC, OLD_REFUSAL, 'flat-1.0')]));
    expect(out.errors).toEqual([]);
    expect(out.generated.programs[0]!.verify!.ok).toBe(true);
    expect(out.generated.programs[0]!.verify!.findings).toEqual([]);
    // The bytes are untouched: this is a check, not a re-plan.
    expect(out.generated.programs[0]!.nc).toBe(GOOD_NC);
    expect(out.generated.programs[0]!.programHash).toBe('h-flat-1.0');
  });

  it('refuses bytes the stored report called clean, and names the program', () => {
    const out = recheck(generatedWith([programFor(BAD_NC, CLEAN, 'flat-1.0')]));
    expect(out.errors.length).toBeGreaterThan(0);
    expect(out.errors[0]!.programIndex).toBe(0);
    expect(out.errors.map((e) => e.finding.code)).toContain('rapid-too-low');
    expect(out.generated.programs[0]!.verify!.ok).toBe(false);
    expect(out.generated.verify!.ok).toBe(false);
  });

  it('a cutter this build cannot resolve keeps its stored report and is reported unresolved', () => {
    const out = recheck(generatedWith([programFor(GOOD_NC, CLEAN, 'inv:not-on-this-bench')]));
    expect(out.unresolved).toEqual([{ programIndex: 0, toolKey: 'inv:not-on-this-bench' }]);
    expect(out.generated.programs[0]!.verify).toBe(CLEAN);
    expect(out.errors).toEqual([]);
  });
});
